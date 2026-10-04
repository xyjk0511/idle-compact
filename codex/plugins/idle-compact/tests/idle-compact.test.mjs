// Focused checks for the decisions idle-compact makes: when to arm, when to
// cancel, and when a timer must decline to compact. These drive the real hook
// entry points rather than re-testing the code they call.
//
// Run: node --test 'plugins/codex/tests/*.test.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = (name) => path.join(here, '..', 'hooks', name)
const sandboxes = []

// Arming really does start a detached timer process, so every sandbox is
// retired when the run ends. Without this a full test run leaves live timers
// sleeping for the default 25 minutes.
const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-compact-'))
  sandboxes.push(dir)
  return dir
}

test.after(() => {
  for (const dir of sandboxes) {
    const stateDir = path.join(dir, 'state')
    let entries = []
    try {
      entries = fs.readdirSync(stateDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const state = JSON.parse(fs.readFileSync(path.join(stateDir, entry), 'utf8'))
        if (state.pid) process.kill(state.pid)
      } catch {
        // Already exited, or never started.
      }
    }
  }
})

function runHook(name, payload, env) {
  return spawnSync(process.execPath, [hook(name)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  })
}

function readState(dir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state', sessionId + '.json'), 'utf8'))
}

function stopPayload(dir, sessionId, extra) {
  return {
    session_id: sessionId,
    transcript_path: path.join(dir, 'rollout.jsonl'),
    cwd: dir,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...extra,
  }
}

test('Stop arms a timer and announces the local compaction time', () => {
  const dir = sandbox()
  const result = runHook('arm.mjs', stopPayload(dir, 's1'), {
    PLUGIN_DATA: dir,
    IDLE_COMPACT_IDLE_MIN: '25',
  })
  assert.equal(result.status, 0)
  const out = JSON.parse(result.stdout.trim())
  assert.match(out.systemMessage, /^idle-compact: compacts at [0-9][0-9]:[0-9][0-9] if nothing happens before then$/)
  const state = readState(dir, 's1')
  assert.equal(state.generation, 1)
  assert.equal(state.dueAt - state.armedAt, 25 * 60 * 1000)
  // The notice is for the person only. Sending additionalContext would change
  // the prompt prefix the plugin exists to preserve.
  assert.equal(out.hookSpecificOutput, undefined)
})

test('Stop does not arm from a hook-driven stop', () => {
  const dir = sandbox()
  const result = runHook('arm.mjs', stopPayload(dir, 's2', { stop_hook_active: true }), { PLUGIN_DATA: dir })
  assert.equal(result.status, 0)
  assert.equal(fs.existsSync(path.join(dir, 'state', 's2.json')), false)
})

test('a new prompt cancels the pending timer and signals its process', () => {
  const dir = sandbox()
  runHook('arm.mjs', stopPayload(dir, 's3'), { PLUGIN_DATA: dir })
  const armed = readState(dir, 's3')
  runHook('cancel.mjs', { session_id: 's3', hook_event_name: 'UserPromptSubmit' }, { PLUGIN_DATA: dir })
  const cancelled = readState(dir, 's3')
  assert.equal(cancelled.generation, armed.generation + 1)
  const probe = spawnSync(process.execPath, ['-e',
    'process.kill(Number(process.argv[1])); console.log("alive")',
    String(armed.pid)], { encoding: 'utf8' })
  // The superseded timer must no longer be running.
  assert.notEqual(probe.stdout.trim(), 'alive')
})

test('repeated turns keep a single timer, bumping the generation each time', () => {
  const dir = sandbox()
  for (const n of [1, 2, 3]) {
    runHook('arm.mjs', stopPayload(dir, 's4'), { PLUGIN_DATA: dir })
    assert.equal(readState(dir, 's4').generation, n)
  }
})

test('IDLE_COMPACT_DISABLE stops the plugin from arming', () => {
  const dir = sandbox()
  runHook('arm.mjs', stopPayload(dir, 's5'), { PLUGIN_DATA: dir, IDLE_COMPACT_DISABLE: '1' })
  assert.equal(fs.existsSync(path.join(dir, 'state', 's5.json')), false)
})

