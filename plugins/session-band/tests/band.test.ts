import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ConfigRow, ConfigSetInput, On, RenderElement, RenderPropsOf, SessionMeasureInput, SessionUsage, TurnCompleteInput } from 'claude-code'

import { EMPTY, GAP_MS, GIT_WAIT_MS, HOLD_MS, NO_DESK, NOTHING_HELD, RUNNING_MAX, SPLASH_MS, TALLY_MOST_MS, TALLY_WAIT_MS, TODOS_MAX, describe, durationForms, heldId, isInterrupted, limitLabel, limitShown, nextTodos, pendingWakes, phraseForms, prettyModel, runningAfter, stepDesk, stepHeld, todosAfterTurn, usingForms, whole } from '../hooks/facts'
import { bandProps as hearthProps } from '../hooks/hearth/props'
import { hearthInfo, slipAt } from '../hooks/hearth/view'
import { REPLY_MOST, lookNow, migrateMotion, offReply, parseBand, replyFor, toastFor, troubleReply, upgradeToast } from '../hooks/look'
import { bandProps as tideProps, desktopScenes, sceneMemory } from '../hooks/tide/props'
import { HEART_PARKED, HEART_SHOWN, positionAt } from '../hooks/tide/desk'
import { PARKED } from '../hooks/hearth/desk'
import { EYES, HEART_ALT, SPIN, cells, cut, lastDot, textPx } from '../hooks/clawd'
import { tideInfo } from '../hooks/tide/view'
import { CELLS, PIXELS, fitLine } from '../hooks/tide/fit'
import { article, plain } from '../hooks/tide/words'
import { firstFit, happeningForms } from '../hooks/hearth/words'
import type { Measure, Said } from '../hooks/hearth/words'
import type { Words } from '../hooks/tide/types'
import type { Activity, Info, Look, Todo } from '../types'

// The band as a whole: its two looks, the opt-out between them (/config and /band, one source of
// truth), stillness, and the one set of facts both looks read.

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const T0 = 1_000_000
const KEY = 'session-band.look'

type WorldOptions = {
  /** Read each time the band asks, so a test can change a setting mid-session. */
  settings?: Record<string, unknown>
  env?: Record<string, string>
  /** What the store holds at the start. */
  store?: Record<string, unknown>
  /** While `isBroken`, the store refuses every write (a read-only disk, say). */
  flaky?: { isBroken: boolean }
  /**
   * How /config answers a change: writes it (the default), refuses it, or answers per call. `missing`:
   * nothing answers, as where /config cannot be reached.
   */
  config?: 'write' | 'missing' | { deny: string } | ((e: ConfigSetInput) => { value: ConfigSetInput['value'] } | { deny: string })
  /** /config's rows, for `$.config.list()`; `missing`: nothing answers. */
  rows?: ConfigRow[] | 'missing'
  /**
   * git as a test steers it: while `held`, every git call waits on it; `branch` is the branch it
   * names (main by default); `status` is what `git status` says (as it stands when the call is made);
   * `fails` names a call that cannot run (a timeout, say).
   */
  git?: { held: Promise<void> | null; branch?: string; status?: string; fails?: 'status' | 'rev-parse' | null; isNoRepo?: boolean }
  /** The main loop's model, read each time the band asks, so a test can /model mid-session; `fails`: the lookup throws. */
  model?: { id: string; fails?: boolean }
  /** Lookups that throw at the start. */
  fails?: ReadonlyArray<'usage' | 'repo'>
  /** Where the clock starts (a seeded reload starts where the last activation left off). */
  now?: number
  /** What `$.session.usage()` says; by default a session 12 minutes old with nothing measured yet. */
  usage?: SessionUsage
  /** Runs while a tool runs, before it answers: a look at the band mid-call, or a wait that keeps it running. */
  onCall?: (tool: string, e: Record<string, unknown>) => Promise<void>
  /** The host refuses to register /band, or cannot read the store, at the start. */
  refuses?: ReadonlyArray<'register' | 'store'>
  /** While `isOn`, every tool fails. */
  failing?: { isOn: boolean }
}

// The engine beneath the plugin: a session in agent-plugins on branch main with two changed files.
function world(on: On, options: WorldOptions = {}) {
  const toasts: string[] = []
  // Claude Code's task ids, one after another for the session.
  let created = 0
  const sets: Array<{ key: string; value: unknown }> = []
  const flaky = options.flaky
  if (options.refuses?.includes('store')) {
    on('store.get', () => {
      throw new Error('store unavailable')
    })
    on('store.set', () => ({ value: undefined }))
  } else if (flaky === undefined) {
    mock.store(on, options.store ?? {})
  } else {
    const kept = new Map<string, unknown>(Object.entries(options.store ?? {}))
    on('store.get', ($, e) => ({ value: kept.get(e.key) }))
    on('store.set', ($, e) => {
      if (flaky.isBroken) throw new Error('read-only')
      kept.set(e.key, e.value)

      return { value: undefined }
    })
    on('store.delete', ($, e) => {
      kept.delete(e.key)

      return { value: undefined }
    })
    on('store.keys', () => ({ value: [...kept.keys()] }))
  }
  mock.env(on, options.env ?? {})
  const clock = mock.clock(on, { now: options.now ?? T0 })
  on('settings.read', () => ({ value: options.settings ?? {} }))
  on('command.register', ($, e) => {
    if (options.refuses?.includes('register')) throw new Error('commands unavailable')

    return { value: { command: e.name } }
  })
  on('session.usage', () => {
    if (options.fails?.includes('usage')) throw new Error('usage unavailable')

    return { value: options.usage ?? { startedAt: T0 - 12 * 60_000, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } } }
  })
  on('session.model', () => {
    if (options.model?.fails === true) throw new Error('model unavailable')

    return { value: options.model?.id ?? 'claude-opus-5-5[1m]' }
  })
  on('session.repo', () => {
    if (options.fails?.includes('repo')) throw new Error('repo lookup failed')

    return { value: { root: '/work/agent-plugins', remote: null, internal: false, name: null } }
  })
  on('process.run', async ($, e) => {
    const status = options.git?.status ?? ' M README.md\n?? notes.md\n'
    const fails = options.git?.fails ?? null
    if (options.git?.held) await options.git.held
    if (fails !== null && e.argv.includes(fails)) throw new Error(`git ${fails} timed out`)
    if (options.git?.isNoRepo === true) {
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    return {
      value: {
        exitCode: 0,
        stdout: e.argv.includes('rev-parse') ? `${options.git?.branch ?? 'main'}\n` : status,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', async ($, e) => {
    await options.onCall?.(String(e.tool), e as Record<string, unknown>)
    if (options.failing?.isOn === true) {
      return { result: { stdout: '', stderr: 'boom' }, isError: true, text: 'boom' }
    }
    if (e.tool === 'Bash' && String(e.command).includes('fail')) {
      return { result: { stdout: '', stderr: 'boom' }, isError: true, text: 'boom' }
    }
    // A subagent whose work goes wrong.
    if (e.tool === 'Agent' && String(e.prompt).includes('fail')) {
      return { result: { stdout: '', stderr: 'boom' }, isError: true, text: 'boom' }
    }
    // A command Esc cut while it ran: an error whose text is the abort's own, as the model reads it.
    if (e.tool === 'Bash' && String(e.command).includes('interrupted')) {
      return { result: '[Request interrupted by user for tool use]', isError: true, text: '[Request interrupted by user for tool use]' }
    }
    // A skill that goes wrong, and a question the person waves off (an error, as Claude Code reports
    // it); and any of Claude Code's own tools with nothing to name.
    if ((e.tool === 'Skill' || e.tool === 'AskUserQuestion' || PLUMBING.has(String(e.tool))) && JSON.stringify(e).includes('fail')) {
      return { result: 'no', isError: true, text: 'no' }
    }
    // A command the person said no to: refused, never run, and no failure of Claude's.
    if (e.tool === 'Bash' && String(e.command).includes('refused')) {
      return { deny: 'The person declined this command.' }
    }
    if (e.tool === 'TaskCreate') {
      created += 1
      return { result: { task: { id: String(created), subject: String(e.subject) } } }
    }

    return { result: { ok: true } }
  })
  const config = options.config ?? 'write'
  if (config !== 'missing') {
    on('config.set', ($, e) => {
      sets.push({ key: e.key, value: e.value })
      if (typeof config === 'function') {
        return config(e)
      }

      return config === 'write' ? { value: e.value } : config
    })
  }
  const rows = options.rows ?? []
  if (rows !== 'missing') {
    on('config.list', () => ({ value: rows }))
  }

  return { toasts, sets, clock }
}

function measured(percent: number, usd = 0.31): SessionMeasureInput {
  return {
    context: { tokens: percent * 2000, window: 200_000, percent },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: new Date(T0 + 130 * 60_000).toISOString() }],
    cost: { usd },
    changed: ['context', 'cost', 'rateLimits'],
  }
}

async function start($: Engine, percent = 42): Promise<void> {
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  await $.session.measure(measured(percent))
}

async function turn($: Engine, ending: Partial<TurnCompleteInput> = {}): Promise<void> {
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', reason: 'answer', isAborted: false, ...ending } as TurnCompleteInput)
}

async function run($: Engine, args = '') {
  const ran = await $.command.run({ command: 'band', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  return ran.text ?? ''
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function textOf(node: unknown): string {
  return typeof node === 'string' ? node : ((node as Node | null)?.children ?? []).map(textOf).join('')
}

// Every outermost Text: one per drawn row (terminal) or line (desktop).
function rows(node: unknown): string[] {
  if (node === null || typeof node !== 'object') {
    return []
  }
  const el = node as Node

  return el.type === 'Text' ? [textOf(el)] : (el.children ?? []).flatMap(rows)
}

function svgOf(node: unknown): { source: string; alt: string } | null {
  if (node === null || typeof node !== 'object') {
    return null
  }
  const el = node as Node
  if (el.type === 'Svg') {
    return { source: String(el.props?.source), alt: String(el.props?.alt) }
  }
  for (const child of el.children ?? []) {
    const found = svgOf(child)
    if (found !== null) return found
  }

  return null
}

type Seen = { look: Look | null; key: string | null; module: string | null; tree: RenderElement; rows: string[]; text: string; source: string; alt: string }

// The band on a surface, whichever look it wears. On the terminal it reads inside the Client.
async function mount($: Engine, surface: Surface, props = BAND) {
  const ui = await $.ui.mount({ plugin: 'session-band', surface, component: 'AbovePrompt', props })
  let sized: string | null = null
  const client = async () => (await ui.findAll({ type: 'Client' }))[0]
  const look = async (): Promise<Seen> => {
    const top = await ui.drawn()
    const found = await client()
    const key = found?.key ?? null
    if (surface === 'terminal' && key !== null && key !== sized) {
      sized = key
      await ui.resize({ columns: props.bodyColumns, rows: 3, in: key })
    }
    const tree = surface === 'terminal' && key !== null ? await ui.drawn({ in: key }) : top
    const svg = svgOf(top)
    const source = svg?.source ?? ''
    const drawn: Look | null =
      key === 'band' || source.includes('data-tide=') ? 'tide' : key === 'hearth' || source.includes('hh-') ? 'hearth' : null

    return {
      look: drawn,
      key,
      module: found === undefined ? null : String(found.props.module),
      tree,
      rows: rows(tree),
      text: rows(tree).join('\n'),
      source,
      alt: svg?.alt ?? '',
    }
  }
  // Time on the terminal band's own frame clock, a tick at a time.
  const wait = async (ms: number) => {
    if (surface === 'terminal' && sized !== null) {
      for (let left = ms; left > 0; left -= 250) await ui.advance(Math.min(250, left))
    }
  }

  return { ui, look, wait }
}

for (const surface of SURFACES) {
  test(`${surface}: the beach is the look out of the box`, async ($, on) => {
    world(on)
    await start($)
    const { look } = await mount($, surface)
    const seen = await look()

    expect(seen.look).toBe('tide')
    if (surface === 'terminal') {
      expect([seen.key, seen.module]).toEqual(['band', 'hooks/tide/band.tsx'])
      expect(seen.rows.slice(0, 3).length).toBe(3)
    } else {
      expect(seen.source).toContain('data-tide=')
      expect(seen.source).not.toContain('hh-')
    }
  })

  test(`${surface}: look: hearth in /config draws the hearth`, { options: { look: 'hearth' } }, async ($, on) => {
    world(on)
    await start($)
    const seen = await (await mount($, surface)).look()

    expect(seen.look).toBe('hearth')
    if (surface === 'terminal') {
      expect([seen.key, seen.module]).toEqual(['hearth', 'hooks/hearth/band.tsx'])
    } else {
      expect(seen.source).toContain('hh-')
      expect(seen.source).not.toContain('data-tide=')
    }
  })

  test(`${surface}: /band hearth saves the look through /config and the band switches at once`, async ($, on) => {
    const { sets } = world(on)
    await start($)
    const { look } = await mount($, surface)
    expect((await look()).look).toBe('tide')

    expect(await run($, 'hearth')).toBe('Hearth. Clawd blinks and cheers. /band tide to switch back.')
    expect(sets).toEqual([{ key: KEY, value: 'hearth' }])
    expect((await look()).look).toBe('hearth')

    // And back: the beach returns, through /config again.
    expect(await run($, 'tide')).toBe('Tide. Waves lap the shore. /band hearth to switch back.')
    expect(sets).toEqual([
      { key: KEY, value: 'hearth' },
      { key: KEY, value: 'tide' },
    ])
    expect((await look()).look).toBe('tide')
  })

  test(`${surface}: /band still and /band lively change only the motion, on both looks, and a new session remembers`, { timeoutMs: 30_000 }, async ($, on) => {
    const { sets } = world(on)
    await start($)
    const { look, wait } = await mount($, surface, { ...BAND, isWorking: true })
    const isMoving = async (): Promise<boolean> => {
      if (surface === 'desktop') {
        return (await look()).source.includes('infinite')
      }
      const frames = new Set<string>()
      for (let i = 0; i < 120; i++) {
        frames.add(JSON.stringify((await look()).tree))
        await wait(250)
      }

      return frames.size > 1
    }

    expect(await isMoving()).toBe(true)
    expect(await run($, 'still')).toBe('Still. The waves rest. /band lively brings them back.')
    expect(await isMoving()).toBe(false)
    expect(await run($, 'hearth')).toBe('Hearth, still. Clawd rests. /band tide to switch back.')
    expect(await isMoving()).toBe(false)
    expect(await run($, 'lively')).toBe('Lively. Clawd blinks and cheers. /band still calms him.')
    expect(await isMoving()).toBe(true)
    // Only the look went through /config.
    expect(sets).toEqual([{ key: KEY, value: 'hearth' }])

    await run($, 'still')
    await start($)
    expect(await run($)).toContain(', still.')
  })

  test(`${surface}: reduced motion keeps both looks still, and /band says why in the look's own voice`, async ($, on) => {
    world(on, { settings: { prefersReducedMotion: true } })
    await start($)
    const { look, wait } = await mount($, surface, { ...BAND, isWorking: true })
    for (const which of ['tide', 'hearth'] as const) {
      const said = await run($, `${which} lively`)
      // The tide is already on, so only the motion was asked for; the hearth is a switch.
      expect(said).toBe(
        which === 'tide'
          ? 'Lively once reduced motion is off; the waves rest till then.'
          : 'Hearth, still for reduced motion. /band tide to switch back.',
      )
      const first = await look()
      expect(first.look).toBe(which)
      await wait(20_000)
      const later = await look()
      expect(later.tree).toEqual(first.tree)
      if (surface === 'desktop') {
        // Each look's own calm: no motion at all, or motion only where the page asks for it.
        expect(/infinite/.test(first.source) && !/prefers-reduced-motion/.test(first.source)).toBe(false)
      }
    }
  })

  test(`${surface}: the four combinations draw what they promise`, { timeoutMs: 30_000 }, async ($, on) => {
    world(on)
    await start($)
    for (const style of ['tide', 'hearth', 'tide still', 'hearth still']) {
      await run($, style)
      const { ui, look, wait } = await mount($, surface, { ...BAND, isWorking: true })
      const first = await look()
      expect(first.look).toBe(style.split(' ')[0])
      if (surface === 'terminal') {
        expect(first.rows.length).toBeGreaterThanOrEqual(3)
        const frames = new Set<string>([JSON.stringify(first.tree)])
        for (let i = 0; i < 100; i++) {
          await wait(250)
          frames.add(JSON.stringify((await look()).tree))
        }
        expect([style, frames.size > 1]).toEqual([style, !style.endsWith('still')])
      } else {
        // Nothing loops when still (the beach drops its keyframes altogether; the hearth keeps only his one-off moments).
        expect([style, first.source.includes('infinite')]).toEqual([style, !style.endsWith('still')])
        if (style === 'tide still') expect(first.source).not.toContain('@keyframes')
      }
      await ui.unmount()
    }
  })
}

test('a look outside the options draws the beach', { options: { look: 'cozy' } }, async ($, on) => {
  world(on)
  await start($)
  for (const surface of SURFACES) {
    const { ui, look } = await mount($, surface)
    expect((await look()).look).toBe('tide')
    await ui.unmount()
  }
  expect(await run($)).toBe('Tide, lively. Try /band hearth, /band still or /config.')
})

test('/band alone says what is on and how to change it, in one short line, and asks /config nothing', async ($, on) => {
  const settings: Record<string, unknown> = {}
  const { sets } = world(on, { settings })
  await start($)
  const lines: string[] = []
  const status = async () => {
    const line = await run($)
    lines.push(line)

    return line
  }

  expect(await status()).toBe('Tide, lively. Try /band hearth, /band still or /config.')
  await run($, 'still')
  expect(await status()).toBe('Tide, still. Try /band hearth, /band lively or /config.')
  await run($, 'hearth')
  expect(await status()).toBe('Hearth, still. Try /band tide, /band lively or /config.')
  await run($, 'lively')
  expect(await status()).toBe('Hearth, lively. Try /band tide, /band still or /config.')
  settings.prefersReducedMotion = true
  expect(await status()).toBe('Hearth, still for reduced motion. Try /band tide or /config.')
  await run($, 'tide')
  expect(await status()).toBe('Tide, still for reduced motion. Try /band hearth or /config.')

  for (const line of lines) {
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThanOrEqual(REPLY_MOST)
  }
  // The status lines asked /config for nothing: the two calls are /band hearth and /band tide.
  expect(sets.map(set => set.value)).toEqual(['hearth', 'tide'])
})

// Reduced motion turned off between prompts: the band goes lively from the next prompt, and notes
// when (livelyAt), so the desktop's lively frame never replays a moment that began while it was still.
test('reduced motion turned off at a prompt makes the band lively from that moment, noted in the facts', async ($, on) => {
  const settings: Record<string, unknown> = { prefersReducedMotion: true }
  const { clock } = world(on, { settings })
  const facts = factsOf(on)
  await start($)
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 2_000, turnId: 't1', reason: 'answer', isAborted: false } as TurnCompleteInput)
  expect([facts().isCalm, facts().livelyAt]).toEqual([true, null])
  await clock.advance(5_000)
  settings.prefersReducedMotion = false
  const at = clock.now()
  await $.prompt.submit({ text: 'and again', wait: false, origin: { kind: 'composer' } })
  expect([facts().isCalm, facts().livelyAt]).toEqual([false, at])
  // Turned on again and off once more, a later prompt notes the later moment.
  settings.prefersReducedMotion = true
  await clock.advance(3_000)
  await $.prompt.submit({ text: 'still', wait: false, origin: { kind: 'composer' } })
  expect([facts().isCalm, facts().livelyAt]).toEqual([true, at])
  settings.prefersReducedMotion = false
  await clock.advance(3_000)
  await $.prompt.submit({ text: 'lively', wait: false, origin: { kind: 'composer' } })
  expect([facts().isCalm, facts().livelyAt]).toEqual([false, at + 6_000])
})

test('a look already on asks /config for nothing, and the reply never offers to "switch back"', { options: { look: 'hearth' } }, async ($, on) => {
  const { sets } = world(on)
  await start($)
  expect(await run($, 'hearth')).toBe('Hearth, lively. Try /band tide, /band still or /config.')
  expect(await run($, 'hearth still')).toBe('Still. Clawd rests. /band lively lets him move.')
  expect(sets).toEqual([])
})

test('lookNow: a pick from this activation wins; one from another activation is ignored', () => {
  expect(lookNow(null, 'a', undefined)).toBe('tide')
  expect(lookNow(null, 'a', 'hearth')).toBe('hearth')
  expect(lookNow(null, 'a', 'cozy')).toBe('tide')
  expect(lookNow({ look: 'hearth', activation: 'a', isSaved: true, at: 0, over: 'tide' }, 'a', 'tide')).toBe('hearth')
  expect(lookNow({ look: 'hearth', activation: 'old', isSaved: true, at: 0, over: 'tide' }, 'a', 'tide')).toBe('tide')
  // A pick /config could not save outlives a reload, for as long as /config holds the look it was picked over...
  expect(lookNow({ look: 'hearth', activation: 'old', isSaved: false, at: 0, over: 'tide' }, 'a', 'tide')).toBe('hearth')
  expect(lookNow({ look: 'hearth', activation: 'old', isSaved: false, at: 0, over: 'tide' }, 'a', undefined)).toBe('hearth')
  // ...and gives way to a change there.
  expect(lookNow({ look: 'tide', activation: 'old', isSaved: false, at: 0, over: 'tide' }, 'a', 'hearth')).toBe('hearth')
})

test('a /config change after /band wins at once, even back to the value /config already holds', async ($, on) => {
  let isReachable = false
  world(on, {
    rows: 'missing',
    config: e => {
      if (!isReachable) {
        throw new Error('/config is not there')
      }

      return { value: e.value }
    },
  })
  await start($)
  const desk = await mount($, 'desktop')

  // /config cannot be reached: the pick holds for the session alone.
  expect(await run($, 'hearth')).toBe('Hearth (session only). /config couldn\'t save it.')
  expect((await desk.look()).look).toBe('hearth')
  // Short of room, the status keeps the way to the other look, the one the person most needs.
  expect(await run($)).toBe('Hearth (session only), lively. Try /band tide.')

  // The person picks tide in /config, which already held it: the band follows them, not the old pick.
  isReachable = true
  const written = await $.config.set({
    key: KEY,
    value: 'tide',
    previous: 'tide',
    provider: { plugin: 'session-band', tier: 'user' },
    origin: { kind: 'composer' },
  })
  expect(written.value).toBe('tide')
  expect((await desk.look()).look).toBe('tide')
  expect(await run($)).toBe('Tide, lively. Try /band hearth, /band still or /config.')
})

test('with /config out of reach, /band tide is simply the default again, never "this session only"', async ($, on) => {
  const { sets } = world(on, {
    rows: 'missing',
    config: () => {
      throw new Error('/config is not there')
    },
  })
  await start($)
  const desk = await mount($, 'desktop')
  expect(await run($, 'hearth')).toBe('Hearth (session only). /config couldn\'t save it.')
  expect((await desk.look()).look).toBe('hearth')
  // Back to the look /config already gives: nothing is left for this session alone.
  expect(await run($, 'tide')).toBe('Tide. Waves lap the shore. /band hearth to switch back.')
  expect((await desk.look()).look).toBe('tide')
  expect(await run($)).toBe('Tide, lively. Try /band hearth, /band still or /config.')
  expect(sets.map(set => set.value)).toEqual(['hearth', 'tide'])
})

test('when /config refuses, the look stays and the line says why', async ($, on) => {
  const { sets } = world(on, { config: { deny: 'Locked by your organization.' } })
  await start($)
  const desk = await mount($, 'desktop')

  // What is on comes first, as short as it needs to be for the whole reply to fit the line.
  expect(await run($, 'hearth')).toBe('Tide. /config kept the look: locked by your organization.')
  expect(sets).toEqual([{ key: KEY, value: 'hearth' }])
  expect((await desk.look()).look).toBe('tide')
  // The motion asked for alongside still lands, and the reply keeps it, since it is news: here the
  // reason wraps instead.
  expect(await run($, 'hearth still')).toBe('Tide, still. /config kept the look: locked by your organization.')
  expect(await run($)).toBe('Tide, still. Try /band hearth, /band lively or /config.')
  // With off asked for too, the off note comes before the reason, and what is on gives way to the
  // look's name so the plain part keeps to the first line: a wrap only ever moves the reason.
  const off = await run($, 'hearth off')
  expect(off).toBe('Tide. /plugin turns the band off. /config kept the look: locked by your organization.')
  expect(off.slice(0, off.indexOf(': ') + 1).length).toBeLessThanOrEqual(REPLY_MOST)
})

test("/config's reason reads as the rest of the reply's sentence: its opening capital comes down, an acronym or a command keeps its case", async () => {
  // The reason as the reply quotes it, after "/config kept the look: ".
  const refused = (denied: string) => {
    const line = replyFor({ kind: 'look', look: 'tide', motion: 'lively', isCalm: false, denied })
    return line.slice(line.indexOf('/config kept the look: ') + '/config kept the look: '.length)
  }
  expect(refused('Locked by your organization.')).toBe('locked by your organization.')
  expect(refused('  Managed settings win here . ')).toBe('managed settings win here.')
  expect(refused('ID 42 is locked')).toBe('ID 42 is locked.')
  expect(refused('I cannot change this')).toBe('I cannot change this.')
  expect(refused('/config is read-only here.')).toBe('/config is read-only here.')
  expect(refused('Écrit par votre organisation')).toBe('écrit par votre organisation.')
  // The reason's own closing mark goes, whatever it is (the reply adds its stop), and a name keeps its capital.
  expect(refused('Locked by policy!')).toBe('locked by policy.')
  expect(refused('Is this locked?')).toBe('is this locked.')
  expect(refused('Claude Code manages this setting…')).toBe('Claude Code manages this setting.')
  expect(refused('Anthropic sets this')).toBe('Anthropic sets this.')
  expect(refused('GitHub manages this setting')).toBe('GitHub manages this setting.')
  expect(refused('Locked')).toBe('locked.')
})

test('where the row is keyed differently, /band finds it through /config', async ($, on) => {
  const inline = 'session-band@inline.look'
  const row: ConfigRow = {
    key: inline,
    label: 'Band look',
    kind: 'choice',
    value: 'tide',
    options: ['tide', 'hearth'],
    provider: { plugin: 'session-band@inline', tier: 'user' },
    isLocked: false,
  }
  const asked: string[] = []
  world(on, {
    rows: [row],
    config: e => {
      asked.push(e.key)
      if (e.key !== inline) {
        throw new Error(`no row ${e.key}`)
      }

      return { value: e.value }
    },
  })
  await start($)

  const said = await run($, 'hearth')
  expect(said).toBe('Hearth. Clawd blinks and cheers. /band tide to switch back.')
  expect(asked.filter(key => key === inline).length).toBe(1)
  expect(await run($)).not.toContain('this session only')
  // The row it found is the one it writes from then on.
  await run($, 'tide')
  expect(asked.slice(-1)).toEqual([inline])
})

test('/band hearth still and /band still hearth: one /config call and one motion, in either order', async ($, on) => {
  const { sets } = world(on)
  await start($)
  expect(await run($, 'hearth still')).toBe('Hearth, still. Clawd rests. /band tide to switch back.')
  expect(await run($, 'lively tide')).toBe('Tide. Waves lap the shore. /band hearth to switch back.')
  expect(await run($, '  STILL   hearth ')).toBe('Hearth, still. Clawd rests. /band tide to switch back.')
  expect(sets.map(set => set.value)).toEqual(['hearth', 'tide', 'hearth'])
})

test('unknown, doubled or clashing words change nothing and say what /band takes', async ($, on) => {
  const calm: Record<string, unknown> = { prefersReducedMotion: false }
  const { sets } = world(on, { settings: calm })
  await start($)
  expect(await run($, 'sparkly')).toBe('Try tide, hearth, still or lively, not "sparkly".')
  expect(await run($, 'tide sparkly')).toBe('Try tide, hearth, still or lively, not "sparkly".')
  expect(await run($, 'tide hearth')).toBe('One look at a time: /band tide or /band hearth.')
  expect(await run($, 'still lively')).toBe('One motion at a time: /band still or /band lively.')
  // The most natural guess for an opt-out finds what turns the band off (the plugin manager), then
  // the quietest ways the band has.
  for (const off of ['off', 'OFF', 'none', 'hide', 'disable']) {
    expect([off, await run($, off)]).toEqual([off, '/plugin turns the band off. Try /band still or /band hearth.'])
  }
  expect(await run($)).toBe('Tide, lively. Try /band hearth, /band still or /config.')
  expect(sets).toEqual([])
  // On the hearth, the plainer look is the one on screen: the reply offers only the stiller motion.
  await run($, 'hearth')
  const onHearth = await run($, 'off')
  expect(onHearth).toBe('/plugin turns the band off. Try /band still.')
  expect(onHearth.length).toBeLessThanOrEqual(REPLY_MOST)
  await run($, 'tide')
  sets.length = 0
  // Reduced motion already keeps the band still, so the reply never offers /band still, which would change nothing.
  calm.prefersReducedMotion = true
  const onCalm = await run($, 'off')
  expect(onCalm).toBe('/plugin turns the band off. Try /band hearth.')
  await run($, 'hearth')
  const onCalmHearth = await run($, 'off')
  expect(onCalmHearth).toBe('/plugin turns the band off. Reduced motion keeps it still.')
  for (const line of [onCalm, onCalmHearth]) expect(line.length).toBeLessThanOrEqual(REPLY_MOST)
  calm.prefersReducedMotion = false
  await run($, 'tide')
  sets.length = 0
  // A look (or a motion) beside the off word is a switch all the same, and the reply says what is on,
  // then how to turn the band off: "/band hearth off" is the plainer look, then the way out of the band.
  const plainer = await run($, 'hearth off')
  expect(plainer).toBe('Hearth, lively. /plugin turns the band off.')
  expect(sets.map(set => set.value)).toEqual(['hearth'])
  expect(await run($, 'off still')).toBe('Hearth, still. /plugin turns the band off.')
  await run($, 'tide lively')
  sets.length = 0
  // The same word twice is still one word.
  expect(await run($, 'still still')).toMatch(/^Still\. /u)
  // Asking what /band takes is asking what is on.
  for (const ask of ['help', '?', 'status', ' HELP ']) {
    expect(await run($, ask)).toBe('Tide, still. Try /band hearth, /band lively or /config.')
  }
  expect(sets).toEqual([])
})

// Someone who chose still and still wants less is who types /band off: the reply never offers a
// /band still the band is already in, whether the motion or reduced motion keeps it still, and a
// still hearth is as quiet as the band gets.
test('/band off never offers /band still to a band that is still already, by its motion or by reduced motion', async ($, on) => {
  const calm: Record<string, unknown> = { prefersReducedMotion: false }
  world(on, { settings: calm })
  await start($)
  expect(await run($, 'off')).toBe('/plugin turns the band off. Try /band still or /band hearth.')
  await run($, 'still')
  expect(await run($, 'off')).toBe('/plugin turns the band off. Try /band hearth.')
  await run($, 'hearth')
  expect(await run($, 'off')).toBe("/plugin turns the band off. It's as quiet as it gets.")
  await run($, 'lively')
  expect(await run($, 'off')).toBe('/plugin turns the band off. Try /band still.')
  // Reduced motion keeps the band still whatever its motion, and the reply says so.
  calm.prefersReducedMotion = true
  expect(await run($, 'off')).toBe('/plugin turns the band off. Reduced motion keeps it still.')
  await run($, 'still')
  expect(await run($, 'off')).toBe('/plugin turns the band off. Reduced motion keeps it still.')
  calm.prefersReducedMotion = false
  // The motion a new session reads back is the one the reply goes by.
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  expect(await run($, 'off')).toBe("/plugin turns the band off. It's as quiet as it gets.")
})

test("an older band's stored style becomes a motion, once, and never picks the look", async ($, on) => {
  for (const [style, motion] of [
    ['still', 'still'],
    ['hearth', 'lively'],
    ['tide', 'lively'],
    ['cozy', 'lively'],
    ['trail', 'lively'],
    ['peek', 'lively'],
    ['nonsense', 'lively'],
    [undefined, 'lively'],
  ] as const) {
    expect([style, migrateMotion(undefined, style)]).toEqual([style, motion])
  }
  expect(migrateMotion('still', 'hearth')).toBe('still')
  expect(migrateMotion('lively', 'still')).toBe('lively')

  // Only the Hearth build stored `still`, so it was the still hearth: the beach is news to them too.
  const { sets, toasts } = world(on, { store: { style: 'still' } })
  await start($)
  expect(toasts).toEqual(['The beach is the new look. /band hearth to switch back.'])
  expect(await run($)).toBe('Tide, still. Try /band hearth, /band lively or /config.')
  expect(sets).toEqual([])
})

test("a user whose older build stored the hearth's look hears once, on the first session after the upgrade, that the beach is the new look and how to go back", async ($, on) => {
  const UPGRADED = 'The beach is the new look. /band hearth to switch back.'
  const { toasts, sets } = world(on, { store: { style: 'hearth' } })
  await start($)
  expect(toasts).toEqual([UPGRADED])
  // The motion it migrated to is stored, so a reload or the next session says nothing more.
  await start($)
  await start($)
  expect(toasts).toEqual([UPGRADED])
  expect(await run($)).toBe('Tide, lively. Try /band hearth, /band still or /config.')
  expect(sets).toEqual([])

  // Only the hearth's own stored look, never landing on the hearth already, never once migrated,
  // and never when the store could not keep the motion (it would come back every session).
  expect(upgradeToast(undefined, 'hearth', 'tide')).toBe(UPGRADED)
  expect(upgradeToast(undefined, 'still', 'tide')).toBe(UPGRADED)
  for (const [motion, style, look] of [
    [undefined, 'hearth', 'hearth'],
    [undefined, 'still', 'hearth'],
    ['lively', 'hearth', 'tide'],
    [undefined, 'tide', 'tide'],
    [undefined, 'cozy', 'tide'],
    [undefined, undefined, 'tide'],
  ] as const) {
    expect([motion, style, look, upgradeToast(motion, style, look)]).toEqual([motion, style, look, null])
  }
})

test('a stored hearth look whose motion the store would not keep stays quiet, rather than saying it every session', async ($, on) => {
  const { toasts } = world(on, { store: { style: 'hearth' }, flaky: { isBroken: true } })
  await start($)
  await start($)
  expect(toasts).toEqual([])
})

test('the toast comes once per crossing, rounded, in the voice of the look on screen', async ($, on) => {
  const { toasts } = world(on)
  await start($)
  await $.session.measure(measured(86.4))
  await $.session.measure(measured(87))
  expect(toasts).toEqual(["High tide: context is 86% full. Try /compact soon."])
  // A second session.start above the line does not say it again.
  await start($, 88)
  expect(toasts.length).toBe(1)

  await $.session.measure(measured(40))
  await run($, 'hearth')
  await $.session.measure(measured(81.6))
  expect(toasts).toEqual(["High tide: context is 86% full. Try /compact soon.", "Context is 82% full. Run /compact when you're ready."])
})

test('both looks read the same facts', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.tool.call({ tool: 'TodoWrite', todos: [
    { content: 'Read the band', status: 'completed', activeForm: 'Reading the band' },
    { content: 'Draw the beach', status: 'pending', activeForm: 'Drawing the beach' },
  ] })
  await turn($)
  await clock.advance(20_000)
  const said: Record<string, string> = {}
  for (const which of ['tide', 'hearth'] as const) {
    await run($, which)
    for (const surface of SURFACES) {
      const { ui, look } = await mount($, surface, { ...BAND, bodyColumns: 140 })
      said[`${which} ${surface}`] = (await look()).text.replace(/\s+/g, ' ')
      await ui.unmount()
    }
  }
  for (const [where, text] of Object.entries(said)) {
    for (const fact of ['42%', '$0.31', 'main', '23%', 'agent-plugins', 'Opus 5.5']) {
      expect([where, fact, text.includes(fact)]).toEqual([where, fact, true])
    }
  }
  // The last turn, and the todos, the same in each look's words.
  expect(said['tide terminal']).toContain('Next up: Draw the beach')
  expect(said['hearth terminal']).toContain('Next up: Draw the beach')
  // One tally, in one wording.
  expect(said['hearth terminal']).toContain('1 of 2 done')
  expect(said['tide terminal']).toContain('Next up: Draw the beach · 1 of 2 done')
})

