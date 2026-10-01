// Stop hook: arm exactly one detached idle timer for this thread.
//
// Codex gives plugin hooks no in-process timer, so the timer is a separate
// detached Node process that outlives this hook. It re-reads the state file
// before acting, so a stale or superseded timer can never compact a live
// thread.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clockTime, config, killTimer, log, readState, writeState } from './common.mjs'

function readPayload() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { raw += chunk })
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
    process.stdin.on('error', () => resolve(null))
  })
}

const payload = await readPayload()
const settings = config()

// stop_hook_active marks a Stop hook already driving this turn. Arming from
// there would let a blocking hook re-arm itself forever.
if (!payload || payload.stop_hook_active === true) process.exit(0)
if (settings.disabled) {
  log('disabled via IDLE_COMPACT_DISABLE')
  process.exit(0)
}

const sessionId = payload.session_id
const transcriptPath = payload.transcript_path
if (!sessionId || !transcriptPath) process.exit(0)

// One timer at most: bumping the generation retires the previous one.
const previous = readState(sessionId)
const generation = (previous && Number.isFinite(Number(previous.generation)) ? Number(previous.generation) : 0) + 1
if (previous) killTimer(previous.pid)

const armedAt = Date.now()
const dueAt = armedAt + settings.idleMs
const latestAt = armedAt + settings.latestMs
const cwd = payload.cwd || process.cwd()
const timerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'timer.mjs')

const child = spawn(
  process.execPath,
  [timerPath, sessionId, String(generation), String(dueAt), String(latestAt), transcriptPath, cwd],
  { detached: true, windowsHide: true, stdio: 'ignore', cwd },
)
child.unref()

writeState(sessionId, {
  sessionId,
  generation,
  armedAt,
  dueAt,
  latestAt,
  pid: child.pid || 0,
  transcriptPath,
})
log('armed generation ' + generation + ' due ' + new Date(dueAt).toISOString() + ' pid ' + (child.pid || 0))

// systemMessage is shown to the person; additionalContext would enter the
// model's prompt and change the prefix this plugin is trying to preserve.
process.stdout.write(JSON.stringify({
  systemMessage: 'idle-compact: compacts at ' + clockTime(dueAt) + ' if nothing happens before then',
}) + '\n')
