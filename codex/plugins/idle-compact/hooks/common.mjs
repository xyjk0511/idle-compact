// Shared helpers for the idle-compact Codex plugin. Node built-ins only.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Scheduling defaults do not guarantee upstream cache retention.
export const DEFAULT_IDLE_MIN = 25
export const DEFAULT_LATEST_MIN = 35

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function config() {
  const idleMin = num(process.env.IDLE_COMPACT_IDLE_MIN, DEFAULT_IDLE_MIN)
  const latestMin = Math.max(num(process.env.IDLE_COMPACT_LATEST_MIN, DEFAULT_LATEST_MIN), idleMin)
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'codex.exe')
  const bundledBin = process.platform === 'win32' && fs.existsSync(bundled) ? bundled : ''
  const codexBin = process.env.IDLE_COMPACT_CODEX || bundledBin || process.env.CODEX_CLI_PATH || newestCodexBin() || 'codex'
  return {
    idleMs: idleMin * 60 * 1000,
    latestMs: latestMin * 60 * 1000,
    minTokens: num(process.env.IDLE_COMPACT_MIN_TOKENS, 0),
    disabled: process.env.IDLE_COMPACT_DISABLE === '1' || fs.existsSync(path.join(dataDir(), 'paused')),
    codexBin,
    cacheSafeRuntime: codexBin === bundledBin && Boolean(bundledBin),
    logFile: process.env.IDLE_COMPACT_LOG || '',
  }
}

// The desktop app keeps its current CLI in bin/<hash>/codex.exe; the bare
// bin/codex.exe that PATH finds is an older build that rejects newer
// config.toml keys, so the app server it starts cannot load the config.
export function newestCodexBin(binDir = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin')) {
  try {
    const found = fs
      .readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binDir, entry.name, 'codex.exe'))
      .filter((file) => fs.existsSync(file))
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return found.length > 0 ? found[0].file : ''
  } catch {
    return ''
  }
}

export function dataDir() {
  const base = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA
  return base ? base : path.join(os.homedir(), '.codex', 'idle-compact')
}

export function logPath() {
  const configured = config().logFile
  return configured ? configured : path.join(dataDir(), 'idle-compact.log')
}

export function log(line) {
  try {
    const file = logPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + os.EOL)
  } catch {
    // Logging never breaks the session.
  }
}

// The person-facing words follow the system language: Chinese on a Chinese
// system, English everywhere else.
export function systemLang() {
  try {
    return /^zh\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

export function toastBody(idleMs, lang = systemLang()) {
  const minutes = Math.round(idleMs / 60000)
  return lang === 'zh' ? '空闲 ' + minutes + ' 分钟，已自动压缩' : 'Idle for ' + minutes + ' min, compacted'
}

const TOAST_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'toast.ps1')

// The Windows balloon shown after a compaction, drawn by the script shipped
// next to this module. Empty off Windows, when the script is missing, or when
// IDLE_COMPACT_TOAST is 0.
export function toastArgv(cwd, idleMs, script = TOAST_SCRIPT) {
  if (process.env.IDLE_COMPACT_TOAST === '0' || process.platform !== 'win32' || !fs.existsSync(script)) return []
  const folder = String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  const title = 'Codex · ' + (folder || 'idle-compact')
  const body = toastBody(idleMs)
  return ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Title', encodeURIComponent(title), '-Body', encodeURIComponent(body)]
}

export function stateFile(sessionId) {
  return path.join(dataDir(), 'state', sessionId + '.json')
}

export function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'))
  } catch {
    return null
  }
}

export function writeState(sessionId, state) {
  try {
    const file = stateFile(sessionId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state))
  } catch {
    // A failed state write only means no timer; it must not fail the turn.
  }
}

// The timer child is stopped by signalling its pid. On Windows that ends the
// process without POSIX signals; either way the child re-checks the state file
// before doing anything, so a missed kill is harmless.
export function killTimer(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return
  try {
    process.kill(pid)
  } catch {
    // Already gone.
  }
}

export function bumpGeneration(sessionId) {
  const previous = readState(sessionId)
  const generation = (previous && Number(previous.generation) ? Number(previous.generation) : 0) + 1
  if (previous) killTimer(previous.pid)
  writeState(sessionId, { sessionId, generation, armedAt: 0, dueAt: 0, pid: 0 })
  return generation
}

// Read at most the tail of the rollout: rollouts grow to many megabytes and
// only the most recent token_count record matters here.
const TAIL_BYTES = 4 * 1024 * 1024

