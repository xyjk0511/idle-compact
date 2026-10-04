// A local operator receipt enables only the desktop route that was verified.
// Changing its runtime or provider configuration requires a fresh verification.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export function providerHash(text, provider) {
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) return null
  const section = text.match(new RegExp('^\\[model_providers\\.' + provider + '\\]\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))', 'm'))?.[1]
  if (!section || !/^name\s*=\s*"OpenAI"\s*$/m.test(section) || !/^wire_api\s*=\s*"responses"\s*$/m.test(section)) return null
  return createHash('sha256').update(section).digest('hex')
}

// Provider changes are sparse rollout events: a bounded tail can forget one
// after a long turn and fall back to the creation-time provider. Scan one
// fixed-size snapshot of the JSONL stream, but parse only records that can
// change the policy identity. Nothing from the transcript is logged or kept.
function transcriptIdentity(transcript) {
  const fd = fs.openSync(transcript, 'r')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let pending = ''
  let first = true
  let provider
  let model

  const readLine = (line) => {
    if (first) {
      first = false
      const meta = JSON.parse(line)
      if (meta.type !== 'session_meta') throw new Error('missing session metadata')
      provider = meta.payload?.model_provider
      return
    }
    if (!line.includes('turn_context') && !line.includes('session_configured') && !line.includes('thread_settings_applied')) return
    let record
    try { record = JSON.parse(line) } catch { return }
    if (record.type === 'turn_context') model = record.payload?.model
    if (['session_configured', 'thread_settings_applied'].includes(record.payload?.type)) {
      provider = record.payload.model_provider_id || provider
    }
  }

  try {
    const size = fs.fstatSync(fd).size
    for (let position = 0; position < size;) {
      const length = Math.min(buffer.length, size - position)
      const count = fs.readSync(fd, buffer, 0, length, position)
      if (!count) throw new Error('transcript changed while reading')
      position += count
      const lines = (pending + decoder.write(buffer.subarray(0, count))).split('\n')
      pending = lines.pop() || ''
      for (const line of lines) readLine(line)
    }
    pending += decoder.end()
    if (pending) readLine(pending)
    if (first) throw new Error('empty transcript')
    return { provider, model }
  } finally {
    fs.closeSync(fd)
  }
}

export function desktopNativeAllowed({ data, transcript, runtime, runtimeVersion, configFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml') }) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(data, 'desktop-native.json'), 'utf8'))
    if (receipt.version !== 'codex-cli 0.160.0' || !runtime || path.resolve(runtime) !== path.resolve(receipt.runtime)) return false
    if (path.resolve(receipt.configFile) !== path.resolve(configFile)) return false
    if (typeof receipt.providerHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.providerHash)) return false
    if (providerHash(fs.readFileSync(receipt.configFile, 'utf8'), receipt.provider) !== receipt.providerHash) return false
    const current = transcriptIdentity(transcript)
    if (current.provider !== receipt.provider || typeof current.model !== 'string' || !/^gpt-/.test(current.model)) return false
    const version = runtimeVersion ?? spawnSync(runtime, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).stdout?.trim()
    return version === receipt.version
  } catch { return false }
}