// The todo queued next, cut after a whole word where the band is narrow: two words at least, on both
// looks and both surfaces ("Next: Write the tests…"), never one and an ellipsis ("Next: Write…",
// "Next up: Regenerate…"), which reads as an order cut off. Narrower, what the line says with nothing
// queued.
test('the todo queued next is never cut to one word and an ellipsis, on either look or surface, at 34 to 80 columns', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  let n = 0
  for (const subject of ['Write the tests for the splash ladder', 'Regenerate the test fixtures']) {
    n += 1
    await $.tool.call({ tool: 'TodoWrite', todos: [
      { content: 'Read the band', status: 'completed', activeForm: 'Reading the band' },
      { content: subject, status: 'pending', activeForm: 'Working on it' },
    ] })
    await turn($, { turnId: `next-${n}` })
    await clock.advance(20_000)
    for (const look of ['tide', 'hearth'] as const) {
      await run($, look)
      for (const surface of SURFACES) {
        const cuts: string[] = []
        for (let columns = 34; columns <= 80; columns++) {
          const { ui, look: seen } = await mount($, surface, { ...BAND, bodyColumns: columns })
          const text = painted((await seen()).tree).replace(/\s+/gu, ' ')
          const next = /Next(?: up)?: ([^·…]+?)(…|(?= ·)|$)/u.exec(text)
          const label = [subject, look, surface, columns, next?.[0] ?? '']
          if (next !== null && next[2] === '…') {
            cuts.push(next[1] ?? '')
            expect([...label, /\s/u.test((next[1] ?? '').trim())]).toEqual([...label, true])
          }
          await ui.unmount()
        }
        // Some band narrow enough cuts it, after two words or more.
        expect([subject, look, surface, cuts.length > 0]).toEqual([subject, look, surface, true])
      }
    }
  }
})

test('a switch mid-session keeps Clawd\'s day: no second hello, no replayed cheer, three rows across it', async ($, on) => {
  const { clock } = world(on)
  await start($)
  const { look, wait } = await mount($, 'terminal')
  await clock.advance(6000)
  await wait(6000)
  // Five seconds in, the hello is over: switching to the hearth does not wave again.
  await run($, 'hearth')
  let raised = false
  for (let i = 0; i < 16; i++) {
    const seen = await look()
    expect(seen.key).toBe('hearth')
    expect(seen.rows.length).toBeGreaterThanOrEqual(3)
    raised ||= (seen.rows[0] ?? '').includes('▄')
    await wait(250)
  }
  expect(raised).toBe(false)

  // A turn, twenty quiet seconds, then back to the beach: no cheer replayed.
  await turn($)
  await clock.advance(20_000)
  await run($, 'tide')
  const after = await look()
  expect(after.key).toBe('band')
  expect(after.text).toContain('Done in 41s')
  // No sparkles beside him (the words' dim ✻ is the settled line's, as Claude Code marks a finished turn).
  expect(after.rows.slice(0, 3).join('')).not.toMatch(/[✻✽✶✢]/u)
})

test('a reload keeps the session: a napping Clawd stays asleep, and the counts carry on', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($)
  await clock.advance(4 * 60_000)
  // session.start again, as a reload may run it: the facts it keeps are kept.
  await start($)
  const desk = await mount($, 'desktop')
  expect((await desk.look()).alt).toContain('naps')
  await run($, 'hearth')
  expect((await desk.look()).source).toContain('hh-')
  expect((await desk.look()).text).toContain('Done in 41s')
})

test('older state fills in: an info with no beach facts and one with no hearth facts each draw on both looks', () => {
  const read: Activity = { id: 'r', kind: 'read', verb: 'Reading', target: 'band.tsx', what: 'Read band.tsx' }
  const { what: _what, ...noWhat } = read
  void _what
  // One older build kept no beach facts and no `what`.
  const noBeach = {
    model: 'Opus 5.5',
    project: 'agent-plugins',
    branch: 'main',
    dirty: 2,
    percent: 42,
    activity: noWhat,
    slip: null,
    held: { activity: noWhat, slip: null, at: T0 - 500 },
    lastTurn: { seconds: 41, tools: 7, files: 2, ending: 'answer' },
    todos: [],
    cheers: 1,
    oops: 0,
    isCalm: false,
    beat: 3,
  } as unknown as Partial<Info>
  // Another kept no hearth facts, `isStill` for the setting and `isError` for how a turn ended.
  const noHearth = {
    model: 'Opus 5.5',
    project: 'agent-plugins',
    percent: 86,
    turnPercent: 80,
    activity: null,
    desk: { activity: null, shownAt: 0 },
    turnWorked: true,
    woke: false,
    lastTurn: { seconds: 12, tools: 2, files: 1, isError: true },
    todos: [],
    cheers: 2,
    cheeredAt: null,
    oops: 1,
    oopsAt: null,
    oopsWhat: null,
    isStill: true,
    beat: 0,
  } as unknown as Partial<Info>
  const now = T0
  for (const stored of [noBeach, noHearth]) {
    const known = whole(stored)
    expect(Array.isArray(known.turnFiles)).toBe(true)
    expect(known.desk).toEqual(NO_DESK)
    expect(known.held.activity === null || typeof known.held.activity.what === 'string').toBe(true)
    expect(known.activity === null || typeof known.activity.what === 'string').toBe(true)
    expect(['answer', 'stopped', 'error']).toContain(known.lastTurn?.ending)
    for (const surface of SURFACES) {
      const tide = tideProps(tideInfo(known), 'lively', false, 80, 100, now)
      expect(plain(tide.words.now[0] ?? []).length).toBeGreaterThan(0)
      const hearth = hearthProps(hearthInfo(known), slipAt(known), 'lively', false, 80, 100, now, null)
      expect(hearth.lastTurn?.seconds).toBe(stored === noBeach ? 41 : 12)
    }
  }
  expect(whole(noHearth).isCalm).toBe(true)
  expect(whole(noHearth).lastTurn?.ending).toBe('error')
  expect(whole(noBeach).held.activity?.what).toBe('band.tsx')
  expect(whole(noBeach).activity?.what).toBe('band.tsx')
})

// The beach reads its wave's start only beside a failure that stands: one Esc or /clear took back
// leaves no wave to carry on, whatever start is kept.
test('the beach carries on a wave only beside a failure that stands', () => {
  const since = (stored: Partial<Info>) => tideProps(tideInfo(whole(stored)), 'lively', true, 80, 100, T0 + 1_000, null, false).sinceSplashMs
  expect(since({ oopsAt: null, splashAt: T0 })).toBe(null)
  expect(since({ oopsAt: T0, splashAt: T0 - 500 })).toBe(1_500)
  expect(since({ oopsAt: T0, splashAt: null })).toBe(1_000)
})

test('sceneMemory: a fresh activation seeded with the kept scene hands out the very same scene; an unseeded one starts afresh', () => {
  const props = (stored: Partial<Info>, isWorking: boolean) => tideProps(tideInfo(whole(stored)), 'lively', isWorking, 80, 100, T0, null, true)
  const idle = props({ lastActiveAt: T0 - 1_000 }, false)
  const working = props({ lastActiveAt: T0, isTurnOpen: true }, true)
  const first = sceneMemory()
  expect(first.settle(idle, T0).isNew).toBe(true)
  const handed = first.settle(working, T0 + 5_000)
  expect(handed.isNew).toBe(true)
  expect(typeof handed.scene.from).toBe('number')
  // As $.state keeps it: through JSON.
  const kept: unknown = JSON.parse(JSON.stringify(first.shown()))

  const seeded = sceneMemory()
  seeded.seed(kept)
  const again = seeded.settle(working, T0 + 6_000)
  expect(again.isNew).toBe(false)
  expect(again.scene).toEqual(handed.scene)
  // Seeding is once, as the beach is first drawn: a later seed never takes the memory back.
  seeded.seed(null)
  expect(seeded.settle(working, T0 + 7_000).isNew).toBe(false)

  const fresh = sceneMemory()
  const anew = fresh.settle(working, T0 + 6_000)
  expect([anew.isNew, anew.scene.from, anew.scene.sea]).toEqual([true, null, null])
  // A kept scene this build would not draw the same way is no scene at all.
  const stranger = sceneMemory()
  stranger.seed({ ...(kept as object), key: 'drawn by another build' })
  expect(stranger.settle(working, T0 + 6_000).isNew).toBe(true)
})

test('with no hiccup, the hearth desktop holds its words exactly as the beach does', () => {
  // A seeded dice, so the 500 sequences are the same every run.
  let seed = 7
  const dice = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0

    return seed % n
  }
  for (let run = 0; run < 500; run++) {
    let known: Info = { ...EMPTY }
    let time = 10_000
    for (let step = 0; step < 24; step++) {
      time += [0, 40, 60, 120, 400, 700, 760, 1000, 1600][dice(9)] ?? 0
      const roll = dice(3)
      if (roll === 0 && known.activity === null) {
        const activity: Activity = { id: `t${run}-${step}`, kind: 'read', verb: 'Reading', target: `f${step}.ts`, what: `Read f${step}.ts` }
        known = { ...known, activity }
      } else if (roll === 1 && known.activity !== null) {
        known = { ...known, activity: null, toolEndedAt: time }
      }
      const held = stepHeld(known, time)
      const shown = stepDesk(known, time)
      expect([run, step, heldId(held.held), held.held.at, held.wakeIn]).toEqual([run, step, shown.desk.activity?.id ?? '', shown.desk.shownAt, shown.wakeIn])
      known = { ...known, held: held.held, slipDue: held.slipDue, desk: shown.desk }
    }
  }
  expect([HOLD_MS, GAP_MS]).toEqual([1000, 750])
})

// Both holds, stepped as a tool's start or end (or a look again) steps them in one write.
function stepBoth(known: Info, time: number, change: Partial<Info> = {}): Info {
  const now = { ...known, ...change }
  const held = stepHeld(now, time)
  const shown = stepDesk(now, time)

  return { ...now, held: held.held, slipDue: held.slipDue, desk: shown.desk }
}

// A question answered (or a plan looked over) is a wait that is over: the line lets it go the moment
// the answer comes, on both looks, where a step of work stays through a pause shorter than 750 ms:
// never "Asking you: Auth method" for three quarters of a second after the click.
test('an answered question leaves the line at once, on both looks; a step of work stays through a short pause', () => {
  const ask: Activity = { id: 'q', kind: 'ask', verb: 'Asking you', target: 'Auth method', what: 'Ask you a question' }
  const read: Activity = { id: 'r', kind: 'read', verb: 'Reading', target: 'alpha.ts', what: 'Read alpha.ts' }
  const said = (known: Info) => [known.desk.activity?.id ?? 'thinking', heldId(known.held) || 'thinking']
  for (const [step, gone] of [[ask, ['thinking', 'thinking']], [read, ['r', 'r']]] as const) {
    let known = stepBoth({ ...EMPTY, isTurnOpen: true }, 10_000, { activity: step, running: [step] })
    expect([step.kind, said(known)]).toEqual([step.kind, [step.id, step.id]])
    known = stepBoth(known, 14_000, { activity: null, running: [], toolEndedAt: 14_000 })
    expect([step.kind, said(known)]).toEqual([step.kind, gone])
    known = stepBoth(known, 14_760)
    expect([step.kind, said(known)]).toEqual([step.kind, ['thinking', 'thinking']])
  }
})

// A question that came under another tool's second, and was answered within it, is over: the hold
// never puts it up after (it would read "Asking you: Auth method" once the answer is in).
test('a question kept off the line under another tool\'s second and answered within it is never put up after, on both looks', () => {
  const ask: Activity = { id: 'q', kind: 'ask', verb: 'Asking you', target: 'Auth method', what: 'Ask you a question' }
  const read: Activity = { id: 'r', kind: 'read', verb: 'Reading', target: 'alpha.ts', what: 'Read alpha.ts' }
  const said = (known: Info) => [known.desk.activity?.id ?? 'thinking', heldId(known.held) || 'thinking']
  let known = stepBoth({ ...EMPTY, isTurnOpen: true }, 10_000, { activity: read, running: [read] })
  known = stepBoth(known, 10_100, { activity: null, running: [], toolEndedAt: 10_100 })
  known = stepBoth(known, 10_300, { activity: ask, running: [ask] })
  expect([known.desk.next?.id, known.held.next?.id, said(known)]).toEqual(['q', 'q', ['r', 'r']])
  known = stepBoth(known, 10_600, { activity: null, running: [], toolEndedAt: 10_600 })
  for (const at of [11_000, 11_200, 11_400, 12_000]) {
    known = stepBoth(known, at)
    expect([at, said(known).includes('q')]).toEqual([at, false])
  }
})

// After a splash with nothing to hand the line on to, the dim line of what failed holds no second of
// its own: the next tool to start shows as it starts, a moment after the splash or a while after.
test('after a splash that hands the line on to nothing, the next tool to start shows at once', () => {
  const run: Activity = { id: 'r', kind: 'run', verb: '', target: 'Run the tests', what: 'Run the tests' }
  const next: Activity = { id: 'n', kind: 'read', verb: 'Reading', target: 'next.ts', what: 'Read next.ts' }
  for (const after of [10, 300, 900]) {
    // Up a second before it failed at 10 s; the splash is the line until 13 s.
    let known: Info = { ...EMPTY, isTurnOpen: true, desk: { activity: run, shownAt: 9_000, next: null }, activity: run, running: [run] }
    known = { ...known, activity: null, running: [], toolEndedAt: 10_000, oops: 1, oopsAt: 10_000, splashAt: 10_000, waves: 1, slip: run, lastSlip: run, slipDue: run }
    known = { ...known, desk: stepDesk(known, 10_000).desk }
    known = { ...known, desk: stepDesk(known, 13_000).desk }
    expect([after, known.desk.activity]).toEqual([after, null])
    known = { ...known, activity: next, running: [next], slip: null }
    expect([after, stepDesk(known, 13_000 + after).desk.activity?.id]).toEqual([after, 'n'])
  }
})

test('a tool the hold kept off the line (it started and ended under another\'s second) has its second once the hold is over, on both looks: only the latest such, never one that says what is already up, never one that failed', () => {
  const read = (id: string, file: string): Activity => ({ id, kind: 'read', verb: 'Reading', target: file, what: `Read ${file}` })
  const plan = (id: string): Activity => ({ id, kind: 'plan', verb: 'Planning', target: '', what: 'Update the todos' })
  const said = (known: Info) => [known.desk.activity?.id ?? 'thinking', heldId(known.held) || 'thinking']
  // "Thinking it over" went up at 10 s, after a tool that ended at 9.2 s.
  const thinking: Info = { ...EMPTY, isTurnOpen: true, toolEndedAt: 9_200, held: { ...NOTHING_HELD, at: 10_000 }, desk: { ...NO_DESK, shownAt: 10_000 } }
  // Two 5 ms reads inside that second: the line names the later one once the second is over, for a second.
  let known = stepBoth(thinking, 10_300, { activity: read('a', 'alpha.ts'), running: [read('a', 'alpha.ts')] })
  known = stepBoth(known, 10_305, { activity: null, running: [], toolEndedAt: 10_305 })
  known = stepBoth(known, 10_600, { activity: read('b', 'bravo.ts'), running: [read('b', 'bravo.ts')] })
  known = stepBoth(known, 10_605, { activity: null, running: [], toolEndedAt: 10_605 })
  expect(said(known)).toEqual(['thinking', 'thinking'])
  known = stepBoth(known, 11_000)
  expect(said(known)).toEqual(['b', 'b'])
  known = stepBoth(known, 11_990)
  expect(said(known)).toEqual(['b', 'b'])
  known = stepBoth(known, 12_000)
  expect(said(known)).toEqual(['thinking', 'thinking'])
  // A tool that reads as the line already does ("Planning" after "Planning") has no second of its own to wait for.
  let planning = stepBoth({ ...EMPTY, isTurnOpen: true }, 20_000, { activity: plan('p1'), running: [plan('p1')] })
  planning = stepBoth(planning, 20_000, { activity: null, running: [], toolEndedAt: 20_000 })
  planning = stepBoth(planning, 20_100, { activity: plan('p2'), running: [plan('p2')] })
  planning = stepBoth(planning, 20_100, { activity: null, running: [], toolEndedAt: 20_100 })
  planning = stepBoth(planning, 21_000)
  expect(said(planning)).toEqual(['thinking', 'thinking'])
  // One that failed under the hold is the splash's and the hiccup's, never a running line after it.
  const failing = read('f', 'gone.ts')
  let failed = stepBoth(thinking, 10_300, { activity: failing, running: [failing] })
  failed = stepBoth(failed, 10_400, { activity: null, running: [], toolEndedAt: 10_400, slip: failing, lastSlip: failing, slipDue: failing })
  expect([failed.desk.activity, failed.desk.next ?? null]).toEqual([null, null])
  failed = stepBoth(failed, 11_000)
  expect(failed.desk.activity).toBe(null)
  // Kept off the line under another tool's second, then failed: it waits on neither line any more
  // (the hearth's hiccup has its second when that one's is over, and is never a running line after it).
  const other = read('o', 'other.ts')
  let behind = stepBoth({ ...EMPTY, isTurnOpen: true }, 30_000, { activity: other, running: [other] })
  behind = stepBoth(behind, 30_100, { activity: null, running: [], toolEndedAt: 30_100 })
  behind = stepBoth(behind, 30_300, { activity: failing, running: [failing] })
  expect([behind.held.next?.id, behind.desk.next?.id]).toEqual(['f', 'f'])
  behind = stepBoth(behind, 30_400, { activity: null, running: [], toolEndedAt: 30_400, slip: failing, lastSlip: failing, slipDue: failing })
  expect([behind.held.next ?? null, behind.desk.next ?? null, heldId(behind.held)]).toEqual([null, null, 'o'])
  behind = stepBoth(behind, 31_000)
  expect([behind.held.next ?? null, heldId(behind.held), behind.held.at]).toEqual([null, 'slip f', 31_000])
  behind = stepBoth(behind, 32_000, { slipDue: null })
  expect([behind.held.next ?? null, heldId(behind.held)]).toEqual([null, 'slip f'])
})

test('a failure never waits behind the line: the beach lets a failed step\'s running words go at once, and the hearth\'s hiccup takes over at once from its own tool and from "Thinking it over"', () => {
  const run: Activity = { id: 'r', kind: 'run', verb: '', target: 'Run the tests', what: 'Run the tests' }
  const lint: Activity = { id: 'l', kind: 'run', verb: '', target: 'Lint the code', what: 'Lint the code' }
  // Shown 200 ms ago, then it fails: the beach's words let it go (the splash says what happened, then
  // what failed), and the hearth's line says it stumbled, keeping its subject.
  let known = stepBoth({ ...EMPTY, isTurnOpen: true }, 10_000, { activity: run, running: [run] })
  known = stepBoth(known, 10_200, { activity: null, running: [], toolEndedAt: 10_200, slip: run, lastSlip: run, slipDue: run })
  expect([known.desk.activity, known.desk.shownAt, known.held.slip?.id, known.held.at]).toEqual([null, 10_200, 'r', 10_200])
  // "Thinking it over" up 300 ms, and a step fails: the hiccup comes then, never 700 ms later.
  let thinking: Info = { ...EMPTY, isTurnOpen: true, toolEndedAt: 20_000, held: { ...NOTHING_HELD, at: 20_800 }, desk: { ...NO_DESK, shownAt: 20_800 } }
  thinking = stepBoth(thinking, 21_000, { activity: lint, running: [lint] })
  thinking = stepBoth(thinking, 21_100, { activity: null, running: [], toolEndedAt: 21_100, slip: lint, lastSlip: lint, slipDue: lint })
  expect([heldId(thinking.held), thinking.held.at]).toEqual(['slip l', 21_100])
})

test('describe names every tool the way both looks say it', () => {
  const call = (tool: string, input: Record<string, unknown> = {}) => describe('x', { tool, ...input })
  const said = (tool: string, input: Record<string, unknown> = {}) => {
    const { kind, verb, target, what } = call(tool, input)

    return [kind, verb, target, what]
  }
  expect(said('Read', { file_path: '/w/hooks/band.tsx' })).toEqual(['read', 'Reading', 'band.tsx', 'Read band.tsx'])
  expect(said('Edit', { file_path: '/w/a.ts' })).toEqual(['edit', 'Editing', 'a.ts', 'Edit a.ts'])
  expect(said('MultiEdit', { file_path: '/w/a.ts' })).toEqual(['edit', 'Editing', 'a.ts', 'Edit a.ts'])
  expect(said('NotebookEdit', { notebook_path: '/w/n.ipynb' })).toEqual(['edit', 'Editing', 'n.ipynb', 'Edit n.ipynb'])
  expect(said('Write', { file_path: '/w/b.ts' })).toEqual(['edit', 'Writing', 'b.ts', 'Write b.ts'])
  expect(said('Grep', { pattern: 'band' })).toEqual(['read', 'Searching for', 'band', 'Search for band'])
  expect(said('Glob', { pattern: '**/*.ts' })).toEqual(['read', 'Searching for', '**/*.ts', 'Search for **/*.ts'])
  // A page fetched is quoted with the verb its working line used ("Reading claude.ai", then
  // '"Read claude.ai" failed'), as every other tool's is.
  expect(said('WebFetch', { url: 'https://claude.ai/x' })).toEqual(['web', 'Reading', 'claude.ai', 'Read claude.ai'])
  expect(said('WebSearch', { query: 'tides' })).toEqual(['web', 'Searching the web for', 'tides', 'Search the web for tides'])
  expect(said('Agent', { description: 'Look around' })).toEqual(['other', 'Delegating', 'Look around', 'Look around'])
  expect(said('Task', {})).toEqual(['other', 'Delegating', '', 'A subagent'])
  expect(said('TodoWrite')).toEqual(['plan', 'Planning', '', 'Update the todos'])
  expect(said('TaskCreate')).toEqual(['plan', 'Planning', '', 'Update the todos'])
  expect(said('TaskUpdate')).toEqual(['plan', 'Planning', '', 'Update the todos'])
  expect(said('Bash', { command: 'npm test', description: 'Run the tests' })).toEqual(['run', '', 'Run the tests', 'Run the tests'])
  expect(said('Bash', { command: 'npm\ttest  --watch\nmore' })).toEqual(['run', 'Running', 'npm test --watch', 'npm test --watch'])
  // Looking at a folder or a notebook reads in words, as a read does: "Listing hooks", "Reading n.ipynb".
  expect(said('LS', { path: '/w/hooks/' })).toEqual(['read', 'Listing', 'hooks', 'List hooks'])
  expect(said('LS')).toEqual(['read', 'Listing', '', 'List the files'])
  expect(said('NotebookRead', { notebook_path: '/w/n.ipynb' })).toEqual(['read', 'Reading', 'n.ipynb', 'Read n.ipynb'])
  // Another server's tool in words: its server as the person named it, then what it does.
  expect(said('mcp__github__search_code')).toEqual(['other', 'Using', 'GitHub: search code', 'Use GitHub: search code'])
  // A connector's server as the person knows it, without the "claude_ai_" Claude puts before it; a
  // plugin's without its "plugin_<plugin>_"; and underscores and hyphens made spaces.
  // What another server's tool did is an order, as every other tool's is ("Use Linear: create
  // issue"), and a server named all in lower case is a name all the same ("GitHub", "Notes").
  expect(said('mcp__claude_ai_Linear__create_issue')).toEqual(['other', 'Using', 'Linear: create issue', 'Use Linear: create issue'])
  expect(said('mcp__plugin_github_github__create_pull_request')).toEqual(['other', 'Using', 'GitHub: create pull request', 'Use GitHub: create pull request'])
  expect(said('mcp__Google_Drive__search_files')).toEqual(['other', 'Using', 'Google Drive: search files', 'Use Google Drive: search files'])
  expect(said('mcp__claude_ai_Google_Drive__search-files')).toEqual(['other', 'Using', 'Google Drive: search files', 'Use Google Drive: search files'])
  expect(said('mcp__plugin_my-tools_notes__add')).toEqual(['other', 'Using', 'Notes: add', 'Use Notes: add'])
  expect(said('mcp__claude_ai__ping')[2]).toBe('Claude: ping')
  expect(said('mcp__sentry__get_issue')[2]).toBe('Sentry: get issue')
  // Claude Code's own tools, in words: a question and a plan are waits on you; a skill by its name
  // (not its plugin's); a background command looked in on or stopped; a worktree entered or left;
  // and any other its name in words, as a set phrase ("Using memory list"), never its code name.
  const asked = { questions: [{ question: 'Which?', header: 'Auth method', options: [], multiSelect: false }] }
  expect(said('AskUserQuestion', asked)).toEqual(['ask', 'Asking you', 'Auth method', 'Ask you a question'])
  expect(said('AskUserQuestion', { questions: [] })).toEqual(['ask', 'Asking you a question', '', 'Ask you a question'])
  expect(said('ExitPlanMode')).toEqual(['ask', 'Plan ready for you', '', 'Share the plan'])
  expect(said('Skill', { skill: 'plugin-authoring' })).toEqual(['other', 'Using the', 'plugin-authoring', 'Use the plugin-authoring skill'])
  expect(said('Skill', { skill: 'ms-office-suite:pdf' })).toEqual(['other', 'Using the', 'pdf', 'Use the pdf skill'])
  expect(said('Skill')).toEqual(['other', 'Using a skill', '', 'Use a skill'])
  expect(said('ToolSearch', { query: 'select:Read' })).toEqual(['other', 'Finding tools', '', 'Find tools'])
  expect(said('TaskList')).toEqual(['plan', 'Planning', '', 'Check the todos'])
  expect(said('BashOutput', { bash_id: 'b' })).toEqual(['run', 'Checking on a command', '', 'Check on a command'])
  expect(said('KillShell', { shell_id: 'b' })).toEqual(['run', 'Stopping a command', '', 'Stop a command'])
  expect(said('EnterWorktree', { name: 'tide' })).toEqual(['other', 'Entering a worktree', '', 'Enter a worktree'])
  expect(said('ExitWorktree', { action: 'keep' })).toEqual(['other', 'Leaving the worktree', '', 'Leave the worktree'])
  expect(said('memory_list')).toEqual(['other', 'Using memory list', '', 'Use memory list'])
  // A word to another agent, the schedule, a server's resources: each its own phrase.
  expect(said('SendMessage', { to: 'b', message: 'hi' })).toEqual(['other', 'Sending a message', '', 'Send a message'])
  expect(said('CronCreate')).toEqual(['other', 'Scheduling a task', '', 'Schedule a task'])
  // In US English, as Claude Code writes ("Canceling").
  expect(said('CronDelete')).toEqual(['other', 'Canceling a scheduled task', '', 'Cancel a scheduled task'])
  expect(said('CronList')).toEqual(['other', 'Checking the schedule', '', 'Check the schedule'])
  expect(said('ListMcpResourcesTool')).toEqual(['other', 'Listing resources', '', 'List resources'])
  expect(said('ReadMcpResourceTool')).toEqual(['other', 'Reading a resource', '', 'Read a resource'])
  // Any other: its name in words, an acronym said as one ("MCP"), less a "Tool" that says nothing.
  expect(said('LSP')).toEqual(['other', 'Using LSP', '', 'Use LSP'])
  expect(said('ReadMCPResource')).toEqual(['other', 'Using read MCP resource', '', 'Use read MCP resource'])
  expect(said('ReadMcpResourceDirTool')).toEqual(['other', 'Using read MCP resource dir', '', 'Use read MCP resource dir'])
  expect(said('Tool')).toEqual(['other', 'Using tool', '', 'Use tool'])
  // The narrowest band's last word on such a tool: its server, or "a tool"; never a bare "Using".
  expect(usingForms('github: search code')).toEqual(['Using github'])
  expect(usingForms('Linear: create issue')).toEqual(['Using Linear'])
  expect(usingForms('Google Drive: search files')).toEqual(['Using Google Drive', 'Using a tool'])
  expect(usingForms('LS')).toEqual(['Using a tool'])
  // A set phrase is read whole, or gives way to a shorter one that says what it is doing; never cut.
  expect(phraseForms('Using memory list')).toEqual(['Using memory list', 'Using a tool'])
  expect(phraseForms('Using a skill')).toEqual(['Using a skill', 'Using a tool'])
  expect(phraseForms('Using a tool')).toEqual(['Using a tool'])
  expect(phraseForms('Finding tools')).toEqual(['Finding tools', 'Searching'])
  // Never a bare "Entering" or "Leaving", which want their object.
  expect(phraseForms('Entering a worktree')).toEqual(['Entering a worktree', 'New worktree'])
  expect(phraseForms('Leaving the worktree')).toEqual(['Leaving the worktree', 'Leaving worktree', 'Using a tool'])
  expect(phraseForms('Planning')).toEqual(['Planning'])
  // A long undescribed command keeps its first 200 characters, with an ellipsis.
  const long = call('Bash', { command: 'x'.repeat(500) })
  expect([...long.target].length).toBe(200)
  expect(long.target.endsWith('…')).toBe(true)
})

test('another server\'s tool reads in words in both looks, and no band ever ends on a bare "Using"', { timeoutMs: 30_000 }, async ($, on) => {
  let during: (() => Promise<void>) | undefined
  world(on, { onCall: async () => during?.() })
  await start($)
  await $.prompt.submit({ text: 'file it', wait: false, origin: { kind: 'composer' } })
  for (const style of ['tide', 'hearth'] as const) {
    await run($, style)
    for (const surface of SURFACES) {
      for (const columns of [34, 36, 40, 48, 64, 100]) {
        const desk = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await desk.look()
        // A look at the band while the tool runs (the terminal's words change on its next tick).
        let seen: Awaited<ReturnType<typeof desk.look>> | undefined
        during = async () => {
          await desk.ui.redraw({ ...BAND, bodyColumns: columns, isWorking: true })
          await desk.wait(250)
          seen = await desk.look()
        }
        await $.tool.call({ tool: 'mcp__linear__create_issue', title: 'Tide' })
        during = undefined
        if (seen === undefined) throw new Error('the tool never ran')
        // The line's runs, together (the hearth's terminal sets its object in a box of its own).
        const all = seen.rows.join(' ')
        expect([style, surface, columns, all.match(/Using/gu)?.length]).toEqual([style, surface, columns, 1])
        // A server named all in lower case ("linear") is a name all the same: "Linear".
        expect([style, surface, columns, all]).toEqual([style, surface, columns, expect.stringMatching(/Using\s+(Linear|a tool)/u)])
        if (columns === 100) expect([style, surface, all]).toEqual([style, surface, expect.stringMatching(/Using\s+Linear:\s+create issue/u)])
        await desk.ui.unmount()
      }
    }
  }
})

// Another server's tool that fails: the beach quotes it as the order it was, its server whole
// ('Splash! "Use Google Drive: search files" failed'), never a bare name with no verb
// ('Splash! "Google Drive: search files" failed'); narrower, the server's tool in words ('Splash! A
// Google Drive tool failed'), never an order nobody gave ('"Use Google Drive" failed');
// the hearth names it, then its server ("Hiccup · Google Drive"), then "A tool". Never the server
// cut short, at any width.
test('another server\'s tool that fails is an order with its server whole on the beach, and its server on a narrow hearth, at every width', { timeoutMs: 60_000 }, async ($, on) => {
  const failing = { isOn: false }
  const { clock } = world(on, { failing })
  await start($)
  await $.prompt.submit({ text: 'find the doc', wait: false, origin: { kind: 'composer' } })
  const forms = {
    tide: /^Splash!(?: "Use Google Drive: search files" failed| A Google Drive tool failed| A tool failed)?$/u,
    hearth: /^Hiccup(?: · Google Drive: search files| · Google Drive| · A tool)?$/u,
  }
  for (const style of ['tide', 'hearth'] as const) {
    await run($, style)
    await clock.advance(3_000)
    failing.isOn = true
    await $.tool.call({ tool: 'mcp__claude_ai_Google_Drive__search_files', query: 'tide' } as never)
    failing.isOn = false
    for (const surface of SURFACES) {
      const seen: string[] = []
      for (let columns = 34; columns <= 100; columns++) {
        const { ui, look, wait } = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await look()
        await wait(250)
        const drawn = await look()
        const text = painted(drawn.tree).replace(/\s+/gu, ' ')
        const line = (style === 'tide' ? ((surface === 'terminal' ? drawn.rows[3] : drawn.rows[0]) ?? '') : text.slice(text.indexOf('Hiccup'))).replace(/[“”]/gu, '"').trim()
        expect([style, surface, columns, line, forms[style].test(line)]).toEqual([style, surface, columns, line, true])
        if (seen.at(-1) !== line) seen.push(line)
        await ui.unmount()
      }
      expect([style, surface, seen.at(-1)]).toEqual([style, surface, style === 'tide' ? 'Splash! "Use Google Drive: search files" failed' : 'Hiccup · Google Drive: search files'])
      if (style === 'tide') expect([surface, seen.includes('Splash! A Google Drive tool failed')]).toEqual([surface, true])
    }
    await clock.advance(3_500)
  }
})

// "A" or "An" before a server's name, as the name is said: a word by its sound, an acronym a letter
// at a time ("An MCP tool", "An SQL tool", "A GitHub tool").
test('a server\'s tool takes "A" or "An" as its name is said', () => {
  const said = (owner: string) => `${article(owner)} ${owner} tool`
  expect(['GitHub', 'Google Drive', 'Linear', 'Notion', 'Sentry', 'Unity', 'Uber', 'Ubiquiti', 'Uniswap', 'YouTube', 'Hugging Face'].map(said)).toEqual([
    'A GitHub tool', 'A Google Drive tool', 'A Linear tool', 'A Notion tool', 'A Sentry tool', 'A Unity tool', 'An Uber tool', 'A Ubiquiti tool', 'A Uniswap tool', 'A YouTube tool', 'A Hugging Face tool',
  ])
  expect(['Asana', 'Atlassian', 'Outlook', 'Intercom', 'Excel', 'Upstash', 'Umbrel', 'MCP', 'SQL', 'HTTP', 'AWS', 'NPM', 'FTP', 'GCP', 'XML API'].map(said)).toEqual([
    'An Asana tool', 'An Atlassian tool', 'An Outlook tool', 'An Intercom tool', 'An Excel tool', 'An Upstash tool', 'An Umbrel tool', 'An MCP tool', 'An SQL tool', 'An HTTP tool', 'An AWS tool', 'An NPM tool', 'An FTP tool', 'A GCP tool', 'An XML API tool',
  ])
})

// Claude Code's own tools that the band once named by their code names ("Using AskUserQuestion"),
// and connectors' and plugins' tools by their servers' ("Using claude_ai_Linear"): what each says on
// the widest band, and the forms it keeps to at every width. A set phrase is never cut ("Using a
// ski…", "Finding too…", "Using enter…" at 34 columns): it is whole, or a shorter phrase
// stands in. A question for you and a plan to look over are waits on you, as "Ready" is; a phrase
// with nothing to name (Claude Code's own tool, in words) is in the quiet dim on the hearth.
const OWN_TOOLS: ReadonlyArray<{ tool: string; input: Record<string, unknown>; wide: string; narrow: RegExp; isWait?: boolean; isDim?: boolean }> = [
  {
    tool: 'AskUserQuestion',
    input: { questions: [{ question: 'Which way should sign-in go?', header: 'Auth method', options: [{ label: 'OAuth', description: 'A browser sign-in' }, { label: 'Keys', description: 'An API key' }], multiSelect: false }] },
    wide: 'Asking you: Auth method',
    // The header whole, or cut after a whole word, or gone: never "Auth met…".
    narrow: /Asking you(?:: Auth(?: method|…))?(?![\w…:])/u,
    isWait: true,
  },
  { tool: 'ExitPlanMode', input: {}, wide: 'Plan ready for you', narrow: /Plan ready/u, isWait: true },
  { tool: 'Skill', input: { skill: 'plugin-authoring' }, wide: 'Using the plugin-authoring skill', narrow: /Using (the plugin-\S* skill|a skill|a tool)(?!…)/u },
  { tool: 'Skill', input: {}, wide: 'Using a skill', narrow: /Using a (skill|tool)(?!…)/u, isDim: true },
  { tool: 'ToolSearch', input: { query: 'select:Read', max_results: 1 }, wide: 'Finding tools', narrow: /(Finding tools|Searching)(?!…)/u, isDim: true },
  { tool: 'TaskList', input: {}, wide: 'Planning', narrow: /Planning/u },
  { tool: 'TaskGet', input: { taskId: '1' }, wide: 'Planning', narrow: /Planning/u },
  { tool: 'EnterPlanMode', input: {}, wide: 'Planning', narrow: /Planning/u },
  { tool: 'TaskOutput', input: { task_id: 'b1' }, wide: 'Checking on a task', narrow: /Checking/u },
  { tool: 'BashOutput', input: { bash_id: 'b1' }, wide: 'Checking on a command', narrow: /Checking/u },
  { tool: 'KillShell', input: { shell_id: 'b1' }, wide: 'Stopping a command', narrow: /Stopping/u },
  { tool: 'TaskStop', input: { task_id: 'b1' }, wide: 'Stopping a task', narrow: /Stopping/u },
  { tool: 'EnterWorktree', input: { name: 'tide' }, wide: 'Entering a worktree', narrow: /(Entering a worktree|New worktree)(?!…)/u, isDim: true },
  { tool: 'ExitWorktree', input: { action: 'keep' }, wide: 'Leaving the worktree', narrow: /(Leaving (the )?worktree|Using a tool)(?!…)/u, isDim: true },
  { tool: 'SendMessage', input: { to: 'b', message: 'hi' }, wide: 'Sending a message', narrow: /Sending( a message)?(?!…)/u, isDim: true },
  { tool: 'CronDelete', input: { id: 'c1' }, wide: 'Canceling a scheduled task', narrow: /Canceling( a scheduled task)?(?!…)/u, isDim: true },
  { tool: 'ReadMcpResourceTool', input: { server: 'docs', uri: 'docs://a' }, wide: 'Reading a resource', narrow: /Reading( a resource)?(?!…)/u },
  { tool: 'memory_list', input: {}, wide: 'Using memory list', narrow: /Using (memory list|a tool)(?!…)/u, isDim: true },
  { tool: 'mcp__claude_ai_Linear__create_issue', input: { title: 'Tide' }, wide: 'Using Linear: create issue', narrow: /Using (Linear|a tool)(?!…)/u },
  { tool: 'mcp__plugin_github_github__create_pull_request', input: { title: 'Tide' }, wide: 'Using GitHub: create pull request', narrow: /Using (GitHub|a tool)(?!…)/u },
  { tool: 'mcp__Google_Drive__search_files', input: { query: 'tide' }, wide: 'Using Google Drive: search files', narrow: /Using (Google Drive|a tool)(?!…)/u },
]

