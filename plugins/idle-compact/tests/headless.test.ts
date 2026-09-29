import { describe, expect, test } from 'claude-code/testing'
import { isHeadlessRefusal, modeLabel, register, toastBody } from '../hooks/idle-compact.ts'

// The engine's own test kit skips a hook that throws, so it cannot make
// $.session.compact reject the way a headless host does. This drives the
// plugin's hooks directly with a minimal fake $ instead.
const MIN = 60 * 1000
const HEADLESS =
  'not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on'

type Hook = ($: unknown, e: any, next: (e: unknown) => Promise<unknown>) => unknown

function harness(opts: { refusal?: string } = {}) {
  let now = 1_700_000_000_000
  let pending: { at: number; fn: () => void } | null = null
  const hooks: Record<string, Hook> = {}
  const commands: string[] = []
  const notices: string[] = []
  const toasts: string[][] = []
  let compacts = 0
  let redraws = 0
  const $ = {
    plugin: { name: 'idle-compact', root: 'C:/plugins/idle-compact' },
    clock: {
      now: async () => now,
      after: (ms: number, fn: () => void) => {
        const timer = { at: now + ms, fn }
        pending = timer
        return { cancel: () => { if (pending === timer) pending = null } }
      },
    },
    session: {
      id: async () => 'session-a',
      cwd: async () => 'D:\\work\\my-project',
      compact: async () => {
        if (opts.refusal !== undefined) throw new Error(opts.refusal)
        compacts++
        return { messages: [] }
      },
    },
    process: {
      run: async (argv: string[]) => {
        toasts.push(argv)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    command: {
      run: async ({ command }: { command: string }) => {
        commands.push(command)
        return { text: '' }
      },
    },
    ui: {
      invalidate: () => { redraws++ },
      log: async (text: string, o: { to: string }) => {
        if (o.to === 'transcript') notices.push(text)
      },
    },
  }
  register(((event: string, ...rest: unknown[]) => {
    hooks[event] = rest[rest.length - 1] as Hook
    return { catch: () => undefined }
  }) as never, {} as never)
  const raise = (event: string, e: unknown) => hooks[event]($, e, async (x) => x) as Promise<unknown>
  let n = 0
  return {
    commands,
    notices,
    toasts,
    get compacts() { return compacts },
    async turn(text = 'hi') {
      const turnId = `turn-${++n}`
      await raise('turn.start', { text, turnId })
      await raise('turn.complete', { answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
    },
    async compactEvent(result: unknown) {
      await hooks['session.compact']($, { trigger: 'manual', messages: [] }, async () => result)
    },
    async advance(ms: number) {
      now += ms
      const timer = pending
      if (timer !== null && timer.at <= now) {
        pending = null
        timer.fn()
        for (let i = 0; i < 20; i++) await Promise.resolve()
      }
    },
    get armed() { return pending !== null },
    get redraws() { return redraws },
    async modes(modes: string[] = []) {
      const drawn = (await hooks['ui.render']($, { component: 'SessionMode', surface: 'desktop', requestId: 'r', props: { modes } }, async (x) => x)) as { props: { modes: string[] } }
      return drawn.props.modes
    },
  }
}

describe('headless fallback', () => {
  test('recognizes the engine refusal text', () => {
    expect(isHeadlessRefusal(new Error(HEADLESS))).toBe(true)
    expect(isHeadlessRefusal(new Error('compaction is switched off in this session (DISABLE_COMPACT)'))).toBe(false)
  })

  test('an interactive host compacts directly and queues nothing', async () => {
    const h = harness()
    await h.turn()
    await h.advance(50 * MIN)
    expect(h.compacts).toBe(1)
    expect(h.commands).toEqual([])
  })

  test('a headless refusal queues /compact once', async () => {
    const h = harness({ refusal: HEADLESS })
    await h.turn()
    await h.advance(50 * MIN)
    expect(h.commands).toEqual(['compact'])
    await h.advance(5 * 60 * MIN)
    expect(h.commands).toEqual(['compact'])
  })

  test('the queued /compact turn does not re-arm the timer', async () => {
    const h = harness({ refusal: HEADLESS })
    await h.turn()
    await h.advance(50 * MIN)
    await h.turn('/compact')
    expect(h.armed).toBe(false)
    await h.advance(60 * MIN)
    expect(h.commands).toEqual(['compact'])
  })

  test('a continuation turn with no text is taken as the queued /compact', async () => {
    const h = harness({ refusal: HEADLESS })
    await h.turn()
    await h.advance(50 * MIN)
    await h.turn('')
    expect(h.armed).toBe(false)
  })

  test('the next real turn after it arms again', async () => {
    const h = harness({ refusal: HEADLESS })
    await h.turn()
    await h.advance(50 * MIN)
    await h.turn('/compact')
    await h.turn('next question')
    expect(h.armed).toBe(true)
    await h.advance(50 * MIN)
    expect(h.commands).toEqual(['compact', 'compact'])
  })

  test('a typed prompt that comes first still arms', async () => {
    const h = harness({ refusal: HEADLESS })
    await h.turn()
    await h.advance(50 * MIN)
    await h.turn('something else')
    expect(h.armed).toBe(true)
  })

  test('the queued compaction without a turn of its own clears the flag and shows the cache hit', async () => {
    const h = harness({ refusal: HEADLESS })
    await h.turn()
    await h.advance(50 * MIN)
    await h.compactEvent({
      messages: [],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
    })
    expect(h.notices.at(-1)).toBe('compacted with a 90% cache hit (90 read, 0 written, 10 uncached)')
    // The flag is gone: a later empty continuation turn arms as usual.
    await h.turn('')
    expect(h.armed).toBe(true)
  })

  test('any other refusal queues nothing', async () => {
    const h = harness({ refusal: 'compaction is switched off in this session (DISABLE_COMPACT)' })
    await h.turn()
    await h.advance(50 * MIN)
    expect(h.commands).toEqual([])
  })
})

describe('footer label', () => {
  test('shows the local compaction time while armed and nothing otherwise', async () => {
    const h = harness()
    expect(await h.modes(['focus'])).toEqual(['focus'])
    await h.turn()
    const modes = await h.modes(['focus'])
    expect(modes).toHaveLength(2)
    expect(modes[0]).toBe('focus')
    expect(modes[1]).toMatch(/^(\d{2}:\d{2} 自动压缩|compacts \d{2}:\d{2})$/)
    await h.advance(50 * MIN)
    expect(await h.modes(['focus'])).toEqual(['focus'])
  })

  test('a new turn removes the label until it completes', async () => {
    const h = harness()
    await h.turn()
    const before = h.redraws
    await h.turn()
    expect(h.redraws).toBeGreaterThan(before)
    expect(await h.modes()).toHaveLength(1)
  })

  test('the label is 50 minutes after the turn completed', () => {
    const at = new Date(2026, 8, 26, 19, 53).getTime()
    expect(modeLabel({ armed: { armedAt: at } as never }, 'zh')).toBe('20:43 自动压缩')
    expect(modeLabel({ armed: { armedAt: at } as never }, 'en')).toBe('compacts 20:43')
    expect(modeLabel({ armed: null })).toBe(null)
  })
})

describe('balloon on a headless host', () => {
  test('the queued /compact announces itself once it compacted', async () => {
    const h = harness({ refusal: HEADLESS })
    await h.turn()
    await h.advance(50 * MIN)
    expect(h.toasts).toHaveLength(0)
    await h.compactEvent({ messages: [] })
    expect(h.toasts).toHaveLength(1)
    const argv = h.toasts[0]
    expect(decodeURIComponent(argv[argv.indexOf('-Title') + 1])).toBe('my-project')
    expect(argv[argv.indexOf('-File') + 1]).toBe('C:/plugins/idle-compact/hooks/toast.ps1')
    expect(decodeURIComponent(argv[argv.indexOf('-Body') + 1])).toBe(toastBody())
  })

  test('the balloon text follows the system language', () => {
    expect(toastBody('zh')).toBe('空闲 50 分钟，已自动压缩')
    expect(toastBody('en')).toBe('Idle for 50 min, compacted')
  })

  test('a vetoed compaction shows nothing', async () => {
    const h = harness({ refusal: HEADLESS })
    await h.turn()
    await h.advance(50 * MIN)
    await h.compactEvent({ skip: 'blocked' })
    expect(h.toasts).toHaveLength(0)
  })

  test('a compaction the person ran shows nothing', async () => {
    const h = harness()
    await h.compactEvent({ messages: [] })
    expect(h.toasts).toHaveLength(0)
  })
})
