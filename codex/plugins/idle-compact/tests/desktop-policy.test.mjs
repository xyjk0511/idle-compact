import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { desktopNativeAllowed, providerHash } from '../hooks/desktop-policy.mjs'

test('desktop activation is bound to the verified provider, config and runtime', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-native-policy-'))
  const configFile = path.join(data, 'config.toml')
  const transcript = path.join(data, 'rollout.jsonl')
  const runtime = path.join(data, 'codex.exe')
  const config = '[model_providers.native]\nname = "OpenAI"\nwire_api = "responses"\nbase_url = "http://127.0.0.1:10100/v1"\n'
  fs.writeFileSync(configFile, config)
  const rollout = (provider, model = 'gpt-6-luna') => fs.writeFileSync(transcript,
    JSON.stringify({ type: 'session_meta', payload: { model_provider: provider } }) + '\n' +
    JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n')
  rollout('native')
  const args = { data, transcript, runtime, configFile, runtimeVersion: 'codex-cli 0.160.0' }
  try {
    assert.equal(desktopNativeAllowed(args), false)
    fs.writeFileSync(path.join(data, 'desktop-native.json'), JSON.stringify({
      runtime, version: args.runtimeVersion, configFile, provider: 'native', providerHash: providerHash(config, 'native'),
    }))
    assert.equal(desktopNativeAllowed(args), true)
    assert.equal(desktopNativeAllowed({ ...args, runtimeVersion: 'codex-cli 0.161.0' }), false)
    assert.equal(desktopNativeAllowed({ ...args, runtime: path.join(data, 'other.exe') }), false)
    assert.equal(desktopNativeAllowed({ ...args, configFile: path.join(data, 'other.toml') }), false)
    rollout('another')
    assert.equal(desktopNativeAllowed(args), false)
    rollout('native', 'third-party/model')
    assert.equal(desktopNativeAllowed(args), false)
    rollout('native')
    fs.appendFileSync(transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'session_configured', model_provider_id: 'another' } }) + '\n')
    assert.equal(desktopNativeAllowed(args), false)
    rollout('native')
    fs.writeFileSync(configFile, config.replace('10100', '10101'))
    assert.equal(desktopNativeAllowed(args), false)
    assert.equal(providerHash(config.replace('OpenAI', 'Other'), 'native'), null)
  } finally {
    for (const file of ['config.toml', 'rollout.jsonl', 'desktop-native.json']) fs.unlinkSync(path.join(data, file))
    fs.rmdirSync(data)
  }
})