test('bundled fixed runtime takes precedence over the desktop CLI environment',
  { skip: process.platform !== 'win32' }, () => {
    const bundled = path.join(here, '..', 'runtime', 'codex.exe')
    assert.ok(fs.existsSync(bundled), 'Release tests require the actual bundled runtime')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {config} from ' + JSON.stringify(new URL('../hooks/common.mjs', import.meta.url).href) + '; console.log(JSON.stringify(config()))'], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, CODEX_CLI_PATH: 'unpatched-desktop.exe', IDLE_COMPACT_CODEX: '' },
    })
    assert.equal(result.status, 0)
    const selected = JSON.parse(result.stdout)
    assert.equal(selected.codexBin, bundled)
    assert.equal(selected.cacheSafeRuntime, true)
  })

test('persistent pause stops already loaded hooks from creating new timers', () => {
  const dir = sandbox()
  fs.writeFileSync(path.join(dir, 'paused'), '')
  const result = runHook('arm.mjs', stopPayload(dir, 'paused-thread'), {
    PLUGIN_DATA: dir, IDLE_COMPACT_DISABLE: '',
  })
  assert.equal(result.status, 0)
  assert.equal(fs.existsSync(path.join(dir, 'state', 'paused-thread.json')), false)
})

test('a timer created before persistent pause never starts compaction', async () => {
  const { dir, armedAt } = desktopTimerSandbox('paused-timer')
  fs.writeFileSync(path.join(dir, 'paused'), '')
  const logText = await runTimer(dir, 'paused-timer', 1, armedAt, armedAt + 60000)
  assert.match(logText, /paused or disabled, skipped/)
  assert.equal(fs.existsSync(path.join(dir, 'state', 'paused-timer.done.json')), false)
})

async function runTimer(dir, sessionId, generation, dueAt, latestAt, extraEnv) {
  const child = spawn(process.execPath, [
    hook('timer.mjs'), sessionId, String(generation), String(dueAt), String(latestAt),
    path.join(dir, 'rollout.jsonl'), dir,
  ], { env: { ...process.env, PLUGIN_DATA: dir, ...extraEnv }, windowsHide: true })
  await new Promise((resolve) => child.on('exit', resolve))
  return fs.readFileSync(path.join(dir, 'idle-compact.log'), 'utf8')
}

test('the timer does nothing when its generation was superseded', async () => {
  const dir = sandbox()
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'state', 's6.json'), JSON.stringify({
    sessionId: 's6', generation: 9, armedAt: Date.now(), dueAt: Date.now(),
    latestAt: Date.now() + 60000, pid: 0,
  }))
  const logText = await runTimer(dir, 's6', 3, Date.now(), Date.now() + 60000)
  assert.match(logText, /superseded; nothing to do/)
  assert.equal(fs.existsSync(path.join(dir, 'state', 's6.done.json')), false)
})

test('the timer declines once the cache window has passed', async () => {
  const dir = sandbox()
  const armedAt = Date.now() - 90 * 60 * 1000
  const dueAt = armedAt + 25 * 60 * 1000
  const latestAt = armedAt + 35 * 60 * 1000
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'state', 's7.json'), JSON.stringify({
    sessionId: 's7', generation: 1, armedAt, dueAt, latestAt, pid: 0,
  }))
  const logText = await runTimer(dir, 's7', 1, dueAt, latestAt)
  assert.match(logText, /outside the window, skipped/)
  assert.equal(fs.existsSync(path.join(dir, 'state', 's7.done.json')), false)
})

test('a small context is skipped when IDLE_COMPACT_MIN_TOKENS is set', async () => {
  const dir = sandbox()
  const armedAt = Date.now()
  const dueAt = armedAt
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'state', 's8.json'), JSON.stringify({
    sessionId: 's8', generation: 1, armedAt, dueAt, latestAt: armedAt + 60000, pid: 0,
  }))
  fs.writeFileSync(path.join(dir, 'rollout.jsonl'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 120 } } } }) + '\n')
  const logText = await runTimer(dir, 's8', 1, dueAt, armedAt + 60000, { IDLE_COMPACT_MIN_TOKENS: '5000' })
  assert.match(logText, /context below IDLE_COMPACT_MIN_TOKENS, skipped/)
})

