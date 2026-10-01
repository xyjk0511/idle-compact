// Compaction through the Codex desktop app itself.
//
// A thread open in the desktop app is owned by that app's app server, which
// holds the thread's writer lock (~/.codex/thread-writer-locks), so a second
// app server cannot resume it ("already has an active writer"). The desktop
// app runs an IPC router on a named pipe for its follower clients, and a
// follower may ask the thread's owner to compact it. The owner then compacts
// in its own process, exactly as its compact button would.
//
// Wire format (read from the desktop app bundle): each frame is a 4-byte
// little-endian length followed by UTF-8 JSON. A client sends `initialize`
// with a clientType and gets a clientId back; requests without a target are
// routed to whichever client answers the router's discovery that it can
// handle them, which for thread-follower-* is the thread's owner.

import net from 'node:net'
import { randomUUID } from 'node:crypto'

export const DEFAULT_PIPE = '\\\\.\\pipe\\codex-ipc'

// Method versions the desktop app checks before handling a request.
const VERSIONS = { initialize: 0, 'thread-owner-discovery': 1, 'thread-follower-compact-thread': 1 }

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

// Splits complete frames off the front of `buffer`.
export function decodeFrames(buffer) {
  const messages = []
  let rest = buffer
  while (rest.length >= 4) {
    const length = rest.readUInt32LE(0)
    if (rest.length < 4 + length) break
    messages.push(JSON.parse(rest.subarray(4, 4 + length).toString('utf8')))
    rest = rest.subarray(4 + length)
  }
  return { messages, rest }
}

class Follower {
  constructor(socket) {
    this.socket = socket
    this.clientId = 'initializing-client'
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('close', () => {
      for (const resolve of this.pending.values()) resolve({ resultType: 'error', error: 'connection-closed' })
      this.pending.clear()
    })
  }

  onData(chunk) {
    let decoded
    try {
      decoded = decodeFrames(Buffer.concat([this.buffer, chunk]))
    } catch {
      this.socket.destroy()
      return
    }
    this.buffer = decoded.rest
    for (const message of decoded.messages) {
      if (message.type === 'response' && this.pending.has(message.requestId)) {
        const resolve = this.pending.get(message.requestId)
        this.pending.delete(message.requestId)
        resolve(message)
      } else if (message.type === 'client-discovery-request') {
        // This client handles nothing; say so, so the router does not wait on it.
        this.socket.write(encodeFrame({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }))
      }
    }
  }

  request(method, params, timeoutMs) {
    const requestId = randomUUID()
    this.socket.write(encodeFrame({
      type: 'request', requestId, sourceClientId: this.clientId, version: VERSIONS[method], method, params, timeoutMs,
    }))
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ resultType: 'error', error: 'timeout' })
      }, timeoutMs + 2000)
      this.pending.set(requestId, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }
}

function connect(pipe, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(pipe)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

// Resolves with:
//   'compacted'   the owning desktop app accepted the compaction
//   'no-owner'    the router answered, but no client has the thread open
//   'unavailable' no desktop app (no pipe, or it did not answer)
// and throws when the owner refused, for example because a turn is running.
export async function compactViaDesktop(threadId, { pipe = process.env.IDLE_COMPACT_IPC_PIPE || DEFAULT_PIPE, timeoutMs = 6000, probeOnly = false } = {}) {
  if (process.platform !== 'win32' && pipe === DEFAULT_PIPE) return 'unavailable'
  const socket = await connect(pipe, timeoutMs)
  if (!socket) return 'unavailable'
  socket.on('error', () => {})
  const follower = new Follower(socket)
  try {
    const init = await follower.request('initialize', { clientType: 'idle-compact' }, timeoutMs)
    if (init.resultType !== 'success' || !init.result || !init.result.clientId) return 'unavailable'
    follower.clientId = init.result.clientId

    const owner = await follower.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, timeoutMs)
    if (owner.resultType !== 'success') {
      if (owner.error === 'no-client-found') return 'no-owner'
      return 'unavailable'
    }

    if (probeOnly) return 'owned'
    const compacted = await follower.request('thread-follower-compact-thread', { conversationId: threadId }, 120000)
    if (compacted.resultType === 'success') return 'compacted'
    if (compacted.error === 'timeout') throw new Error('the desktop app did not answer the compaction request; it may still be compacting')
    throw new Error('the desktop app refused the compaction: ' + (compacted.error || 'unknown error'))
  } finally {
    socket.end()
  }
}
