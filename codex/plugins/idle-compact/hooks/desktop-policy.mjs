// A local operator receipt enables only the desktop route that was verified.
// Changing its runtime or provider configuration requires a fresh verification.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export function providerHash(text, provider) {
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) return null
  const section = text.match(new RegExp('^\\[model_providers\\.' + provider + '\\]\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))', 'm'))?.[1]
  if (!section || !/^name\s*=\s*"OpenAI"\s*$/m.test(section) || !/^wire_api\s*=\s*"responses"\s*$/m.test(section)) return null
  return createHash('sha256').update(section).digest('hex')
}

export function desktopNativeAllowed({ data, transcript, runtime, runtimeVersion, configFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml') }) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(data, 'desktop-native.json'), 'utf8'))
    if (receipt.version !== 'codex-cli 0.160.0' || !runtime || path.resolve(runtime) !== path.resolve(receipt.runtime)) return false
    if (path.resolve(receipt.configFile) !== path.resolve(configFile)) return false
    if (typeof receipt.providerHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.providerHash)) return false
    if (providerHash(fs.readFileSync(receipt.configFile, 'utf8'), receipt.provider) !== receipt.providerHash) return false
    const fd = fs.openSync(transcript, 'r')
    let head, tail
    try {
      const size = fs.fstatSync(fd).size
      const read = (start, length) => {
        const bytes = Buffer.alloc(length)
        fs.readSync(fd, bytes, 0, length, start)
        return bytes.toString('utf8')
      }
      head = read(0, Math.min(size, 1024 * 1024))
      tail = read(Math.max(0, size - 4 * 1024 * 1024), Math.min(size, 4 * 1024 * 1024))
    } finally { fs.closeSync(fd) }
    const meta = JSON.parse(head.split('\n')[0])
    if (meta.type !== 'session_meta') return false
    let provider = meta.payload.model_provider, model
    for (const line of tail.split('\n')) {
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (record.type === 'turn_context') model = record.payload.model
      if (['session_configured', 'thread_settings_applied'].includes(record.payload?.type)) {
        provider = record.payload.model_provider_id || provider
      }
    }
    if (provider !== receipt.provider || typeof model !== 'string' || !/^gpt-/.test(model)) return false
    const version = runtimeVersion ?? spawnSync(runtime, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).stdout?.trim()
    return version === receipt.version
  } catch { return false }
}