test('cache hit percent treats cached tokens as a subset of the input', async () => {
  const { cacheHitPercent, cacheHitLine } = await import('../hooks/common.mjs')
  // Codex reports input_tokens inclusive of cached_input_tokens, so these two
  // must not be added together.
  assert.equal(cacheHitPercent({ inputTokens: 74808, cachedTokens: 74482, cacheWriteTokens: 0 }), 99)
  assert.equal(cacheHitPercent({ inputTokens: 0, cachedTokens: 0 }), null)
  assert.equal(cacheHitPercent(null), null)
  assert.equal(
    cacheHitLine({ inputTokens: 100, cachedTokens: 95, cacheWriteTokens: 0 }),
    'compacted with a 95% cache hit (95 cached, 0 written, 5 uncached)',
  )
})

test('lastUsage reads the most recent record that actually billed input', async () => {
  const { lastUsage } = await import('../hooks/common.mjs')
  const dir = sandbox()
  const file = path.join(dir, 'rollout.jsonl')
  const line = (o) => JSON.stringify(o) + '\n'
  fs.writeFileSync(file, [
    line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 100 } } } }),
    line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 0, cached_input_tokens: 0 } } } }),
    line({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
  ].join(''))
  assert.deepEqual(lastUsage(file), { inputTokens: 500, cachedTokens: 100, cacheWriteTokens: 0 })
})

test('newestCodexBin picks the most recently updated hashed desktop build', async () => {
  const { newestCodexBin } = await import('../hooks/common.mjs')
  const dir = sandbox()
  const make = (name, seconds) => {
    fs.mkdirSync(path.join(dir, name))
    const file = path.join(dir, name, 'codex.exe')
    fs.writeFileSync(file, '')
    fs.utimesSync(file, seconds, seconds)
    return file
  }
  make('old1111', 1_000)
  const fresh = make('new2222', 2_000)
  fs.mkdirSync(path.join(dir, 'empty'))
  fs.writeFileSync(path.join(dir, 'codex.exe'), '')
  assert.equal(newestCodexBin(dir), fresh)
  assert.equal(newestCodexBin(path.join(dir, 'missing')), '')
})

test('the balloon text follows the system language', async () => {
  const { toastBody } = await import('../hooks/common.mjs')
  assert.equal(toastBody(25 * 60 * 1000, 'zh'), '空闲 25 分钟，已自动压缩')
  assert.equal(toastBody(25 * 60 * 1000, 'en'), 'Idle for 25 min, compacted')
})

test('toastArgv uses the bundled script, names the folder, and stays quiet without a script',
  { skip: process.platform !== 'win32' && 'the balloon is Windows only' }, async () => {
  const { toastArgv, toastBody } = await import('../hooks/common.mjs')
  const dir = sandbox()
  const bundled = toastArgv('D:\\work\\my-project\\', 25 * 60 * 1000)
  assert.equal(bundled[bundled.indexOf('-File') + 1], path.join(here, '..', 'hooks', 'toast.ps1'))
  const script = path.join(dir, 'toast.ps1')
  fs.writeFileSync(script, '')
  const argv = toastArgv('D:\\work\\my-project\\', 25 * 60 * 1000, script)
  assert.equal(argv[0], 'powershell.exe')
  assert.equal(argv[argv.indexOf('-File') + 1], script)
  assert.equal(decodeURIComponent(argv[argv.indexOf('-Title') + 1]), 'Codex · my-project')
  assert.equal(decodeURIComponent(argv[argv.indexOf('-Body') + 1]), toastBody(25 * 60 * 1000))
  assert.deepEqual(toastArgv('F:\\x', 1, path.join(dir, 'missing.ps1')), [])
  process.env.IDLE_COMPACT_TOAST = '0'
  try {
    assert.deepEqual(toastArgv('F:\\x', 1, script), [])
  } finally {
    delete process.env.IDLE_COMPACT_TOAST
  }
})