/**
 * The terminal band's lines of words that are wider than the room the layout gives them, which Ink
 * would cut at the edge ("Using a ski…" at 34 columns): the beach's words beside it,
 * the hearth's panel lines (a line, its object in the box cut for it, and its right-hand figure).
 */
function clipped(tree: unknown): string[] {
  const out: string[] = []
  const kids = (el: Node) => (el.children ?? []).filter((child): child is Node => typeof child === 'object' && child !== null)
  const num = (value: unknown) => (typeof value === 'number' ? value : 0)
  const walk = (el: Node) => {
    const props = el.props ?? {}
    if (el.type === 'Box' && props.flexDirection === 'row' && props.height === 3 && typeof props.width === 'number') {
      // The beach: its scene, then its words in what is left of the row.
      const [beach, words] = kids(el)
      if (words !== undefined) {
        const room = props.width - num(beach?.props?.width) - num(words.props?.marginLeft)
        for (const line of rows(words)) if (cells(line) > room) out.push(line)
      }
    }
    if (el.type === 'Box' && props.flexDirection === 'column' && typeof props.width === 'number' && props.marginLeft !== undefined) {
      // The hearth's panel: each line's words and, two cells after them, its figure.
      for (const line of kids(el)) {
        const [words, right] = kids(line)
        const room = props.width - (right === undefined ? 0 : 2 + cells(textOf(right)))
        const parts = words === undefined ? [] : kids(words)
        const squeeze = parts.find(part => typeof part.props?.width === 'number')
        const used = parts.reduce((sum, part) => sum + (part === squeeze ? num(part.props?.width) : cells(textOf(part))), 0)
        // (A squeezed object cut to its box is the hearth's own cut, with Ink's ellipsis: see cutAt.)
        if (used > room) out.push(textOf(line))
      }
    }
    kids(el).forEach(walk)
  }
  walk(tree as Node)

  return out
}

// Each run of text on the band, and whether it is dim (the terminal's dim, or the theme's inactive gray).
function runsOf(node: unknown, isDim = false): Array<{ text: string; isDim: boolean }> {
  if (typeof node === 'string') {
    return [{ text: node, isDim }]
  }
  if (node === null || typeof node !== 'object') {
    return []
  }
  const el = node as Node
  const dim = isDim || (el.type === 'Text' && (el.props?.dimColor === true || el.props?.color === 'inactive'))

  return (el.children ?? []).flatMap(child => runsOf(child, dim))
}

// One test for each look on each surface: the four together run close to a minute, and on a busy
// machine past a single test's budget.
for (const style of ['tide', 'hearth'] as const) {
  for (const surface of SURFACES) {
    test(`Claude Code's own tools read in words (${style}, ${surface}), at every width: never a code name, and a question for you is a wait`, { timeoutMs: 120_000 }, async ($, on) => {
      let during: (() => Promise<void>) | undefined
      const { clock } = world(on, { onCall: async () => during?.() })
      await start($)
      await $.prompt.submit({ text: 'plan it', wait: false, origin: { kind: 'composer' } })
      // A turn that has changed something: Clawd potters (the beach) or taps along (the hearth) while Claude works.
      await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
      await run($, style)
      for (const columns of [34, 38, 44, 48, 52, 64, 80, 100, 160]) {
        const desk = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await desk.look()
        for (const one of OWN_TOOLS) {
          // The last tool's second is long over.
          await clock.advance(3_000)
          let seen: Awaited<ReturnType<typeof desk.look>> | undefined
          during = async () => {
            await desk.ui.redraw({ ...BAND, bodyColumns: columns, isWorking: true })
            // The terminal's band changes its words a second after it last did, at most.
            await desk.wait(1_250)
            seen = await desk.look()
          }
          await $.tool.call({ tool: one.tool, ...one.input } as Parameters<Engine['tool']['call']>[0])
          during = undefined
          if (seen === undefined) throw new Error('the tool never ran')
          const label = [style, surface, columns, one.tool]
          // The line's runs, together (the hearth's terminal sets its object in a box of its own).
          const all = seen.rows.join(' ').replace(/\s+/gu, ' ')
          // Never a code name: no capital inside a word ("AskUserQuestion"; a brand spelled its own
          // way, "GitHub", aside), never an underscore ("claude_ai_Linear"), and never the tool's own name.
          expect([...label, all.replace(/\bGitHub\b/gu, 'Github').match(/\p{Ll}\p{Lu}/u)?.[0] ?? null]).toEqual([...label, null])
          expect([...label, all.match(/\S*_\S*/u)?.[0] ?? null]).toEqual([...label, null])
          expect([...label, all.includes(one.tool)]).toEqual([...label, false])
          expect([...label, all]).toEqual([...label, expect.stringMatching(one.narrow)])
          // Every line fits its room: none is cut at the edge by the terminal.
          if (surface === 'terminal') expect([...label, clipped(seen.tree)]).toEqual([...label, []])
          if (columns === 160) expect([...label, all]).toEqual([...label, expect.stringContaining(one.wide)])
          if (one.isDim === true && style === 'hearth') {
            const words = runsOf(seen.tree).filter(run => one.narrow.test(run.text))
            expect([...label, words.length > 0 && words.every(run => run.isDim)]).toEqual([...label, true])
          }
          if (one.isWait === true) {
            // A wait on you reads as "Ready" does, in the quiet dim, and Clawd is at rest.
            const words = runsOf(seen.tree).filter(run => /Asking|Plan ready|Auth method/u.test(run.text))
            expect([...label, words.length > 0 && words.every(run => run.isDim)]).toEqual([...label, true])
            if (surface === 'desktop') {
              expect([...label, seen.alt]).toEqual([...label, expect.stringMatching(style === 'tide' ? /^Clawd strolls on the sand/u : /^Clawd rests\./u)])
            }
          }
        }
        await desk.ui.unmount()
      }
    })
  }
}

// A question's header is words Claude wrote for you, not a name: cut after a whole word, or left off,
// never mid-word as a name is ("Asking you: Auth met…").
test('a question\'s header is cut after a whole word, never mid-word, in both looks, on both surfaces, at every width', { timeoutMs: 60_000 }, async ($, on) => {
  let during: (() => Promise<void>) | undefined
  const { clock } = world(on, { onCall: async () => during?.() })
  await start($)
  await $.prompt.submit({ text: 'ask me', wait: false, origin: { kind: 'composer' } })
  const ask = OWN_TOOLS.find(one => one.tool === 'AskUserQuestion')
  if (ask === undefined) throw new Error('no question')
  for (const style of ['tide', 'hearth'] as const) {
    await run($, style)
    for (const surface of SURFACES) {
      const seen = new Set<string>()
      for (let columns = 34; columns <= 72; columns++) {
        const desk = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await desk.look()
        await clock.advance(3_000)
        let all = ''
        during = async () => {
          await desk.ui.redraw({ ...BAND, bodyColumns: columns, isWorking: true })
          await desk.wait(1_250)
          all = (await desk.look()).rows.join(' ').replace(/\s+/gu, ' ')
        }
        await $.tool.call({ tool: ask.tool, ...ask.input } as Parameters<Engine['tool']['call']>[0])
        during = undefined
        // The chip, and what follows it: never a letter, an ellipsis or a colon ("Auth met…", "Asking you:").
        const chip = /Asking you(?:: Auth(?: method|…))?(?![\w…:])/u.exec(all)?.[0] ?? all
        seen.add(chip)
        expect([style, surface, columns, chip]).toEqual([style, surface, columns, expect.stringMatching(/^Asking you(?:: Auth(?: method|…))?$/u)])
        await desk.ui.unmount()
      }
      // Whole where it fits, then cut after "Auth" (the hearth's terminal has room for it whole).
      const forms = style === 'hearth' && surface === 'terminal' ? ['Asking you: Auth method'] : style === 'hearth' ? ['Asking you: Auth method', 'Asking you: Auth…'] : ['Asking you', 'Asking you: Auth method', 'Asking you: Auth…']
      expect([style, surface, [...seen].sort()]).toEqual([style, surface, forms.sort()])
    }
  }
})

test('a skill that fails is named in both looks, and a question you waved off is no failure', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  const facts = factsOf(on)
  await start($)
  await $.prompt.submit({ text: 'make it', wait: false, origin: { kind: 'composer' } })
  for (const style of ['tide', 'hearth'] as const) {
    await run($, style)
    await clock.advance(3_000)
    await $.tool.call({ tool: 'Skill', skill: 'plugin-authoring', args: 'fail' })
    for (const surface of SURFACES) {
      for (const columns of [34, 48, 64, 100, 160]) {
        const { ui, look, wait } = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await look()
        await wait(250)
        const all = (await look()).rows.join(' ').replace(/\s+/gu, ' ')
        const label = [style, surface, columns]
        expect([...label, all.includes('Skill')]).toEqual([...label, false])
        if (columns >= 100) {
          const named = style === 'hearth' ? 'Hiccup · plugin-authoring skill' : surface === 'desktop' ? 'Splash! “Use the plugin-authoring skill” failed' : 'Splash! "Use the plugin-authoring skill" failed'
          expect([...label, all]).toEqual([...label, expect.stringContaining(named)])
        }
        await ui.unmount()
      }
    }
    // The person waves the question off: their answer, never a splash or a hiccup.
    await clock.advance(3_000)
    const oops = facts().oops
    await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Should it fail?', header: 'Failure', options: [{ label: 'Yes', description: 'It fails' }, { label: 'No', description: 'It does not' }], multiSelect: false }] })
    expect([style, facts().oops, facts().oopsWhat]).toEqual([style, oops, 'Use the plugin-authoring skill'])
  }
})

// Names cut on a narrow band: back to the end of a part ("a-file-that…", "docs.anthropic…"), never a
// letter or two into the next one ("a-file-t…", "docs.an…") or into an extension ("**/*.fa…"), which
// read as typos.
const PART_NAMES = [
  { call: { tool: 'Read', file_path: '/work/hooks/an-extraordinarily-long-component-file-name.tsx' }, name: 'an-extraordinarily-long-component-file-name.tsx', part: 'an-extraordinarily-long-component-file…' },
  { call: { tool: 'Read', file_path: '/work/notes/a-file-that-will-fail-to-open.ts' }, name: 'a-file-that-will-fail-to-open.ts', part: 'a-file-that-will…' },
  { call: { tool: 'WebFetch', url: 'https://docs.anthropic.com/en/docs', prompt: 'read it' }, name: 'docs.anthropic.com', part: 'docs.anthropic…' },
  { call: { tool: 'Glob', pattern: 'hooks/**/*.failing.tsx' }, name: 'hooks/**/*.failing.tsx', part: null },
] as const

/**
 * The band's text as painted: a box of a set width that hides its overflow (the hearth terminal's
 * cut name) shows what fits and Ink's ellipsis.
 */
function painted(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const el = node as Node
  const inner = (el.children ?? []).map(painted).join(el.type === 'Text' ? '' : ' ')
  const width = el.props?.width
  return el.type === 'Box' && el.props?.overflow === 'hidden' && typeof width === 'number' && cells(inner) > width ? `${cut(inner, width - 1)}…` : inner
}

/** Each cut of `name` on the band (what shows before an ellipsis) that reads as a typo: a letter or two into a new part or short of its end, or into its extension. */
function stubsOf(text: string, name: string): string[] {
  const chars = [...name]
  const dot = lastDot(name)
  const isEdge = (at: number) => /[\s/._*-]/u.test(chars[at - 1] ?? '') || (/[\p{Ll}\d]/u.test(chars[at - 1] ?? '') && /\p{Lu}/u.test(chars[at] ?? ''))
  return text.split('…').slice(0, -1).flatMap(before => {
    // The longest end of what comes before the ellipsis that starts the name.
    let shown = ''
    for (let n = Math.min(chars.length, [...before].length); n > 0; n--) {
      const tail = [...before].slice(-n).join('')
      if (name.startsWith(tail)) {
        shown = tail
        break
      }
    }
    const end = [...shown].length
    if (end < 2 || end >= chars.length) return []
    let start = end
    while (start > 0 && !isEdge(start)) start -= 1
    let stop = end
    while (stop < chars.length && !/[\s/._*-]/u.test(chars[stop] ?? '') && !isEdge(stop)) stop += 1
    const isPart = stop === end
    // A letter or two into a part, or a letter or two short of its end ("an-extraordinaril…").
    return (!isPart && ((start > 0 && end - start < 3) || stop - end < 3)) || (dot !== null && end > dot) ? [shown] : []
  })
}

// One test for each look, running and failed: the four together run past half a minute, and on a
// busy machine past a single test's budget.
for (const style of ['tide', 'hearth'] as const) {
  for (const when of ['running', 'failed'] as const) {
    test(`a name cut on a narrow band ends at the end of one of its parts, never a letter or two into the next (${style}, ${when})`, { timeoutMs: 120_000 }, async ($, on) => {
      let held: Promise<void> | null = null
      const failing = { isOn: false }
      const { clock } = world(on, { onCall: async () => held ?? undefined, failing })
      await start($)
      await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
      await run($, style)
      for (const { call, name, part } of PART_NAMES) {
        await clock.advance(3_000)
        let release: () => void = () => undefined
        held = when === 'running' ? new Promise<void>(resolve => (release = resolve)) : null
        failing.isOn = when === 'failed'
        const calling = $.tool.call(call as never)
        await clock.settle()
        if (when === 'failed') await calling
        for (const surface of SURFACES) {
          const seen = new Set<string>()
          for (let columns = 34; columns <= 160; columns += 2) {
            const { ui, look, wait } = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
            await look()
            await wait(250)
            const text = painted((await look()).tree).replace(/\s+/gu, ' ')
            seen.add(text)
            expect([style, call.tool, when, surface, columns, text, stubsOf(text, name)]).toEqual([style, call.tool, when, surface, columns, text, []])
            await ui.unmount()
          }
          if (part !== null && when === 'running') expect([style, call.tool, surface, [...seen].some(text => text.includes(part))]).toEqual([style, call.tool, surface, true])
        }
        failing.isOn = false
        release()
        await calling
      }
    })
  }
}

test('pendingWakes says what a fresh activation must arm', () => {
  const spans = { cheer: [4010, 4600], splash: [3100], flinch: [2010] }
  const base: Info = { ...EMPTY, lastActiveAt: T0 }
  // Mid nap-countdown: the nap's redraw at three quiet minutes and a second.
  expect(pendingWakes(base, T0 + 60_000, spans)).toEqual({ nap: 121_000, moments: [], hold: null })
  // Asleep already: nothing to wait for.
  expect(pendingWakes(base, T0 + 10 * 60_000, spans)).toEqual({ nap: null, moments: [], hold: null })
  // Mid-cheer: both looks' ends still to come.
  expect(pendingWakes({ ...base, cheeredAt: T0 }, T0 + 1000, spans).moments).toEqual([3010, 3600])
  // Mid-splash and mid-flinch.
  expect(pendingWakes({ ...base, oopsAt: T0, flinchAt: T0 }, T0 + 1000, spans).moments).toEqual([2100, 1010])
  // Mid-hold: a tool's words have had half their second.
  const activity: Activity = { id: 'a', kind: 'read', verb: 'Reading', target: 'a.ts', what: 'Read a.ts' }
  const holding: Info = { ...base, activity: null, toolEndedAt: T0, held: { ...NOTHING_HELD, activity, at: T0 - 500 }, desk: { activity, shownAt: T0 - 500 } }
  expect(pendingWakes(holding, T0 + 100, spans).hold).toBe(GAP_MS - 100)
  // Mid-splash on the beach, a tool running beside the one that failed: the hearth's line has nothing
  // to wait for (the tool is up), but the beach's words hand on to it as the splash ends.
  const failed: Activity = { id: 'f', kind: 'run', verb: '', target: 'Run the tests', what: 'Run the tests' }
  const splashing: Info = { ...base, activity, oopsAt: T0, lastSlip: failed, held: { ...NOTHING_HELD, activity, at: T0 - 3_000 }, desk: { activity: null, shownAt: T0, next: activity } }
  expect(pendingWakes(splashing, T0 + 1_000, spans).hold).toBe(SPLASH_MS - 1_000)
})

// Claude Code prints a command's reply after a prefix that names the plugin ("  ⎿  session-band: ",
// 19 cells), so a reply of REPLY_MOST cells is one line at 80 columns, with a cell to spare, and at
// any wider width, never a word or two left alone below it. The ellipsis counts two cells, since
// terminals differ on its width.
const PRINTED = '  \u23bf  session-band: '
const replyCells = (line: string) => cells(line) + (line.match(/\u2026/gu)?.length ?? 0)

test('every reply fits on one line after Claude Code\'s prefix at 80 columns, in the look on screen', () => {
  expect([PRINTED.length, PRINTED.length + REPLY_MOST]).toEqual([19, 79])
  const fits = (line: string) => {
    expect([line, replyCells(line) <= REPLY_MOST]).toEqual([line, true])
    expect(line).not.toContain('\n')
    // The prefix already names the plugin, so a reply never names it again ("session-band: Band: ...").
    expect([line, /^band\b/iu.test(line)]).toEqual([line, false])
    expect([line, /^[\p{Lu}/]/u.test(line), /[.]$/u.test(line)]).toEqual([line, true, true])
  }
  const looks: Look[] = ['tide', 'hearth']
  for (const look of looks) {
    for (const kind of ['status', 'look', 'motion'] as const) {
      for (const motion of ['lively', 'still'] as const) {
        for (const isCalm of [false, true]) {
          for (const isSessionOnly of [false, true]) {
            for (const isOff of [false, true]) {
              const line = replyFor({ kind, look, motion, isCalm, isSessionOnly, isOff })
              fits(line)
              expect([line, line.endsWith('/plugin turns the band off.')]).toEqual([line, isOff])
              // "Them" and "him" only after the words that say who they are ("Waves lap…", "Clawd…").
              expect([line, /^[^]*\bthem\b/u.test(line) && !/[Ww]aves\b[^]*\bthem\b/u.test(line)]).toEqual([line, false])
              expect([line, /\bhim\b/u.test(line) && !/Clawd\b[^]*\bhim\b/u.test(line)]).toEqual([line, false])
              // Each look in its own voice: the beach speaks of its waves, the hearth of Clawd.
              expect([line, /Clawd/u.test(line) && look === 'tide', /waves|[Bb]each/u.test(line) && look === 'hearth']).toEqual([line, false, false])
              // What is on comes first: the look's name, or the motion's after a motion word alone (with
              // off beside it, the reply says what is on as the status does, "Tide, still.").
              const first = kind === 'motion' && !isOff ? (motion === 'still' ? 'Still' : 'Lively') : look === 'tide' ? 'Tide' : 'Hearth'
              expect([line, line.startsWith(first)]).toEqual([line, true])
            }
          }
        }
      }
    }
    // /band off: never a /band still to a band already still, by its motion or by reduced motion.
    for (const motion of ['lively', 'still'] as const) {
      for (const isCalm of [false, true]) {
        const line = offReply(look, motion, isCalm)
        fits(line)
        expect([line, line.startsWith('/plugin turns the band off. '), line.includes('/band still')]).toEqual([line, true, motion === 'lively' && !isCalm])
      }
    }
  }
  expect(offReply('hearth', 'still', false)).toBe("/plugin turns the band off. It's as quiet as it gets.")
  expect(offReply('tide', 'still', false)).toBe('/plugin turns the band off. Try /band hearth.')
  expect(offReply('hearth', 'lively', true)).toBe('/plugin turns the band off. Reduced motion keeps it still.')
  for (const isStatus of [false, true]) fits(troubleReply(isStatus))
  // The toasts print under the plugin's name too: the upgrade note, and the context nudge up to 100%.
  fits(upgradeToast(undefined, 'hearth', 'tide') ?? '')
  for (const look of looks) for (const percent of [1, 86, 100]) fits(toastFor(look, percent))
  // A word /band does not know is the person's own: the reply says what /band takes, then quotes a
  // word of up to 18 cells whole, and cuts a longer one with an ellipsis, so it stays on one line
  // however long the word (a long pasted token, a word in a wide script).
  const longest = 'abcdefghijklmnopqr'
  const wide = '\u65e5\u672c\u8a9e\u306e\u30c6\u30b9\u30c8\u3067\u3059'
  for (const args of ['cozy', 'sparkly', longest, `${longest}s`, 'configurations', 'averylongpastedwordthatsomeonepastedin', wide, `${wide}\u306d`, 'tide hearth', 'still lively', 'calm, lively']) {
    const asked = parseBand(args)
    fits('error' in asked ? asked.error : '')
  }
  const said = (word: string) => `Try tide, hearth, still or lively, not "${word}".`
  expect(parseBand(longest)).toEqual({ error: said(longest) })
  expect(replyCells(said(longest))).toBe(REPLY_MOST)
  expect(parseBand(`${longest}s`)).toEqual({ error: said('abcdefghijklmnop\u2026') })
  expect(parseBand('Configurations')).toEqual({ error: said('configurations') })
  expect(parseBand('Incomprehensibilities')).toEqual({ error: said('incomprehensibil\u2026') })
  expect(parseBand(wide)).toEqual({ error: said(wide) })
  expect(parseBand(`${wide}\u306d`)).toEqual({ error: said('\u65e5\u672c\u8a9e\u306e\u30c6\u30b9\u30c8\u3067\u2026') })
  // A refusal quotes /config's own reason, which may run long, after the plain part: what is on,
  // and the off note when asked for, all of it within the first line. The refusal is the news, so a
  // look /config could not save before goes unmarked there.
  const refused = replyFor({ kind: 'look', look: 'tide', motion: 'still', isCalm: false, denied: 'Managed settings decide this look for everyone in your organization' })
  expect(refused.startsWith('Tide. /config kept the look: managed settings')).toBe(true)
  for (const denied of ['Locked', 'Locked by your organization.', 'Managed settings decide this look for everyone in your organization']) {
    for (const look of looks) {
      for (const motion of ['lively', 'still'] as const) {
        for (const isCalm of [false, true]) {
          for (const isOff of [false, true]) {
            for (const isSessionOnly of [false, true]) {
              for (const isMotionAsked of [false, true]) {
                const line = replyFor({ kind: 'look', look, motion, isCalm, isOff, isSessionOnly, isMotionAsked, denied })
                const plain = line.slice(0, line.indexOf('/config kept the look:') + '/config kept the look:'.length)
                expect([line, plain.length <= REPLY_MOST, plain.startsWith(look === 'tide' ? 'Tide' : 'Hearth'), plain.includes('/plugin turns the band off.'), line.includes('session only')]).toEqual([line, true, true, isOff, false])
                // The whole reply on one line whenever a shorter plain part allows it, short of leaving
                // out a motion the words asked for.
                const name = look === 'tide' ? 'Tide' : 'Hearth'
                const shortest = `${isMotionAsked ? `${name}, ${isCalm ? 'still' : motion}` : name}.${isOff ? ' /plugin turns the band off.' : ''} /config kept the look:`
                const couldFit = replyCells(`${shortest}${line.slice(plain.length)}`) <= REPLY_MOST
                expect([line, replyCells(line) <= REPLY_MOST || !couldFit]).toEqual([line, true])
              }
            }
          }
        }
      }
    }
  }
  expect(replyFor({ kind: 'look', look: 'tide', motion: 'lively', isCalm: false, denied: 'Locked' })).toBe('Tide, lively. /config kept the look: locked.')
  expect(replyFor({ kind: 'look', look: 'tide', motion: 'lively', isCalm: false, denied: 'Locked by your organization.' })).toBe('Tide. /config kept the look: locked by your organization.')
  expect(replyFor({ kind: 'look', look: 'tide', motion: 'still', isCalm: false, isMotionAsked: true, denied: 'Locked by your organization.' })).toBe('Tide, still. /config kept the look: locked by your organization.')
  expect(replyFor({ kind: 'look', look: 'hearth', motion: 'still', isCalm: true, isMotionAsked: true, denied: 'Locked' })).toBe('Hearth, still. /config kept the look: locked.')
  expect(replyFor({ kind: 'look', look: 'hearth', motion: 'lively', isCalm: false, isSessionOnly: true, isOff: true, denied: 'Locked' })).toBe('Hearth. /plugin turns the band off. /config kept the look: locked.')
  // When no form lets the whole reply fit, the shortest goes first, so the reason wraps as little as it can.
  expect(replyFor({ kind: 'look', look: 'hearth', motion: 'still', isCalm: true, isMotionAsked: true, denied: 'Locked by your organization' })).toBe('Hearth, still. /config kept the look: locked by your organization.')
  expect(replyFor({ kind: 'look', look: 'tide', motion: 'lively', isCalm: false, denied: 'Managed settings decide this look for everyone in your organization' })).toBe('Tide. /config kept the look: managed settings decide this look for everyone in your organization.')
  // A reason with no words in it leaves no colon dangling.
  for (const denied of ['', '  ', '...', '!']) {
    expect(replyFor({ kind: 'look', look: 'tide', motion: 'lively', isCalm: false, denied })).toBe('Tide, lively. /config kept the look.')
  }
  // /band still off: what is on, as the status says it, then the off note.
  expect(replyFor({ kind: 'motion', look: 'tide', motion: 'still', isCalm: false, isOff: true })).toBe('Tide, still. /plugin turns the band off.')
  expect(replyFor({ kind: 'motion', look: 'hearth', motion: 'lively', isCalm: false, isOff: true })).toBe('Hearth, lively. /plugin turns the band off.')
  expect(replyFor({ kind: 'look', look: 'hearth', motion: 'lively', isCalm: false, isOff: true })).toBe('Hearth, lively. /plugin turns the band off.')
  expect(replyFor({ kind: 'status', look: 'tide', motion: 'lively', isCalm: false, isOff: true })).toBe('Tide, lively. /plugin turns the band off.')
  // Under reduced motion, "still" gives up its reason before what is on gives up the motion.
  expect(replyFor({ kind: 'motion', look: 'hearth', motion: 'still', isCalm: true, isOff: true })).toBe('Hearth, still. /plugin turns the band off.')
  // A look /config could not save keeps the way back under reduced motion too.
  expect(replyFor({ kind: 'status', look: 'hearth', motion: 'lively', isCalm: true, isSessionOnly: true })).toBe('Hearth (session only), still. Try /band tide.')
  expect(parseBand('')).toEqual({ look: null, motion: null })
  expect(parseBand(' Hearth  STILL ')).toEqual({ look: 'hearth', motion: 'still' })
  // Lenient with what fingers add: a stray comma or full stop, a dash or two before a word.
  expect(parseBand('hearth,')).toEqual({ look: 'hearth', motion: null })
  expect(parseBand('tide, still.')).toEqual({ look: 'tide', motion: 'still' })
  expect(parseBand('hearth,lively')).toEqual({ look: 'hearth', motion: 'lively' })
  expect(parseBand('--help')).toEqual({ look: null, motion: null })
  expect(parseBand('?')).toEqual({ look: null, motion: null })
  expect(parseBand('-still')).toEqual({ look: null, motion: 'still' })
  // The words the band's replies use for its settings mean those settings: "/band still calms them".
  expect(parseBand('calm')).toEqual({ look: null, motion: 'still' })
  expect(parseBand('Quiet')).toEqual({ look: null, motion: 'still' })
  expect(parseBand('beach calm')).toEqual({ look: 'tide', motion: 'still' })
  expect(parseBand('calm lively')).toEqual({ error: 'One motion at a time: /band still or /band lively.' })
  // Two words for one setting ask for it once ("still calm", "tide beach"), and so does a word said
  // twice; a look and a motion joined as the looks are named elsewhere read as meant ("hearth-still",
  // "hearth/still", or "tide" and "still" joined by a long dash); "stop" and "pause" mean still; a
  // setting's own name alone asks which is on, and before a setting says nothing more ("/band look
  // hearth").
  expect(parseBand('still calm')).toEqual({ look: null, motion: 'still' })
  expect(parseBand('tide beach')).toEqual({ look: 'tide', motion: null })
  expect(parseBand('hearth hearth')).toEqual({ look: 'hearth', motion: null })
  expect(parseBand('hearth-still')).toEqual({ look: 'hearth', motion: 'still' })
  expect(parseBand('hearth/still')).toEqual({ look: 'hearth', motion: 'still' })
  expect(parseBand('Tide\u2014still')).toEqual({ look: 'tide', motion: 'still' })
  expect(parseBand('stop')).toEqual({ look: null, motion: 'still' })
  expect(parseBand('pause.')).toEqual({ look: null, motion: 'still' })
  expect(parseBand('look')).toEqual({ look: null, motion: null })
  expect(parseBand('Motion?')).toEqual({ look: null, motion: null })
  expect(parseBand('look hearth')).toEqual({ look: 'hearth', motion: null })
  expect(parseBand('motion: still')).toEqual({ look: null, motion: 'still' })
  expect(parseBand('calm, lively')).toEqual({ error: 'One motion at a time: /band still or /band lively.' })
  expect(parseBand('Cozy-still')).toEqual({ error: 'Try tide, hearth, still or lively, not "cozy".' })
  expect(parseBand('cozy')).toEqual({ error: 'Try tide, hearth, still or lively, not "cozy".' })
  // A word set in quotes, backticks or brackets is the word ('/band "hearth"' is never answered with
  // '""hearth""', quoted twice); the tide's old name is the tide (the tidepool); "-h" asks.
  expect(parseBand('"hearth"')).toEqual({ look: 'hearth', motion: null })
  expect(parseBand('`tide` \u201cstill\u201d')).toEqual({ look: 'tide', motion: 'still' })
  expect(parseBand("(hearth) 'lively'.")).toEqual({ look: 'hearth', motion: 'lively' })
  expect(parseBand('"cozy"')).toEqual({ error: 'Try tide, hearth, still or lively, not "cozy".' })
  expect(parseBand('[sparkly]')).toEqual({ error: 'Try tide, hearth, still or lively, not "sparkly".' })
  expect(parseBand('"?"')).toEqual({ look: null, motion: null })
  expect(parseBand('tidepool')).toEqual({ look: 'tide', motion: null })
  expect(parseBand('Tidepool, still')).toEqual({ look: 'tide', motion: 'still' })
  expect(parseBand('tide-pool')).toEqual({ look: 'tide', motion: null })
  expect(parseBand('-h')).toEqual({ look: null, motion: null })
  // Every error is a reply like the others: one line that fits after the prefix, a full stop.
  expect(parseBand('off')).toEqual({ off: true })
  expect(parseBand('hide.')).toEqual({ off: true })
  expect(parseBand('hearth off')).toEqual({ look: 'hearth', motion: null, off: true })
  expect(parseBand('off, still')).toEqual({ look: null, motion: 'still', off: true })
  expect(parseBand('off sparkly')).toEqual({ error: 'Try tide, hearth, still or lively, not "sparkly".' })
  for (const args of ['cozy', 'tide hearth', 'still lively', 'off tide', 'off hearth', 'a-very-long-word-that-someone-pasted-in']) {
    const asked = parseBand(args)
    const line = 'error' in asked ? asked.error : 'off' in asked ? offReply(args.endsWith('hearth') ? 'hearth' : 'tide', 'lively', false) : ''
    expect([args, 'off' in asked && 'look' in asked]).toEqual([args, args.startsWith('off ')])
    expect([args, /[.]$/u.test(line), replyCells(line) <= REPLY_MOST]).toEqual([args, true, true])
  }
})

// The settings as /config and the replies name them ("look=hearth"), a word in angle brackets as help
// texts write a placeholder, and the command typed twice all read as meant; something with no word in
// it is quoted back as it was typed, never cut down to a single dot.
test('/band reads "look=hearth", "<hearth>" and "/band /band hearth" as meant, and quotes "..." back whole', () => {
  const nothing = (typed: string) => `Try tide, hearth, still or lively, not "${typed}".`
  expect(parseBand('look=hearth')).toEqual({ look: 'hearth', motion: null })
  expect(parseBand('motion=lively')).toEqual({ look: null, motion: 'lively' })
  expect(parseBand('look = tide, motion = still')).toEqual({ look: 'tide', motion: 'still' })
  expect(parseBand('look:hearth')).toEqual({ look: 'hearth', motion: null })
  expect(parseBand('<hearth>')).toEqual({ look: 'hearth', motion: null })
  expect(parseBand('<tide> <still>')).toEqual({ look: 'tide', motion: 'still' })
  expect(parseBand('/band hearth')).toEqual({ look: 'hearth', motion: null })
  expect(parseBand('/band')).toEqual({ look: null, motion: null })
  expect(parseBand('...')).toEqual({ error: nothing('...') })
  expect(parseBand('!!!')).toEqual({ error: nothing('!!!') })
  expect(parseBand('hearth ...')).toEqual({ error: nothing('...') })
  // A word keeps its own name: only the punctuation around it goes.
  expect(parseBand('cozy...')).toEqual({ error: nothing('cozy') })
  expect(parseBand('<cozy>')).toEqual({ error: nothing('cozy') })
  expect(parseBand('look=cozy')).toEqual({ error: nothing('cozy') })
})

test('desktop: a look switch mid-moment never replays it: the new look starts at rest, with one new frame and none cut short', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const { ui, look } = await mount($, 'desktop')
  // Each source the desktop is handed from here, and what it shows.
  const watch = async (ms: number) => {
    const shown: string[] = []
    let last = ''
    for (let t = 0; t <= ms; t += 250) {
      const seen = await look()
      if (seen.source !== last) shown.push(seen.alt.split('. ')[0] ?? '')
      last = seen.source
      await clock.advance(250)
    }

    return shown
  }

  await turn($)
  expect((await look()).alt).toMatch(/^Clawd spins with joy/)
  await clock.advance(2000)
  // Two seconds into the beach's cheer, the hearth comes on: resting, and nothing reloads it after.
  await run($, 'hearth')
  expect(await watch(8000)).toEqual(['Clawd rests.'])
  expect((await look()).source).not.toContain('hh-mc-')

  // A cheer that begins on the hearth's watch is the hearth's own, and plays.
  await turn($, { turnId: 't2' })
  expect((await look()).alt).toBe('Clawd cheers for a finished turn.')
  await clock.advance(1000)
  // A second into it, back to the beach: Clawd at rest on the sand, no spin, and no reload after.
  await run($, 'tide')
  const back = await watch(8000)
  expect(back).toEqual(['Clawd strolls on the sand'])
  expect((await look()).source).not.toContain('spin0')

  // The same for a splash.
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  expect((await look()).alt).toMatch(/^A wave splashes Clawd/)
  await clock.advance(500)
  await run($, 'hearth')
  await clock.advance(250)
  await run($, 'tide')
  expect((await look()).alt).not.toMatch(/splash/u)
})

// /band lively during a moment: the lively frame opens at rest, as after a look switch, never
// replaying the moment from its first beat (which its end would then cut off mid-pose). Still, a
// moment is one held frame, right whenever it opens.
for (const look of ['tide', 'hearth'] as const) {
  test(`desktop, ${look}: /band still a second into a cheer, then /band lively two seconds later, opens at rest and never reloads as the cheer ends`, { timeoutMs: 30_000, options: { look } }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    const { ui, look: seen } = await mount($, 'desktop')
    await turn($)
    expect((await seen()).alt).toMatch(look === 'tide' ? /^Clawd spins with joy/u : /^Clawd cheers/u)
    await clock.advance(1_000)
    await run($, 'still')
    await clock.advance(2_000)
    await run($, 'lively')
    const lively = await seen()
    // At rest: no moment in the source (the beach's lead-in tracks, the hearth's cheer).
    expect([look, lively.alt]).toEqual([look, look === 'tide' ? expect.stringMatching(/^Clawd strolls on the sand/u) : 'Clawd rests.'])
    expect([look, /@keyframes m-|hh-mc-/u.test(lively.source)]).toEqual([look, false])
    // And nothing reloads it as the cheer ends: the frame he opened at rest in carries on.
    const sources = new Set<string>()
    for (let t = 0; t < 6_000; t += 50) {
      await clock.advance(50)
      sources.add((await seen()).source)
    }
    expect([look, sources.size, [...sources][0] === lively.source]).toEqual([look, 1, true])
    await ui.unmount()
  })
}

