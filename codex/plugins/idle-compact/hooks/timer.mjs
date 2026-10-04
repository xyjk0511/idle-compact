// Detached one-shot timer. Reached only after the armed delay has elapsed.
//
// It compacts the thread once, then exits: through the desktop app when the
// thread is open there (see desktop.mjs), otherwise through a throwaway app
// server over the JSON-RPC API.
// Every guard is re-checked here against live state: the timer may have been
// superseded, the thread may have been used, or the machine may have slept
// through the deadline.

import { spawn } from 'node:child_process'
import { cacheHitLine, compactionIn, config, dataDir, lastUsage, log, readState, threadBusy, toastArgv, writeState } from './common.mjs'
import { compactViaDesktop } from './desktop.mjs'
import { desktopNativeAllowed } from './desktop-policy.mjs'
import fs from 'node:fs'
import path from 'node:path'

const [sessionId, generationArg, dueAtArg, latestAtArg, transcriptPath, cwd] = process.argv.slice(2)
const settings = config()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(dueAt) {
  // A single long sleep would drift where timers are throttled, so wait in
  // bounded slices and re-check the wall clock.
  for (;;) {
    const remaining = dueAt - Date.now()
    if (remaining <= 0) return
    await sleep(Math.min(remaining, 60 * 1000))
  }
}

function stillCurrent() {
  const state = readState(sessionId)
  if (!state) return false
  return Number(state.generation) === Number(generationArg)
}

// The app-server speaks newline-delimited JSON-RPC over stdio.
class Server {
  constructor(child) {
    this.child = child
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 1
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    // Keep stderr out of the way but drained: the app server logs warnings
    // there, and an unread pipe would eventually fill and stall it.
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.resume()
      this.stderrTail = ''
      child.stderr.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-2000)
      })
    }
  }

  onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const at = this.buffer.indexOf('\n')
      if (at < 0) return
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined
      if (waiter) {
        this.pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)))
        else waiter.resolve(message.result)
      } else if (message.method === 'turn/completed') {
        if (this.onTurnComplete) this.onTurnComplete(message.params)
      } else if (message.method === 'turn/failed' || message.method === 'error') {
        if (this.onTurnFailed) this.onTurnFailed(message.params)
      }
    }
  }

  send(method, params) {
    const id = this.nextId++
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(method + ' timed out'))
      }, 120000)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  kill() {
    for (const waiter of this.pending.values()) clearTimeout(waiter.timer)
    this.pending.clear()
    try {
      this.child.kill()
    } catch {
      // Already gone.
    }
  }
}

async function main() {
  if (config().disabled) {
    log('paused or disabled, skipped')
    return
  }
  const state = readState(sessionId)
  if (!state || Number(state.generation) !== Number(generationArg)) {
    log('timer for generation ' + generationArg + ' is superseded; nothing to do')
    return
  }

  await waitUntil(Number(dueAtArg))
  if (config().disabled) {
    log('paused or disabled, skipped')
    return
  }

  const elapsedMin = (Date.now() - Number(state.armedAt)) / 60000
  const minutes = elapsedMin.toFixed(1)

  // Re-check after the wait: the person may have sent a turn, or the machine
  // may have slept past the window, in which case the cache is already cold
  // and compacting would re-read the whole context for nothing.
  if (!stillCurrent()) {
    log('fired after ' + minutes + ' min: superseded, skipped')
    return
  }
  const now = Date.now()
  if (now < Number(dueAtArg) || now >= Number(latestAtArg)) {
    log('fired after ' + minutes + ' min: outside the window, skipped')
    return
  }

  // A goal keeps a thread working turn after turn without a prompt, so the
  // Stop that armed this timer may be followed by a turn that is still going.
  if (threadBusy(transcriptPath, Number(state.armedAt) + 60 * 1000)) {
    log('fired after ' + minutes + ' min: the thread is still working, skipped')
    return
  }

  const usage = lastUsage(transcriptPath)
  if (settings.minTokens > 0 && (!usage || usage.inputTokens < settings.minTokens)) {
    log('fired after ' + minutes + ' min: context below IDLE_COMPACT_MIN_TOKENS, skipped')
    return
  }

  // A thread open in the desktop app can only be written by the desktop app,
  // so ask it first; start our own app server only when nobody owns the thread.
  if (!stillCurrent()) {
    log('fired after ' + minutes + ' min: superseded, skipped')
    return
  }
  // The compaction fires this thread's PreCompact hook, and its cancel kills
  // the pid in the state file, which is this process: it would die before it
  // could log the result or write the receipt. Drop the pid; the generation
  // stays, so activity before this point still wins.
  writeState(sessionId, { ...readState(sessionId), pid: 0 })
  const offset = fileSize(transcriptPath)
  const beforeCompact = () => {
    if (!stillCurrent() || config().disabled || Date.now() >= Number(latestAtArg) ||
      threadBusy(transcriptPath, Number(state.armedAt) + 60 * 1000)) return false
    return true
  }
  const nativeDesktop = () => desktopNativeAllowed({ data: dataDir(), transcript: transcriptPath, runtime: process.env.CODEX_CLI_PATH })
  const viaDesktop = await compactViaDesktop(sessionId, {
    probeOnly: settings.cacheSafeRuntime && !nativeDesktop(),
    beforeCompact: () => (!settings.cacheSafeRuntime || nativeDesktop()) && beforeCompact(),
  })
  if (viaDesktop === 'cancelled') {
    log('activity or settings changed during desktop discovery, skipped')
    return
  }
  if (viaDesktop === 'owned') {
    log('desktop still owns the thread; patched app-server cannot acquire it, skipped')
    return
  }
  if (viaDesktop === 'compacted') {
    log('fired after ' + minutes + ' min: the desktop app is compacting')
    const seen = await waitForCompaction(transcriptPath, offset, Number(process.env.IDLE_COMPACT_CONFIRM_MS) || 120000)
    if (!seen) {
      log('the desktop app accepted the compaction, but it did not finish in the rollout in time')
      return
    }
    finish(seen.usage)
    await toast()
    return
  }

  if (!beforeCompact()) {
    log('activity or settings changed during desktop discovery, skipped')
    return
  }
  log('fired after ' + minutes + ' min: desktop app ' + viaDesktop + ', compacting via app-server')
  if (await compactViaAppServer()) await toast()
}