// A stand-in for the desktop app's IPC router plus the one client that owns
// `owned`. `onOwnerDiscovery` runs before the owner-discovery reply, and
// `onCompact` runs when the owner is asked to compact.
async function fakeDesktop({ owned, refuse = false, onCompact = () => {}, onOwnerDiscovery = () => {}, probe = false }) {
  const net = await import('node:net')
  const { encodeFrame, decodeFrames } = await import('../hooks/desktop.mjs')
  const pipe = process.platform === 'win32'
    ? '\\\\.\\pipe\\idle-compact-test-' + process.pid + '-' + Math.random().toString(36).slice(2)
    : path.join(sandbox(), 'ipc.sock')
  const seen = []
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      const decoded = decodeFrames(Buffer.concat([buffer, chunk]))
      buffer = decoded.rest
      for (const m of decoded.messages) {
        seen.push(m)
        const reply = (extra) => socket.write(encodeFrame({ type: 'response', requestId: m.requestId, method: m.method, ...extra }))
        if (m.method === 'initialize') {
          reply({ resultType: 'success', result: { clientId: 'c-1' } })
          // Route another client's request past this follower, as the router does.
          if (probe) socket.write(encodeFrame({ type: 'client-discovery-request', requestId: 'd-1', request: { method: 'thread-follower-start-turn', version: 2 } }))
        }
        else if (m.method === 'thread-owner-discovery') {
          if (m.params.conversationId === owned && m.params.hostId === 'local') {
            onOwnerDiscovery(m)
            reply({ resultType: 'success', handledByClientId: 'owner' })
          }
          else reply({ resultType: 'error', error: 'no-client-found' })
        } else if (m.method === 'thread-follower-compact-thread') {
          if (refuse) reply({ resultType: 'error', error: 'turn in progress' })
          else {
            onCompact(m)
            reply({ resultType: 'success', result: { ok: true } })
          }
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(pipe, resolve))
  return { pipe, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('frames are a little-endian length and UTF-8 JSON, and split frames reassemble', async () => {
  const { encodeFrame, decodeFrames } = await import('../hooks/desktop.mjs')
  const a = encodeFrame({ type: 'request', method: 'initialize', note: '压缩' })
  const b = encodeFrame({ type: 'response' })
  assert.equal(a.readUInt32LE(0), a.length - 4)
  const joined = Buffer.concat([a, b])
  const first = decodeFrames(joined.subarray(0, a.length + 2))
  assert.deepEqual(first.messages, [{ type: 'request', method: 'initialize', note: '压缩' }])
  const second = decodeFrames(Buffer.concat([first.rest, joined.subarray(a.length + 2)]))
  assert.deepEqual(second.messages, [{ type: 'response' }])
  assert.equal(second.rest.length, 0)
})

test('the desktop app compacts a thread it owns, asked as a follower', async () => {
  const { compactViaDesktop } = await import('../hooks/desktop.mjs')
  const desktop = await fakeDesktop({ owned: 't-open' })
  try {
    assert.equal(await compactViaDesktop('t-open', { pipe: desktop.pipe }), 'compacted')
    const compact = desktop.seen.find((m) => m.method === 'thread-follower-compact-thread')
    assert.deepEqual(compact.params, { conversationId: 't-open' })
    assert.equal(compact.version, 1)
    assert.equal(compact.sourceClientId, 'c-1')
    assert.equal(compact.targetClientId, undefined)
  } finally {
    await desktop.close()
  }
})

test('beforeCompact=false cancels without sending desktop compaction', async () => {
  const { compactViaDesktop } = await import('../hooks/desktop.mjs')
  const desktop = await fakeDesktop({ owned: 't-cancel' })
  try {
    const result = await compactViaDesktop('t-cancel', {
      pipe: desktop.pipe,
      beforeCompact: () => false,
    })
    const compactSent = desktop.seen.some((message) => message.method === 'thread-follower-compact-thread')
    assert.deepEqual({ result, compactSent }, { result: 'cancelled', compactSent: false })
  } finally {
    await desktop.close()
  }
})

test('a thread no desktop client owns is left to the app-server path', async () => {
  const { compactViaDesktop } = await import('../hooks/desktop.mjs')
  const desktop = await fakeDesktop({ owned: 't-open' })
  try {
    assert.equal(await compactViaDesktop('t-closed', { pipe: desktop.pipe }), 'no-owner')
    assert.equal(desktop.seen.some((m) => m.method === 'thread-follower-compact-thread'), false)
  } finally {
    await desktop.close()
  }
})

test('ownership probe does not send compaction to an unpatched desktop owner', async () => {
  const { compactViaDesktop } = await import('../hooks/desktop.mjs')
  const desktop = await fakeDesktop({ owned: 'owned-probe' })
  try {
    assert.equal(await compactViaDesktop('owned-probe', { pipe: desktop.pipe, probeOnly: true }), 'owned')
    assert.equal(desktop.seen.some((message) => message.method === 'thread-follower-compact-thread'), false)
  } finally {
    await desktop.close()
  }
})

test('bundled timer skips an owned desktop thread without requesting compaction',
  { skip: process.platform !== 'win32' }, async () => {
    const desktop = await fakeDesktop({ owned: 'bundled-owned' })
    try {
      const { dir, armedAt } = desktopTimerSandbox('bundled-owned')
      const logText = await runTimer(dir, 'bundled-owned', 1, armedAt, armedAt + 60000, {
        IDLE_COMPACT_CODEX: '', CODEX_CLI_PATH: 'unpatched-desktop.exe',
        IDLE_COMPACT_IPC_PIPE: desktop.pipe, IDLE_COMPACT_TOAST: '0',
      })
      assert.match(logText, /desktop still owns the thread.*skipped/)
      assert.equal(desktop.seen.some((message) => message.method === 'thread-follower-compact-thread'), false)
      assert.equal(fs.existsSync(path.join(dir, 'state', 'bundled-owned.done.json')), false)
    } finally {
      await desktop.close()
    }
  })

test('app-server completion without a compaction record produces no success receipt', async () => {
  const { dir, armedAt } = desktopTimerSandbox('false-completion')
  fs.writeFileSync(path.join(dir, 'app-server'), `
    const readline = require('node:readline')
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line)
      process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n')
      if (request.method === 'thread/compact/start') {
        process.stdout.write(JSON.stringify({ method: 'turn/completed', params: {} }) + '\\n')
      }
    })
  `)
  const missingPipe = process.platform === 'win32'
    ? '\\\\.\\pipe\\idle-compact-no-owner-' + process.pid
    : path.join(dir, 'no-owner.sock')
  const logText = await runTimer(dir, 'false-completion', 1, armedAt, armedAt + 60000, {
    IDLE_COMPACT_CODEX: process.execPath, IDLE_COMPACT_IPC_PIPE: missingPipe,
    IDLE_COMPACT_CONFIRM_MS: '100', IDLE_COMPACT_TOAST: '0',
  })
  assert.match(logText, /without a confirmed compaction record/)
  assert.doesNotMatch(logText, /compaction finished/)
  assert.equal(fs.existsSync(path.join(dir, 'state', 'false-completion.done.json')), false)
})

test('no desktop app means unavailable, and a refusal is an error', async () => {
  const { compactViaDesktop } = await import('../hooks/desktop.mjs')
  const missing = process.platform === 'win32' ? '\\\\.\\pipe\\idle-compact-missing-' + process.pid : path.join(sandbox(), 'none.sock')
  assert.equal(await compactViaDesktop('t', { pipe: missing, timeoutMs: 1000 }), 'unavailable')
  const desktop = await fakeDesktop({ owned: 't-busy', refuse: true })
  try {
    await assert.rejects(compactViaDesktop('t-busy', { pipe: desktop.pipe }), /turn in progress/)
  } finally {
    await desktop.close()
  }
})

test('the timer hands an open thread to the desktop app and waits for its record', async () => {
  const dir = sandbox()
  const rollout = path.join(dir, 'rollout.jsonl')
  const line = (o) => JSON.stringify(o) + '\n'
  fs.writeFileSync(rollout, line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 10 } } } }))
  const desktop = await fakeDesktop({
    owned: 's9',
    // The order Codex writes: the summary call's usage, compacted, a zero-delta
    // usage record, then task_complete.
    onCompact: () => setTimeout(() => fs.appendFileSync(rollout,
      line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 190 } } } }) +
      line({ type: 'compacted', payload: {} }) +
      line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 0, cached_input_tokens: 0 } } } }) +
      line({ type: 'event_msg', payload: { type: 'task_complete' } })), 300),
  })
  try {
    const armedAt = Date.now()
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'state', 's9.json'), JSON.stringify({
      sessionId: 's9', generation: 1, armedAt, dueAt: armedAt, latestAt: armedAt + 60000, pid: 0,
    }))
    const logText = await runTimer(dir, 's9', 1, armedAt, armedAt + 60000, {
      IDLE_COMPACT_IPC_PIPE: desktop.pipe, IDLE_COMPACT_TOAST: '0', IDLE_COMPACT_CODEX: 'codex-must-not-run',
    })
    assert.match(logText, /the desktop app is compacting/)
    assert.match(logText, /compaction finished; compacted with a 95% cache hit/)
    assert.doesNotMatch(logText, /via app-server/)
    assert.equal(fs.existsSync(path.join(dir, 'state', 's9.done.json')), true)
  } finally {
    await desktop.close()
  }
})