test('desktop: back on the beach after the hearth, a napping Clawd is simply curled by his shell, never walking home again', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($)
  await clock.advance(30_000)
  const { look } = await mount($, 'desktop')
  expect((await look()).source).toContain('@keyframes walk')
  await clock.advance(151_000)
  const homeward = (source: string) => [...(/@keyframes homeward\{(.*?)\}\}/.exec(source)?.[1] ?? '').matchAll(/translateX\((\d+)px\)/g)].map(m => Number(m[1]))
  const dozing = await look()
  expect(dozing.alt).toContain('naps')
  expect(homeward(dozing.source)[0]).toBeGreaterThan(0)
  await run($, 'hearth')
  expect((await look()).look).toBe('hearth')
  await run($, 'tide')
  const back = await look()
  expect(back.alt).toContain('naps')
  // The beach the page draws now is a new frame: he is already home, so he does not walk there again.
  expect(Math.max(0, ...homeward(back.source))).toBe(0)
})

test('under reduced motion no reply points at /band lively, which would change nothing there', () => {
  for (const look of ['tide', 'hearth'] as const) {
    for (const kind of ['status', 'look', 'motion'] as const) {
      for (const motion of ['lively', 'still'] as const) {
        const line = replyFor({ kind, look, motion, isCalm: true })
        // It names the setting that holds the band still ("lively once reduced motion is off" for a
        // lively that is stored but not yet on screen).
        expect([line, line.includes('/band lively'), /[Rr]educed[ -]motion/u.test(line)]).toEqual([line, false, true])
      }
    }
  }
})

test('a duration reads the way Claude Code says it, with a shorter form that keeps the figure whole', () => {
  expect([0, 59, 60, 61, 734, 3600, 3725].map(durationForms)).toEqual([
    ['0s'],
    ['59s'],
    ['1m'],
    ['1m 1s', '1m'],
    ['12m 14s', '12m'],
    ['1h'],
    ['1h 2m', '1h'],
  ])
})

test('a long turn reads "12m 14s" on both looks and both surfaces; a narrow band keeps the figure whole', async ($, on) => {
  const { clock } = world(on)
  await start($)
  const said = async (columns: number) => {
    const out: string[] = []
    for (const which of ['tide', 'hearth'] as const) {
      await run($, which)
      for (const surface of SURFACES) {
        const { ui, look } = await mount($, surface, { ...BAND, bodyColumns: columns })
        out.push((await look()).text.replace(/\s+/g, ' '))
        await ui.unmount()
      }
    }
    return out
  }
  await turn($, { durationMs: 734_000 })
  await clock.advance(20_000)
  for (const text of await said(140)) expect(text).toContain('Done in 12m 14s · 2 tools · 1 file changed')
  for (const text of await said(34)) {
    expect(text).toMatch(/Done in 12m( 14s)?/u)
    // Never a figure cut short ("12m 1…") or a raw count of seconds.
    expect(text).not.toMatch(/12m 1…|734s/u)
  }
  await clock.advance(4 * 60_000)
  await run($, 'tide')
  const { ui, look } = await mount($, 'terminal', { ...BAND, bodyColumns: 140 })
  expect((await look()).text).toContain('Napping · last turn took 12m 14s')
  await ui.unmount()

  await turn($, { reason: 'aborted', isAborted: true, durationMs: 95_000 })
  for (const text of await said(140)) expect(text).toContain('Stopped after 1m 35s')
  await turn($, { reason: 'error', durationMs: 3_725_000 })
  for (const text of await said(140)) expect(text).toContain('Stopped on an error after 1h 2m')
  // Narrow, the verdict shortens before the figure goes: "Error after 1h 2m", never "Stopped (error)".
  for (const text of await said(40)) {
    expect(text).toMatch(/Error after 1h( 2m)?|Stopped on an error after 1h 2m/u)
    expect(text).not.toContain('(error)')
  }
})

test('as the tide’s cheer hands over to the settled line, no word changes at any width: only the colors calm', () => {
  for (const seconds of [41, 734]) {
    const known = whole({ lastTurn: { seconds, tools: 7, files: 2, ending: 'answer' }, cheers: 1, cheeredAt: T0 - 1000 } as Partial<Info>)
    for (const surface of SURFACES) {
      const { words } = tideProps(tideInfo(known), 'lively', false, 80, 100, T0, null, surface === 'desktop')
      const measure = surface === 'desktop' ? PIXELS : CELLS
      for (let room = 4; room <= (surface === 'desktop' ? 900 : 120); room += surface === 'desktop' ? 3 : 1) {
        const cheer = plain(fitLine(words.cheer, room, measure))
        const settled = plain(fitLine(words.now, room, measure))
        expect([surface, seconds, room, settled]).toEqual([surface, seconds, room, cheer])
      }
    }
  }
})

for (const surface of SURFACES) {
  test(`${surface}: /clear in the middle of a cheer or a splash ends it with the conversation, on both looks`, async ($, on) => {
    const failing = { isOn: false }
    const { clock } = world(on, { failing })
    const facts = factsOf(on)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await start($)
    await clock.advance(10_000)
    for (const look of ['tide', 'hearth'] as const) {
      await run($, look)
      // A turn lands, and a second and a half later /clear starts a fresh conversation.
      await turn($)
      await clock.advance(1_500)
      await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
      const { ui, look: seen } = await mount($, surface)
      const after = await seen()
      expect(after.text).toContain('Ready')
      expect(after.text).not.toContain('Done')
      expect(after.alt).not.toMatch(/spins|cheer/)
      await ui.unmount()
      // A tool fails, then /clear: no splash plays on into the fresh one.
      await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
      // (A file that failed has a name to quote; a command, a word for it.)
      failing.isOn = look === 'tide'
      await $.tool.call(look === 'tide' ? { tool: 'Read', file_path: '/work/notes/missing.ts' } : { tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
      failing.isOn = false
      await $.turn.complete({ answer: '', durationMs: 2_000, turnId: 't2', reason: 'answer', isAborted: false } as TurnCompleteInput)
      await clock.advance(500)
      expect([facts().oopsName, facts().oopsNoun]).toEqual(look === 'tide' ? ['missing.ts', 'A file read'] : [null, 'A command'])
      await $.session.end({ reason: 'clear', sessionId: 's2', resume: { id: 's2' } })
      // Everything the splash knew of what failed goes with the conversation.
      // (Its wave's start too, so a band mounted in the fresh one carries on no splash of the old.)
      const { oopsAt, oopsWhat, oopsName, oopsCommand, oopsNoun, oopsPercent, splashAt } = facts()
      expect({ oopsAt, oopsWhat, oopsName, oopsCommand, oopsNoun, oopsPercent, splashAt }).toEqual({ oopsAt: null, oopsWhat: null, oopsName: null, oopsCommand: false, oopsNoun: null, oopsPercent: null, splashAt: null })
      const fresh = await mount($, surface)
      const view = await fresh.look()
      expect(view.text).not.toMatch(/Splash|failed|Hiccup|Done/)
      expect(view.alt).not.toMatch(/splash|flinch|spins|cheer/i)
      await fresh.ui.unmount()
      await clock.advance(10_000)
    }
  })
}

test('terminal: a pet or a /band lively switch landing just before a tick never makes a fifth frame in a second, on either look', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  let n = 0
  for (const which of ['tide', 'hearth'] as const) {
    for (const how of ['pet', 'lively'] as const) {
      n += 1
      await run($, `${which} ${how === 'pet' ? 'lively' : 'still'}`)
      const { ui, look } = await mount($, 'terminal')
      const key = (await look()).key ?? ''
      // Still, then lively: the hearth's cheer twinkles on, and the beach's held splash gives way to
      // him at rest on the dim line. (A beach cheer whose arms are up stays as it is: lively starts
      // no spin in it.)
      if (how === 'lively' && which === 'hearth') await turn($, { turnId: `t-${n}` })
      if (how === 'lively' && which === 'tide') {
        await $.prompt.submit({ text: 'test it', wait: false, origin: { kind: 'composer' } })
        await $.tool.call({ tool: 'Bash', command: 'npm run fail', description: 'Run the tests' })
      }
      await ui.advance(1_000)
      // Every frame change, to the 10 ms, from a second before the pet or switch to two after it,
      // which lands 10 ms before a tick (they come every 250 ms from the band's first frame).
      const changes: number[] = []
      let last = (await look()).text
      for (let at = 1_000; at <= 4_000; at += 10) {
        if (at === 2_240) {
          if (how === 'pet') await ui.pointer({ type: 'down', x: which === 'tide' ? 3 : 4, y: 1, button: 'left', in: key })
          else await run($, 'lively')
        }
        const now = (await look()).text
        if (now !== last) changes.push(at)
        last = now
        await ui.advance(10)
      }
      // It shows at once, and what follows runs on at the ticks; the next tick holds, so the frame
      // after it comes a tick and a bit later (the hearth's spin and the tide's cheer gone lively
      // change every tick: those are the seconds a fifth frame would crowd). A splash that ends
      // on its quiet line ends on a tick, never between two, so the beach's goes at the next one.
      const shown = which === 'tide' && how === 'lively' ? 2_250 : 2_240
      const next = changes.find(at => at > shown) ?? Infinity
      expect([which, how, changes.find(at => at >= 2_240), next >= 2_500]).toEqual([which, how, shown, true])
      const busiest = Math.max(...changes.map(from => changes.filter(at => at >= from && at < from + 1_000).length))
      expect([which, how, busiest <= 4]).toEqual([which, how, true])
      await ui.unmount()
    }
  }
})

test('terminal: a look switch landing just before a tick, mid-cheer, never makes a fifth frame in the second it starts, either way', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  let n = 0
  for (const [from, to] of [['hearth', 'tide'], ['tide', 'hearth']] as const) {
    n += 1
    await run($, `${from} lively`)
    const { ui, look } = await mount($, 'terminal')
    await ui.advance(1_000)
    // The turn lands a second in, so the switch comes with most of the cheer still to play: the
    // beach is mid-spin, a new frame every tick, or takes the hearth's cheer on with its arms up.
    await turn($, { turnId: `s-${n}` })
    const changes: number[] = []
    let last = (await look()).text
    for (let at = 1_000; at <= 4_000; at += 10) {
      if (at === 2_240) await run($, to)
      const seen = await look()
      if (seen.text !== last) changes.push(at)
      last = seen.text
      await ui.advance(10)
    }
    expect([from, to, (await look()).key]).toEqual([from, to, to === 'tide' ? 'band' : 'hearth'])
    // It shows at once, and the new look's next frame comes a tick and a bit later: the cheer either
    // look carries on changes no sooner than its second tick. Every second from the last frame
    // before the switch keeps to four.
    const next = changes.find(at => at > 2_240) ?? Number.POSITIVE_INFINITY
    expect([from, to, changes.includes(2_240), next >= 2_500]).toEqual([from, to, true, true])
    const before = Math.max(...changes.filter(at => at < 2_240))
    const around = changes.filter(at => at >= before)
    const busiest = Math.max(...around.map(at => around.filter(other => other >= at && other < at + 1_000).length))
    expect([from, to, busiest <= 4]).toEqual([from, to, true])
    await ui.unmount()
  }
})

// The heads of Claude Code's spin turned away from you (side-on and three-quarter): drawn only in a
// spin.
const SPIN_HEADS = SPIN.slice(1, -1).map(frame => frame[0].trim())

test('terminal: /band lively during a still cheer keeps his arms up to its end, on either look: no spin starts midway, and the finale never plays twice', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  let n = 0
  for (const look of ['tide', 'hearth'] as const) {
    for (const columns of [34, 60]) {
      for (let ticks = 1; ticks <= 8; ticks++) {
        n += 1
        await run($, `${look} still`)
        const { ui, look: seen, wait } = await mount($, 'terminal', { ...BAND, bodyColumns: columns })
        await seen()
        await wait(1_000)
        await turn($, { turnId: `l-${n}` })
        // From the tick his arms go up for the still cheer, then /band lively some ticks in.
        let film = ''
        for (let i = 0; i < 8 && !film.includes('U'); i++) {
          await wait(250)
          film += (await seen()).text.includes('▗▟') ? 'U' : '.'
        }
        await wait(250 * ticks)
        await run($, 'lively')
        film += '|'
        for (let i = 0; i < 28; i++) {
          const { text } = await seen()
          const where = [look, columns, ticks, i, text]
          expect([...where, SPIN_HEADS.filter(head => text.includes(head))]).toEqual([...where, []])
          film += text.includes('▗▟') ? 'U' : '.'
          await wait(250)
        }
        // Up from the cheer's first tick to its end, once: never down and up again.
        expect([look, columns, ticks, film, /^\.*U+\|U+\.+$/u.test(film)]).toEqual([look, columns, ticks, film, true])
        await ui.unmount()
        await clock.advance(30_000)
      }
    }
  }
})

test('terminal: back to the beach from the hearth during a cheer, he opens with his arms up (or at rest), never spinning to raise them a second time', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  let n = 0
  for (const columns of [34, 60]) {
    for (const away of [1, 3, 6, 10]) {
      for (const back of [2, 4, 8]) {
        n += 1
        await run($, 'tide lively')
        const { ui, look, wait } = await mount($, 'terminal', { ...BAND, bodyColumns: columns })
        // Time on both clocks, the facts' and the band's, a tick at a time.
        const both = async (ticks: number) => {
          for (let i = 0; i < ticks; i++) {
            await clock.advance(250)
            await wait(250)
          }
        }
        await look()
        await both(4)
        await turn($, { turnId: `b-${n}` })
        await both(away)
        await run($, 'hearth')
        await look()
        await both(back)
        await run($, 'tide')
        let film = ''
        for (let i = 0; i < 24; i++) {
          const { text, key } = await look()
          const where = [columns, away, back, i, key, text]
          expect([...where, SPIN_HEADS.filter(head => text.includes(head))]).toEqual([...where, []])
          film += text.includes('▗▟') ? 'U' : '.'
          await both(1)
        }
        // Arms up from the switch to the cheer's end, or at rest all along: up once at most. (Early in
        // the cheer, with most of it to go, up.)
        expect([columns, away, back, film, /^U*\.*$/u.test(film), away + back > 8 || film.startsWith('UUUU')]).toEqual([columns, away, back, film, true, true])
        await ui.unmount()
        await clock.advance(30_000)
      }
    }
  }
})

test('terminal: a switch to the hearth during a cheer carries it on, but never its last beat alone', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  const armsUp = (text: string) => text.includes('▗▟')
  // A second into the cheer: the hearth carries it on, arms up.
  await turn($)
  await clock.advance(1_000)
  await run($, 'hearth')
  const early = await mount($, 'terminal')
  expect((await early.look()).key).toBe('hearth')
  expect(armsUp((await early.look()).text)).toBe(true)
  await early.ui.unmount()
  // Three and a quarter seconds in, under a second and a half left: he starts at rest, and stays so.
  await run($, 'tide')
  await turn($, { turnId: 't2' })
  await clock.advance(3_250)
  await run($, 'hearth')
  const late = await mount($, 'terminal')
  for (let i = 0; i < 8; i++) {
    const seen = await late.look()
    expect(seen.key).toBe('hearth')
    expect(armsUp(seen.text)).toBe(false)
    await late.wait(250)
  }
  await late.ui.unmount()
})

test('desktop: picking the look already on in /config, mid-cheer, changes nothing on screen', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  for (const look of ['tide', 'hearth'] as const) {
    await run($, look)
    await clock.advance(10_000)
    const desk = await mount($, 'desktop')
    await turn($, { turnId: `t-${look}` })
    await clock.advance(1_000)
    const before = (await desk.look()).source
    expect(before).toMatch(look === 'tide' ? /m-spin6/ : /hh-hop/)
    await $.config.set({ key: KEY, value: look, previous: look, provider: { plugin: 'session-band', tier: 'user' }, origin: { kind: 'composer' } })
    // The same look again: it keeps the time it came on, so the cheer plays on in the same frame.
    expect((await desk.look()).source).toBe(before)
    await desk.ui.unmount()
    await clock.advance(10_000)
  }
})

test('desktop: a turn whose answer runs on a minute after its last tool still naps on time', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  for (const look of ['tide', 'hearth'] as const) {
    await run($, look)
    const desk = await mount($, 'desktop')
    await $.prompt.submit({ text: 'explain it', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    // The answer streams for a minute after the last tool.
    await clock.advance(60_000)
    await $.turn.complete({ answer: 'Here is how it works.', durationMs: 62_000, turnId: `t-${look}`, reason: 'answer', isAborted: false } as TurnCompleteInput)
    // Three minutes after the turn, with nothing else to redraw the band, he dozes off.
    await clock.advance(3 * 60_000 + 2_000)
    expect((await desk.look()).alt).toMatch(/naps|napping/)
    await desk.ui.unmount()
    // Wake the session for the next look.
    await clock.advance(1_000)
  }
})

test('/band always answers, even when the band cannot write its state', async ($, on) => {
  let isBroken = false
  let refused = 0
  world(on)
  on('state.set', ($, e, next) => {
    if (isBroken) {
      refused += 1
      return { deny: 'disk full' } as unknown as ReturnType<typeof next>
    }

    return next(e)
  })
  await start($)
  isBroken = true
  // Asked only what is on, it says so as usual: nothing it must keep stands in the way.
  expect(await run($)).toBe('Tide, lively. Try /band hearth, /band still or /config.')
  const said = await run($, 'hearth')
  expect(refused).toBeGreaterThan(0)
  expect(said).toBe("Couldn't switch just now. Try /band again in a moment.")
  expect(await run($, 'still')).toBe("Couldn't switch just now. Try /band again in a moment.")
  isBroken = false
  expect(await run($, 'hearth')).toBe('Hearth. Clawd blinks and cheers. /band tide to switch back.')
})

test('a motion the store will not keep stays for the session, through a reload', async ($, on) => {
  const flaky = { isBroken: false }
  world(on, { flaky })
  await start($)
  flaky.isBroken = true
  expect(await run($, 'still')).toBe('Still. The waves rest. /band lively brings them back.')
  // /config changes something and the plugin reloads: session.start runs again, and he stays still.
  await start($)
  expect(await run($)).toBe('Tide, still. Try /band hearth, /band lively or /config.')
  // The store takes writes again: the next reload hands it the motion, and all is as usual.
  flaky.isBroken = false
  await start($)
  expect(await run($)).toBe('Tide, still. Try /band hearth, /band lively or /config.')
  expect(await run($, 'lively')).toBe('Lively. Waves lap the shore. /band still calms them.')
  await start($)
  expect(await run($)).toBe('Tide, lively. Try /band hearth, /band still or /config.')
})

test('the limit shown is the 5h one, unless another is nearer its end and past 80%; each has its short name', () => {
  const limit = (kind: string, percentUsed: number) => ({ kind, percentUsed, resetsAt: new Date(T0).toISOString() }) as Parameters<typeof limitShown>[0][number]
  expect(limitShown([limit('five_hour', 10), limit('seven_day', 95)])?.kind).toBe('seven_day')
  expect(limitShown([limit('five_hour', 10), limit('seven_day', 60)])?.kind).toBe('five_hour')
  expect(limitShown([limit('five_hour', 90), limit('seven_day', 85)])?.kind).toBe('five_hour')
  expect(limitShown([limit('seven_day', 30)])?.kind).toBe('seven_day')
  expect(limitShown([])).toBeUndefined()
  expect(['five_hour', 'seven_day', 'spend_limit', 'seven_day_opus'].map(limitLabel)).toEqual(['5h', '7d', 'spend', 'seven day opus'])
})

test('the tide’s next todo: whole beside "Next up:", then "Next:" with its name cut at a word, then the turn as it went', () => {
  const todos = [
    { id: '1', subject: 'Read the band', activeForm: null, status: 'completed' },
    { id: '2', subject: 'Lay out the beach and its shell', activeForm: null, status: 'pending' },
    { id: '3', subject: 'Ship it', activeForm: null, status: 'pending' },
  ]
  const known = whole({ lastTurn: { seconds: 41, tools: 2, files: 1, ending: 'answer' }, todos } as Partial<Info>)
  const { words } = tideProps(tideInfo(known), 'lively', false, 80, 100, T0 + 60_000, null, false)
  const at = (room: number) => plain(fitLine(words.now, room, CELLS))
  expect(at(120)).toBe('Next up: Lay out the beach and its shell · 1 of 3 done')
  expect(at(40)).toBe('Next up: Lay out the beach and its shell')
  expect(at(39)).toBe('Next: Lay out the beach and its shell')
  // Never ending on a little word: "Lay out…", not "Lay out the…".
  expect(at(20)).toBe('Next: Lay out…')
  expect(at(14)).toBe('✻ Done in 41s')
  // Each narrower room only takes away.
  let wider = at(120)
  for (let room = 119; room >= 12; room--) {
    const now = at(room)
    expect([room, now.length <= wider.length]).toEqual([room, true])
    wider = now
  }
})

test('words a person wrote are never cut mid-word: a first word too long for the room gives way to the shorter form, while writing with no spaces still cuts between characters; a name is cut after a whole part', () => {
  const said = (text: string): Words[] => [[{ text: 'Searching for ' }, { text, isShort: true, least: 3, cut: 'word' }], [{ text: 'Searching' }]]
  expect(plain(fitLine(said('hyperlinks everywhere'), 22, CELLS))).toBe('Searching')
  expect(plain(fitLine(said('hyperlinks everywhere'), 26, CELLS))).toBe('Searching for hyperlinks…')
  expect(plain(fitLine(said('日本語の文章をここに'), 22, CELLS))).toBe('Searching for 日本語…')
  // A name is cut after a whole part of it where it has parts ("agent…", never "agent-plug…"), and
  // at a letter where it has none.
  const project = (text: string): Words[] => [[{ text, isShort: true, least: 5, cut: 'part' }]]
  expect(plain(fitLine(project('agent-plugins'), 12, CELLS))).toBe('agent…')
  expect(plain(fitLine(project('agent-plugins'), PIXELS.text('agent-plu', false) + PIXELS.ellipsis, PIXELS))).toBe('agent…')
  expect(plain(fitLine(project('agentplugins'), 11, CELLS))).toBe('agentplug…')
})

for (const which of ['tide', 'hearth'] as const) {
  test(`${which}: git slow at a turn's end never holds the band in the turn; the uncommitted count catches up after`, async ($, on) => {
    const git: { held: Promise<void> | null; status?: string } = { held: null }
    const { clock } = world(on, { git })
    await start($)
    await turn($)
    await clock.advance(20_000)
    if (which === 'hearth') await run($, 'hearth')
    const props = { ...BAND, bodyColumns: 140 }
    const term = await mount($, 'terminal', props)
    const desk = await mount($, 'desktop', props)
    await $.prompt.submit({ text: 'and again', wait: false, origin: { kind: 'composer' } })
    await term.ui.redraw({ ...props, isWorking: true })
    await desk.ui.redraw({ ...props, isWorking: true })
    await $.tool.call({ tool: 'Edit', file_path: '/work/c.ts', old_string: 'a', new_string: 'b' })
    // The turn's nine seconds pass on both clocks: the terminal band's frame clock runs all the while.
    await clock.advance(9_000)
    await term.wait(9_000)
    const working = await desk.look()
    expect(working.text).toContain('2 uncommitted')
    // git hangs, and has a third file to report when it answers.
    let release: () => void = () => undefined
    git.held = new Promise<void>(resolve => {
      release = resolve
    })
    git.status = ' M README.md\n?? notes.md\n M c.ts\n'
    const ending = $.turn.complete({ answer: 'Done.', durationMs: 9_000, turnId: 't2', reason: 'answer', isAborted: false } as TurnCompleteInput)
    let isHandedOn = false
    void ending.then(() => {
      isHandedOn = true
    })
    await clock.advance(1)
    await term.ui.redraw(props)
    await desk.ui.redraw(props)
    const cheer = await desk.look()
    // The terminal's cheer starts at once, or a tick or two later when the second has no room for it
    // (a frame put up just before a tick keeps that tick): it starts whole either way (see pace.ts).
    for (let i = 0; i < 2 && !(await term.look()).text.includes('9s'); i++) await term.wait(250)
    const seen = await term.look()
    for (const [where, now] of [['terminal', seen], ['desktop', cheer]] as const) {
      // The turn is over at once: its own duration, never the last turn's, and nothing of it at work.
      expect([where, now.text]).toEqual([where, expect.stringContaining('9s')])
      expect([where, now.text.includes('41s')]).toEqual([where, false])
      expect([where, now.text]).toEqual([where, expect.stringContaining('2 uncommitted')])
    }
    expect(cheer.source).not.toBe(working.source)
    expect(cheer.alt).toMatch(which === 'tide' ? /spins with joy/u : /cheers/u)
    expect(cheer.alt).not.toMatch(/sits|rests|taps|work/u)
    // Nor is the turn's handoff held up: what other hooks show beneath the answer goes on without git.
    expect(isHandedOn).toBe(true)
    // git answers: the count catches up, and the picture carries on as it was, with no new frame.
    release()
    git.held = null
    await ending
    await clock.advance(10)
    await desk.ui.redraw(props)
    await term.ui.redraw(props)
    const caught = await desk.look()
    expect(caught.text).toContain('3 uncommitted')
    // On the terminal the cheer's line holds its second, as any change there does, then follows: a
    // tick or two later still, as the cheer's first frames keep their ticks (see pace.ts).
    await term.wait(1_500)
    expect((await term.look()).text).toContain('3 uncommitted')
    expect(caught.source).toBe(cheer.source)
    await term.ui.unmount()
    await desk.ui.unmount()
  })
}

test('git that cannot answer keeps the branch and count the band last knew, and the half that answers still lands', async ($, on) => {
  const git: { held: Promise<void> | null; status?: string; fails?: 'status' | 'rev-parse' | null } = { held: null }
  const { clock } = world(on, { git })
  await start($)
  const props = { ...BAND, bodyColumns: 140 }
  const desk = await mount($, 'desktop', props)
  const after = async () => {
    await turn($)
    await clock.advance(6_000)
    await desk.ui.redraw(props)
    return (await desk.look()).text
  }
  expect(await after()).toMatch(/main.*2 uncommitted/su)
  // git status times out: the count stays what it was, and so does the branch.
  git.fails = 'status'
  git.status = ' M a.ts\n'
  expect(await after()).toMatch(/main.*2 uncommitted/su)
  // The branch's call fails and the status answers: the new count lands, the branch stays.
  git.fails = 'rev-parse'
  git.status = ' M a.ts\n M b.ts\n M c.ts\n'
  expect(await after()).toMatch(/main.*3 uncommitted/su)
  await desk.ui.unmount()
})

// A fresh session's first frame already says where you are, however slow git is: the project from
// the first frame, then git's answer joins the line. Nothing that showed moves or goes, so both looks
// hold the model back until git answers: on the beach it stands after the branch, and by the hearth,
// pinned at line 1's right, it is the first thing a narrow line gives up for the branch. Drawn before
// the start has written anything, or while it waits on git, at every width from the narrowest band
// with words to a wide one, with a long branch under a prefix and a count.
const WHERE_WIDTHS = [34, 36, 40, 46, 52, 58, 64, 70, 75, 88, 100, 120] as const
for (const which of ['tide', 'hearth'] as const) {
  for (const order of ['drawn before the start', 'drawn while the start waits on git'] as const) {
    test(`${which}, ${order}: the first frame says where you are, and git's late answer only joins the line, at every width`, { options: { look: which }, timeoutMs: 120_000 }, async ($, on) => {
      let release: () => void = () => undefined
      const git: { held: Promise<void> | null; branch: string } = {
        held: new Promise<void>(resolve => {
          release = resolve
        }),
        branch: 'claude/first-mod-polish',
      }
      const { clock } = world(on, { git })
      const facts = factsOf(on)
      // What the engine draws while the beach's desktop band waits for git: nothing.
      on('ui.render', () => ({ type: 'Box', children: [] }))
      const starting = async () => {
        const started = $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
        await clock.advance(10)
        return { started }
      }
      const early = order === 'drawn while the start waits on git' ? await starting() : null
      const bands = []
      for (const columns of WHERE_WIDTHS) {
        const props = { ...BAND, bodyColumns: columns }
        for (const surface of SURFACES) bands.push({ columns, surface, props, band: await mount($, surface, props) })
      }
      // The beach's desktop band waits a moment for git first (its words' lines set the beach's
      // width): nothing yet, then, with git still out once the wait is over, its first frame.
      if (which === 'tide') {
        for (const { columns, surface, band } of bands) if (surface === 'desktop') expect([columns, (await band.look()).rows]).toEqual([columns, []])
        await clock.advance(GIT_WAIT_MS + 20)
      }
      // The where line (the beach's line 3, the hearth's line 1) from the project on, and what stands
      // at its right end apart from it (the hearth's model, pinned to the panel's edge).
      const where = async (band: Awaited<ReturnType<typeof mount>>) => {
        const drawn = (await band.look()).rows
        const at = drawn.findIndex(row => row.startsWith('agent'))
        if (at < 0) return { left: `(none) ${drawn.join(' | ')}`, right: '' }
        const end = drawn.findIndex((row, i) => i > at && (row === 'Opus 5.5' || /^(context|No context)/u.test(row)))
        return { left: drawn.slice(at, end < 0 ? undefined : end).join(''), right: end >= 0 && drawn[end] === 'Opus 5.5' ? 'Opus 5.5' : '' }
      }
      const first = []
      for (const { columns, surface, band } of bands) first.push({ band, seen: { columns, surface, ...(await where(band)) } })
      // The project alone at every width (whole, or cut at its end on the narrowest beach): no model
      // yet, on either look.
      for (const { seen } of first) {
        expect({ ...seen, isProject: /^agent(-plugins|\u2026)$/u.test(seen.left) }).toEqual({ ...seen, right: '', isProject: true })
      }
      // The start goes on (or begins) while git is still out. It has already written the project down
      // (so the render's own lookup is only for a band drawn before that), and the line stays as it was.
      const { started } = early ?? (await starting())
      expect([facts().project, facts().isGitRead, facts().branch]).toEqual(['agent-plugins', false, null])
      for (let t = 0; t < 4; t++) {
        await clock.advance(250)
        for (const { band, props } of bands) await band.ui.redraw(props)
        for (const { band, surface } of bands) if (surface === 'terminal') await band.wait(250)
        for (const { band, seen: was } of first) {
          expect({ t, ...was, ...(await where(band)) }).toEqual({ t, ...was })
        }
      }
      // git answers: the branch, the count and the model join, and every piece the first frame showed
      // is still there, where it was.
      release()
      git.held = null
      await started
      await clock.advance(10)
      for (const { band, props } of bands) await band.ui.redraw(props)
      for (const { band, surface } of bands) if (surface === 'terminal') await band.wait(1_000)
      const joined = []
      for (const { band, seen: was } of first) {
        const now = await where(band)
        joined.push({ ...now, columns: was.columns, surface: was.surface })
        expect({ ...was, kept: now.left.startsWith(was.left) && (was.right === '' || now.right === was.right) }).toEqual({ ...was, kept: true })
      }
      // At a wide band all of it shows: the whole branch, the count, and the model at its place.
      const wide = joined.filter(seen => seen.columns === 120)
      for (const seen of wide) {
        expect(seen).toEqual({
          columns: 120,
          surface: seen.surface,
          ...(which === 'tide'
            ? { left: 'agent-plugins · claude/first-mod-polish · 2 uncommitted · Opus 5.5', right: '' }
            : { left: 'agent-plugins on claude/first-mod-polish · 2 uncommitted', right: 'Opus 5.5' }),
        })
      }
      for (const { band } of bands) await band.ui.unmount()
    })
  }
}

// git's usual answer lands within the beach's wait: its desktop band's first frame already has the
// branch, the count and the model, so the beach is drawn once at its width, and its frame (the hello
// and all) never starts over as line 3 fills in.
test('tide: a fresh session\'s desktop beach waits a moment for git, then draws once, at the width its whole where-line leaves', { options: { look: 'tide' } }, async ($, on) => {
  let release: () => void = () => undefined
  const git: { held: Promise<void> | null; branch: string } = {
    held: new Promise<void>(resolve => {
      release = resolve
    }),
    branch: 'claude/first-mod-polish',
  }
  const { clock } = world(on, { git })
  on('ui.render', () => ({ type: 'Box', children: [] }))
  const started = $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  const { ui, look } = await mount($, 'desktop', { ...BAND, bodyColumns: 100 })
  expect((await look()).rows).toEqual([])
  await clock.advance(100)
  release()
  git.held = null
  await started
  await clock.advance(10)
  const first = await look()
  expect(first.text).toContain('agent-plugins · claude/first-mod-polish · 2 uncommitted · Opus 5.5')
  const sources = new Set([first.source])
  for (let i = 0; i < 12; i++) {
    await clock.advance(250)
    sources.add((await look()).source)
  }
  expect(sources.size).toBe(1)
  await ui.unmount()
})

// The beach keeps room for its lines as wide as they have been: a count of uncommitted files that
// comes with an edit and goes with a commit narrows it once, never back and forth with each.
test('tide: on the desktop a count of uncommitted files coming and going narrows the beach once, never back and forth', { options: { look: 'tide' } }, async ($, on) => {
  const git: { held: Promise<void> | null; status?: string; branch: string } = { held: null, status: '', branch: 'feature/session-band' }
  const { clock } = world(on, { git })
  await start($)
  const props = { ...BAND, bodyColumns: 96 }
  const { ui, look } = await mount($, 'desktop', props)
  const width = async () => Number(/viewBox="0 -5 (\d+) 64"/u.exec((await look()).source)?.[1])
  const widths = [await width()]
  for (const status of [' M a.ts\n', '', ' M a.ts\n', '']) {
    git.status = status
    await turn($)
    await clock.advance(20_000)
    await ui.redraw(props)
    widths.push(await width())
  }
  expect((await look()).text).not.toContain('uncommitted')
  expect(widths[1]).toBeLessThan(widths[0] ?? 0)
  expect(widths.slice(1)).toEqual([widths[1], widths[1], widths[1], widths[1]])
  await ui.unmount()
})

// The upgrade note reads the pick to find the look on screen. A pick that cannot be read leaves
// /config's look, and never stops the start before git's answer lands, so the branch, the count and
// the model still join the line.
test('a pick the start cannot read never holds up git: the branch, the count and the model still join the line', async ($, on) => {
  world(on)
  const facts = factsOf(on)
  const broken = { isOn: true }
  on('state.get', ($, e, next) => {
    if (broken.isOn && e.plugin === 'session-band' && e.key === 'pick') return { deny: 'unreadable' } as unknown as ReturnType<typeof next>

    return next(e)
  })
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  expect([facts().project, facts().branch, facts().dirty, facts().isGitRead, facts().model]).toEqual(['agent-plugins', 'main', 2, true, 'Opus 5.5'])
  broken.isOn = false
  for (const surface of SURFACES) {
    const { ui, look } = await mount($, surface, { ...BAND, bodyColumns: 120 })
    expect([surface, (await look()).rows.join('')]).toEqual([surface, expect.stringMatching(/agent-plugins · main · 2 uncommitted · Opus 5\.5/u)])
    await ui.unmount()
  }
})

// A start that goes wrong partway (here its first write of the facts is refused) still writes git's
// answer: the branch and the count land, and both looks know git has answered, so the model joins
// the line as soon as it is known (the next prompt reads it), never only at a turn's end.
test('a start whose first write of the facts is refused still writes git\'s answer, so the model is not held back after it', async ($, on) => {
  let release: () => void = () => undefined
  const git: { held: Promise<void> | null } = {
    held: new Promise<void>(resolve => {
      release = resolve
    }),
  }
  const { clock } = world(on, { git })
  let facts: Info = EMPTY
  // The facts cannot be written while git is still out; then they can.
  let refused = 0
  let isRefusing = true
  on('state.set', ($, e, next) => {
    if (e.plugin === 'session-band' && e.key === 'info') {
      if (isRefusing) {
        refused += 1
        return { deny: 'state is busy' } as unknown as ReturnType<typeof next>
      }
      facts = JSON.parse(JSON.stringify(e.value ?? null)) as Info
    }

    return next(e)
  })
  const started = $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  isRefusing = false
  release()
  git.held = null
  await started
  expect([refused > 0, facts.branch, facts.dirty, facts.isGitRead]).toEqual([true, 'main', 2, true])
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  for (const surface of SURFACES) {
    const { ui, look } = await mount($, surface, { ...BAND, bodyColumns: 120 })
    expect([surface, (await look()).rows.join('')]).toEqual([surface, expect.stringMatching(/agent-plugins · main · 2 uncommitted · Opus 5\.5/u)])
    await ui.unmount()
  }
})

// git answers for the start and for a turn's end, each stamped, and an older answer that lands after
// a newer one is dropped. So the turn's answer must say git has answered as well, or a start whose
// git was overtaken would leave the model held back for good.
for (const which of ['tide', 'hearth'] as const) {
  test(`${which}: a turn's git answer that lands before the start's slow one lets the model join the line`, { options: { look: which } }, async ($, on) => {
    const git: { held: Promise<void> | null } = { held: null }
    const { clock } = world(on, { git })
    const facts = factsOf(on)
    let releaseStart: () => void = () => undefined
    git.held = new Promise<void>(resolve => {
      releaseStart = resolve
    })
    const started = $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
    await clock.advance(10)
    // A quick first turn, whose git is held too, and answers first.
    let releaseTurn: () => void = () => undefined
    git.held = new Promise<void>(resolve => {
      releaseTurn = resolve
    })
    await turn($)
    expect([facts().isGitRead, facts().branch]).toEqual([false, null])
    releaseTurn()
    await clock.advance(10)
    expect([facts().isGitRead, facts().branch]).toEqual([true, 'main'])
    // The start's answer lands last, and is dropped as the older one: the model stays on the line.
    releaseStart()
    git.held = null
    await started
    await clock.advance(10)
    expect(facts().isGitRead).toBe(true)
    for (const surface of SURFACES) {
      const { ui, look } = await mount($, surface, { ...BAND, bodyColumns: 120 })
      expect([which, surface, (await look()).rows.join('').includes('Opus 5.5')]).toEqual([which, surface, true])
      await ui.unmount()
    }
  })
}

test('a folder that stops being a repository mid-session drops its branch and count, rather than keep the old ones', async ($, on) => {
  const git: { held: Promise<void> | null; isNoRepo?: boolean } = { held: null }
  const { clock } = world(on, { git })
  await start($)
  const props = { ...BAND, bodyColumns: 140 }
  const desk = await mount($, 'desktop', props)
  const after = async () => {
    await turn($)
    await clock.advance(6_000)
    await desk.ui.redraw(props)
    return (await desk.look()).text
  }
  expect(await after()).toMatch(/agent-plugins.*main.*2 uncommitted/su)
  // git says this is no repository now (the folder's .git went): neither the branch nor a count stays.
  git.isNoRepo = true
  const text = await after()
  expect([text.includes('agent-plugins'), /\bmain\b/u.test(text), text.includes('uncommitted')]).toEqual([true, false, false])
  await desk.ui.unmount()
})

test('hearth, then the beach, then the hearth again mid-turn: the bead of sweat a new reading brought shows at once, never held back for the old frame', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await run($, 'hearth')
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  const busy = { ...BAND, isWorking: true, bodyColumns: 120 }
  const desk = await mount($, 'desktop', busy)
  await clock.advance(2_000)
  await desk.ui.redraw(busy)
  expect((await desk.look()).source).not.toContain('class="hh-sw"')
  // Over to the beach, where the context climbs past the warning, and back.
  await run($, 'tide')
  await desk.ui.redraw(busy)
  await $.session.measure(measured(90))
  await clock.advance(1_000)
  await desk.ui.redraw(busy)
  await run($, 'hearth')
  await desk.ui.redraw(busy)
  // The hearth's frame is new: it draws the bead with the reading, on its first frame.
  expect((await desk.look()).source).toContain('class="hh-sw"')
  await desk.ui.unmount()
})

