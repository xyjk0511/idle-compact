import type { EngineInterface, Register, Timer } from 'claude-code'

// Compact once after the main conversation has been idle for 50 minutes, while
// the 1h prompt cache is still warm. One one-shot timer at most; no polling,
// no keep-alive, and nothing is re-armed after the compaction.
export const IDLE_MS = 50 * 60 * 1000
// Past this the cache may already be cold (the Mac slept, the timer ran late),
// so compacting would re-cache the whole context: do nothing instead.
export const LATEST_MS = 58 * 60 * 1000

type Armed = {
  generation: number
  timer: Timer
  sessionId: string
  armedAt: number
}

type State = {
  generation: number
  armed: Armed | null
  currentTurnId: string | null
  isCompacting: boolean
  // Headless fallback: a /compact we queued whose turn has not started yet,
  // and the id of that turn once it has.
  queuedCompact: boolean
  compactTurnId: string | null
}

// A desktop or SDK session is headless: $.session.compact rejects there, and
// compaction runs as a /compact turn instead (Claude Code 2.1.280).
export function isHeadlessRefusal(error: unknown) {
  return /headless/i.test(error instanceof Error ? error.message : String(error))
}

export type Lang = 'zh' | 'en'

// The person-facing words (balloon, footer label) follow the system language:
// Chinese on a Chinese system, English everywhere else.
export function systemLang(): Lang {
  try {
    return /^zh\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

export function toastBody(lang: Lang = systemLang()) {
  const minutes = IDLE_MS / 60000
  return lang === 'zh' ? `空闲 ${minutes} 分钟，已自动压缩` : `Idle for ${minutes} min, compacted`
}

// The desktop app draws none of a plugin's UI, so a finished idle compaction
// is announced with a Windows balloon drawn by the script shipped next to
// this module. Elsewhere powershell.exe is missing and the call fails quietly.
async function toast($: EngineInterface) {
  try {
    const cwd = await $.session.cwd()
    const title = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Claude Code'
    const script = `${$.plugin.root}/hooks/toast.ps1`
    const argv = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
    argv.push('-Title', encodeURIComponent(title), '-Body', encodeURIComponent(toastBody()))
    // Not awaited: the script keeps its balloon up for six seconds.
    void $.process.run(argv).catch(() => undefined)
  } catch {}
}

function isCompacted(result: unknown) {
  return result !== undefined && (result as { skip?: string }).skip === undefined
}

// Debug log only (--debug / --debug-file): never shown to the person.
async function log($: EngineInterface, text: string) {
  try {
    await $.ui.log(`idle-compact: ${text}`, { to: 'debug' })
  } catch {}
}

// Shown in the conversation and kept in the transcript, never sent to the model.
async function notice($: EngineInterface, text: string) {
  try {
    await $.ui.log(text, { to: 'transcript' })
  } catch {}
}

// Local wall-clock time, HH:MM.
function clockTime(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

type CompactUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// How much of the summary call's input came from the prompt cache. The host
// leaves `usage` out when it has none (all zero, or a precomputed summary).
export function cacheHitLine(result: unknown): string | null {
  const usage = (result as { usage?: CompactUsage } | undefined)?.usage
  if (usage === undefined) return null
  const read = usage.cache_read_input_tokens ?? 0
  const written = usage.cache_creation_input_tokens ?? 0
  const uncached = usage.input_tokens ?? 0
  const total = read + written + uncached
  if (total === 0) return null
  const n = (x: number) => x.toLocaleString('en-US')
  // Integer math: (29 / 50) * 100 is 57.99..., which would floor to 57.
  const percent = Math.floor((read * 100) / total)
  return `compacted with a ${percent}% cache hit (${n(read)} read, ${n(written)} written, ${n(uncached)} uncached)`
}

// The label the prompt footer's mode list shows while a timer is armed
// (SessionMode: terminal and desktop), so every conversation says when.
export function modeLabel(state: Pick<State, 'armed'>, lang: Lang = systemLang()) {
  if (state.armed === null) return null
  const at = clockTime(state.armed.armedAt + IDLE_MS)
  return lang === 'zh' ? `${at} 自动压缩` : `compacts ${at}`
}

function redraw($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {}
}

function cancel(state: State) {
  state.generation++
  state.armed?.timer.cancel()
  state.armed = null
}

async function arm($: EngineInterface, state: State) {
  cancel(state)
  const generation = state.generation
  const armedAt = await $.clock.now()
  const sessionId = await $.session.id()
  if (state.generation !== generation) return
  const timer = $.clock.after(IDLE_MS, () => void fire($, state, generation))
  state.armed = { generation, timer, sessionId, armedAt }
  redraw($)
  // Issued before any further await, so it never announces a timer a turn has
  // just cancelled.
  await notice($, `compacts at ${clockTime(armedAt + IDLE_MS)} if nothing happens before then`)
  await log($, `armed at ${new Date(armedAt).toISOString()}`)
}

// Compacts directly, or on a headless host queues /compact, which runs as a
// turn of its own once the session is idle. That turn never re-arms.
async function compact($: EngineInterface, state: State) {
  try {
    return await $.session.compact()
  } catch (error) {
    if (!isHeadlessRefusal(error)) throw error
  }
  await log($, 'headless session: queueing /compact')
  state.queuedCompact = true
  try {
    await $.command.run({ command: 'compact' })
  } catch (error) {
    state.queuedCompact = false
    throw error
  }
  return undefined
}

async function fire($: EngineInterface, state: State, generation: number) {
  const armed = state.armed
  if (armed === null || armed.generation !== generation || state.isCompacting) return
  state.armed = null
  redraw($)
  try {
    const elapsed = (await $.clock.now()) - armed.armedAt
    const minutes = (elapsed / 60000).toFixed(1)
    if (elapsed < IDLE_MS || elapsed >= LATEST_MS) {
      await log($, `fired after ${minutes} min: outside the window, skipped`)
      return
    }
    if ((await $.session.id()) !== armed.sessionId) {
      await log($, `fired after ${minutes} min: session changed, skipped`)
      return
    }
    await log($, `fired after ${minutes} min: compacting`)
    // Checked after the last await: a turn may have started in the meantime.
    if (state.generation !== generation) return
    state.isCompacting = true
    const result = await compact($, state)
    await log($, 'compaction finished')
    if (isCompacted(result)) await toast($)
    const line = cacheHitLine(result)
    if (line !== null) await notice($, line)
  } catch (error) {
    // A running turn, DISABLE_COMPACT or a headless host: no retry, by design.
    await log($, `compaction failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    state.isCompacting = false
  }
}

export const register: Register = (on) => {
  const state: State = {
    generation: 0,
    armed: null,
    currentTurnId: null,
    isCompacting: false,
    queuedCompact: false,
    compactTurnId: null,
  }

  on('ui.render', { component: 'SessionMode' }, ($, e, next) => {
    const label = modeLabel(state)
    if (label === null || e.component !== 'SessionMode') return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  on('turn.start', ($, e, next) => {
    cancel(state)
    redraw($)
    state.currentTurnId = e.turnId
    if (state.queuedCompact) {
      state.queuedCompact = false
      const text = e.text.trim()
      if (text === '' || text.startsWith('/compact')) state.compactTurnId = e.turnId
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Main loop only (subagent runs carry agentId and raise no turn.start),
    // answered normally, and not a completion raised by our own compaction.
    if (e.turnId === state.compactTurnId) {
      // The /compact turn this plugin queued: compaction is not activity.
      state.compactTurnId = null
      state.currentTurnId = null
      return result
    }
    if (e.agentId !== undefined || e.reason !== 'answer' || state.isCompacting) return result
    if (e.turnId !== state.currentTurnId) return result
    state.currentTurnId = null
    await arm($, state)
    return result
  })

  // The person's /compact (or an automatic one) is activity too: the pending
  // timer would only compact the fresh summary again.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const isQueued = e.trigger === 'manual' && (state.queuedCompact || state.compactTurnId !== null)
    if (e.trigger === 'manual' || e.trigger === 'auto') {
      cancel(state)
      redraw($)
    }
    const result = await next(e)
    if (isQueued) {
      state.queuedCompact = false
      if (isCompacted(result)) await toast($)
      const line = cacheHitLine(result)
      if (line !== null) await notice($, line)
    }
    return result
  })

  on('session.end', ($, e, next) => {
    cancel(state)
    redraw($)
    state.currentTurnId = null
    return next(e)
  })
}