test('the PreCompact cancel set off by the compaction does not kill the timer that asked for it', async () => {
  const { dir, armedAt } = desktopTimerSandbox('s14')
  const rollout = path.join(dir, 'rollout.jsonl')
  const line = (o) => JSON.stringify(o) + '\n'
  const desktop = await fakeDesktop({
    owned: 's14',
    // The desktop app runs the thread's PreCompact hook as the compaction starts.
    onCompact: () => {
      runHook('cancel.mjs', { session_id: 's14', hook_event_name: 'PreCompact' }, { PLUGIN_DATA: dir })
      setTimeout(() => fs.appendFileSync(rollout,
        line({ type: 'compacted', payload: {} }) + line({ type: 'event_msg', payload: { type: 'task_complete' } })), 300)
    },
  })
  try {
    const child = spawn(process.execPath, [hook('timer.mjs'), 's14', '1', String(armedAt), String(armedAt + 60000), rollout, dir], {
      env: { ...process.env, PLUGIN_DATA: dir, IDLE_COMPACT_IPC_PIPE: desktop.pipe, IDLE_COMPACT_TOAST: '0', IDLE_COMPACT_CODEX: 'codex-must-not-run' },
      windowsHide: true,
    })
    // Arming records the timer's pid, which is what cancel signals.
    const stateFile = path.join(dir, 'state', 's14.json')
    fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), pid: child.pid }))
    await new Promise((resolve) => child.on('exit', resolve))
    const logText = fs.readFileSync(path.join(dir, 'idle-compact.log'), 'utf8')
    assert.match(logText, /cancelled, generation now 2 \(PreCompact\)/)
    assert.match(logText, /compaction finished/)
    assert.equal(fs.existsSync(path.join(dir, 'state', 's14.done.json')), true)
  } finally {
    await desktop.close()
  }
})