function tailText(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// Read the last context size recorded for the thread. Returns null when
// nothing usable is found.
export function lastUsage(rolloutPath) {
  let text
  try {
    text = tailText(rolloutPath)
  } catch {
    return null
  }
  let found = null
  for (const line of text.split('\n')) {
    if (!line.includes('token_count')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type !== 'event_msg') continue
    const payload = record.payload || {}
    if (payload.type !== 'token_count' || !payload.info) continue
    const last = payload.info.last_token_usage || {}
    if (!Number.isFinite(last.input_tokens)) continue
    // Codex also emits zero-delta token_count records (for example right
    // after a compaction). Keep the last record that actually billed input,
    // which is the one that describes the call.
    if (!last.input_tokens && !last.cache_write_input_tokens) continue
    found = {
      inputTokens: last.input_tokens || 0,
      cachedTokens: last.cached_input_tokens || 0,
      cacheWriteTokens: last.cache_write_input_tokens || 0,
    }
  }
  return found
}

// Finds, in rollout text appended since the compaction was requested, a
// compacted record followed by its task_complete. Codex writes the summary
// call's token_count just before the compacted record (the one after it is a
// zero-delta record), so that is the usage reported. Returns { usage } or null.
export function compactionIn(text) {
  let usage = null
  let compacted = null
  for (const line of text.split('\n')) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // A partial last line, or not a record.
    }
    const payload = record.payload || {}
    if (record.type === 'compacted') {
      compacted = { usage }
    } else if (record.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
      const last = payload.info.last_token_usage || {}
      if (last.input_tokens) {
        usage = { inputTokens: last.input_tokens, cachedTokens: last.cached_input_tokens || 0, cacheWriteTokens: last.cache_write_input_tokens || 0 }
      }
    } else if (compacted && record.type === 'event_msg' && payload.type === 'task_complete') {
      return compacted
    }
  }
  return null
}

// Whether the thread is still working, judged from the tail of its rollout.
// A goal (and any other automatic continuation) starts the next turn without
// a prompt, so UserPromptSubmit never cancels the timer the previous Stop
// armed. The thread counts as busy when:
//   - a record is stamped after `since` (the file's mtime is no help: Windows
//     leaves it stale while Codex holds the rollout open), or
//   - its last turn event is a task_started with no task_complete or
//     turn_aborted after it, or
//   - the tail holds no turn event at all although it is only part of the
//     file: a single turn has written more than the whole tail.
// `whole` says the text is the entire file.
export function threadBusyIn(text, { since = Infinity, whole = true } = {}) {
  let running = null
  let lastAt = 0
  for (const line of text.split('\n')) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // A partial first or last line.
    }
    const at = Date.parse(record && record.timestamp)
    if (Number.isFinite(at) && at > lastAt) lastAt = at
    const type = record && record.type === 'event_msg' && record.payload ? record.payload.type : ''
    if (type === 'task_started') running = true
    else if (type === 'task_complete' || type === 'turn_aborted') running = false
  }
  if (lastAt > since) return true
  return running === null ? !whole : running
}

export function threadBusy(rolloutPath, since) {
  try {
    const whole = fs.statSync(rolloutPath).size <= TAIL_BYTES
    return threadBusyIn(tailText(rolloutPath), { since, whole })
  } catch {
    return false
  }
}

// Percent of the last call's input that came from the prompt cache, or null
// when the rollout cannot establish authoritative cache detail.
//
// In Codex token_count records, input_tokens is the whole input and
// cached_input_tokens is the cached subset of it, so the two are not
// additive. Integer math keeps an exact hit from displaying one below.
export function cacheHitPercent(usage) {
  if (!usage) return null
  const total = usage.inputTokens || 0
  const cached = usage.cachedTokens || 0
  const written = usage.cacheWriteTokens || 0
  // Rollout token_count records carry no cache-provenance bit. A positive
  // count cannot be a zero-default artifact, but an all-zero detail cannot be
  // distinguished from bridge normalization and must stay unavailable.
  if (!total || (!cached && !written)) return null
  return Math.floor((cached * 100) / total)
}

export function cacheHitLine(usage) {
  if (!usage) return null
  const total = usage.inputTokens || 0
  if (!total) return null
  const cached = usage.cachedTokens || 0
  const written = usage.cacheWriteTokens || 0
  const n = (x) => Number(x || 0).toLocaleString('en-US')
  if (!cached && !written) {
    return 'cache-read accounting unavailable (' + n(total) + ' input; rollout zero has no provenance)'
  }
  const percent = cacheHitPercent(usage)
  return 'compacted with a ' + percent + '% cache hit (' + n(cached) + ' cached, ' + n(written) + ' written, ' + n(total - cached) + ' uncached)'
}

export function clockTime(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