test('a file edited twice in a turn is one file changed', async ($, on) => {
  const { clock } = world(on)
  await start($)
  const desk = await mount($, 'desktop', { ...BAND, bodyColumns: 140 })
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'b', new_string: 'c' })
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', reason: 'answer', isAborted: false } as TurnCompleteInput)
  await clock.advance(10_000)
  await desk.ui.redraw({ ...BAND, bodyColumns: 140 })
  expect((await desk.look()).text).toContain('Done in 41s · 2 tools · 1 file changed')
  await desk.ui.unmount()
})

// Keeping the todos is bookkeeping, not a step of the work: the tools a turn ran leave it out, on both
// looks and both surfaces, so three steps with a list kept as they went is "3 tools", never "8 tools".
test('the tools a turn ran leave out its todo bookkeeping, on both looks and both surfaces', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  let n = 0
  for (const style of ['tide', 'hearth'] as const) {
    n += 1
    await run($, style)
    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Read the notes', description: 'Read them', activeForm: 'Reading the notes' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Fix the notes', description: 'Fix them', activeForm: 'Fixing the notes' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    await $.tool.call({ tool: 'Read', file_path: '/work/notes.md' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'TaskList' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/notes.md', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Run the tests', status: 'completed', activeForm: 'Running the tests' }] })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
    await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: `t-${n}`, reason: 'answer', isAborted: false } as TurnCompleteInput)
    await clock.advance(10_000)
    for (const surface of SURFACES) {
      const shown = await mount($, surface, { ...BAND, bodyColumns: 140 })
      const { text } = await shown.look()
      expect([style, surface, text.includes('Done in 41s · 3 tools · 1 file changed')]).toEqual([style, surface, true])
      await shown.ui.unmount()
    }
  }
})

test('a plan whose every task is done leaves the next turn counting afresh, as Claude Code\'s list does', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const term = await mount($, 'terminal', { ...BAND, isWorking: true, bodyColumns: 140 })
  await term.look()
  for (let n = 1; n <= 3; n++) {
    await $.prompt.submit({ text: `step ${n}`, wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'TaskCreate', subject: `Step ${n}`, description: '', activeForm: `Doing step ${n}` })
    await $.tool.call({ tool: 'TaskUpdate', taskId: String(n), status: 'completed' })
    await $.turn.complete({ answer: 'Done.', durationMs: 5_000, turnId: `s${n}`, reason: 'answer', isAborted: false } as TurnCompleteInput)
    await clock.advance(10_000)
  }
  // A plan left half done carries on into the next turn, its count with it.
  await $.prompt.submit({ text: 'two more', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Draw the shell', description: '', activeForm: 'Drawing the shell' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Draw the wave', description: '', activeForm: 'Drawing the wave' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'completed' })
  // The words as they settle, both clocks running.
  const settled = async () => {
    for (let i = 0; i < 12; i++) {
      await clock.advance(250)
      await term.ui.redraw({ ...BAND, isWorking: true, bodyColumns: 140 })
      await term.wait(250)
    }
    return (await term.look()).text
  }
  expect(['half done', await settled()]).toEqual(['half done', expect.stringContaining('Drawing the wave · 1 of 2 done')])
  await $.turn.complete({ answer: 'Done.', durationMs: 5_000, turnId: 's4', reason: 'answer', isAborted: false } as TurnCompleteInput)
  await clock.advance(10_000)
  await $.prompt.submit({ text: 'and the wave', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '5', status: 'in_progress' })
  expect(['carried on', await settled()]).toEqual(['carried on', expect.stringContaining('Drawing the wave · 1 of 2 done')])
  await term.ui.unmount()
})

test('git answers that land out of order never set the count back to an older one', async ($, on) => {
  const git: { held: Promise<void> | null; status?: string } = { held: null }
  const { clock } = world(on, { git })
  await start($)
  const props = { ...BAND, bodyColumns: 140 }
  const desk = await mount($, 'desktop', props)
  // One turn's git hangs with four files to report; the next turn's answers at once, with one.
  let release: () => void = () => undefined
  git.held = new Promise<void>(resolve => {
    release = resolve
  })
  git.status = ' M a.ts\n M b.ts\n M c.ts\n M d.ts\n'
  await turn($)
  git.held = null
  git.status = ' M a.ts\n'
  await turn($)
  await clock.advance(6_000)
  await desk.ui.redraw(props)
  expect((await desk.look()).text).toContain('1 uncommitted')
  // The older answer lands last, and is let go.
  release()
  await clock.advance(10)
  await desk.ui.redraw(props)
  expect((await desk.look()).text).toContain('1 uncommitted')
  await desk.ui.unmount()
})

test('the hearth lets go of the beach’s kept scene once, then writes nothing more as it redraws', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  const writes: unknown[] = []
  on('state.set', ($, e, next) => {
    const write = e as { plugin?: string; key?: string; value?: unknown }
    if (write.plugin === 'session-band' && write.key === 'scene') writes.push(write.value ?? null)

    return next(e)
  })
  await start($)
  const desk = await mount($, 'desktop')
  await desk.look()
  await clock.advance(1)
  expect(writes.map(value => value === null)).toEqual([false])
  await run($, 'hearth')
  for (let i = 0; i < 5; i++) {
    await clock.advance(2_000)
    await desk.ui.redraw(BAND)
    expect((await desk.look()).look).toBe('hearth')
  }
  await clock.advance(1)
  expect(writes.map(value => value === null)).toEqual([false, true])
  // Back on the beach, the frame it draws is kept again.
  await run($, 'tide')
  expect((await desk.look()).look).toBe('tide')
  await clock.advance(1)
  expect(writes.map(value => value === null)).toEqual([false, true, false])
  await desk.ui.unmount()
})

// The desktop draws Clawd as an image: an interactive frame blanks for a frame or two whenever its
// source changes, and the band changes it with every moment. An image takes no hover, so the pet is
// a heart of its own, laid over him by the band's own hover. The desktop draws a revealed absolute
// Box as a floating card above the band, and a revealed picture starts its clock over, so the heart
// is never revealed: it is always mounted, parked where nothing of it shows, and the hover moves it
// onto him.
test('desktop: on either look Clawd is a plain image, and resting the pointer on him brings a parked heart over him that beats, solid all the while', async ($, on) => {
  world(on)
  await start($)
  for (const which of ['tide', 'hearth'] as const) {
    await run($, which)
    const desk = await mount($, 'desktop')
    const { tree } = await desk.look()
    const svgs: Node[] = []
    const hidden: Node[] = []
    const parked: { box: Node; inScope: boolean }[] = []
    const visit = (node: unknown, inScope: boolean) => {
      if (node === null || typeof node !== 'object') return
      const el = node as Node
      if (el.type === 'Svg') svgs.push(el)
      if (el.type === 'Box' && el.props?.display === 'none') hidden.push(el)
      // The drawn tree carries a Box's hover beside its props.
      const hover = (el as { hover?: { top?: number } }).hover
      if (el.type === 'Box' && hover?.top !== undefined) parked.push({ box: el, inScope })
      for (const child of el.children ?? []) visit(child, inScope || (el.type === 'Box' && typeof el.props?.key === 'string'))
    }
    visit(tree, false)
    expect([which, svgs.filter(svg => svg.props?.isInteractive === true).length]).toEqual([which, 0])
    // Nothing is revealed (that would be a card above the band); one heart is parked where nothing of
    // it shows (absolute, so moving it moves nothing), inside his own hover scope, and the hover lays
    // it over him: the hearth's below the band, the beach's across its bottom edge (see HEART_PARKED).
    expect([which, hidden.length, parked.length]).toEqual([which, 0, 1])
    const { box, inScope } = parked[0]!
    const [top, shown] = which === 'tide' ? [HEART_PARKED, HEART_SHOWN] : [PARKED, 0]
    expect([which, box.props?.position, box.props?.top, box.props?.left, (box as { hover?: unknown }).hover, inScope]).toEqual([which, 'absolute', top, 0, { top: shown }, true])
    const svg = box.children?.[0] as Node | undefined
    // Never an empty alt: the desktop app draws no Svg whose alt is empty, and the heart never showed.
    expect([which, svg?.type, svg?.props?.alt]).toEqual([which, 'Svg', HEART_ALT])
    const heart = String(svg?.props?.source ?? '')
    expect([which, heart]).toEqual([which, expect.stringMatching(/^<svg /u)])
    // Never faded (a half-faded pink is a muddy mauve on the dark page), and no script.
    expect([which, /opacity/u.test(heart), heart.includes('<script')]).toEqual([which, false, false])
    // Shown, it is already up, so it beats softly; only where the page asks for no less motion.
    expect([which, heart]).toEqual([which, expect.stringMatching(/@media \(prefers-reduced-motion:no-preference\)\{.*beat/u)])
    expect([which, /scale\(0\)/u.test(heart)]).toEqual([which, false])
    await desk.ui.unmount()
  }
})

test('after /model, line 3 names the new model by the next Enter, on both looks and both surfaces; a lookup that fails keeps the last one', async ($, on) => {
  const model = { id: 'claude-opus-5-5[1m]', fails: false }
  const { clock } = world(on, { model })
  await start($)
  await turn($)
  const said = async (): Promise<string[]> => {
    const lines: string[] = []
    for (const which of ['tide', 'hearth'] as const) {
      await run($, which)
      for (const surface of SURFACES) {
        const { ui, look } = await mount($, surface, { ...BAND, bodyColumns: 140 })
        lines.push(`${which} ${surface}: ${(await look()).text.replace(/\s+/g, ' ')}`)
        await ui.unmount()
      }
    }

    return lines
  }
  for (const line of await said()) expect([line, line.includes('Opus 5.5')]).toEqual([line, true])
  // /model sonnet between turns: the next prompt names it, before any tool runs.
  model.id = 'claude-sonnet-5'
  await $.prompt.submit({ text: 'and now on sonnet', wait: false, origin: { kind: 'composer' } })
  for (const line of await said()) expect([line, line.includes('Sonnet 5'), line.includes('Opus')]).toEqual([line, true, false])
  // /model typed while that turn runs: its end names the model the next turn will use.
  model.id = 'haiku'
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't2', reason: 'answer', isAborted: false } as TurnCompleteInput)
  await clock.advance(20_000)
  for (const line of await said()) expect([line, line.includes('Haiku'), line.includes('Sonnet')]).toEqual([line, true, false])
  // A lookup that fails keeps the model the band last knew.
  model.fails = true
  await turn($)
  await clock.advance(20_000)
  for (const line of await said()) expect([line, line.includes('Haiku')]).toEqual([line, true])
})

test('a model switch names the new model on line 3 at once, with no prompt; a subagent\'s switch leaves it alone', async ($, on) => {
  world(on)
  // No settings hook beneath: the engine's own answer is nothing to add.
  on('classic.PostModelSwitch', () => ({}))
  await start($)
  await turn($)
  const switched = (to: string, agent?: string) =>
    $.classic.PostModelSwitch({
      from_model: 'claude-opus-5-5[1m]',
      to_model: to,
      requested_model: null,
      source: 'command',
      context_tokens: 0,
      prompt_cache_warm: false,
      cache_ttl: '5m',
      estimated_cache_write_usd: 0,
      pricing: 'catalog',
      ...(agent === undefined ? {} : { agent_id: agent, agent_type: 'general-purpose' }),
    })
  const lines = async (): Promise<string[]> => {
    const all: string[] = []
    for (const which of ['tide', 'hearth'] as const) {
      await run($, which)
      for (const surface of SURFACES) {
        const { ui, look } = await mount($, surface, { ...BAND, bodyColumns: 140 })
        all.push(`${which} ${surface}: ${(await look()).text.replace(/\s+/g, ' ')}`)
        await ui.unmount()
      }
    }

    return all
  }
  await switched('claude-haiku-5-5', 'agent-1')
  for (const line of await lines()) expect([line, line.includes('Opus 5.5'), line.includes('Haiku')]).toEqual([line, true, false])
  await switched('claude-sonnet-5')
  for (const line of await lines()) expect([line, line.includes('Sonnet 5'), line.includes('Opus')]).toEqual([line, true, false])
})

for (const fails of [['usage'], ['repo'], ['usage', 'repo']] as const) {
  test(`a ${fails.join(' and ')} lookup that fails at the start loses only its own fact: line 3 still names the project and the model`, async ($, on) => {
    world(on, { fails })
    await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
    for (const which of ['tide', 'hearth'] as const) {
      await run($, which)
      for (const surface of SURFACES) {
        const { ui, look } = await mount($, surface, { ...BAND, bodyColumns: 140 })
        const line = `${which} ${surface}: ${(await look()).text.replace(/\s+/g, ' ')}`
        for (const fact of ['agent-plugins', 'Opus 5.5', 'main']) expect([line, fact, line.includes(fact)]).toEqual([line, fact, true])
        await ui.unmount()
      }
    }
  })
}

test('prettyModel names a model the way a person does', () => {
  const named = Object.fromEntries(
    ['claude-opus-5-5[1m]', 'claude-sonnet-5', 'claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku-20241022', 'sonnet', 'opus[1m]', 'some-other-model'].map(id => [id, prettyModel(id)]),
  )
  expect(named).toEqual({
    'claude-opus-5-5[1m]': 'Opus 5.5',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-sonnet-4-20250514': 'Sonnet 4',
    'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
    'claude-3-5-haiku-20241022': 'Haiku 3.5',
    sonnet: 'Sonnet',
    'opus[1m]': 'Opus',
    'some-other-model': 'some-other-model',
  })
})

// ── A real reload of the hooks module, as near as the kit comes: each test is a fresh register()
// (a new activation, its closures and timers gone), so a test seeded with the $.state the test
// before it left behind is that module loaded again, as a /config change or a respawned worker
// loads it. The pairs below run in order: the first leaves its state in KEPT, the second starts
// from it at the time the first left off.
const KEPT = new Map<string, unknown>()
const LEFT: Record<string, { state: Map<string, unknown>; at: number; source: string; alt: string }> = {}

function keepState(on: On): void {
  KEPT.clear()
  on('state.set', ($, e, next) => {
    if (e.plugin === 'session-band') KEPT.set(e.key, JSON.parse(JSON.stringify(e.value ?? null)))

    return next(e)
  })
}

function seedState(on: On, from: Map<string, unknown>, onWrite: () => void = () => undefined): void {
  const left = new Map(from)
  on('state.get', async ($, e, next) => {
    const real = await next(e)
    if (e.plugin === 'session-band' && left.has(e.key)) {
      // The kept value, at the version the session holds, so the band's own writes still land.
      return { value: { value: left.get(e.key), version: 'value' in real ? (real.value?.version ?? 0) : 0 } }
    }

    return real
  })
  on('state.set', ($, e, next) => {
    if (e.plugin === 'session-band') {
      left.delete(e.key)
      onWrite()
    }

    return next(e)
  })
}

async function leave(name: string, clock: { now: () => number; advance: (ms: number) => Promise<void> }, desk: Awaited<ReturnType<typeof mount>>): Promise<void> {
  const seen = await desk.look()
  // The kept scene is written a moment after the draw.
  await clock.advance(1)
  LEFT[name] = { state: new Map(KEPT), at: clock.now(), source: seen.source, alt: seen.alt }
}

test('reload mid-cheer (1 of 2): the beach cheers on the desktop', async ($, on) => {
  keepState(on)
  const { clock } = world(on)
  await start($)
  const desk = await mount($, 'desktop')
  await desk.look()
  await turn($)
  await clock.advance(1200)
  await desk.ui.redraw(BAND)
  expect((await desk.look()).alt).toContain('spins')
  await leave('cheer', clock, desk)
})

test('reload mid-cheer (2 of 2): the new module hands the frame the same source, and the cheer still settles, in exactly one more frame', { timeoutMs: 30_000, options: { warnAt: 85 } }, async ($, on) => {
  const left = LEFT.cheer
  expect(left === undefined).toBe(false)
  if (left === undefined) return
  seedState(on, left.state)
  const { clock } = world(on, { now: left.at })
  const desk = await mount($, 'desktop')
  const seen = await desk.look()
  expect(seen.source).toBe(left.source)
  // The cheer's end was armed by the module that unloaded; this one arms it again as it first draws.
  const sources = [seen.source]
  for (let t = 0; t < 12_000; t += 500) {
    await clock.advance(500)
    const now = (await desk.look()).source
    if (now !== sources[sources.length - 1]) sources.push(now)
  }
  expect(sources.length).toBe(2)
  expect((await desk.look()).alt).not.toContain('spins')
})

for (const look of ['tide', 'hearth'] as const) {
  test(`${look}: reload half a minute into a fresh session (1 of 2)`, { options: { look } }, async ($, on) => {
    keepState(on)
    const { clock } = world(on)
    await start($)
    const desk = await mount($, 'desktop')
    await desk.look()
    await clock.advance(30_000)
    await desk.ui.redraw(BAND)
    await leave(`fresh ${look}`, clock, desk)
  })

  test(`${look}: reload half a minute into a fresh session (2 of 2): session.start runs again and Clawd never waves hello twice`, { options: { look, warnAt: 85 } }, async ($, on) => {
    const left = LEFT[`fresh ${look}`]
    expect(left === undefined).toBe(false)
    if (left === undefined) return
    seedState(on, left.state)
    // The session as it stands: usage now has the figures the last module measured.
    const { context, rateLimits, cost } = measured(42)
    world(on, { now: left.at, usage: { startedAt: T0 - 12 * 60_000, context, rateLimits, cost } })
    await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
    const desk = await mount($, 'desktop')
    expect((await desk.look()).source).toBe(left.source)
    const term = await mount($, 'terminal')
    const client = (await term.ui.findAll({ type: 'Client' }))[0]
    const props = (client?.props.props ?? {}) as { isGreeting?: boolean; greetedMs?: number | null }
    expect([props.isGreeting, props.greetedMs]).toEqual([false, null])
  })
}

// ── The guards and timers a later cleanup could break without a sign on screen until it mattered.

for (const refused of [['register'], ['store'], ['register', 'store']] as const) {
  test(`a start whose ${refused.join(' and ')} ${refused.length > 1 ? 'are' : 'is'} refused still has every fact: line 3 from the first draw, and the nap on time`, async ($, on) => {
    const { clock } = world(on, { refuses: refused })
    await start($)
    for (const look of ['tide', 'hearth'] as const) {
      if (look === 'hearth') await $.config.set({ key: KEY, value: 'hearth', previous: 'tide', provider: { plugin: 'session-band', tier: 'user' }, origin: { kind: 'composer' } })
      for (const surface of SURFACES) {
        const desk = await mount($, surface)
        const seen = await desk.look()
        expect([look, surface, seen.text]).toEqual([look, surface, expect.stringContaining('agent-plugins')])
        expect([look, surface, seen.text]).toEqual([look, surface, expect.stringContaining('Opus 5.5')])
        await desk.ui.unmount()
      }
    }
    // The nap's redraw was armed at the start: three quiet minutes on, he sleeps without a nudge.
    const desk = await mount($, 'desktop')
    await desk.look()
    await clock.advance(3 * 60_000 + 1_500)
    expect((await desk.look()).alt).toBe('Clawd naps.')
  })
}

test("a subagent's own tools and its own turn leave the band alone: no words of its, no splash, no hiccup, no cheer mid-turn", async ($, on) => {
  const { clock } = world(on)
  await start($)
  const busy = { ...BAND, isWorking: true }
  for (const look of ['tide', 'hearth'] as const) {
    await run($, look)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    const desk = await mount($, 'desktop', busy)
    const before = await desk.look()
    await clock.advance(2_000)
    // (The kit's own call types carry no agentId; the engine's events do.)
    await $.tool.call({ tool: 'Read', file_path: '/work/inside-the-subagent.ts', agentId: 'sub1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'make fail', agentId: 'sub1' } as never)
    await clock.advance(1_200)
    const during = await desk.look()
    expect([look, during.text]).toEqual([look, before.text])
    expect([look, during.source]).toEqual([look, before.source])
    // The subagent answers its own turn while the main loop goes on: Claude Code may say it is
    // between steps, but the band still shows the work, never "Done" and a cheer.
    await $.turn.complete({ answer: 'Found it.', durationMs: 3_000, turnId: 'sub', reason: 'answer', isAborted: false, agentId: 'sub1' } as TurnCompleteInput)
    await desk.ui.redraw(BAND)
    const between = await desk.look()
    expect([look, between.text.includes('Done'), /cheer|spins/u.test(between.alt)]).toEqual([look, false, false])
    await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', reason: 'answer', isAborted: false } as TurnCompleteInput)
    await desk.ui.redraw(BAND)
    expect([look, (await desk.look()).text]).toEqual([look, expect.stringContaining('Done in 41s')])
    await clock.advance(10_000)
    await desk.ui.unmount()
  }
})

test('another /config row changing (a built-in, or the band\'s own warnAt) never touches the look', { options: { look: 'hearth' } }, async ($, on) => {
  world(on)
  await start($)
  const desk = await mount($, 'desktop')
  expect((await desk.look()).look).toBe('hearth')
  await $.config.set({ key: 'verbose', value: true, previous: false, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
  await $.config.set({ key: 'session-band.warnAt', value: 85, previous: 80, provider: { plugin: 'session-band', tier: 'user' }, origin: { kind: 'composer' } })
  await desk.ui.redraw(BAND)
  expect((await desk.look()).look).toBe('hearth')
  expect(await run($)).toMatch(/^Hearth, /u)
})

test('a store that cannot be read as the band draws still leaves Clawd and a line of words on screen, on both looks and surfaces', async ($, on) => {
  const broken = { isOn: false }
  world(on)
  on('state.get', ($, e, next) => {
    // The read refused, as a host may refuse it.
    if (broken.isOn && e.plugin === 'session-band') return { deny: 'unreadable' } as unknown as ReturnType<typeof next>

    return next(e)
  })
  await start($)
  for (const style of ['tide', 'hearth'] as const) {
    await run($, style)
    broken.isOn = true
    for (const surface of SURFACES) {
      const { ui, look } = await mount($, surface)
      const seen = await look()
      // Clawd (his frame, or his picture) and the words a fresh session starts with.
      expect([style, surface, surface === 'terminal' ? seen.key !== null : seen.source.includes('<svg')]).toEqual([style, surface, true])
      expect([style, surface, seen.text]).toEqual([style, surface, expect.stringContaining('Ready')])
      await ui.unmount()
    }
    broken.isOn = false
  }
})

test('a command the person refuses is no failure of Claude\'s: no splash, no hiccup, no flinch', async ($, on) => {
  const { clock } = world(on)
  await start($)
  const busy = { ...BAND, isWorking: true }
  for (const look of ['tide', 'hearth'] as const) {
    await run($, look)
    await $.prompt.submit({ text: 'clean up', wait: false, origin: { kind: 'composer' } })
    const desk = await mount($, 'desktop', busy)
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build refused' }).catch(() => undefined)
    for (const wait of [100, 1_100]) {
      await clock.advance(wait)
      const seen = await desk.look()
      expect([look, wait, /Splash|Hiccup|failed/u.test(seen.text), /splash|flinch/u.test(seen.alt)]).toEqual([look, wait, false, false])
    }
    await $.turn.complete({ answer: 'Done.', durationMs: 5_000, turnId: 't1', reason: 'answer', isAborted: false } as TurnCompleteInput)
    await clock.advance(10_000)
    await desk.ui.unmount()
  }
})

test('a busy turn keeps one look-again timer at a time: 25 quick tools write the facts about twice each, not once per stale timer', async ($, on) => {
  let writes = 0
  let isCounting = false
  on('state.set', ($, e, next) => {
    if (isCounting && e.plugin === 'session-band' && e.key === 'info') writes += 1

    return next(e)
  })
  const { clock } = world(on)
  await start($)
  const desk = await mount($, 'desktop', { ...BAND, isWorking: true })
  await desk.look()
  await $.prompt.submit({ text: 'busy', wait: false, origin: { kind: 'composer' } })
  isCounting = true
  for (let i = 0; i < 25; i++) {
    await $.tool.call({ tool: 'Read', file_path: `/work/${i}.ts` })
    await clock.advance(120)
  }
  await clock.advance(3_000)
  isCounting = false
  // Two writes a tool (its start and its end), and a look again or two once the tools go quiet.
  expect(writes).toBeLessThanOrEqual(2 * 25 + 4)
})

test('reload mid-turn (1 of 2): a step fails on the hearth desktop, its hiccup a moment from showing', { options: { look: 'hearth' } }, async ($, on) => {
  keepState(on)
  const { clock } = world(on)
  await start($)
  const busy = { ...BAND, isWorking: true }
  const desk = await mount($, 'desktop', busy)
  await desk.look()
  await clock.advance(20_000)
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'make fail' })
  await clock.advance(250)
  await desk.ui.redraw(busy)
  // The edit's words have their second first: the hiccup is still to come.
  expect((await desk.look()).alt).toBe('Clawd taps along as Claude works.')
  await leave('mid-turn', clock, desk)
})

test('reload mid-turn (2 of 2): the new module arms the hold again, so the hiccup and his flinch come on time, and nothing redraws in a loop', { options: { look: 'hearth', warnAt: 85 }, timeoutMs: 20_000 }, async ($, on) => {
  const left = LEFT['mid-turn']
  expect(left === undefined).toBe(false)
  if (left === undefined) return
  let writes = 0
  seedState(on, left.state, () => {
    writes += 1
  })
  const { clock } = world(on, { now: left.at })
  const busy = { ...BAND, isWorking: true }
  const desk = await mount($, 'desktop', busy)
  expect((await desk.look()).source).toBe(left.source)
  let flinchedAt: number | null = null
  for (let t = 50; t <= 3_000; t += 50) {
    await clock.advance(50)
    if (flinchedAt === null && (await desk.look()).alt.startsWith('Clawd flinches')) flinchedAt = t
  }
  // The edit's words went up 251 ms before the reload: their second is over 749 ms after it.
  expect([flinchedAt !== null && flinchedAt >= 700 && flinchedAt <= 850, flinchedAt]).toEqual([true, flinchedAt])
  expect((await desk.look()).text).toContain('Hiccup')
  // Three seconds of a held hiccup and a flinch: a handful of writes, never a loop.
  expect(writes).toBeLessThan(12)
})

for (const look of ['tide', 'hearth'] as const) {
  test(`${look}: overlapping tools: when the later one ends first, the words go back to the one still running, never "Thinking", on both surfaces`, { timeoutMs: 20_000 }, async ($, on) => {
    // The first subagent runs on until the test lets it go; the second answers once the test has looked.
    let letGoOfFirst: () => void = () => undefined
    const first = new Promise<void>(resolve => {
      letGoOfFirst = resolve
    })
    let whileChecking: () => Promise<void> = async () => undefined
    const { clock } = world(on, {
      onCall: async (tool, e) => (e.description === 'Survey the hooks folder' ? first : e.description === 'Check the tests' ? whileChecking() : undefined),
    })
    await start($)
    await run($, look)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true, bodyColumns: 120 }
    const term = await mount($, 'terminal', busy)
    const desk = await mount($, 'desktop', busy)
    await term.look()
    // Both surfaces at the same moment: the terminal's words step on its own clock, the desktop's hold in the hooks module.
    const both = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        await clock.advance(Math.min(250, left))
        await term.wait(Math.min(250, left))
      }
      return [(await term.look()).text, (await desk.look()).text]
    }
    const surveying = $.tool.call({ tool: 'Agent', description: 'Survey the hooks folder', prompt: 'look', subagent_type: 'Explore' } as never)
    for (const text of await both(1_500)) expect([look, text]).toEqual([look, expect.stringContaining('Survey the hooks folder')])
    // A second subagent, side by side: its own words while it runs, then back to the first.
    let during: string[] = []
    whileChecking = async () => {
      during = await both(1_500)
    }
    await $.tool.call({ tool: 'Agent', description: 'Check the tests', prompt: 'check', subagent_type: 'Explore' } as never)
    expect(during.length).toBe(2)
    for (const text of during) expect([look, text]).toEqual([look, expect.stringContaining('Check the tests')])
    for (const wait of [1_500, 10_000, 30_000, 60_000]) {
      for (const text of await both(wait)) {
        expect([look, wait, text]).toEqual([look, wait, expect.stringContaining('Survey the hooks folder')])
        expect([look, wait, text.includes('Thinking')]).toEqual([look, wait, false])
      }
    }
    // The first one ends: nothing runs, and only now is Claude thinking it over.
    letGoOfFirst()
    await surveying
    for (const text of await both(2_000)) expect([look, text]).toEqual([look, expect.stringContaining('Thinking')])
    await $.turn.complete({ answer: 'Done.', durationMs: 120_000, turnId: 't1', reason: 'answer', isAborted: false } as TurnCompleteInput)
    await term.ui.unmount()
    await desk.ui.unmount()
  })
}

test('the todos keep the latest TODOS_MAX tasks (a TodoWrite list its first), and a turn that finishes them all leaves none', () => {
  let todos: Todo[] = []
  for (let n = 1; n <= TODOS_MAX + 10; n++) todos = nextTodos(todos, { tool: 'TaskCreate', subject: `Step ${n}` }, String(n))
  expect([todos.length, todos[0]?.id, todos[todos.length - 1]?.id]).toEqual([TODOS_MAX, '11', String(TODOS_MAX + 10)])
  const list = nextTodos([], { tool: 'TodoWrite', todos: Array.from({ length: TODOS_MAX + 5 }, (_, i) => ({ content: `Step ${i}`, status: 'pending' })) }, undefined)
  expect([list.length, list[0]?.subject]).toEqual([TODOS_MAX, 'Step 0'])
  const done = todos.map(todo => ({ ...todo, status: 'completed' as const }))
  expect([todosAfterTurn(done), todosAfterTurn([...done.slice(1), { ...done[0]!, status: 'pending' }]).length, todosAfterTurn([])]).toEqual([[], TODOS_MAX, []])
})

test('runningAfter keeps the tools still running in start order, and says the latest of them', () => {
  const tool = (id: string): Activity => ({ id, kind: 'read', verb: 'Reading', target: `${id}.ts`, what: `Read ${id}.ts` })
  let now = runningAfter([], { started: tool('a') })
  now = runningAfter(now.running, { started: tool('b') })
  expect(now.activity?.id).toBe('b')
  // The later one ends first: back to the one still running.
  now = runningAfter(now.running, { ended: 'b' })
  expect([now.activity?.id, now.running.map(one => one.id)]).toEqual(['a', ['a']])
  // The earlier one ends first: the later one stays.
  now = runningAfter(runningAfter(now.running, { started: tool('c') }).running, { ended: 'a' })
  expect([now.activity?.id, now.running.map(one => one.id)]).toEqual(['c', ['c']])
  expect(runningAfter(now.running, { ended: 'c' })).toEqual({ running: [], activity: null })
  // A turn gone strange never keeps more than RUNNING_MAX.
  let many = { running: [] as Activity[], activity: null as Activity | null }
  for (let i = 0; i < 100; i++) many = runningAfter(many.running, { started: tool(`t${i}`) })
  expect([many.running.length, many.running[0]?.id, many.activity?.id]).toEqual([RUNNING_MAX, 't68', 't99'])
  // An older build's state, with one activity and no list: that one is running.
  expect(whole({ activity: tool('old') }).running.map(one => one.id)).toEqual(['old'])
  // The same call started again (the host retrying it) is one call, moved to the latest: it ends once.
  now = runningAfter(runningAfter(runningAfter([], { started: tool('a') }).running, { started: tool('b') }).running, { started: tool('a') })
  expect([now.activity?.id, now.running.map(one => one.id)]).toEqual(['a', ['b', 'a']])
  expect(runningAfter(now.running, { ended: 'a' }).activity?.id).toBe('b')
})

// Every change of a terminal band's frame, to the 10 ms, while `act` runs at `at` ms after the band appears.
async function film(band: Awaited<ReturnType<typeof mount>>, until: number, acts: Record<number, () => Promise<void>>): Promise<number[]> {
  const changes: number[] = []
  let last = (await band.look()).text
  for (let at = 0; at <= until; at += 10) {
    await acts[at]?.()
    const now = (await band.look()).text
    if (now !== last) changes.push(at)
    last = now
    await band.ui.advance(10)
  }

  return changes
}

/** The most changes in any one second (from each change, the next 999 ms). */
function busiest(changes: number[]): number {
  return Math.max(0, ...changes.map(from => changes.filter(at => at >= from && at < from + 1_000).length))
}