test('the follower tells the router it handles nothing, so no request is misrouted to it', async () => {
  const { compactViaDesktop } = await import('../hooks/desktop.mjs')
  const desktop = await fakeDesktop({ owned: 't-open', probe: true })
  try {
    assert.equal(await compactViaDesktop('t-open', { pipe: desktop.pipe }), 'compacted')
    const answer = desktop.seen.find((m) => m.type === 'client-discovery-response')
    assert.deepEqual(answer, { type: 'client-discovery-response', requestId: 'd-1', response: { canHandle: false } })
  } finally {
    await desktop.close()
  }
})

test('the receipt is the summary call just before the compacted record, confirmed by its task_complete', async () => {
  const { compactionIn } = await import('../hooks/common.mjs')
  const rec = (o) => JSON.stringify(o)
  const usage = (input, cached) => rec({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached } } } })
  const done = rec({ type: 'event_msg', payload: { type: 'task_complete' } })
  // A turn someone ran meanwhile finishes first; it is not the compaction.
  assert.equal(compactionIn([usage(900, 10), done].join('\n')), null)
  // Compacted but not finished yet, with a partial last line.
  assert.equal(compactionIn([usage(4438, 3840), rec({ type: 'compacted' }), '{"type":"ev'].join('\n')), null)
  assert.deepEqual(
    compactionIn([usage(900, 10), done, usage(4438, 3840), rec({ type: 'compacted' }), usage(0, 0), done].join('\n')),
    { usage: { inputTokens: 4438, cachedTokens: 3840, cacheWriteTokens: 0 } },
  )
})

