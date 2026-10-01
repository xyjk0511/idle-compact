// Cancel any pending idle timer: the thread saw activity, so the timer that
// was armed for it is obsolete.

import { bumpGeneration, log } from './common.mjs'

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
const sessionId = payload && payload.session_id

if (sessionId) {
  const generation = bumpGeneration(sessionId)
  log('cancelled, generation now ' + generation + ' (' + (payload.hook_event_name || '?') + ')')
}

process.stdout.write('{}\n')