test('terminal: whatever lands while he spins, at any point in a tick, no second has more than four changes, and nothing is lost, on either look', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  let n = 0
  // He spins a second in: the beach's cheer, the hearth's petted turn (both a new frame every tick),
  // and the hearth's cheer, which a switch to the beach carries on. Something lands 750 ms into it
  // (a second into the hearth's cheer, whose bounce has four changes in the second before).
  const plays = [
    ...(['pet', 'prompt', 'still', 'switch', 'turn'] as const).flatMap(what => [['tide', 'cheer', what, 1_750], ['hearth', 'pet', what, 1_750]] as const),
    ['hearth', 'cheer', 'switch', 2_000],
  ] as const
  for (const [which, moment, what, landAt] of plays) {
    for (const offset of [0, 10, 120, 240]) {
      n += 1
      await run($, `${which} lively`)
      const band = await mount($, 'terminal')
      const key = (await band.look()).key ?? ''
      const pet = () => band.ui.pointer({ type: 'down', x: which === 'tide' ? 7 : 4, y: 1, button: 'left', in: key })
      const spin = moment === 'cheer' ? () => turn($, { turnId: `spin-${n}` }) : pet
      const land: Record<typeof what, () => Promise<void>> = {
        pet,
        prompt: async () => {
          await $.prompt.submit({ text: 'and again', wait: false, origin: { kind: 'composer' } })
          await band.ui.redraw({ ...BAND, isWorking: true })
        },
        still: async () => {
          await run($, 'still')
        },
        switch: async () => {
          await run($, which === 'tide' ? 'hearth' : 'tide')
        },
        turn: () => turn($, { turnId: `land-${n}` }),
      }
      const changes = await film(band, 4_000, { 1_000: spin, [landAt + offset]: land[what] })
      const play = [which, moment, what, offset]
      expect([...play, busiest(changes)]).toEqual([...play, Math.min(4, busiest(changes))])
      // What landed shows within a tick, and each frame from then on stays up a tick at least.
      const after = changes.filter(at => at >= landAt + offset)
      expect([...play, (after[0] ?? Infinity) - (landAt + offset) <= 250]).toEqual([...play, true])
      const gaps = after.slice(1).map((at, i) => at - (after[i] ?? at))
      expect([...play, Math.min(250, ...gaps)]).toEqual([...play, 250])
      await band.ui.unmount()
      await $.prompt.submit({ text: 'reset', wait: false, origin: { kind: 'composer' } })
      await $.turn.complete({ answer: '', durationMs: 1_000, turnId: `reset-${n}`, reason: 'aborted', isAborted: true } as TurnCompleteInput)
      await clock.advance(10_000)
    }
  }
})

/** A frame of both surfaces at once: the terminal band's text, and the desktop's text, alt and Svg source. */
type Both = { at: number; term: string; desk: string; alt: string; source: string }

/**
 * Both surfaces filmed every 10 ms for `until` ms, the engine's clock and the terminal's frame clock
 * moving together, with `acts` run at their times.
 */
async function filmBoth(
  clock: { advance: (ms: number) => Promise<void> },
  term: Awaited<ReturnType<typeof mount>>,
  desk: Awaited<ReturnType<typeof mount>> | null,
  until: number,
  acts: Record<number, () => Promise<void>> = {},
): Promise<Both[]> {
  const frames: Both[] = []
  for (let at = 0; at <= until; at += 10) {
    await acts[at]?.()
    const [t, d] = [await term.look(), desk === null ? null : await desk.look()]
    frames.push({ at, term: t.text, desk: d?.text ?? '', alt: d?.alt ?? '', source: d?.source ?? '' })
    await clock.advance(10)
    await term.ui.advance(10)
  }

  return frames
}

for (const motion of ['lively', 'still', 'calm'] as const) {
  test(`terminal, ${motion}: a prompt that wakes the napping hearth opens his eyes on the very frame that says "Thinking it over"`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on, motion === 'calm' ? { settings: { prefersReducedMotion: true } } : {})
    await start($)
    await run($, `hearth ${motion === 'still' ? 'still' : 'lively'}`)
    let n = 0
    // The prompt lands anywhere in a tick, and the host says it is working a moment after.
    for (const offset of [0, 10, 120, 240]) {
      n += 1
      await turn($, { turnId: `before-${n}` })
      await clock.advance(3.5 * 60_000)
      const band = await mount($, 'terminal')
      const asleep = (text: string) => text.includes('▂███▂█')
      expect([motion, offset, asleep((await band.look()).text)]).toEqual([motion, offset, true])
      const frames = await filmBoth(clock, band, null, 2_000, {
        [500 + offset]: async () => {
          await $.prompt.submit({ text: 'wake up', wait: false, origin: { kind: 'composer' } })
        },
        [560 + offset]: () => band.ui.redraw({ ...BAND, isWorking: true }),
      })
      // Every frame is him asleep, or already the turn's words: never his eyes open beside the last turn's.
      const lagging = frames.filter(frame => !asleep(frame.term) && !frame.term.includes('Thinking it over')).map(frame => frame.at)
      expect([motion, offset, lagging]).toEqual([motion, offset, []])
      expect([motion, offset, frames.at(-1)?.term.includes('Thinking it over')]).toEqual([motion, offset, true])
      await band.ui.unmount()
      await $.turn.complete({ answer: '', durationMs: 1_000, turnId: `woke-${n}`, reason: 'answer', isAborted: false } as TurnCompleteInput)
      await clock.advance(10_000)
    }
  })
}

// A prompt's "Thinking it over" comes as the prompt does on both looks, wherever it lands in a tick:
// the hearth's terminal never waits for its next tick, which would put it up to a tick behind the
// beach's and the desktop's.
for (const look of ['tide', 'hearth'] as const) {
  test(`terminal, ${look}: a prompt's "Thinking it over" comes at once, wherever it lands in a tick, as on the desktop`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await run($, look)
    let n = 0
    for (const offset of [0, 10, 60, 120, 180, 240]) {
      n += 1
      await turn($, { turnId: `before-${n}` })
      await clock.advance(20_000)
      const band = await mount($, 'terminal')
      const frames = await filmBoth(clock, band, null, 1_000, {
        [100 + offset]: async () => {
          await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
        },
      })
      const at = frames.find(frame => frame.term.includes('Thinking it over'))?.at ?? Infinity
      expect([look, offset, at - (100 + offset)]).toEqual([look, offset, 0])
      await band.ui.unmount()
      await $.turn.complete({ answer: '', durationMs: 1_000, turnId: `t-${n}`, reason: 'answer', isAborted: false } as TurnCompleteInput)
      await clock.advance(10_000)
    }
  })
}

for (const look of ['tide', 'hearth'] as const) {
  test(`${look}: a step that fails beside a running subagent has its moment, then the words go back to the subagent, and to "Thinking" once it ends, on both surfaces`, { timeoutMs: 30_000 }, async ($, on) => {
    let letGoOfSurvey: () => void = () => undefined
    const survey = new Promise<void>(resolve => {
      letGoOfSurvey = resolve
    })
    const { clock } = world(on, { onCall: async (tool, e) => (e.description === 'Survey the hooks folder' ? survey : undefined) })
    await start($)
    await run($, look)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true, bodyColumns: 120 }
    const term = await mount($, 'terminal', busy)
    const desk = await mount($, 'desktop', busy)
    await term.look()
    const both = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        await clock.advance(Math.min(250, left))
        await term.wait(Math.min(250, left))
      }
      return [(await term.look()).text, (await desk.look()).text]
    }
    const surveying = $.tool.call({ tool: 'Agent', description: 'Survey the hooks folder', prompt: 'look', subagent_type: 'Explore' } as never)
    for (const text of await both(1_500)) expect([look, text]).toEqual([look, expect.stringContaining('Survey the hooks folder')])
    await $.tool.call({ tool: 'Bash', command: 'npm run lint -- fail', description: 'Lint the code' })
    // The hiccup has its second (the splash its three), and then the subagent has the line back.
    const failure = /Lint|Hiccup|failed|Splash/u
    for (const wait of look === 'hearth' ? [1_500, 2_500, 6_000, 20_000, 30_000] : [4_000, 6_000, 20_000, 30_000]) {
      for (const text of await both(wait)) {
        expect([look, wait, text]).toEqual([look, wait, expect.stringContaining('Survey the hooks folder')])
        expect([look, wait, failure.test(text)]).toEqual([look, wait, false])
      }
    }
    // The subagent ends well: nothing runs, and the failure it outlasted does not come back.
    letGoOfSurvey()
    await surveying
    for (const text of await both(2_000)) {
      expect([look, text]).toEqual([look, expect.stringContaining('Thinking')])
      expect([look, failure.test(text)]).toEqual([look, false])
    }
    await $.turn.complete({ answer: 'Done.', durationMs: 90_000, turnId: 't1', reason: 'answer', isAborted: false } as TurnCompleteInput)
    await term.ui.unmount()
    await desk.ui.unmount()
  })
}

test('terminal: /clear in the middle of a cheer or a splash ends it at once on the band already on screen, on both looks', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)
  await clock.advance(10_000)
  let n = 0
  for (const look of ['tide', 'hearth'] as const) {
    await run($, look)
    const band = await mount($, 'terminal')
    await band.look()
    for (const moment of ['cheer', 'splash'] as const) {
      n += 1
      if (moment === 'cheer') {
        await turn($, { turnId: `cheer-${n}` })
      } else {
        await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
        await band.ui.redraw({ ...BAND, isWorking: true })
        await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
      }
      // A second and a half into the cheer, half a second into the splash: /clear.
      await filmBoth(clock, band, null, moment === 'cheer' ? 1_500 : 500)
      if (moment === 'splash') {
        await $.turn.complete({ answer: '', durationMs: 2_000, turnId: `splash-${n}`, reason: 'answer', isAborted: false } as TurnCompleteInput)
        await band.ui.redraw(BAND)
      }
      const playing = (await band.look()).text
      expect([look, moment, /Done|Splash|✻|✽|✶|✢|▗▟/u.test(playing)]).toEqual([look, moment, true])
      await $.session.end({ reason: 'clear', sessionId: `s-${n}`, resume: { id: `s-${n}` } })
      // From two ticks after /clear on (a busy second waits for room, as every change does): the fresh
      // conversation's words, and Clawd at rest beside them.
      const after = (await filmBoth(clock, band, null, 4_000)).filter(frame => frame.at >= 500)
      for (const frame of after) {
        expect([look, moment, frame.at, frame.term.includes('Ready')]).toEqual([look, moment, frame.at, true])
        expect([look, moment, frame.at, /Done|Splash|failed|Hiccup|✻|✽|✶|✢|▗▟/u.test(frame.term)]).toEqual([look, moment, frame.at, false])
      }
      await filmBoth(clock, band, null, 2_000)
    }
    await band.ui.unmount()
  }
})

for (const isMarked of [true, false]) {
  test(`Esc while a command runs is no failure of Claude's${isMarked ? '' : ', even when nothing at the call’s end says so'}: no splash, no hiccup, no flinch, on both looks and both surfaces`, { timeoutMs: 60_000 }, async ($, on) => {
    let release: () => void = () => undefined
    const { clock } = world(on, {
      onCall: async (tool, e) =>
        e.description === 'Run the tests'
          ? new Promise<void>(resolve => {
              release = resolve
            })
          : undefined,
    })
    const facts = factsOf(on)
    await start($)
    let n = 0
    for (const look of ['tide', 'hearth'] as const) {
      n += 1
      await run($, look)
      await $.prompt.submit({ text: 'run the tests', wait: false, origin: { kind: 'composer' } })
      const busy = { ...BAND, isWorking: true }
      const term = await mount($, 'terminal', busy)
      const desk = await mount($, 'desktop', busy)
      await term.look()
      const command = isMarked ? 'npm test -- interrupted' : 'npm test -- fail'
      const running = $.tool.call({ tool: 'Bash', command, description: 'Run the tests' }).catch(() => undefined)
      await filmBoth(clock, term, desk, 2_000)
      const before = (await desk.look()).source
      // Esc: the call settles in an error, and the turn says it was stopped 30 ms later.
      const frames = await filmBoth(clock, term, desk, 4_000, {
        0: async () => {
          release()
          await running
        },
        30: async () => {
          await $.turn.complete({ answer: '', durationMs: 5_000, turnId: `esc-${n}`, reason: 'aborted', isAborted: true } as TurnCompleteInput)
        },
        60: async () => {
          await term.ui.redraw(BAND)
          await desk.ui.redraw(BAND)
        },
      })
      const failure = /Splash|Hiccup|failed/u
      // With the abort's own words at the call's end, nothing of a failure ever shows, and the desktop
      // loads one new frame, the stopped turn's. Without them, the turn's end takes it back at once.
      const watched = isMarked ? frames : frames.filter(frame => frame.at >= 250)
      for (const frame of watched) {
        expect([look, frame.at, failure.test(frame.term), failure.test(frame.desk), /splash|flinch/iu.test(frame.alt)]).toEqual([look, frame.at, false, false, false])
      }
      if (isMarked) {
        expect([look, new Set(frames.map(frame => frame.source).filter(source => source !== before)).size]).toEqual([look, 1])
      }
      expect([look, frames.at(-1)?.term, frames.at(-1)?.desk]).toEqual([look, expect.stringContaining('Stopped after 5s'), expect.stringContaining('Stopped after 5s')])
      // Taken back whole: the failure and its wave's start, so no band mounted from here carries on its splash.
      expect([look, facts().oopsAt, facts().splashAt]).toEqual([look, null, null])
      await term.ui.unmount()
      await desk.ui.unmount()
      await clock.advance(10_000)
    }
  })
}

test('hearth: a subagent sent with no task in words that fails reads "Hiccup · A subagent", as the beach names it, never "Hiccup · Delegating"', { options: { look: 'hearth' } }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  const busy = { ...BAND, isWorking: true }
  const term = await mount($, 'terminal', busy)
  const desk = await mount($, 'desktop', busy)
  await term.look()
  await $.tool.call({ tool: 'Agent', prompt: 'fail', subagent_type: 'Explore' } as never)
  await clock.advance(250)
  await term.wait(250)
  for (const text of [(await term.look()).text, (await desk.look()).text].map(seen => seen.replace(/\n/gu, ''))) {
    expect(text).toContain('Hiccup · A subagent')
    expect(text).not.toContain('Delegating')
  }
})

const PLUMBING = new Set(['ToolSearch', 'BashOutput', 'EnterWorktree', 'ExitWorktree', 'SendMessage', 'KillShell', 'TaskStop', 'TaskOutput', 'memory_list'])

// A tool with nothing to name that fails: the hearth says what it was doing in a few words, as a
// described command does ("Hiccup · Run the tests"), never its running verb ("Hiccup · Finding
// tools"); the beach says the phrase itself, unquoted: it is no order to quote.
const PHRASE_FAILS = [
  { call: { tool: 'ToolSearch', query: 'fail' }, hiccup: 'Hiccup · Find tools', splash: 'Splash! Finding tools failed' },
  { call: { tool: 'BashOutput', bash_id: 'fail' }, hiccup: 'Hiccup · Check on a command', splash: 'Splash! Checking on a command failed' },
  { call: { tool: 'EnterWorktree', name: 'fail' }, hiccup: 'Hiccup · Enter a worktree', splash: 'Splash! Entering a worktree failed' },
  { call: { tool: 'memory_list', note: 'fail' }, hiccup: 'Hiccup · Use memory list', splash: 'Splash! Using memory list failed' },
] as const
for (const { call, hiccup, splash } of PHRASE_FAILS) {
  test(`${call.tool} failing reads "${hiccup}" on the hearth and "${splash}" on the beach`, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    for (const look of ['hearth', 'tide'] as const) {
      await run($, look)
      const busy = { ...BAND, isWorking: true, bodyColumns: 120 }
      const term = await mount($, 'terminal', busy)
      const desk = await mount($, 'desktop', busy)
      await term.look()
      await $.tool.call(call as never)
      await clock.advance(250)
      await term.wait(250)
      for (const text of [(await term.look()).text, (await desk.look()).text].map(seen => seen.replace(/\n/gu, '').replace(/[“”]/gu, '"'))) {
        expect([look, text.includes(look === 'hearth' ? hiccup : splash)]).toEqual([look, true])
        expect([look, text.includes('"')]).toEqual([look, false])
      }
      await term.ui.unmount()
      await desk.ui.unmount()
      await clock.advance(5_000)
    }
  })
}

// A hiccup on a narrow hearth: a set phrase whole, else what failed in a word ("Hiccup · A command"
// for a command looked in on or stopped, "Hiccup · A task" for a task, "Hiccup · A tool" for any
// other), else "Hiccup" alone; words
// quoted as what failed (a described command) keep two words at least before an ellipsis. Never one
// word and an ellipsis, which reads as an order cut off ("Hiccup · Find…", "Hiccup · Check…",
// "Hiccup · Enter…", "Hiccup · Use send…").
const HICCUPS: ReadonlyArray<{ call: Record<string, unknown>; forms: ReadonlyArray<string | RegExp> }> = [
  { call: { tool: 'BashOutput', bash_id: 'fail' }, forms: ['Hiccup · Check on a command', 'Hiccup · A command', 'Hiccup · A tool', 'Hiccup'] },
  { call: { tool: 'KillShell', shell_id: 'fail' }, forms: ['Hiccup · Stop a command', 'Hiccup · A command', 'Hiccup · A tool', 'Hiccup'] },
  // A task in the background is a task, not a command ("Hiccup · A command").
  // (And only a task: "Hiccup · A tool" is just as short, so it would only show where the desktop's
  // font fits it a pixel before "Hiccup · A task".)
  { call: { tool: 'TaskStop', task_id: 'fail' }, forms: ['Hiccup · Stop a task', 'Hiccup · A task', 'Hiccup'] },
  { call: { tool: 'EnterWorktree', name: 'fail' }, forms: ['Hiccup · Enter a worktree', 'Hiccup · A tool', 'Hiccup'] },
  { call: { tool: 'ExitWorktree', action: 'fail' }, forms: ['Hiccup · Leave the worktree', 'Hiccup · A tool', 'Hiccup'] },
  { call: { tool: 'ToolSearch', query: 'fail' }, forms: ['Hiccup · Find tools', 'Hiccup · A tool', 'Hiccup'] },
  { call: { tool: 'SendMessage', to: 'fail', message: 'hi' }, forms: ['Hiccup · Send a message', 'Hiccup · A tool', 'Hiccup'] },
  {
    call: { tool: 'Bash', command: 'npm run build -- fail', description: 'Check why the build fails' },
    forms: ['Hiccup · Check why the build fails', /^Hiccup · Check why the build…$/u, 'Hiccup · A command', 'Hiccup · A tool', 'Hiccup'],
  },
]
for (const { call, forms } of HICCUPS) {
  test(`hearth: ${String(call.tool)}${call.description === undefined ? '' : ' (described)'} failing on a band of 34 to 60 columns reads its phrase whole, then what failed in a word, then "Hiccup", on both surfaces: never a word and an ellipsis`, { options: { look: 'hearth' }, timeoutMs: 60_000 }, async ($, on) => {
    world(on)
    await start($)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    await $.tool.call(call as never)
    for (const surface of SURFACES) {
      const shown: number[] = []
      for (let columns = 34; columns <= 60; columns++) {
        const { ui, look, wait } = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await look()
        await wait(250)
        const text = painted((await look()).tree).replace(/\s+/gu, ' ')
        // Line 3, the hearth's last: from its "Hiccup".
        const third = text.slice(text.indexOf('Hiccup')).trim()
        const label = [String(call.tool), surface, columns, third]
        const at = forms.findIndex(form => (typeof form === 'string' ? third === form : form.test(third)))
        expect([...label, at >= 0]).toEqual([...label, true])
        shown.push(at)
        await ui.unmount()
      }
      // A wider band never says less: each form only takes away from the one before.
      expect([String(call.tool), surface, shown]).toEqual([String(call.tool), surface, [...shown].sort((a, b) => b - a)])
      // The widest says it whole, and a noun stands in before "Hiccup" goes bare.
      expect([String(call.tool), surface, shown.at(-1), shown.includes(forms.length - 1)]).toEqual([String(call.tool), surface, 0, false])
      // The word for a command or a task is a rung of its own, in its exact words, at some width.
      for (const noun of ['Hiccup · A command', 'Hiccup · A task']) {
        if (forms.includes(noun)) expect([String(call.tool), surface, noun, shown.includes(forms.indexOf(noun))]).toEqual([String(call.tool), surface, noun, true])
      }
    }
  })
}

// A task in the background that fails says "Hiccup · A task" and never "Hiccup · A tool": the two are
// just as short, and the desktop's proportional font fits "A tool" 3 px before "A task", the less
// exact word for whatever room falls between. Every width from the narrowest to the widest, and every
// room a line might have to the tenth of a pixel, so a page measuring its own cell wider or narrower
// never finds that gap either.
// The hearth desktop's measure: its glyph table, and two cells of gap between the words and a figure.
const HEARTH_PX: Measure = { row: row => row.reduce((sum, seg) => sum + textPx(seg.text, seg.bold === true), 0), gap: 2 * 7.6 }
for (const call of [{ tool: 'TaskStop', task_id: 'fail' }, { tool: 'TaskOutput', task_id: 'fail' }]) {
  test(`hearth, desktop: ${call.tool} failing reads "Hiccup · A task" where its phrase has no room, never "Hiccup · A tool", at 34 to 160 columns or any room between`, { options: { look: 'hearth' }, timeoutMs: 60_000 }, async ($, on) => {
    const said = { isWorking: true, activity: null, slip: describe('t', call), todos: null, isHigh: false, percent: 42, limit: null, lastTurn: null, resetsAt: null, isLanding: false } as unknown as Said
    const fit = (room: number) => firstFit(happeningForms(said), room, HEARTH_PX)
    const lines = new Set<string>()
    for (let room = 0; room <= 3_000; room += 1) {
      const line = fit(room / 10)
      lines.add([...line.left, ...(line.squeeze ?? []), ...(line.tail ?? [])].map(seg => seg.text).join(''))
    }
    expect([call.tool, [...lines].filter(line => line.includes('A tool'))]).toEqual([call.tool, []])
    world(on)
    await start($)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    await $.tool.call(call as never)
    const nouns = new Set<string>()
    for (let columns = 34; columns <= 160; columns++) {
      const { ui, look } = await mount($, 'desktop', { ...BAND, bodyColumns: columns, isWorking: true })
      const text = painted((await look()).tree).replace(/\s+/gu, ' ')
      const third = text.slice(text.indexOf('Hiccup')).trim()
      expect([call.tool, columns, third.startsWith('Hiccup'), third.includes('A tool')]).toEqual([call.tool, columns, true, false])
      nouns.add(third)
      await ui.unmount()
    }
    expect([call.tool, nouns.has('Hiccup · A task')]).toEqual([call.tool, true])
  })
}

// A tool at a name that fails on a narrow hearth: its name (cut where it must be), then what the
// name is in a word ("Hiccup · A file", "Hiccup · A search", "Hiccup · A page"), then "Hiccup · A
// tool": never a bare "Hiccup" from 34 columns up, for a pattern that is never cut (Glob) or a file
// name at the narrowest widths (Edit, Read, WebFetch, NotebookEdit).
const NAMED_HICCUPS: ReadonlyArray<{ call: Record<string, unknown>; noun: string }> = [
  { call: { tool: 'Glob', pattern: '**/*.failing.tsx' }, noun: 'Hiccup · A search' },
  { call: { tool: 'Grep', pattern: 'registerBandHooks' }, noun: 'Hiccup · A search' },
  { call: { tool: 'Edit', file_path: '/w/hooks/register.tsx', old_string: 'a', new_string: 'b' }, noun: 'Hiccup · A file' },
  { call: { tool: 'Read', file_path: '/w/hooks/register.tsx' }, noun: 'Hiccup · A file' },
  { call: { tool: 'NotebookEdit', notebook_path: '/w/notes/exploring-the-tides.ipynb', new_source: 'x' }, noun: 'Hiccup · A file' },
  { call: { tool: 'WebFetch', url: 'https://docs.anthropic.com/en/docs', prompt: 'read it' }, noun: 'Hiccup · A page' },
  { call: { tool: 'LS', path: '/w/hooks/tide/clawd-sprites' }, noun: 'Hiccup · A folder' },
]
for (const { call, noun } of NAMED_HICCUPS) {
  test(`hearth: ${String(call.tool)} failing on a band of 34 to 60 columns reads its name, then "${noun}", never a bare "Hiccup", on both surfaces`, { options: { look: 'hearth' }, timeoutMs: 60_000 }, async ($, on) => {
    const failing = { isOn: false }
    world(on, { failing })
    await start($)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    failing.isOn = true
    await $.tool.call(call as never)
    failing.isOn = false
    // Its name, whole or cut ("Hiccup · regist…"), is one word with no space in it.
    const forms = [/^Hiccup · [^\s·]+$/u, noun, 'Hiccup · A tool', 'Hiccup']
    for (const surface of SURFACES) {
      const shown: number[] = []
      for (let columns = 34; columns <= 60; columns++) {
        const { ui, look, wait } = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await look()
        await wait(250)
        const text = painted((await look()).tree).replace(/\s+/gu, ' ')
        const third = text.slice(text.indexOf('Hiccup')).trim()
        const label = [String(call.tool), surface, columns, third]
        const at = forms.findIndex(form => (typeof form === 'string' ? third === form : form.test(third)))
        expect([...label, at >= 0, at === forms.length - 1]).toEqual([...label, true, false])
        shown.push(at)
        await ui.unmount()
      }
      expect([String(call.tool), surface, shown]).toEqual([String(call.tool), surface, [...shown].sort((a, b) => b - a)])
      expect([String(call.tool), surface, shown.at(-1)]).toEqual([String(call.tool), surface, 0])
      // What the name is, in its own word, is a rung of its own: never straight from the name to "A tool".
      // (Where the name, cut, fits down to 34 columns, neither shows.)
      expect([String(call.tool), surface, noun, shown.some(at => at >= 2) ? shown.includes(1) : true]).toEqual([String(call.tool), surface, noun, true])
    }
  })
}

// The beach's failure ladder, during the splash and after it: the quote (a described command's), a
// word for what failed (a phrase says it: "Finding tools"), then "A command" under a command's own
// phrase, then "A tool", which any failure is, and only then the verdict alone ("Splash!", "Failed").
// One step at a time, at every width, on both surfaces: never from the phrase straight to a bare
// "Failed" or "Splash!" with rungs between them left out.
const LADDERS: ReadonlyArray<{ call: Record<string, unknown>; quotes: RegExp | null; nouns: readonly string[] }> = [
  { call: { tool: 'EnterWorktree', name: 'fail' }, quotes: null, nouns: ['Entering a worktree', 'A tool'] },
  { call: { tool: 'ToolSearch', query: 'fail' }, quotes: null, nouns: ['Finding tools', 'A tool'] },
  { call: { tool: 'BashOutput', bash_id: 'fail' }, quotes: null, nouns: ['Checking on a command', 'A command', 'A tool'] },
  // A task in the background is a task ('Splash! A task failed'), not a command, and only a task:
  // "A tool" is just as short, so its rung would only show where the desktop's proportional font fits
  // the one a pixel before the other, for a single column.
  { call: { tool: 'TaskStop', task_id: 'fail' }, quotes: null, nouns: ['Stopping a task', 'A task'] },
  { call: { tool: 'SendMessage', to: 'fail', message: 'hi' }, quotes: null, nouns: ['Sending a message', 'A tool'] },
  { call: { tool: 'Bash', command: 'npm run build -- fail', description: 'Check why the build fails' }, quotes: /^"Check why the build(?: fails|…)" failed$/u, nouns: ['A command', 'A tool'] },
  // A tool at a name says what it did to what, as the hearth names it ("Hiccup · A search"), before
  // "A tool", so the beach never says "A tool failed" where the hearth names it.
  { call: { tool: 'Glob', pattern: '**/*.failing.tsx' }, quotes: /^"Search for [^"]+" failed$/u, nouns: ['A search', 'A tool'] },
  { call: { tool: 'Grep', pattern: 'registerBandHooks' }, quotes: /^"Search for [^"]+" failed$/u, nouns: ['A search', 'A tool'] },
  { call: { tool: 'Read', file_path: '/w/hooks/register.tsx' }, quotes: /^"Read [^"]+" failed$/u, nouns: ['A file read', 'A tool'] },
  { call: { tool: 'Edit', file_path: '/w/hooks/register.tsx', old_string: 'a', new_string: 'b' }, quotes: /^"Edit [^"]+" failed$/u, nouns: ['A file edit', 'A tool'] },
  { call: { tool: 'Write', file_path: '/w/hooks/tide/clawd-sprites.tsx', content: 'x' }, quotes: /^"Write [^"]+" failed$/u, nouns: ['A file write', 'A tool'] },
  { call: { tool: 'NotebookEdit', notebook_path: '/w/notes/exploring-the-tides.ipynb', new_source: 'x' }, quotes: /^"Edit [^"]+" failed$/u, nouns: ['A file edit', 'A tool'] },
  // ("A page" is as short as "A tool", and stands in for it.)
  { call: { tool: 'WebFetch', url: 'https://docs.anthropic.com/en/docs', prompt: 'read it' }, quotes: /^"Read [^"]+" failed$/u, nouns: ['A page'] },
  { call: { tool: 'LS', path: '/w/hooks/tide/clawd-sprites' }, quotes: /^"List [^"]+" failed$/u, nouns: ['A listing', 'A tool'] },
]
for (const { call, quotes, nouns } of LADDERS) {
  test(`tide: ${String(call.tool)}${call.description === undefined ? '' : ' (described)'} failing steps down its ladder one rung at a time at 34 to 70 columns, during the splash and after, on both surfaces: "A tool failed" before the verdict alone`, { timeoutMs: 60_000 }, async ($, on) => {
    const failing = { isOn: false }
    const { clock } = world(on, { failing })
    await start($)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    failing.isOn = true
    await $.tool.call(call as never)
    failing.isOn = false
    for (const when of ['splash', 'after'] as const) {
      // Narrow to wide: the verdict alone, then each word for what failed, the least particular first, then the quote.
      const ladder = [when === 'splash' ? 'Splash!' : 'Failed', ...[...nouns].reverse().map(noun => (when === 'splash' ? `Splash! ${noun} failed` : `${noun} failed`))]
      for (const surface of SURFACES) {
        const shown: number[] = []
        for (let columns = 34; columns <= 70; columns++) {
          const { ui, look, wait } = await mount($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
          await look()
          await wait(250)
          const seen = await look()
          const line = ((surface === 'terminal' ? seen.rows[3] : seen.rows[0]) ?? '').replace(/[“”]/gu, '"').trim()
          const rung = ladder.indexOf(line)
          const isQuote = quotes !== null && quotes.test(line.replace(/^Splash! /u, ''))
          expect([String(call.tool), when, surface, columns, line, rung >= 0 || isQuote]).toEqual([String(call.tool), when, surface, columns, line, true])
          shown.push(isQuote ? ladder.length : rung)
          await ui.unmount()
        }
        const label = [String(call.tool), when, surface]
        // A wider band never says less.
        expect([...label, shown]).toEqual([...label, [...shown].sort((a, b) => a - b)])
        // The verdict alone only below "A tool failed", or below a word for what failed that is just as
        // short ("A task failed": the terminal's even cells fit the two at the same widths, and the more
        // particular one wins): never straight from a longer word for what failed.
        if (shown.includes(0) && shown.some(rung => rung > 1)) {
          const least = Math.min(...shown.filter(rung => rung > 0))
          const noun = [...nouns].reverse()[least - 1] ?? ''
          expect([...label, noun, least === 1 || noun.length === 'A tool'.length]).toEqual([...label, noun, true])
        }
        // "Failed" alone only where "A tool failed" has no room: the terminal's narrowest band (34
        // columns, twelve cells of words), never one wider.
        if (when === 'after') expect([...label, shown.slice(surface === 'terminal' ? 1 : 0).includes(0)]).toEqual([...label, false])
        // Each word for what failed is a rung of its own, in its exact words, at some width: a phrase,
        // a command, a task, a search, a file read (all but "A tool", which an equally short word
        // before it may stand in for).
        for (const noun of nouns.filter(noun => noun !== 'A tool')) {
          const rung = ladder.indexOf(when === 'splash' ? `Splash! ${noun} failed` : `${noun} failed`)
          expect([...label, noun, shown.includes(rung)]).toEqual([...label, noun, true])
        }
      }
      await clock.advance(3_500)
    }
  })
}

for (const motion of ['lively', 'still'] as const) {
  test(`terminal, ${motion}: a beach band mounted afresh just after a /band switch takes a pet at once; one swapped in under the hearth's band on screen keeps that band's last second`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await clock.advance(10_000)
    // When the pet's first frame shows, in ms after the click, filmed every 10 ms on the band's clock.
    const petted = async (seen: Awaited<ReturnType<typeof mount>>) => {
      const before = (await seen.look()).text
      await seen.ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' })
      await seen.ui.pointer({ type: 'up', x: 8, y: 1, button: 'left', in: 'band' })
      for (let at = 0; at <= 1_000; at += 10) {
        if ((await seen.look()).text !== before) return at
        await seen.ui.advance(10)
      }

      return null
    }
    // No band on screen through the switch (a band mounted afresh after it): the beach put up then has
    // no second to keep pace with, and the pet shows on the spot.
    await run($, `hearth ${motion}`)
    await run($, `tide ${motion}`)
    const fresh = await mount($, 'terminal')
    expect([motion, 'fresh', fresh !== null && (await fresh.look()).key]).toEqual([motion, 'fresh', 'band'])
    expect([motion, 'fresh', await petted(fresh)]).toEqual([motion, 'fresh', 0])
    await fresh.ui.unmount()
    await clock.advance(10_000)
    // Swapped in where the hearth's band stood a moment ago: the hearth may have changed on each of
    // its last ticks, so the beach's first changes wait for room in that second (see pace.ts).
    await run($, `hearth ${motion}`)
    const swapped = await mount($, 'terminal')
    expect((await swapped.look()).key).toBe('hearth')
    await swapped.ui.advance(1_000)
    await run($, `tide ${motion}`)
    expect((await swapped.look()).key).toBe('band')
    const at = await petted(swapped)
    expect([motion, 'swapped', at !== null && at >= 250]).toEqual([motion, 'swapped', true])
    await swapped.ui.unmount()
  })
}

for (const look of ['tide', 'hearth'] as const) {
  test(`${look}: a subagent Esc stopped before its end came never comes back in the next turn, on both surfaces`, { timeoutMs: 30_000 }, async ($, on) => {
    let letGo: () => void = () => undefined
    const stuck = new Promise<void>(resolve => {
      letGo = resolve
    })
    const { clock } = world(on, { onCall: async (tool, e) => (e.description === 'Survey the hooks folder' ? stuck : undefined) })
    await start($)
    await run($, look)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true, bodyColumns: 120 }
    const term = await mount($, 'terminal', busy)
    const desk = await mount($, 'desktop', busy)
    await term.look()
    const both = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        await clock.advance(Math.min(250, left))
        await term.wait(Math.min(250, left))
      }
      return [(await term.look()).text, (await desk.look()).text]
    }
    const surveying = $.tool.call({ tool: 'Agent', description: 'Survey the hooks folder', prompt: 'look', subagent_type: 'Explore' } as never)
    for (const text of await both(1_500)) expect([look, text]).toEqual([look, expect.stringContaining('Survey the hooks folder')])
    // Esc: the turn ends, and the subagent's end never comes while the next turn runs.
    await $.turn.complete({ answer: '', durationMs: 3_000, turnId: 't1', reason: 'aborted', isAborted: true } as TurnCompleteInput)
    await both(2_000)
    await $.prompt.submit({ text: 'just read it', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Read', file_path: '/work/hooks/look.ts' })
    // The read over, nothing of this turn runs: "Thinking it over", never the old subagent.
    for (const wait of [1_500, 3_000]) {
      for (const text of await both(wait)) {
        expect([look, wait, text]).toEqual([look, wait, expect.stringContaining('Thinking')])
        expect([look, wait, /Survey|Delegating/u.test(text)]).toEqual([look, wait, false])
      }
    }
    letGo()
    await surveying
    await term.ui.unmount()
    await desk.ui.unmount()
  })

  test(`${look}: a step that fails after its own turn was stopped never splashes in the next turn, on both surfaces`, { timeoutMs: 30_000 }, async ($, on) => {
    let letGo: () => void = () => undefined
    const stuck = new Promise<void>(resolve => {
      letGo = resolve
    })
    let letReadGo: () => void = () => undefined
    const reading = new Promise<void>(resolve => {
      letReadGo = resolve
    })
    const { clock } = world(on, { onCall: async (tool, e) => (e.description === 'Wait a while' ? stuck : tool === 'Read' ? reading : undefined) })
    await start($)
    await run($, look)
    await $.prompt.submit({ text: 'wait for it', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true, bodyColumns: 120 }
    const term = await mount($, 'terminal', busy)
    const desk = await mount($, 'desktop', busy)
    await term.look()
    const both = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        await clock.advance(Math.min(250, left))
        await term.wait(Math.min(250, left))
      }
      return [(await term.look()).text, (await desk.look()).text, (await desk.look()).alt]
    }
    const waiting = $.tool.call({ tool: 'Bash', command: 'sleep 100 -- fail', description: 'Wait a while' })
    await both(1_500)
    await $.turn.complete({ answer: '', durationMs: 2_000, turnId: 't1', reason: 'aborted', isAborted: true } as TurnCompleteInput)
    await both(2_000)
    // The next turn reads a file; the stopped command ends with an error as it does.
    await $.prompt.submit({ text: 'read it instead', wait: false, origin: { kind: 'composer' } })
    const read = $.tool.call({ tool: 'Read', file_path: '/work/hooks/look.ts' })
    await both(1_500)
    letGo()
    await waiting
    for (const wait of [250, 1_000, 2_000, 3_500]) {
      for (const text of await both(wait)) {
        expect([look, wait, /Splash|Hiccup|failed|Wait a while|flinch|splash/u.test(text)]).toEqual([look, wait, false])
      }
    }
    letReadGo()
    await read
    await term.ui.unmount()
    await desk.ui.unmount()
  })
}