function desktopTimerSandbox(sessionId) {
  const dir = sandbox()
  const armedAt = Date.now()
  fs.writeFileSync(path.join(dir, 'rollout.jsonl'), '')
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'state', sessionId + '.json'), JSON.stringify({
    sessionId, generation: 1, armedAt, dueAt: armedAt, latestAt: armedAt + 60000, pid: 0,
  }))
  return { dir, armedAt }
}

test('owner discovery followed by a new prompt cancels timer compaction without fallback', async () => {
  const sessionId = 'owner-discovery-new-prompt'
  const { dir, armedAt } = desktopTimerSandbox(sessionId)
  let cancelResult
  const desktop = await fakeDesktop({
    owned: sessionId,
    onOwnerDiscovery: () => {
      cancelResult = runHook('cancel.mjs', {
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
      }, { PLUGIN_DATA: dir })
    },
  })
  try {
    const logText = await runTimer(dir, sessionId, 1, armedAt, armedAt + 60000, {
      IDLE_COMPACT_IPC_PIPE: desktop.pipe,
      IDLE_COMPACT_TOAST: '0',
      IDLE_COMPACT_CONFIRM_MS: '100',
      IDLE_COMPACT_CODEX: 'codex-must-not-run',
    })
    assert.deepEqual({
      cancelExitCode: cancelResult?.status,
      generation: readState(dir, sessionId).generation,
      compactRequests: desktop.seen.filter((message) => message.method === 'thread-follower-compact-thread').length,
      appServerFallback: /via app-server/.test(logText),
      receiptExists: fs.existsSync(path.join(dir, 'state', sessionId + '.done.json')),
    }, {
      cancelExitCode: 0,
      generation: 2,
      compactRequests: 0,
      appServerFallback: false,
      receiptExists: false,
    })
  } finally {
    await desktop.close()
  }
})

test('owner discovery followed by a pause cancels timer compaction without fallback', async () => {
  const sessionId = 'owner-discovery-pause'
  const { dir, armedAt } = desktopTimerSandbox(sessionId)
  const desktop = await fakeDesktop({
    owned: sessionId,
    onOwnerDiscovery: () => fs.writeFileSync(path.join(dir, 'paused'), ''),
  })
  try {
    const logText = await runTimer(dir, sessionId, 1, armedAt, armedAt + 60000, {
      IDLE_COMPACT_IPC_PIPE: desktop.pipe,
      IDLE_COMPACT_TOAST: '0',
      IDLE_COMPACT_CONFIRM_MS: '100',
      IDLE_COMPACT_CODEX: 'codex-must-not-run',
    })
    assert.deepEqual({
      paused: fs.existsSync(path.join(dir, 'paused')),
      compactRequests: desktop.seen.filter((message) => message.method === 'thread-follower-compact-thread').length,
      appServerFallback: /via app-server/.test(logText),
      receiptExists: fs.existsSync(path.join(dir, 'state', sessionId + '.done.json')),
    }, {
      paused: true,
      compactRequests: 0,
      appServerFallback: false,
      receiptExists: false,
    })
  } finally {
    await desktop.close()
  }
})

test('an accepted compaction that never shows up claims nothing', async () => {
  const desktop = await fakeDesktop({ owned: 's10' })
  try {
    const { dir, armedAt } = desktopTimerSandbox('s10')
    const logText = await runTimer(dir, 's10', 1, armedAt, armedAt + 60000, {
      IDLE_COMPACT_IPC_PIPE: desktop.pipe, IDLE_COMPACT_TOAST: '0', IDLE_COMPACT_CONFIRM_MS: '1500', IDLE_COMPACT_CODEX: 'codex-must-not-run',
    })
    assert.match(logText, /did not finish in the rollout in time/)
    assert.doesNotMatch(logText, /compaction finished|via app-server/)
    assert.equal(fs.existsSync(path.join(dir, 'state', 's10.done.json')), false)
  } finally {
    await desktop.close()
  }
})