function finish(usage) {
  const line = cacheHitLine(usage)
  log('compaction finished' + (line ? '; ' + line : ''))
  writeSummary(line)
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

// The desktop app answers as soon as the compaction has started. Wait for the
// compacted record and the task_complete that follows it, so the receipt
// describes the summary call and not a turn someone ran meanwhile. Resolves
// with { usage } (usage may be null), or null when it never finished in time.
async function waitForCompaction(file, offset, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(Math.min(2000, timeoutMs))
    let text
    try {
      const size = fs.statSync(file).size
      if (size <= offset) continue
      const fd = fs.openSync(file, 'r')
      const buffer = Buffer.alloc(size - offset)
      fs.readSync(fd, buffer, 0, buffer.length, offset)
      fs.closeSync(fd)
      text = buffer.toString('utf8')
    } catch {
      continue
    }
    const found = compactionIn(text)
    if (found) return found
  }
  return null
}

async function compactViaAppServer() {
  // plugins={} suppresses MCP and plugin startup for this throwaway server.
  // Without it the compaction would also bring up every configured MCP server
  // in the background, which is a heavy and pointless side effect of a call
  // that only needs to summarise the thread.
  const child = spawn(settings.codexBin, ['app-server', '--stdio', '-c', 'plugins={}'], {
    detached: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  })
  const server = new Server(child)

  try {
    await server.send('initialize', { clientInfo: { name: 'idle-compact', version: '1.2.0', title: 'idle-compact' } })
    if (!stillCurrent()) {
      log('superseded while starting the app server, skipped')
      return false
    }
    await server.send('thread/resume', { threadId: sessionId })
    if (!stillCurrent()) {
      log('superseded before compaction, skipped')
      return false
    }

    const done = new Promise((resolve, reject) => {
      server.onTurnComplete = () => resolve(true)
      server.onTurnFailed = (params) => reject(new Error((params && params.error && params.error.message) || 'turn failed'))
    })
    const offset = fileSize(transcriptPath)
    await server.send('thread/compact/start', { threadId: sessionId })
    let completionTimer
    try {
      await Promise.race([done, new Promise((_, reject) => {
        completionTimer = setTimeout(() => reject(new Error('compaction timed out')), 120000)
      })])
    } finally {
      clearTimeout(completionTimer)
    }
    const seen = await waitForCompaction(transcriptPath, offset, Number(process.env.IDLE_COMPACT_CONFIRM_MS) || 120000)
    if (!seen) throw new Error('app-server finished without a confirmed compaction record')
    finish(seen.usage)
    return true
  } finally {
    server.kill()
  }
}

// Leave a small receipt next to the state file: the transcript is written by
// Codex, and an external writer must not append to it.
function writeSummary(line) {
  try {
    const file = path.join(dataDir(), 'state', sessionId + '.done.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), line }))
  } catch {
    // A missing receipt is not worth failing over.
  }
}

// Awaited, not detached: a detached PowerShell has no console and exits at
// once, and an orphaned one dies with this process, so the balloon would
// never show. The script holds it for about seven seconds.
function toast() {
  const argv = toastArgv(cwd, settings.idleMs)
  if (argv.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const giveUp = setTimeout(resolve, 20000)
    const finish = () => {
      clearTimeout(giveUp)
      resolve()
    }
    try {
      const child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: 'ignore' })
      child.on('error', (error) => {
        log('toast failed: ' + error.message)
        finish()
      })
      child.on('exit', finish)
    } catch (error) {
      log('toast failed: ' + (error && error.message ? error.message : String(error)))
      finish()
    }
  })
}

main()
  .catch((error) => log('timer failed: ' + (error && error.message ? error.message : String(error))))
  .finally(() => process.exit(0))