// Quick tools, as Claude Code runs them: a Read or an Edit of 5 to 80 ms, a second and a half to three
// apart, starting anywhere in a tick. The desktop's words are held in the facts, so it gives most of
// them their second; the terminal, whose frame clock ticks every 250 ms, must too, or it would miss
// nearly all.
for (const look of ['tide', 'hearth'] as const) {
  test(`terminal, ${look}: a tool that starts and ends between two ticks shows whenever the desktop shows it, within a tick, for its second, at four changes a second at most`, { timeoutMs: 120_000 }, async ($, on) => {
    const gates = new Map<string, Promise<void>>()
    const { clock } = world(on, { onCall: async (tool, e) => gates.get(String(e.file_path)) })
    await start($)
    await run($, look)
    await $.prompt.submit({ text: 'tidy the hooks', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true }
    const term = await mount($, 'terminal', busy)
    const desk = await mount($, 'desktop', busy)
    await term.look()
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
    const lasting = [5, 30, 80, 10, 50, 20, 70, 40]
    const gaps = [1_530, 2_710, 1_840, 2_290, 1_660, 2_930, 2_020, 2_480]
    // When each tool starts, and so ends, in ms from the first frame.
    const starts = gaps.map((_, i) => 1_000 + gaps.slice(0, i).reduce((sum, one) => sum + one, 0) + (i * 70) % 250)
    const frames: Array<{ at: number; term: string; desk: string }> = []
    let at = 0
    const step = async (ms: number) => {
      await clock.advance(ms)
      await term.ui.advance(ms)
      at += ms
      frames.push({ at, term: (await term.look()).text, desk: `${(await desk.look()).text}\n${(await desk.look()).alt}` })
    }
    const until = (starts.at(-1) ?? 0) + 4_000
    let next = 0
    while (at < until) {
      const begins = starts[next]
      if (begins !== undefined && at >= begins) {
        const name = names[next] ?? ''
        const path = `/work/hooks/${name}.ts`
        let letGo: () => void = () => undefined
        gates.set(path, new Promise<void>(resolve => (letGo = resolve)))
        const call = next % 3 === 2 ? { tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' } : { tool: 'Read', file_path: path }
        const calling = $.tool.call(call as never)
        for (let left = lasting[next] ?? 0; left > 0; left -= Math.min(10, left)) await step(Math.min(10, left))
        letGo()
        await calling
        next += 1
      }
      await step(10)
    }
    const shown = (side: 'term' | 'desk', name: string) => frames.filter(frame => frame[side].includes(`${name}.ts`)).map(frame => frame.at)
    const onDesk = names.filter(name => shown('desk', name).length > 0)
    // The desktop shows most of them (one that starts as "Thinking" goes up waits behind its second).
    expect(onDesk.length).toBeGreaterThanOrEqual(5)
    for (const name of onDesk) {
      const [deskAt, termAt] = [shown('desk', name)[0] ?? Infinity, shown('term', name)[0] ?? Infinity]
      expect([look, name, termAt - deskAt <= 250]).toEqual([look, name, true])
    }
    // Each tool the terminal shows stays up its second at least, and no second has more than four changes.
    for (const name of names) {
      const times = shown('term', name)
      if (times.length > 0) expect([look, name, (times.at(-1) ?? 0) - (times[0] ?? 0) >= 990]).toEqual([look, name, true])
    }
    const changes = frames.filter((frame, i) => i > 0 && frame.term !== frames[i - 1]?.term).map(frame => frame.at)
    expect([look, busiest(changes)]).toEqual([look, Math.min(4, busiest(changes))])
    await term.ui.unmount()
    await desk.ui.unmount()
  })
}

// Tools that start and end with no redraw in between (a 0 ms Read: its start and its end land in one
// go), as a quick tool often does in a real session, where whether a redraw falls inside a call is up
// to Ink's throttle. Both surfaces draw the one held step the facts keep (stepDesk, stepHeld): the
// terminal names the very tools the desktop names, within a tick, in a calm stretch or a burst, never
// only what a redraw happened to catch while a tool ran (here no redraw falls inside any of the 8).
// A pet a moment into a burst (its spin or heart takes the frame's changes for a while) leaves the
// terminal no further behind than a tick, and only while it lasts: the line catches up with the
// desktop once a tool has had its second, rather than carrying the lag through the rest of the burst.
const ZERO_MS_RUNS = [
  ['1.2 to 2.4 s apart', [1_210, 2_390, 1_530, 1_980, 2_270, 1_350, 2_120, 1_760], null],
  ['in a burst, 200 to 900 ms apart', [200, 450, 900, 260, 610, 330, 880, 520, 240, 700, 410], null],
  ['1.5 to 1.8 s apart, with a pet mid-way through a tool\'s second', [1_560, 1_710, 1_620, 1_790, 1_530, 1_680, 1_750, 1_590], 1_400],
] as const
for (const look of ['tide', 'hearth'] as const) {
  for (const [label, gaps, petAt] of ZERO_MS_RUNS) {
    test(`terminal, ${look}: tools with no redraw while they run (0 ms) show on the terminal exactly when the desktop shows them, ${label}: the same names, within a tick, at four changes a second at most`, { timeoutMs: 120_000 }, async ($, on) => {
      const { clock } = world(on)
      await start($)
      await run($, look)
      await $.prompt.submit({ text: 'tidy the hooks', wait: false, origin: { kind: 'composer' } })
      const busy = { ...BAND, isWorking: true }
      const term = await mount($, 'terminal', busy)
      const desk = await mount($, 'desktop', busy)
      await term.look()
      const names = gaps.map((_, i) => ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo'][i] ?? `n${i}`)
      // When each tool runs, in ms from the first frame, landing anywhere in a tick.
      const starts = gaps.map((_, i) => 1_000 + gaps.slice(0, i).reduce((sum, one) => sum + one, 0) + (i * 70) % 250)
      const key = (await term.look()).key ?? ''
      let isPetted = petAt === null
      const frames: Array<{ at: number; term: string; desk: string }> = []
      let at = 0
      const step = async (ms: number) => {
        await clock.advance(ms)
        await term.ui.advance(ms)
        at += ms
        const seen = await desk.look()
        frames.push({ at, term: (await term.look()).text, desk: `${seen.text}\n${seen.alt}` })
      }
      const until = (starts.at(-1) ?? 0) + 4_000
      let next = 0
      while (at < until) {
        const begins = starts[next]
        if (!isPetted && at >= (petAt ?? 0)) {
          isPetted = true
          await term.ui.pointer({ type: 'down', x: look === 'tide' ? 7 : 4, y: 1, button: 'left', in: key })
        }
        if (begins !== undefined && at >= begins) {
          const path = `/work/hooks/${names[next] ?? ''}.ts`
          await $.tool.call((next % 3 === 2 ? { tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' } : { tool: 'Read', file_path: path }) as never)
          next += 1
        }
        await step(10)
      }
      const shown = (side: 'term' | 'desk', name: string) => frames.filter(frame => frame[side].includes(`${name}.ts`)).map(frame => frame.at)
      const onDesk = names.filter(name => shown('desk', name).length > 0)
      const onTerm = names.filter(name => shown('term', name).length > 0)
      // The desktop names the tools (a burst: some of them, each its second); the terminal names the same ones.
      expect([look, onDesk.length >= Math.min(4, names.length)]).toEqual([look, true])
      expect([look, onTerm]).toEqual([look, onDesk])
      for (const name of onDesk) {
        const [deskFrom, termFrom] = [shown('desk', name)[0] ?? Infinity, shown('term', name)[0] ?? Infinity]
        const [deskTo, termTo] = [shown('desk', name).at(-1) ?? 0, shown('term', name).at(-1) ?? 0]
        // On within a tick of the desktop, and off within a tick of it, and up its second at least.
        expect([look, name, termFrom - deskFrom >= 0 && termFrom - deskFrom <= 250, Math.abs(termTo - deskTo) <= 250, termTo - termFrom >= 990]).toEqual([look, name, true, true, true])
      }
      const changes = frames.filter((frame, i) => i > 0 && frame.term !== frames[i - 1]?.term).map(frame => frame.at)
      expect([look, busiest(changes)]).toEqual([look, Math.min(4, busiest(changes))])
      await term.ui.unmount()
      await desk.ui.unmount()
    })
  }
}

// A turn as Claude Code runs one, filmed every 10 ms on both surfaces at once: each step a tool (its
// input, how long it runs) and the pause after it. Returns what each surface said at each moment (the
// terminal's text, the desktop's text and its alt, and the hearth terminal's Clawd), and when each
// step started.
type Step = { call: Record<string, unknown>; ms: number; gap: number }
async function filmTurn($: Engine, on: On, look: Look, steps: readonly Step[], columns = 64, before: (clock: ReturnType<typeof world>['clock']) => Promise<void> = async () => undefined) {
  const gates = new Map<string, Promise<void>>()
  const keyOf = (e: Record<string, unknown>) => String(e.file_path ?? e.pattern ?? e.url ?? e.description ?? (e.todos === undefined ? '' : 'todos'))
  const { clock } = world(on, { onCall: async (tool, e) => gates.get(keyOf(e)) })
  await start($, 31)
  await run($, look)
  await before(clock)
  await $.prompt.submit({ text: 'tidy the band', wait: false, origin: { kind: 'composer' } })
  const busy = { ...BAND, isWorking: true, bodyColumns: columns }
  const term = await mount($, 'terminal', busy)
  const desk = await mount($, 'desktop', busy)
  await term.look()
  const frames: Array<{ at: number; term: string; desk: string; pose: string; source: string }> = []
  let at = 0
  const step = async (ms: number) => {
    await clock.advance(ms)
    await term.ui.advance(ms)
    at += ms
    const seen = await desk.look()
    const drawn = await term.look()
    // The hearth's Clawd and his marks: the first six rows of its tree (his three, the marks' three).
    frames.push({ at, term: drawn.text, desk: `${seen.text}\n${seen.alt}`, pose: drawn.rows.slice(0, 6).join('\n'), source: seen.source })
  }
  const starts: number[] = []
  await step(10)
  for (const { call, ms, gap } of steps) {
    let letGo: () => void = () => undefined
    gates.set(keyOf(call), new Promise<void>(resolve => (letGo = resolve)))
    starts.push(at)
    const calling = $.tool.call(call as never).catch(() => undefined)
    for (let left = ms; left > 0; left -= 10) await step(10)
    letGo()
    await calling
    gates.delete(keyOf(call))
    for (let left = gap; left > 0; left -= 10) await step(10)
  }
  await term.ui.unmount()
  await desk.ui.unmount()

  return { frames, starts }
}

/** What a line says, by the first of `labels` in it (else its text): one label per run of frames. */
function said(frames: ReadonlyArray<{ at: number; term: string; desk: string }>, side: 'term' | 'desk', labels: readonly string[], from = 0): Array<{ label: string; at: number }> {
  const runs: Array<{ label: string; at: number }> = []
  for (const frame of frames) {
    if (frame.at < from) continue
    const text = frame[side].replace(/\s+/gu, ' ').trim()
    const label = labels.find(one => text.includes(one)) ?? text
    if (runs.at(-1)?.label !== label) runs.push({ label, at: frame.at })
  }

  return runs
}

// The tail of a real turn, as Claude Code ran it: a look round (a Glob and two
// Reads), a TodoWrite that puts "Run the tests" in progress, two seconds of thought, an Edit of 80 ms,
// and the answer being written. The plan's todo is on the line half a second after the TodoWrite
// lands (a step that started in that half second would have brought it: see tallied), so "Planning"
// never comes back after it, and the Edit is named as it runs, on both looks and both surfaces.
const REAL_TAIL: readonly Step[] = [
  { call: { tool: 'WebFetch', url: 'https://docs.anthropic.com/en/docs/claude-code/hooks', prompt: 'x' }, ms: 1_800, gap: 900 },
  { call: { tool: 'Glob', pattern: '**/*.tsx' }, ms: 20, gap: 150 },
  { call: { tool: 'Read', file_path: '/w/hooks/hearth/band.tsx' }, ms: 30, gap: 100 },
  { call: { tool: 'Read', file_path: '/w/hooks/hearth/desk.tsx' }, ms: 30, gap: 100 },
  {
    call: { tool: 'TodoWrite', todos: [{ content: 'Tidy the band', status: 'completed', activeForm: 'Tidying the band' }, { content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' }] },
    ms: 10,
    gap: 2_000,
  },
  { call: { tool: 'Edit', file_path: '/w/hooks/hearth/band.tsx', old_string: 'a', new_string: 'b' }, ms: 80, gap: 2_500 },
]
for (const look of ['tide', 'hearth'] as const) {
  test(`${look}: a plan's todo on the line never goes back to "Planning", and the Edit after it is named as it runs, on both surfaces`, { timeoutMs: 120_000 }, async ($, on) => {
    const { frames, starts } = await filmTurn($, on, look, REAL_TAIL)
    const labels = ['Planning', 'Running the tests', 'Editing band.tsx', 'Reading', 'Searching', 'Thinking it over']
    const planAt = starts[4] ?? 0
    const editAt = starts[5] ?? 0
    for (const side of ['term', 'desk'] as const) {
      // From the moment the TodoWrite has landed: its todo, the Edit, its todo again.
      // (The hearth's terminal takes a line change that is no turn's start or end on its next tick.)
      const after = said(frames, side, labels, planAt + (side === 'term' && look === 'hearth' ? 260 : 20))
      // ("Thinking it over" stays while the todo waits its half second, and the terminal's next tick.)
      const todoAt = after.find(run => run.label === 'Running the tests')?.at ?? Infinity
      expect([look, side, todoAt - (planAt + 10) <= TALLY_WAIT_MS + (side === 'term' ? 270 : 20)]).toEqual([look, side, true])
      expect([look, side, after.filter(run => run.at >= todoAt).map(run => run.label)]).toEqual([look, side, ['Running the tests', 'Editing band.tsx', 'Running the tests']])
      expect([look, side, after.filter(run => run.at < todoAt).map(run => run.label)]).toEqual([look, side, after[0]?.at === todoAt ? [] : ['Thinking it over']])
      // The Edit is named as it starts (the terminal on its next tick at the latest).
      const edit = after.find(run => run.label === 'Editing band.tsx')?.at ?? Infinity
      expect([look, side, edit - editAt <= (side === 'term' ? 260 : 10)]).toEqual([look, side, true])
    }
  })
}

// A todo ticked off (TodoWrite) while the line is on its way to another step comes up with that step,
// on all four views, so the line changes once; with no step coming it shows on its own half a second
// later, a step of its own: never "Searching … 1 of 3 done" for a moment before the read, nor "Doing
// step 1 · 1 of 3 done" for a tick before a read 50 ms after the TodoWrite.
// Each way a line can be on its way to its next step holds a todo ticked off meanwhile for that step,
// so the line changes once, on both looks: the step on the line is over (the next tool comes within
// the pause); a tool the hold kept off the line is owed its second; a tool runs that the hold keeps
// off the line. Each case has only its own way true. The line as both looks have it, every 10 ms: the
// step (or the todo at work, on the line with no tool on it) and how many todos its tally says are done.
const todoList = (done: number): Todo[] => [0, 1, 2].map(i => ({ id: String(i + 1), subject: `Step ${i}`, activeForm: `Doing step ${i}`, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }))
function lineFilm(start: Info, changes: ReadonlyMap<number, Partial<Info>>, from: number, to: number): { desk: string[]; held: string[] } {
  const said = (activity: Activity | null | undefined, todos: Todo[] | undefined) => {
    const list = todos ?? []
    const atWork = list.find(todo => todo.status === 'in_progress')?.subject ?? '-'
    return `${activity?.id ?? atWork} · ${list.filter(todo => todo.status === 'completed').length}`
  }
  let known = start
  const film = { desk: [] as string[], held: [] as string[] }
  for (let at = from; at <= to; at += 10) {
    known = stepBoth(known, at, changes.get(at) ?? {})
    for (const [side, now] of [['desk', said(known.desk.activity, known.desk.todos)], ['held', said(known.held.activity, known.held.todos)]] as const) {
      if (film[side].at(-1) !== now) film[side].push(now)
    }
  }
  return film
}
test('a todo ticked off waits for the step the line is on its way to, by each way it can be on its way, on both looks', () => {
  const read: Activity = { id: 'r', kind: 'read', verb: 'Reading', target: 'alpha.ts', what: 'Read alpha.ts' }
  const edit: Activity = { id: 'e', kind: 'edit', verb: 'Editing', target: 'alpha.ts', what: 'Edit alpha.ts' }
  const glob: Activity = { id: 'g', kind: 'read', verb: 'Searching for', target: '**/*.ts', what: 'Search for **/*.ts' }
  const ask: Activity = { id: 'q', kind: 'ask', verb: 'Asking you', target: 'Auth method', what: 'Ask you a question' }
  const open: Info = { ...EMPTY, isTurnOpen: true, todos: todoList(0) }
  // The todo's own line, up since 10 s as a step of its own.
  const onTodo: Info = { ...open, desk: { activity: null, shownAt: 10_000, next: null, todos: todoList(0) }, held: { ...NOTHING_HELD, at: 10_000, todos: todoList(0) } }
  const cases: ReadonlyArray<{ name: string; start: Info; changes: Array<[number, Partial<Info>]>; says: string[] }> = [
    {
      // The read on the line is over; the todo is ticked off in the pause after it, and an edit
      // starts 700 ms later, inside the pause: the edit brings the tally.
      name: 'the step on the line is over',
      start: open,
      changes: [
        [10_000, { activity: read, running: [read] }],
        [10_100, { activity: null, running: [], toolEndedAt: 10_100 }],
        [10_300, { todos: todoList(1), toolEndedAt: 10_300 }],
        [11_000, { activity: edit, running: [edit] }],
      ],
      says: ['r · 0', 'e · 1'],
    },
    {
      // A search starts and ends under the todo's own line, so the hold keeps it off; the todo is
      // ticked off, and the search has its second as the hold ends, bringing the tally.
      name: 'a tool the hold kept off the line is owed its second',
      start: onTodo,
      changes: [
        [10_100, { activity: glob, running: [glob] }],
        [10_150, { activity: null, running: [], toolEndedAt: 10_150 }],
        [10_200, { todos: todoList(1), toolEndedAt: 10_200 }],
      ],
      says: ['Step 0 · 0', 'g · 1'],
    },
    {
      // A question asked beside the todo's own line waits for the hold; the todo is ticked off in the
      // same breath, and the question takes the line as the hold ends, bringing the tally.
      name: 'a tool runs that the hold keeps off the line',
      start: onTodo,
      changes: [
        [10_100, { activity: ask, running: [ask] }],
        [10_200, { todos: todoList(1), toolEndedAt: 10_200 }],
      ],
      says: ['Step 0 · 0', 'q · 1'],
    },
  ]
  for (const { name, start, changes, says } of cases) {
    const film = lineFilm(start, new Map(changes), 10_000, 11_900)
    expect([name, film.desk, film.held]).toEqual([name, says, says])
  }
})

// However long the line stays on its way, a todo ticked off shows on its own two seconds after it
// lands at most: under a splash, a tool waiting to take the line as the wave ends never keeps the
// tally back for the whole three seconds of it.
test('a todo ticked off shows on its own two seconds after it lands, at most, while the line stays on its way', () => {
  const run: Activity = { id: 'b', kind: 'run', verb: '', target: 'Run the tests', what: 'Run the tests' }
  const read: Activity = { id: 'r', kind: 'read', verb: 'Reading', target: 'alpha.ts', what: 'Read alpha.ts' }
  const start: Info = { ...EMPTY, isTurnOpen: true, todos: todoList(0), desk: { activity: run, shownAt: 9_000, next: null, todos: todoList(0) }, activity: run, running: [run] }
  const failed: Partial<Info> = { activity: null, running: [], toolEndedAt: 10_000, oops: 1, oopsAt: 10_000, splashAt: 10_000, waves: 1, slip: run, lastSlip: run, slipDue: run }
  let known = stepBoth(start, 10_000, failed)
  known = stepBoth(known, 10_400, { activity: read, running: [read] })
  known = stepBoth(known, 10_500, { todos: todoList(1), toolEndedAt: 10_500 })
  let shown: number | null = null
  for (let at = 10_510; at <= 13_500 && shown === null; at += 10) {
    known = stepBoth(known, at)
    if (known.desk.todos?.[0]?.status === 'completed') shown = at
  }
  expect([shown, known.desk.activity?.id ?? null]).toEqual([10_500 + TALLY_MOST_MS, null])
})

const TICK = (done: number) => ({
  tool: 'TodoWrite',
  todos: [0, 1, 2].map(i => ({ content: `Step ${i}`, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending', activeForm: `Doing step ${i}` })),
})
// What each frame says, step and tally: "Searching **/*.5.ts · 0", "Doing step 1 · 1".
function talliedSteps(frames: ReadonlyArray<{ at: number; term: string; desk: string }>, side: 'term' | 'desk', from: number): Array<{ said: string; at: number }> {
  const runs: Array<{ said: string; at: number }> = []
  for (const frame of frames) {
    if (frame.at < from) continue
    const text = frame[side].replace(/\s+/gu, ' ')
    const step = /Searching(?: for)? (\S+)|Reading (f\d\.ts)|Doing step \d|Planning|Thinking it over/u.exec(text)
    const tally = /(\d)(?: of |\/)3 done/u.exec(text)?.[1] ?? '-'
    const said = `${step === null ? '?' : step[1] !== undefined ? `Searching ${step[1]}` : step[2] !== undefined ? `Reading ${step[2]}` : step[0]} · ${tally}`
    if (runs.at(-1)?.said !== said) runs.push({ said, at: frame.at })
  }

  return runs
}
const TALLY_CASES: ReadonlyArray<{ name: string; steps: readonly Step[]; from: number; says: readonly string[] }> = [
  {
    // A search has the line; a todo is ticked off in its second, and a read starts after: the read
    // brings the tally. Twice in one turn, the second a quick grep's.
    name: 'a todo ticked off in a search\'s second, twice',
    steps: [
      { call: TICK(0), ms: 10, gap: 1_990 },
      { call: { tool: 'Glob', pattern: '**/*.5.ts' }, ms: 10, gap: 590 },
      { call: TICK(1), ms: 10, gap: 300 },
      { call: { tool: 'Read', file_path: '/w/f6.ts' }, ms: 30, gap: 2_200 },
      { call: { tool: 'Grep', pattern: 'f7' }, ms: 10, gap: 100 },
      { call: TICK(2), ms: 10, gap: 50 },
      { call: { tool: 'Read', file_path: '/w/f7.ts' }, ms: 30, gap: 2_500 },
    ],
    from: 2_300,
    says: ['Searching **/*.5.ts · 0', 'Reading f6.ts · 1', 'Doing step 1 · 1', 'Searching f7 · 1', 'Reading f7.ts · 2', 'Doing step 2 · 2'],
  },
  {
    // A todo's own line has been up 800 ms with a search waiting behind it; the todo is ticked off and
    // a read starts 50 ms later (in the same breath): the read takes the line, with the tally.
    name: 'a todo ticked off while its own line waits on a search',
    steps: [
      { call: TICK(0), ms: 10, gap: 1_790 },
      { call: { tool: 'Glob', pattern: '**/*.5.ts' }, ms: 10, gap: 0 },
      { call: TICK(1), ms: 10, gap: 50 },
      { call: { tool: 'Read', file_path: '/w/f6.ts' }, ms: 30, gap: 2_500 },
    ],
    from: 1_400,
    says: ['Doing step 0 · 0', 'Reading f6.ts · 1', 'Doing step 1 · 1'],
  },
]
for (const look of ['tide', 'hearth'] as const) {
  for (const { name, steps, from, says } of TALLY_CASES) {
    test(`${look}: ${name}: the tally comes up with the step after it, one change of the line, on both surfaces`, { timeoutMs: 120_000 }, async ($, on) => {
      const { frames, starts } = await filmTurn($, on, look, steps, 100)
      for (const side of ['term', 'desk'] as const) {
        const runs = talliedSteps(frames, side, (starts[0] ?? 0) + from)
        expect([look, side, runs.map(run => run.said)]).toEqual([look, side, says])
      }
    })
  }
  // With no step to bring it, a todo ticked off shows on its own half a second after it lands (the
  // terminal on its next tick): never at once, and never later. Its todo, on the line with no tool on
  // it, is then a step of its own: a read 100 ms later waits for it to have its second.
  test(`${look}: a todo ticked off with no step after it shows on its own half a second later, and has its second, on both surfaces`, { timeoutMs: 120_000 }, async ($, on) => {
    const steps: Step[] = [
      { call: TICK(0), ms: 10, gap: 1_990 },
      { call: { tool: 'Read', file_path: '/w/f5.ts' }, ms: 30, gap: 1_000 },
      { call: TICK(1), ms: 10, gap: 600 },
      { call: { tool: 'Read', file_path: '/w/f6.ts' }, ms: 30, gap: 2_500 },
    ]
    const { frames, starts } = await filmTurn($, on, look, steps, 100)
    const landed = (starts[2] ?? 0) + 10
    for (const side of ['term', 'desk'] as const) {
      const runs = talliedSteps(frames, side, (starts[1] ?? 0) + 300)
      expect([look, side, runs.map(run => run.said)]).toEqual([look, side, ['Reading f5.ts · 0', 'Doing step 0 · 0', 'Doing step 1 · 1', 'Reading f6.ts · 1', 'Doing step 1 · 1']])
      const [at = Infinity, read = Infinity] = runs.slice(2, 4).map(run => run.at)
      expect([look, side, at - landed >= TALLY_WAIT_MS, at - landed <= TALLY_WAIT_MS + (side === 'term' ? 270 : 20), read - at >= 990]).toEqual([look, side, true, true, true])
    }
  })
}

// The hearth terminal's Clawd through a working stretch: a long fetch and a look round (his glances at
// the words), a step that fails, and quick tools after it. Each pose he strikes (a glance, a blink, a
// claw tap, a step) is up a tick at least: only a turn's start, its landing or a failure changes him
// between ticks: a new line, and the pose that goes with it, taken the moment the facts move,
// whatever tick it is, would cut a beat already up to 10 to 120 ms.
test('terminal, hearth: every pose Clawd strikes is up a tick at least; only a failure changes him between ticks', { timeoutMs: 120_000 }, async ($, on) => {
  const steps: Step[] = [
    ...REAL_TAIL.slice(0, 4),
    { ...FAIL, gap: 640 },
    { call: { tool: 'Read', file_path: '/w/after.ts' }, ms: 30, gap: 1_130 },
    { call: { tool: 'Grep', pattern: 'pose' }, ms: 20, gap: 470 },
    { call: { tool: 'Edit', file_path: '/w/after.ts', old_string: 'a', new_string: 'b' }, ms: 80, gap: 2_000 },
  ]
  const { frames, starts } = await filmTurn($, on, 'hearth', steps)
  const failedAt = (starts[4] ?? 0) + FAIL.ms
  const poses: Array<{ pose: string; at: number }> = []
  for (const frame of frames) {
    if (poses.at(-1)?.pose !== frame.pose) poses.push({ pose: frame.pose, at: frame.at })
  }
  // He did move: glances, blinks, taps, the flinch.
  expect(poses.length >= 8).toBe(true)
  // (The first pose went up as the band did, before the film's first frame; the last is still up.)
  const short = poses.slice(1, -1).filter((run, i) => {
    const end = poses[i + 2]?.at ?? Infinity
    const isFailure = end >= failedAt && end <= failedAt + 20

    return end - run.at < 250 && !isFailure
  })
  expect(short.map(run => run.at)).toEqual([])
})

// A turn that lands a moment after its last read has shown: the glance Clawd began as the read
// showed has its tick, and then he cheers (cut to 50 to 140 ms, it would be a flash before the cheer).
for (const late of [50, 90, 140]) {
  test(`terminal, hearth: a turn that lands ${late} ms after a read shows lets his glance have its tick, then cheers`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await run($, 'hearth')
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true }
    const term = await mount($, 'terminal', busy)
    await term.look()
    const frames: Array<{ at: number; pose: string; text: string }> = []
    let at = 0
    const step = async (ms: number) => {
      await clock.advance(ms)
      await term.ui.advance(ms)
      at += ms
      const seen = await term.look()
      frames.push({ at, pose: seen.rows.slice(0, 6).join('\n'), text: seen.text })
    }
    for (let k = 0; k < 200; k++) await step(10)
    // The read starts between ticks, with the frame on screen up a while: it shows at once, and he glances.
    await step(30)
    await $.tool.call({ tool: 'Read', file_path: '/w/last.ts' })
    const readAt = at
    for (let left = late; left > 0; left -= 10) await step(10)
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, turnId: 'late', reason: 'answer', isAborted: false } as TurnCompleteInput)
    await term.ui.redraw({ ...BAND, isWorking: false })
    const landedAt = at
    for (let k = 0; k < 150; k++) await step(10)
    const after = frames.filter(frame => frame.at > readAt)
    const poses: Array<{ pose: string; at: number }> = []
    for (const frame of after) if (poses.at(-1)?.pose !== frame.pose) poses.push({ pose: frame.pose, at: frame.at })
    // He glanced as the read showed, and that pose was up a tick before the cheer's first.
    expect([late, poses.length >= 2, (poses[1]?.at ?? 0) - (poses[0]?.at ?? 0) >= 250]).toEqual([late, true, true])
    // The cheer came with its words, within two ticks of the landing (the glance, put up between two
    // ticks, keeps the next one too: see pace.ts), and his pose and the words moved together.
    const cheered = after.find(frame => frame.at >= landedAt && frame.text.includes('Done in 9s'))
    expect([late, (cheered?.at ?? Infinity) - landedAt <= 500, cheered?.at]).toEqual([late, true, poses[1]?.at])
    await term.ui.unmount()
  })
}

// A failure, then quick reads while the beach's splash plays (Claude reading the error and looking
// around): the splash is the line for its seconds, and as it ends the line moves on to a read that is
// still owed its second, for a whole second, on both surfaces alike; or to nothing, never a read that
// ended long before: never a flash of the read the hold kept, for its last 10 to 400 ms, on one
// surface while the other skips it.
const FAIL: Step = { call: { tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' }, ms: 300, gap: 0 }
const SPLASH_RUNS: ReadonlyArray<{ label: string; first: number; reads: number; every: number; owed: string | null }> = [
  { label: 'a read 2.1 s in', first: 2_100, reads: 1, every: 0, owed: null },
  { label: 'a read 2.4 s in', first: 2_400, reads: 1, every: 0, owed: 't0.ts' },
  { label: 'three reads 1.2 s in', first: 1_200, reads: 3, every: 0, owed: null },
  { label: 'three reads 2.6 s in', first: 2_600, reads: 3, every: 0, owed: 't2.ts' },
  { label: 'a read every 370 ms through the splash', first: 370, reads: 10, every: 370, owed: 't7.ts' },
]
for (const { label, first, reads, every, owed } of SPLASH_RUNS) {
  test(`tide: the splash is the line for its seconds, and hands on to a read still owed its second, for a whole second, or to none, on both surfaces: ${label}`, { timeoutMs: 120_000 }, async ($, on) => {
    const names = Array.from({ length: reads }, (_, i) => `t${i}.ts`)
    const steps: Step[] = [
      { ...FAIL, gap: first },
      ...names.map((name, i): Step => ({ call: { tool: 'Read', file_path: `/w/${name}` }, ms: 0, gap: i === reads - 1 ? 4_000 : every })),
    ]
    const { frames, starts } = await filmTurn($, on, 'tide', steps)
    const failedAt = (starts[0] ?? 0) + FAIL.ms
    const splashEnd = failedAt + SPLASH_MS
    for (const side of ['term', 'desk'] as const) {
      // Once the splash is over: the read still owed its second, or none at all; never one that ended
      // long before, and never a moment of the line before the splash's end hands it on.
      const runs = said(frames, side, ['Splash!', ...names, 'Thinking it over', 'failed'], failedAt).filter(run => run.at >= splashEnd - 250 && run.label !== 'Splash!')
      const shown = runs.filter(run => names.includes(run.label))
      expect([sideOf(side), shown[0]?.label ?? null]).toEqual([sideOf(side), owed])
      // As the splash ends: on the desktop with it, on the terminal by its next tick.
      if (shown[0] !== undefined) expect([sideOf(side), shown[0].at - splashEnd >= 0, shown[0].at - splashEnd <= (side === 'term' ? 260 : 20)]).toEqual([sideOf(side), true, true])
      // Every read named after the splash is up a second at least.
      for (const run of shown) {
        const end = runs.find(other => other.at > run.at)?.at ?? Infinity
        expect([sideOf(side), run.label, end - run.at >= 990]).toEqual([sideOf(side), run.label, true])
      }
    }
    // Both surfaces name the same reads after the splash, in the same order.
    const named = (side: 'term' | 'desk') => said(frames, side, names, splashEnd - 250).filter(run => names.includes(run.label)).map(run => run.label)
    expect(named('term')).toEqual(named('desk'))
  })
}
const sideOf = (side: 'term' | 'desk') => `tide ${side}`

// A second failure in the first rush of the beach's wave (SPLASH_RUSH_MS) rides along with it: one
// wave, one end, on the terminal's frames and words and the desktop's wave and words alike. One after
// that rush starts a wave of its own. The terminal never ends the splash with its own first wave
// while the desktop's words wait for the second failure's three seconds, which would show the dim
// failed line, or the next tool, beside a desktop still saying Splash!.
// A quick read 2.6 s after the first failure is owed its second as a riding wave ends, and has long
// ended by the time a later wave does.
const LINT_FAIL = { tool: 'Bash', command: 'npm run lint -- fail', description: 'Run the linter' }
for (const motion of ['lively', 'still'] as const) {
  for (const columns of [64, 100] as const) {
    for (const apart of [60, 300, 700, 1_200, 1_800] as const) {
      for (const isRead of [false, true]) {
        test(`tide, ${motion}, ${columns} columns: a second failure ${apart} ms after the first${isRead ? ', then a quick read,' : ''} ${apart < 1_250 ? 'rides along with its wave and ends with it' : 'starts a wave of its own'}, on both surfaces at once`, { timeoutMs: 60_000 }, async ($, on) => {
          const second = Math.min(apart, 300)
          const steps: Step[] = [
            { ...FAIL, gap: apart - second },
            { call: LINT_FAIL, ms: second, gap: isRead ? 2_600 - apart : 4_200 },
            ...(isRead ? [{ call: { tool: 'Read', file_path: '/w/r.ts' }, ms: 0, gap: 4_000 }] : []),
          ]
          const { frames, starts } = await filmTurn($, on, 'tide', steps, columns, async () => {
            if (motion === 'still') await run($, 'still')
          })
          const firstAt = (starts[0] ?? 0) + FAIL.ms
          const waveEnd = (apart < 1_250 ? firstAt : firstAt + apart) + SPLASH_MS
          const label = `${motion} ${columns} ${apart}${isRead ? ' read' : ''}`
          // Line 1: the terminal's fourth row (under his three), the desktop's first line.
          const line1 = frames.map(frame => ({ at: frame.at, term: frame.term.split('\n')[3] ?? '', desk: frame.desk.split('\n')[0] ?? '' }))
          const labels = ['Splash!', 'r.ts', 'linter', 'the tests', 'Thinking it over']
          const ends: Record<'term' | 'desk', number> = { term: 0, desk: 0 }
          for (const side of ['term', 'desk'] as const) {
            const runs = said(line1, side, labels, firstAt)
            // The splash's words, from the first failure to the end of its wave, without a break.
            const splashes = runs.filter(run => run.label === 'Splash!')
            const end = runs.find(run => run.at > (splashes.at(-1)?.at ?? Infinity))?.at ?? Infinity
            ends[side] = end
            expect([label, side, splashes.length, splashes[0] !== undefined && splashes[0].at - firstAt <= (side === 'term' ? 260 : 20)]).toEqual([label, side, 1, true])
            // It ends as the wave does: on the desktop with it, on the terminal by its next tick.
            expect([label, side, end - waveEnd >= 0, end - waveEnd <= (side === 'term' ? 260 : 20)]).toEqual([label, side, true, true])
            // After it, every line holds a second at least (the film's last, open-ended, aside).
            const after = runs.filter(run => run.at >= end)
            for (const [i, run] of after.slice(0, -1).entries()) {
              expect([label, side, run.label, (after[i + 1]?.at ?? Infinity) - run.at >= 990]).toEqual([label, side, run.label, true])
            }
            // The read still owed its second as a riding wave ends is named; one long over by a later
            // wave's end is not, and having started since the failure, it leaves "Thinking it over".
            expect([label, side, after[0]?.label]).toEqual([label, side, isRead ? (apart < 1_250 ? 'r.ts' : 'Thinking it over') : 'linter'])
          }
          // Both surfaces leave the splash within a tick of each other.
          expect([label, ends.term - ends.desk >= 0 && ends.term - ends.desk <= 260]).toEqual([label, true])
          // The desktop's wave is the one its words follow: a riding failure never reloads the frame
          // (so the wave plays on from the first and ends with the words), and a new wave does, once.
          // (Still, the splash is one held frame, which a new wave holds on.)
          const sources = frames.filter(frame => frame.at > firstAt + 20 && frame.at < waveEnd - 20).map(frame => frame.source)
          const reloads = sources.filter((source, i) => i > 0 && source !== sources[i - 1]).length
          expect([label, reloads]).toEqual([label, apart < 1_250 || motion === 'still' ? 0 : 1])
          if (motion === 'still') {
            // Still, the splash is one held frame (the wave at his feet): it gives way as its words do.
            const held = frames.find(frame => frame.at >= waveEnd - 20 && frame.source !== (sources.at(-1) ?? ''))?.at ?? Infinity
            expect([label, held - waveEnd >= 0 && held - waveEnd <= 20]).toEqual([label, true])
          }
        })
      }
    }
  }
}

// A band mounted afresh late in a splash (a /config reload, a dialog closing) has too little of it
// left to carry the wave on, so he is at rest; its words do not go with him, which would put the next
// line up as much as 700 ms before the desktop's. The words are the wave's until the facts say it is over.
for (const motion of ['lively', 'still'] as const) {
  test(`tide, ${motion}: a terminal band mounted afresh mid-splash says "Splash!" until the desktop's words move on, then within a tick`, { timeoutMs: 60_000 }, async ($, on) => {
    const gates = new Map<string, Promise<void>>()
    const { clock } = world(on, { onCall: async (tool, e) => gates.get(String(e.description ?? '')) })
    await start($, 31)
    await run($, 'tide')
    if (motion === 'still') await run($, 'still')
    await $.prompt.submit({ text: 'tidy the band', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true, bodyColumns: 64 }
    for (const cut of [1_000, 2_050, 2_300, 2_700, 2_960]) {
      await clock.advance(10_000)
      let term = await mount($, 'terminal', busy)
      const desk = await mount($, 'desktop', busy)
      await term.look()
      const frames: Array<{ at: number; term: string; desk: string }> = []
      let at = 0
      const step = async (ms: number) => {
        await clock.advance(ms)
        await term.ui.advance(ms)
        at += ms
        frames.push({ at, term: (await term.look()).text.split('\n')[3] ?? '', desk: (await desk.look()).text.split('\n')[0] ?? '' })
      }
      await step(10)
      let letGo: () => void = () => undefined
      gates.set('Run the tests', new Promise<void>(resolve => (letGo = resolve)))
      const calling = $.tool.call(FAIL.call as never).catch(() => undefined)
      for (let left = FAIL.ms; left > 0; left -= 10) await step(10)
      letGo()
      await calling
      const failedAt = at
      while (at < failedAt + cut) await step(10)
      // The reload: the terminal's band starts over, its own clock with it.
      await term.ui.unmount()
      term = await mount($, 'terminal', busy)
      await term.look()
      while (at < failedAt + 4_000) await step(10)
      const end = (side: 'term' | 'desk') => frames.find(frame => frame.at > failedAt + cut && !frame[side].includes('Splash!'))?.at ?? Infinity
      // The desktop's words go with the wave; the fresh terminal's say "Splash!" until then, and move on by its next tick.
      expect([motion, cut, end('desk') - failedAt >= SPLASH_MS, end('desk') - failedAt <= SPLASH_MS + 20]).toEqual([motion, cut, true, true])
      expect([motion, cut, end('term') - end('desk') >= 0, end('term') - end('desk') <= 260]).toEqual([motion, cut, true, true])
      await term.ui.unmount()
      await desk.ui.unmount()
    }
  })
}

// A switch to the beach mid-splash never draws Clawd dry and at rest under a bold 'Splash! "Run the
// tests" failed', which the desktop, opening at rest, never says. The words are the wave's only on the
// look that was on screen as it began: a look switched to after opens on the dim line, on both
// surfaces, and it holds. Nor does the terminal carry on a wave this look never drew: the beach
// carries a wave on only where it saw it begin, so both surfaces open the same, at any point.
for (const motion of ['lively', 'still'] as const) {
  for (const from of ['tide', 'hearth'] as const) {
    test(`tide, ${motion}: a switch to the beach from ${from === 'tide' ? 'the hearth it went to mid-splash' : 'the hearth'} at any point in the splash opens at rest on the dim line on both surfaces, never "Splash!"`, { options: { look: from }, timeoutMs: 180_000 }, async ($, on) => {
      const gates = new Map<string, Promise<void>>()
      const { clock } = world(on, { onCall: async (tool, e) => gates.get(String(e.description ?? '')) })
      await start($, 31)
      if (motion === 'still') await run($, 'still')
      await $.prompt.submit({ text: 'tidy the band', wait: false, origin: { kind: 'composer' } })
      const busy = { ...BAND, isWorking: true, bodyColumns: 64 }
      const term = await mount($, 'terminal', busy)
      const desk = await mount($, 'desktop', busy)
      for (const back of [...(from === 'tide' ? [1_500, 2_000] : [400, 1_200, 1_800, 2_200]), 2_400, 2_600, 2_800]) {
        await clock.advance(10_000)
        await term.ui.advance(10_000)
        await term.look()
        const frames: Array<{ at: number; look: Look | null; term: string; desk: string }> = []
        let at = 0
        const step = async (ms: number) => {
          await clock.advance(ms)
          await term.ui.advance(ms)
          at += ms
          const seen = await term.look()
          frames.push({ at, look: seen.look, term: seen.look === 'tide' ? (seen.rows[3] ?? '') : '', desk: (await desk.look()).text.split('\n')[0] ?? '' })
        }
        let letGo: () => void = () => undefined
        gates.set('Run the tests', new Promise<void>(resolve => (letGo = resolve)))
        const calling = $.tool.call(FAIL.call as never).catch(() => undefined)
        for (let left = FAIL.ms; left > 0; left -= 10) await step(10)
        letGo()
        await calling
        const failedAt = at
        if (from === 'tide') {
          while (at < failedAt + 1_000) await step(10)
          await run($, 'hearth')
        }
        while (at < failedAt + back) await step(10)
        await run($, 'tide')
        const switchedAt = at
        while (at < failedAt + 4_500) await step(10)
        const after = frames.filter(frame => frame.at > switchedAt)
        const label = `${motion} ${from} ${back}`
        expect([label, after.every(frame => frame.look === 'tide')]).toEqual([label, true])
        // Neither surface names the splash on the look switched to...
        expect([label, after.filter(frame => frame.term.includes('Splash!') || frame.desk.includes('Splash!')).length]).toEqual([label, 0])
        // ...and the line it opens on stays, with nothing new to say (no flash of one thing, then another).
        const lines = [...new Set(after.map(frame => frame.term))]
        expect([label, lines]).toEqual([label, ['"Run the tests" failed']])
        expect([label, [...new Set(after.map(frame => frame.desk))]]).toEqual([label, ['“Run the tests” failed']])
        if (from === 'hearth') await run($, 'hearth')
      }
      await term.ui.unmount()
      await desk.ui.unmount()
    })
  }
}

// /band lively mid-splash on a still beach: like a look switch, both surfaces open at rest on the dim
// line of what failed, never "Splash!" on one beside a calm beach on the other, and never the lively
// wave's ebb carried on from a wave the still frame held.
test('tide: /band lively at any point in a still splash opens at rest on the dim line on both surfaces, never "Splash!"', { timeoutMs: 180_000 }, async ($, on) => {
  const gates = new Map<string, Promise<void>>()
  const { clock } = world(on, { onCall: async (tool, e) => gates.get(String(e.description ?? '')) })
  await start($, 31)
  await $.prompt.submit({ text: 'tidy the band', wait: false, origin: { kind: 'composer' } })
  const busy = { ...BAND, isWorking: true, bodyColumns: 64 }
  const term = await mount($, 'terminal', busy)
  const desk = await mount($, 'desktop', busy)
  for (const back of [400, 1_200, 1_800, 2_200, 2_600]) {
    await run($, 'still')
    await clock.advance(10_000)
    await term.ui.advance(10_000)
    await term.look()
    const frames: Array<{ at: number; term: string; scene: string; desk: string }> = []
    let at = 0
    const step = async (ms: number) => {
      await clock.advance(ms)
      await term.ui.advance(ms)
      at += ms
      const seen = await term.look()
      frames.push({ at, term: seen.rows[3] ?? '', scene: seen.rows.slice(0, 3).join('\n'), desk: (await desk.look()).text.split('\n')[0] ?? '' })
    }
    let letGo: () => void = () => undefined
    gates.set('Run the tests', new Promise<void>(resolve => (letGo = resolve)))
    const calling = $.tool.call(FAIL.call as never).catch(() => undefined)
    for (let left = FAIL.ms; left > 0; left -= 10) await step(10)
    letGo()
    await calling
    const failedAt = at
    while (at < failedAt + back) await step(10)
    // Still, the splash is one held frame, "Splash!" beside it on both surfaces.
    expect([back, frames.at(-1)?.term.includes('Splash!'), frames.at(-1)?.desk.includes('Splash!')]).toEqual([back, true, true])
    await run($, 'lively')
    const switchedAt = at
    while (at < failedAt + 4_500) await step(10)
    // The desktop at once; the terminal on its next tick, as any /band switch (see pace.ts).
    const after = frames.filter(frame => frame.at > switchedAt)
    const ticked = after.filter(frame => frame.at >= switchedAt + 250)
    expect([back, after.filter(frame => frame.desk.includes('Splash!')).length, ticked.filter(frame => frame.term.includes('Splash!')).length]).toEqual([back, 0, 0])
    expect([back, [...new Set(ticked.map(frame => frame.term))]]).toEqual([back, ['"Run the tests" failed']])
    expect([back, [...new Set(after.map(frame => frame.desk))]]).toEqual([back, ['“Run the tests” failed']])
  }
  await term.ui.unmount()
  await desk.ui.unmount()
})

// Two desktops at once (a window and its pop-out, say), their beaches at different widths: each
// carries on from its own last scene. Sharing one memory, each found the other's scene new every
// time it drew, wrote it to `$.state`, and so drew again: a loop of writes and reloads.
for (const [wide, narrow] of [[100, 40], [60, 34], [44, 38]] as const) {
  test(`desktop: two tide desktops at ${wide} and ${narrow} columns each keep their scene, one source each and a write or two of it, never a loop`, { timeoutMs: 60_000 }, async ($, on) => {
    let sceneWrites = 0
    on('state.set', ($, e, next) => {
      if (JSON.stringify(e).includes('"scene"')) sceneWrites += 1
      // A loop is cut off here, so the test can say so rather than spin.
      if (sceneWrites > 200) return { value: undefined } as never
      return next(e)
    })
    const { clock } = world(on)
    await start($)
    await clock.advance(20_000)
    const a = await mount($, 'desktop', { ...BAND, bodyColumns: wide })
    await clock.advance(10)
    const first = sceneWrites
    const b = await mount($, 'desktop', { ...BAND, bodyColumns: narrow })
    const sources = { a: new Set<string>(), b: new Set<string>() }
    for (let at = 0; at < 1_000; at += 10) {
      if (at % 200 === 0) {
        await a.ui.redraw({ ...BAND, bodyColumns: wide })
        await b.ui.redraw({ ...BAND, bodyColumns: narrow })
      }
      await clock.advance(10)
      sources.a.add((await a.look()).source)
      sources.b.add((await b.look()).source)
    }
    expect([wide, narrow, sceneWrites - first]).toEqual([wide, narrow, Math.min(2, sceneWrites - first)])
    expect([wide, narrow, sources.a.size, sources.b.size]).toEqual([wide, narrow, 1, 1])
    // A turn: both beaches move on to it, each once, and the writes stay a couple per scene.
    const writes = sceneWrites
    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    await a.ui.redraw({ ...BAND, bodyColumns: wide, isWorking: true })
    await b.ui.redraw({ ...BAND, bodyColumns: narrow, isWorking: true })
    const turn = { a: new Set<string>(), b: new Set<string>() }
    for (let at = 0; at < 1_000; at += 10) {
      await clock.advance(10)
      turn.a.add((await a.look()).source)
      turn.b.add((await b.look()).source)
    }
    expect([wide, narrow, sceneWrites - writes]).toEqual([wide, narrow, Math.min(2, sceneWrites - writes)])
    expect([wide, narrow, turn.a.size, turn.b.size]).toEqual([wide, narrow, 1, 1])
    await a.ui.unmount()
    await b.ui.unmount()
  })
}

test('desktop scenes: a width drawn again after another had the screen a while starts where that frame had him; widths drawn together keep their own, and only the widest is kept', () => {
  // At work, pottering about: he walks, so where a frame has him depends on which frame it was.
  const known: Info = { ...EMPTY, percent: 42, turnPercent: 42, turnAt: T0, lastActiveAt: T0, turnWorked: true }
  const props = (columns: number, now: number) => tideProps(tideInfo(known), 'lively', true, 80, columns, now, null, true)
  const one = desktopScenes()
  const wide = one.settle(props(100, T0), T0, null)
  expect(wide.keep?.scene).toEqual(wide.scene)
  // Resized to 40 columns for five seconds, drawn now and then, and back.
  const narrow = one.settle(props(40, T0 + 7_000), T0 + 7_000, null)
  expect(narrow.scene.from).toBe(positionAt(wide.scene, 7_000))
  for (const at of [8_000, 9_000, 11_000]) expect(one.settle(props(40, T0 + at), T0 + at, null).keep).toBeUndefined()
  const back = one.settle(props(100, T0 + 12_000), T0 + 12_000, null)
  // Where the narrow frame has him now, not where the old wide frame would have.
  expect(positionAt(narrow.scene, 5_000)).not.toBe(positionAt(wide.scene, 12_000))
  expect(back.scene.from).toBe(positionAt(narrow.scene, 5_000))
  // Two desktops drawing in the same redraws: each width keeps its scene, and only the widest writes it.
  const two = desktopScenes()
  const first = [two.settle(props(100, T0), T0, null), two.settle(props(40, T0), T0, null)]
  expect(first.map(shown => shown.keep === undefined)).toEqual([false, true])
  for (const at of [10, 250, 1_500, 4_000, 9_000]) {
    const again = [two.settle(props(100, T0 + at), T0 + at, null), two.settle(props(40, T0 + at), T0 + at, null)]
    expect([at, again.map(shown => shown.keep)]).toEqual([at, [undefined, undefined]])
    expect([at, again.map(shown => shown.scene)]).toEqual([at, first.map(shown => shown.scene)])
  }
})

// A band dragged through many widths, or bands in several windows, draw at many widths together:
// each keeps its own scene, so none starts afresh on every redraw, and the widest never writes its
// copy each time.
test('desktop scenes: twelve widths drawn together each keep their own scene, redraw after redraw', () => {
  const known: Info = { ...EMPTY, percent: 42, turnPercent: 42, turnAt: T0, lastActiveAt: T0, turnWorked: true }
  const props = (columns: number, now: number) => tideProps(tideInfo(known), 'lively', true, 80, columns, now, null, true)
  const scenes = desktopScenes()
  const widths = [80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120, 124]
  const first = widths.map(columns => scenes.settle(props(columns, T0), T0, null))
  expect(new Set(first.map(shown => shown.scene.width)).size).toBe(widths.length)
  for (const at of [10, 250, 1_500, 4_000]) {
    const again = widths.map(columns => scenes.settle(props(columns, T0 + at), T0 + at, null))
    expect([at, again.map(shown => shown.keep)]).toEqual([at, widths.map(() => undefined)])
    expect([at, again.map(shown => shown.scene)]).toEqual([at, first.map(shown => shown.scene)])
  }
})

// A tool call that throws (the tool itself broke, or its dispatch was cut short) has stopped running:
// the words move on rather than keep it up until the turn ends. No splash: nothing says Claude's step failed.
for (const look of ['tide', 'hearth'] as const) {
  test(`${look}: a tool call that throws while it runs leaves the line on both surfaces, back to "Thinking", with no splash or hiccup`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on, {
      onCall: async (tool, e) => {
        if (String(e.file_path).includes('breaks')) throw new Error('the tool broke')
      },
    })
    await start($)
    await run($, look)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true }
    const term = await mount($, 'terminal', busy)
    const desk = await mount($, 'desktop', busy)
    await term.look()
    await $.tool.call({ tool: 'Read', file_path: '/work/hooks/breaks.ts' }).catch(() => undefined)
    for (let at = 0; at < 3_000; at += 250) {
      await clock.advance(250)
      await term.wait(250)
    }
    for (const seen of [await term.look(), await desk.look()]) {
      expect([look, seen.text, seen.text.includes('breaks')]).toEqual([look, seen.text, false])
      expect([look, seen.text]).toEqual([look, expect.stringContaining('Thinking')])
      expect([look, /Splash|Hiccup|failed/u.test(`${seen.text} ${seen.alt}`)]).toEqual([look, false])
    }
    await term.ui.unmount()
    await desk.ui.unmount()
  })
}

test('terminal, hearth: a turn never opens on a sideways glance, wherever his frame clock stands; his first look away while thinking comes five seconds in', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await run($, 'hearth')
  let n = 0
  // His frame clock at any point of the old sixteen-second cycle (whose glance was at its fifth second) as the prompt lands.
  for (const ticks of [14, 18, 19, 21, 23, 40]) {
    n += 1
    const band = await mount($, 'terminal')
    await band.look()
    for (let i = 0; i < ticks; i++) {
      await clock.advance(250)
      await band.wait(250)
    }
    const frames = await filmBoth(clock, band, null, 7_000, {
      0: async () => {
        await $.prompt.submit({ text: 'think it over', wait: false, origin: { kind: 'composer' } })
        await band.ui.redraw({ ...BAND, isWorking: true })
      },
    })
    const away = frames.filter(frame => frame.term.includes(EYES.left[0]?.text ?? '?')).map(frame => frame.at)
    expect([ticks, away.filter(at => at < 4_000)]).toEqual([ticks, []])
    expect([ticks, away.length > 0 && (away[0] ?? 0) >= 4_500 && (away[0] ?? 0) <= 5_600]).toEqual([ticks, true])
    await band.ui.unmount()
    await $.turn.complete({ answer: '', durationMs: 1_000, turnId: `think-${n}`, reason: 'answer', isAborted: false } as TurnCompleteInput)
    await clock.advance(10_000)
  }
})

// A step fails a few seconds before the turn lands: the splash (or the flinch) has played by then, and
// its frame has gone on into the turn's loop. It stays up until the cheer, one reload, never two in
// under a second (one for the moment's end, then one for the cheer).
for (const look of ['tide', 'hearth'] as const) {
  test(`desktop, ${look}: a failure three to four seconds before the turn lands reloads the frame once more, for the cheer, never for the moment's end first`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await run($, look)
    let n = 0
    for (const before of [3_050, 3_400, 3_700]) {
      n += 1
      await $.prompt.submit({ text: 'run the tests', wait: false, origin: { kind: 'composer' } })
      const busy = { ...BAND, isWorking: true }
      const desk = await mount($, 'desktop', busy)
      await clock.advance(2_000)
      await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
      const sources: string[] = []
      const alts: string[] = []
      const note = async () => {
        const seen = await desk.look()
        if (sources.at(-1) !== seen.source) {
          sources.push(seen.source)
          alts.push(seen.alt)
        }
      }
      for (let at = 0; at < before; at += 50) {
        await note()
        await clock.advance(50)
      }
      await $.turn.complete({ answer: 'Done.', durationMs: 9_000, turnId: `t${n}`, reason: 'answer', isAborted: false } as TurnCompleteInput)
      await desk.ui.redraw(BAND)
      for (let at = 0; at < 1_000; at += 50) {
        await note()
        await clock.advance(50)
      }
      expect([look, before, sources.length]).toEqual([look, before, 2])
      expect([look, before, alts[0]]).toEqual([look, before, look === 'tide' ? expect.stringContaining('A wave splashes Clawd') : 'Clawd flinches at a failed step, then taps along again.'])
      await desk.ui.unmount()
      await clock.advance(20_000)
    }
  })
}

// The facts as the band last wrote them to `$.state`, for what no surface spells out at once.
function factsOf(on: On): () => Info {
  let latest: Info = EMPTY
  on('state.set', ($, e, next) => {
    if (e.plugin === 'session-band' && e.key === 'info') latest = JSON.parse(JSON.stringify(e.value ?? null)) as Info

    return next(e)
  })

  return () => latest
}

for (const look of ['tide', 'hearth'] as const) {
  test(`${look}: an edit Esc left running that ends in the next turn is none of that turn's: no file counted, and its words leave the turn's own last tool on time`, { timeoutMs: 30_000 }, async ($, on) => {
    let letEditGo: () => void = () => undefined
    const editing = new Promise<void>(resolve => {
      letEditGo = resolve
    })
    let letReadGo: () => void = () => undefined
    const reading = new Promise<void>(resolve => {
      letReadGo = resolve
    })
    const { clock } = world(on, { onCall: async tool => (tool === 'Edit' ? editing : tool === 'Read' ? reading : undefined) })
    const facts = factsOf(on)
    await start($)
    await run($, look)
    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    const busy = { ...BAND, isWorking: true, bodyColumns: 120 }
    const desk = await mount($, 'desktop', busy)
    const edit = $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
    await clock.advance(1_500)
    await $.turn.complete({ answer: '', durationMs: 2_000, turnId: 't1', reason: 'aborted', isAborted: true } as TurnCompleteInput)
    await clock.advance(2_000)

    await $.prompt.submit({ text: 'read it instead', wait: false, origin: { kind: 'composer' } })
    const read = $.tool.call({ tool: 'Read', file_path: '/work/hooks/look.ts' })
    await clock.advance(1_200)
    expect([look, (await desk.look()).text.includes('look.ts')]).toEqual([look, true])
    letReadGo()
    await read
    // The stopped edit answers half a second after the turn's own Read: no pause of this turn's
    // starts again for it, so the Read's words go once its own pause is over (GAP_MS).
    await clock.advance(500)
    letEditGo()
    await edit
    await clock.advance(GAP_MS - 500 + 100)
    expect([look, (await desk.look()).text.includes('look.ts')]).toEqual([look, false])
    expect([look, facts().toolEndedAt]).toEqual([look, T0 + 3_500 + 1_200])

    await clock.advance(1_000)
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, turnId: 't2', reason: 'answer', isAborted: false } as TurnCompleteInput)
    await desk.ui.redraw(BAND)
    await clock.advance(250)
    // One tool, the Read; the edit changed a file for a turn already over.
    const done = (await desk.look()).text
    expect([look, done.includes('1 tool'), done.includes('file')]).toEqual([look, true, false])
    expect([look, facts().turnFiles, facts().lastTurn?.files]).toEqual([look, [], 0])
    await desk.ui.unmount()
  })
}

test('an Esc in the next turn never takes back the failure the turn before it made, even within the second', async ($, on) => {
  const { clock } = world(on)
  const facts = factsOf(on)
  await start($)
  const desk = await mount($, 'desktop', { ...BAND, isWorking: true })
  await $.prompt.submit({ text: 'run the tests', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  await $.turn.complete({ answer: '', durationMs: 3_000, turnId: 't1', reason: 'error', isAborted: false } as TurnCompleteInput)
  await clock.advance(200)
  await $.prompt.submit({ text: 'try again', wait: false, origin: { kind: 'composer' } })
  await clock.advance(300)
  // Esc half a second after the failure, in a turn that began after it.
  await $.turn.complete({ answer: '', durationMs: 300, turnId: 't2', reason: 'aborted', isAborted: true } as TurnCompleteInput)
  await desk.ui.redraw(BAND)
  // The failure stands: counted, and still what failed last.
  expect([facts().oops, facts().oopsAt, facts().oopsWhat]).toEqual([1, T0, 'Run the tests'])
  await desk.ui.unmount()
})

test('a call whose dispatch Esc abandoned is no failure, whatever its text says; nor is one whose text is the abort’s own', () => {
  const stopped = new AbortController()
  stopped.abort()
  expect(isInterrupted('boom', stopped.signal)).toBe(true)
  expect(isInterrupted(undefined, stopped.signal)).toBe(true)
  expect(isInterrupted('boom', new AbortController().signal)).toBe(false)
  expect(isInterrupted('boom', undefined)).toBe(false)
  expect(isInterrupted('[Request interrupted by user for tool use]', undefined)).toBe(true)
})

test('desktop, tide: the splash words give way as the splash ends, though the flinch beside them came later and ends later', async ($, on) => {
  let letReadGo: () => void = () => undefined
  const reading = new Promise<void>(resolve => {
    letReadGo = resolve
  })
  const { clock } = world(on, { onCall: async tool => (tool === 'Read' ? reading : undefined) })
  await start($)
  const desk = await mount($, 'desktop', { ...BAND, isWorking: true, bodyColumns: 120 })
  await $.prompt.submit({ text: 'run the tests', wait: false, origin: { kind: 'composer' } })
  // A Read runs; a fifth of a second in, a command beside it fails. The hearth's line keeps the
  // Read its second before the hiccup goes up (and its flinch, and the redraw as that ends, with it).
  const read = $.tool.call({ tool: 'Read', file_path: '/work/hooks/look.ts' })
  await clock.advance(200)
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  await clock.advance(2_500)
  expect((await desk.look()).text).toContain('Splash!')
  // A quarter second after the splash's own end, its words are gone with it.
  await clock.advance(SPLASH_MS - 2_500 + 350)
  expect((await desk.look()).text.includes('Splash!')).toBe(false)
  letReadGo()
  await read
  await desk.ui.unmount()
})

test("desktop: a switch to the hearth while the beach waits out a stride leaves no beach timer behind to redraw the hearth's frame", async ($, on) => {
  const { clock } = world(on)
  let writes = 0
  on('state.set', ($, e, next) => {
    if (e.plugin === 'session-band' && e.key === 'info') writes += 1

    return next(e)
  })
  await start($, 42)
  const desk = await mount($, 'desktop', { ...BAND, isWorking: true })
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await clock.advance(5_000)
  const before = (await desk.look()).source
  // The tide comes in a stride mid-turn: the beach waits STRIDE_WAIT_MS before its new frame.
  await $.session.measure(measured(64))
  expect((await desk.look()).source).toBe(before)
  await run($, 'hearth')
  expect((await desk.look()).look).toBe('hearth')
  await clock.advance(50)
  writes = 0
  await clock.advance(2_000)
  expect(writes).toBe(0)
  await desk.ui.unmount()
})

// ── 256-color terminals ───────────────────────────────────────────────────────
//
// A terminal without truecolor (Apple's Terminal, tmux without its RGB flag, many SSH sessions) shows
// each color as one of xterm's 256. Two roundings are common: chalk's, which Claude Code uses, splits
// each channel evenly across the cube's six levels; tmux's goes to the nearest level, or to the gray
// ramp when that is nearer.

const LEVELS = [0, 95, 135, 175, 215, 255]

function chalk256([r = 0, g = 0, b = 0]: number[]): number {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round(((r - 8) / 247) * 24) + 232
  const level = (v: number) => Math.round((v / 255) * 5)

  return 16 + 36 * level(r) + 6 * level(g) + level(b)
}

function tmux256([r = 0, g = 0, b = 0]: number[]): number {
  const level = (v: number) => (v < 48 ? 0 : v < 114 ? 1 : Math.floor((v - 35) / 40))
  const cube = 16 + 36 * level(r) + 6 * level(g) + level(b)
  const [cr = 0, cg = 0, cb = 0] = [LEVELS[level(r)], LEVELS[level(g)], LEVELS[level(b)]]
  if (cr === r && cg === g && cb === b) return cube
  const average = Math.floor((r + g + b) / 3)
  const step = average > 238 ? 23 : Math.floor((average - 3) / 10)
  const gray = 8 + 10 * step
  const far = (x: number, y: number, z: number) => (x - r) ** 2 + (y - g) ** 2 + (z - b) ** 2

  return far(gray, gray, gray) < far(cr, cg, cb) ? 232 + step : cube
}

function entryRgb(entry: number): number[] {
  if (entry >= 232) return [0, 0, 0].map(() => 8 + 10 * (entry - 232))
  const i = entry - 16

  return [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map(level => LEVELS[level] ?? 0)
}

function rgbOf(hex: string): number[] {
  return [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
}

// OKLab (Björn Ottosson's), where a distance of 0.02 is about the smallest difference a person sees.
function okLab(rgb: number[]): number[] {
  const [r = 0, g = 0, b = 0] = rgb.map(v => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

// Every color a tree paints: a six-digit hex color into `hex`, anything else (a theme key, or a
// color written some other way) into `other`.
function paintedColors(node: unknown, hex: Set<string>, other: Set<string>): void {
  if (node === null || typeof node !== 'object') return
  const el = node as Node
  for (const key of ['color', 'backgroundColor']) {
    const value = el.props?.[key]
    if (typeof value === 'string') {
      if (/^#[0-9a-f]{6}$/iu.test(value)) hex.add(value.toUpperCase())
      else other.add(value)
    }
  }
  for (const child of el.children ?? []) paintedColors(child, hex, other)
}

// The theme keys a terminal look may paint with: Claude Code's named keys and Clawd's own two. Any
// other color must be a six-digit hex color, so the rounding checks below see every literal.
const THEME_KEYS = new Set(['text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord', 'clawd_body', 'clawd_background'])

// The bound is 0.06: chalk shows a channel at the cube's 95 level only when it is 76 or less, and at
// 135 only when it is 127 or less, so a color with such a channel can come no nearer than that. The
// ripples set both bounds: 0.058 from their entry, 24, and a turn of 11 degrees. Every other color
// is within 0.035. A hue may turn by 12 degrees at most, so sand stays sand and the sea stays blue.
// The colors are the looks' own; Clawd and the words use theme keys, which the host rounds (under
// chalk the shell's ridges and Clawd's clay both show as 174, two half cells of shell a cell or more
// from him, which reads as a coral shell beside a coral crab).
test('every color either look draws on the terminal reads as itself on a 256-color terminal: both roundings agree, within 0.06 in OKLab and 12 degrees of hue, and no two colors become one', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(10_000)
  const drawn = new Map<Look, Set<string>>()
  const themed = new Set<string>()
  for (const which of ['tide', 'hearth'] as const) {
    await run($, `${which} lively`)
    const { ui, look } = await mount($, 'terminal')
    const key = (await look()).key ?? ''
    const colors = new Set<string>()
    const said = new Set<string>()
    const watch = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        const seen = await look()
        paintedColors(seen.tree, colors, themed)
        said.add(seen.text)
        await ui.advance(250)
      }
    }
    await watch(1_000)
    // A pet brings the heart; a failure brings the beach's splash and its spray.
    await ui.pointer({ type: 'down', x: which === 'tide' ? 3 : 4, y: 1, button: 'left', in: key })
    await watch(6_000)
    await $.prompt.submit({ text: 'test it', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Bash', command: 'npm run fail', description: 'Run the tests' })
    await watch(3_000)
    // The cheer, its sparkles and its clay words; then high tide, with the nudge and the bead of sweat.
    await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', reason: 'answer', isAborted: false } as TurnCompleteInput)
    await watch(5_000)
    await $.session.measure(measured(90))
    await watch(17_000)
    const saw = (pattern: RegExp) => [...said].some(text => pattern.test(text))
    // (The hearth's hiccup shows while the host says Claude is working, which this film never says;
    // it draws no color of its own.)
    expect([which, which === 'hearth' || saw(/Splash!/u), saw(/Done in/u), saw(/\/compact/u)]).toEqual([which, true, true, true])
    drawn.set(which, colors)
    await ui.unmount()
  }
  // Every color that is not a hex literal is a theme key, which the host rounds as it rounds its own.
  expect([...themed].filter(color => !THEME_KEYS.has(color))).toEqual([])
  expect([themed.has('clawd_body'), themed.has('clawd_background')]).toEqual([true, true])
  // The beach paints its sand, damp sand, sea, ripples, foam, shell, the shell's ridges and the heart;
  // the hearth paints only the heart, the rest (the sparkles and the bead among them) being theme colors.
  const tide = drawn.get('tide') ?? new Set<string>()
  const hearth = [...(drawn.get('hearth') ?? [])]
  expect([tide.size >= 8, tide.size]).toEqual([true, tide.size])
  expect([hearth.length, hearth.every(color => tide.has(color))]).toEqual([1, true])
  const all = tide
  const entries = new Set<number>()
  for (const color of all) {
    const rgb = rgbOf(color)
    const entry = chalk256(rgb)
    entries.add(entry)
    const [l1 = 0, a1 = 0, b1 = 0] = okLab(rgb)
    const [l2 = 0, a2 = 0, b2 = 0] = okLab(entryRgb(entry))
    const distance = Math.hypot(l1 - l2, a1 - a2, b1 - b2)
    const turn = Math.abs(((((Math.atan2(b2, a2) - Math.atan2(b1, a1)) * 180) / Math.PI + 540) % 360) - 180)
    expect([color, tmux256(rgb)]).toEqual([color, entry])
    expect([color, distance <= 0.06]).toEqual([color, true])
    expect([color, Math.hypot(a1, b1) < 0.03 || turn <= 12]).toEqual([color, true])
  }
  expect(entries.size).toBe(all.size)
})

// Something else may hold the band's place: Claude Code's survey, or on the desktop the app's own
// notice above the prompt (its effort warning), each told by `hasSurvey`. The band steps aside, and
// comes back once the place is free, though the app asks for it again only when the engine says it
// changed, and says nothing itself as its notice goes.
for (const look of ['tide', 'hearth'] as const) {
  test(`${look}: while something holds the band's place it steps aside and keeps watching; on the desktop it asks to be drawn again until the place is free`, { options: { look } }, async ($, on) => {
    const { clock } = world(on)
    let asks = 0
    on('ui.render', () => {
      asks += 1
      return { type: 'Text', children: ['Claude thinks longer with Max effort'] }
    })
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'session-band', surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
      expect(await ui.find({ text: 'Claude thinks longer with Max effort' })).toBeDefined()
      // It read the facts as it stepped aside, so a change to them draws it again (and it steps aside again).
      const before = asks
      await $.session.measure(measured(50))
      await clock.advance(200)
      expect([surface, asks > before]).toEqual([surface, true])
      // With nothing changing, the desktop's asks again by itself every 2 s; the terminal's survey
      // draws the band again itself as it goes.
      const quiet = asks
      await clock.advance(6_100)
      expect([surface, asks - quiet]).toEqual([surface, surface === 'desktop' ? 3 : 0])
      // The place is free: the band draws, and asks no more.
      await ui.redraw(BAND)
      expect([surface, await ui.find({ text: 'Claude thinks longer with Max effort' })]).toEqual([surface, undefined])
      const drawn = asks
      await clock.advance(6_100)
      expect([surface, asks]).toEqual([surface, drawn])
      await ui.unmount()
    }
  })
}

// One band coming free never strands another still held: a desktop's band stepped aside beside a
// band drawn free (a terminal's, under Remote Control, or another desktop's), whichever draws first
// and however often the free one draws, asks to be drawn again until its own place is free, and then
// asks no more.
for (const beside of SURFACES) {
  for (const isHeldFirst of [true, false]) {
    test(`a desktop band held beside a ${beside} band drawn free (the ${isHeldFirst ? 'held' : 'free'} one mounted first) asks to be drawn again until its own place is free`, async ($, on) => {
      const { clock } = world(on)
      let asks = 0
      on('ui.invalidate', ($, e, next) => {
        asks += 1
        return next(e)
      })
      on('ui.render', () => ({ type: 'Text', children: ['Claude thinks longer with Max effort'] }))
      await start($)
      const mount = (requestId: string) =>
        $.ui.mount({
          plugin: 'session-band',
          component: 'AbovePrompt',
          requestId,
          ...(requestId === 'held' ? { surface: 'desktop', props: { ...BAND, hasSurvey: true } } : { surface: beside, props: { ...BAND, bodyColumns: 120 } }),
        })
      const first = await mount(isHeldFirst ? 'held' : 'free')
      const second = await mount(isHeldFirst ? 'free' : 'held')
      const [held, free] = isHeldFirst ? [first, second] : [second, first]
      const quiet = asks
      await clock.advance(6_100)
      expect(asks - quiet).toBe(3)
      // The free band drawn again between asks (a resize, the work starting) changes nothing.
      const more = asks
      for (let i = 0; i < 3; i++) {
        await clock.advance(1_000)
        await free.redraw({ ...BAND, bodyColumns: 121 + i })
        await clock.advance(1_000)
      }
      await clock.advance(100)
      expect(asks - more).toBe(3)
      // Its own place free, it asks no more.
      await held.redraw(BAND)
      const drawn = asks
      await clock.advance(6_100)
      expect(asks).toBe(drawn)
      await held.unmount()
      await free.unmount()
    })
  }
}