test('a refusal from the desktop app is logged and not retried elsewhere', async () => {
  const desktop = await fakeDesktop({ owned: 's11', refuse: true })
  try {
    const { dir, armedAt } = desktopTimerSandbox('s11')
    const logText = await runTimer(dir, 's11', 1, armedAt, armedAt + 60000, {
      IDLE_COMPACT_IPC_PIPE: desktop.pipe, IDLE_COMPACT_TOAST: '0', IDLE_COMPACT_CODEX: 'codex-must-not-run',
    })
    assert.match(logText, /timer failed: the desktop app refused the compaction: turn in progress/)
    assert.doesNotMatch(logText, /via app-server/)
    assert.equal(fs.existsSync(path.join(dir, 'state', 's11.done.json')), false)
  } finally {
    await desktop.close()
  }
})

test('a thread is busy mid-turn, after new records, or when one turn fills the tail', async () => {
  const { threadBusyIn } = await import('../hooks/common.mjs')
  const at = (iso) => '2026-09-29T02:' + iso + 'Z'
  const ev = (type, t = '00:00') => JSON.stringify({ timestamp: at(t), type: 'event_msg', payload: { type } })
  const since = Date.parse(at('10:00'))
  assert.equal(threadBusyIn(''), false)
  assert.equal(threadBusyIn([ev('task_started'), ev('task_complete')].join('\n'), { since }), false)
  // A goal continues straight into the next turn, with no prompt in between.
  assert.equal(threadBusyIn([ev('task_started'), ev('task_complete'), ev('task_started'), ev('token_count')].join('\n'), { since }), true)
  assert.equal(threadBusyIn([ev('task_started'), ev('turn_aborted')].join('\n'), { since }), false)
  // Something was recorded after the timer was armed.
  assert.equal(threadBusyIn([ev('task_started'), ev('task_complete'), ev('token_count', '20:00')].join('\n'), { since }), true)
  // Only part of the file was read and it holds no turn event: one long turn.
  assert.equal(threadBusyIn(ev('token_count'), { since, whole: false }), true)
  assert.equal(threadBusyIn(ev('token_count'), { since, whole: true }), false)
})

test('the timer leaves a thread alone while a goal keeps it working', async () => {
  const desktop = await fakeDesktop({ owned: 's12' })
  try {
    const { dir, armedAt } = desktopTimerSandbox('s12')
    const ev = (type) => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n'
    fs.writeFileSync(path.join(dir, 'rollout.jsonl'), ev('task_started') + ev('task_complete') + ev('task_started'))
    const logText = await runTimer(dir, 's12', 1, armedAt, armedAt + 60000, {
      IDLE_COMPACT_IPC_PIPE: desktop.pipe, IDLE_COMPACT_TOAST: '0', IDLE_COMPACT_CODEX: 'codex-must-not-run',
    })
    assert.match(logText, /the thread is still working, skipped/)
    assert.equal(desktop.seen.length, 0)
    assert.equal(fs.existsSync(path.join(dir, 'state', 's12.done.json')), false)
  } finally {
    await desktop.close()
  }
})

test('the timer skips a thread that recorded something after it was armed', async () => {
  const desktop = await fakeDesktop({ owned: 's13' })
  try {
    const { dir, armedAt } = desktopTimerSandbox('s13')
    const ev = (type, at) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type } }) + '\n'
    fs.writeFileSync(path.join(dir, 'rollout.jsonl'), ev('task_complete', armedAt) + ev('token_count', armedAt + 5 * 60 * 1000))
    const logText = await runTimer(dir, 's13', 1, armedAt, armedAt + 60000, {
      IDLE_COMPACT_IPC_PIPE: desktop.pipe, IDLE_COMPACT_TOAST: '0', IDLE_COMPACT_CODEX: 'codex-must-not-run',
    })
    assert.match(logText, /the thread is still working, skipped/)
    assert.equal(desktop.seen.length, 0)
  } finally {
    await desktop.close()
  }
})
