import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf, SessionMeasureInput, TurnCompleteInput } from 'claude-code'

import { HEART_ALT, SPIN, TERMINAL_HEART, cells, dice, textPx } from '../hooks/clawd'
import { SAND, WET, layoutOf, resumeSplash } from '../hooks/tide/band'
import { STRIDE_WAIT_MS } from '../hooks/tide/props'
import { isNightAt, skyStepAt, skySteps, skyTurnsIn } from '../hooks/facts'
import { HEART_PARKED, HEART_SHOWN, ROW_PX, beachWidth, poseAt, positionAt, seaAfter, seaAt } from '../hooks/tide/desk'
import type { Scene } from '../hooks/tide/desk'
import type { Words } from '../hooks/tide/types'

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

// Claude Code's own Clawd, as the terminal draws him: the default head, the head
// looking right, the edge-on frame of his spin, his feet, and the block heart.
const HEAD = '▐▛███▛█'
const HEAD_RIGHT = '▐█▟███▟'
const EDGE_ON = '▐██'
const FEET = '▝▝   ▝▝'
const HEART = '▟▙▟▙'

// What a terminal row may hold: block elements, box drawing, ASCII, and the glyphs Claude Code uses
// (its spinner's sparkles, its tool-result corner, and the ellipsis it ends a cut line with).
const SAFE = /^[ -~─-▟·✢✳✶✻✽⎿…]*$/u
// The cheer's sparkles: the ✻ (by his right claw) and the ✶ (by his left), each twinkling to its other
// form, a heavy ✽ and a little ✢, every half second of a lively finale, as Claude Code's spinner does.
const BURSTS = '✻✽'
const STARS = '✶✢'
const isBurst = (ch: string | undefined) => ch !== undefined && ch !== '' && BURSTS.includes(ch)
const isStar = (ch: string | undefined) => ch !== undefined && ch !== '' && STARS.includes(ch)
const isSparkle = (ch: string | undefined) => isBurst(ch) || isStar(ch)
const SPARKLE = /[✻✽✶✢]/u
// What the desktop's alt says at night by the person's own clock (the stars are out over the beach).
// The tests' clock reads day or night by the machine's time zone, so a test that holds an alt whole
// adds what that time says.
const starsSaid = (now: number) => (isNightAt(now) ? ' The stars are out.' : '')
// The sand's colors (dry, and damp with its specks): nothing above the sand line wears them.
const SAND_COLORS = ['#DAB27F', '#B27F4C']
// The sea's color on the terminal, and the foam on the wave's lip.
const SEA = '#4C7FAF'
const FOAM = '#7FAFD7'
// The scallop by his home: a dome with two ribs running down it, half buried in the sand.
const SHELL = '▟▌▐▙'
// The ground row under it: the shell's buried half narrowing toward its hinge, then a cell of sand.
const SAND_BY_SHELL = /^▝▀▀▘ /u
// The wave at the shore: a foam lip pitching over its foot, its shoulder, and a back sloping into the sea.
const CREST = '▀▛█▄▄▖'
// An eye pixel on the desktop head's top row (y 0), where a dark page would swallow it.
const EYE_ON_TOP = /<rect x="\d+" y="0" width="\d+" height="2" fill="#1B1A19"\/>/

// What a compaction leaves of the conversation: a summary (it always leaves at least one message).
const SUMMARY = { role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }

// Something to do while each tool runs (time passing, say) or while a compaction runs, and a reason
// a hook skips a compaction.
type During = { tool: (() => Promise<void>) | null; compact: (() => Promise<unknown>) | null; skipCompact: string | null }

// The engine beneath the plugin: a session in agent-plugins on branch main with two changed files.
// A test that answers tools itself passes { tools: false }: a hooks module registers tool.call once.
function world(
  on: On,
  { tools = true, branch = 'main', env, now = T0 }: { tools?: boolean; branch?: string; env?: Record<string, string>; now?: number } = {},
): { toasts: string[]; clock: ReturnType<typeof mock.clock>; release: () => void; during: During } {
  const toasts: string[] = []
  const held: Array<() => void> = []
  const during: During = { tool: null, compact: null, skipCompact: null }
  mock.store(on)
  if (env !== undefined) mock.env(on, env)
  const clock = mock.clock(on, { now })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: T0 - 12 * 60_000, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.repo', () => ({ value: { root: '/work/agent-plugins', remote: null, internal: false, name: null } }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('rev-parse') ? `${branch}\n` : ' M README.md\n?? notes.md\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.compact', async () => {
    await during.compact?.()

    return during.skipCompact === null ? { messages: [SUMMARY] } : { skip: during.skipCompact }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  if (tools) on('tool.call', async ($, e) => {
    if (e.tool === 'Read' && String(e.file_path).includes('held')) {
      await new Promise<void>(resolve => held.push(resolve))
    }
    await during.tool?.()
    if (e.tool === 'Bash' && String(e.command).includes('fail')) {
      return { result: { stdout: '', stderr: 'boom' }, isError: true, text: 'boom' }
    }

    return { result: { ok: true } }
  })

  return {
    toasts,
    clock,
    during,
    release: () => {
      for (const resolve of held.splice(0)) resolve()
    },
  }
}

function measured(percent: number, usd: number, five = 23): SessionMeasureInput {
  return {
    context: { tokens: percent * 2000, window: 200_000, percent },
    rateLimits: [{ kind: 'five_hour', percentUsed: five, resetsAt: new Date(T0 + 130 * 60_000).toISOString() }],
    cost: { usd },
    changed: ['context', 'cost', 'rateLimits'],
  }
}

async function start($: Engine, percent = 42, usd = 0.31): Promise<void> {
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  await $.session.measure(measured(percent, usd))
}

// A finished turn of 41 s with two tools, then twenty quiet seconds (past the cheer).
async function turn($: Engine, clock: ReturnType<typeof mock.clock>): Promise<void> {
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(20_000)
}

// Clawd's part of a desktop source: his poses and where he walks (the sea's own carry left out).
function clawdOf(source: string): string {
  const frames = source.match(/@keyframes (?:m-|v-|n-|lead|walk|homeward)[^{]*\{(?:[^{}]*\{[^}]*\})*\}/gu) ?? []

  return [...frames, source.slice(source.indexOf('<g transform="translate('))].join('\n')
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function textOf(node: unknown): string {
  return typeof node === 'string' ? node : ((node as Node).children ?? []).map(textOf).join('')
}

// Every outermost Text node: one per drawn row, top to bottom.
function rowNodes(node: unknown): Node[] {
  if (node === null || typeof node !== 'object') {
    return []
  }
  const el = node as Node
  if (el.type === 'Text') {
    return [el]
  }

  return (el.children ?? []).flatMap(child => rowNodes(child))
}

type Styled = { text: string; color?: unknown; backgroundColor?: unknown; bold?: unknown; dimColor?: unknown }

// Every Text run of one row, with its style.
function runs(row: unknown): Styled[] {
  return ((row as Node | undefined)?.children ?? []).map(child => ({
    text: textOf(child),
    color: (child as Node).props?.color,
    backgroundColor: (child as Node).props?.backgroundColor,
    bold: (child as Node).props?.bold,
    dimColor: (child as Node).props?.dimColor,
  }))
}

function find(node: unknown, type: string): Node[] {
  if (node === null || typeof node !== 'object') {
    return []
  }
  const el = node as Node

  return [...(el.type === type ? [el] : []), ...(el.children ?? []).flatMap(child => find(child, type))]
}

type View = { scene: string[]; words: string[]; rows: Node[]; tree: RenderElement; svg: { source: string; alt: string } | null; heart: string }

async function band($: Engine, surface: Surface, props = BAND) {
  const ui = await $.ui.mount({ plugin: 'session-band', surface, component: 'AbovePrompt', props })
  if (surface === 'terminal') {
    await ui.resize({ columns: props.bodyColumns, rows: 3, in: 'band' })
  }
  const look = async (): Promise<View> => {
    if (surface === 'terminal') {
      const tree = await ui.drawn({ in: 'band' })
      const rows = rowNodes(tree)
      const all = rows.map(textOf)

      return { scene: all.slice(0, 3), words: all.slice(3), rows, tree, svg: null, heart: '' }
    }
    const tree = await ui.drawn()
    const svg = find(tree, 'Svg')[0]
    const rows = rowNodes(tree)

    return {
      scene: [],
      words: rows.map(textOf),
      rows,
      tree,
      svg: svg === undefined ? null : { source: String(svg.props?.source), alt: String(svg.props?.alt) },
      // The heart the band lays over the beach when a pointer rests on it.
      heart: String(find(find(tree, 'Box').find(box => (box as { hover?: unknown }).hover !== undefined), 'Svg')[0]?.props?.source ?? ''),
    }
  }
  // Time on the band's own frame clock (the terminal's), a tick at a time.
  const wait = async (ms: number) => {
    if (surface === 'terminal') {
      for (let left = ms; left > 0; left -= 250) {
        await ui.advance(Math.min(250, left))
      }
    }
  }
  // Time on both clocks, a tick at a time, until what the band shows passes the check (or two seconds go by).
  const until = async (clock: ReturnType<typeof mock.clock>, check: (view: View) => boolean): Promise<View> => {
    for (let i = 0; i < 8; i++) {
      const view = await look()
      if (check(view)) {
        return view
      }
      await wait(250)
      await clock.advance(250)
    }

    return look()
  }

  return { ui, look, wait, until }
}

// How many times the terminal band's picture changes over `seconds`, looked at every tick.
async function changes(look: () => Promise<View>, wait: (ms: number) => Promise<void>, seconds: number): Promise<number> {
  let last = JSON.stringify((await look()).tree)
  let count = 0
  for (let i = 0; i < seconds * 4; i++) {
    await wait(250)
    const now = JSON.stringify((await look()).tree)
    count += now === last ? 0 : 1
    last = now
  }

  return count
}

async function run($: Engine, command: string, args = '') {
  return $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
}

for (const surface of SURFACES) {
  test(`${surface}: Clawd on his beach, beside what is happening, the tide and where we are`, async ($, on) => {
    world(on)
    await start($)
    const { ui, look } = await band($, surface)
    const { scene, words, svg, tree } = await look()

    expect(words[0]).toBe('Ready when you are')
    expect(words[1]).toBe('42% context · $0.31 · 5h limit 23%')
    expect(words[2]).toBe('agent-plugins · main · 2 uncommitted · Opus 5.5')

    if (surface === 'terminal') {
      expect(scene).toHaveLength(3)
      expect(scene[0]).toContain(HEAD)
      expect(scene[2]).toContain(FEET)
    } else {
      // The desktop draws no character art: Clawd is an Svg, crisp and alive.
      expect(svg?.source).toMatch(/^<svg /)
      expect(svg?.source).toContain('crispEdges')
      expect(svg?.alt).toContain('The tide is partway in.')
      expect(svg?.source).toContain('data-tide="40"')
      // An image, never an interactive frame, which blanks for a frame or two as its source changes.
      expect(find(tree, 'Svg').map(svg => svg.props?.isInteractive === true)).toEqual([false, false])
      expect(find(tree, 'Client')).toHaveLength(0)
      expect(words.join('')).not.toMatch(/[▀-▟]/u)
    }

    await ui.unmount()
  })

  test(`${surface}: the context percent is plain bold, the clearest text in the band`, async ($, on) => {
    world(on)
    await start($)
    const { ui, look } = await band($, surface)
    const tide = runs((await look()).rows.at(-2))

    expect(tide[0]).toMatchObject({ text: '42%', bold: true })
    expect(tide[0]?.color).toBeUndefined()

    await ui.unmount()
  })

  test(`${surface}: the tide comes in as the context fills`, async ($, on) => {
    world(on)
    await start($, 10)
    const low = await band($, surface)
    const before = await low.look()
    await low.ui.unmount()

    await $.session.measure(measured(70, 0.5))
    const high = await band($, surface)
    const after = await high.look()

    if (surface === 'terminal') {
      const sea = (view: View) => {
        const ground = runs(view.rows[2])
        const water = ground.at(-1)?.backgroundColor

        return ground.filter(cell => cell.backgroundColor === water).reduce((sum, cell) => sum + [...cell.text].length, 0)
      }
      // At 100 columns sixty points of context put five of the nine cells of shore under water.
      expect(sea(after)).toBeGreaterThanOrEqual(sea(before) + 5)
    } else {
      expect(before.svg?.alt).toContain('The tide is out.')
      expect(before.svg?.source).toContain('data-tide="10"')
      expect(after.svg?.alt).toContain('The tide is more than halfway in.')
      expect(after.svg?.source).toContain('data-tide="70"')
    }
    expect(after.words[1]).toContain('70% context')

    await high.ui.unmount()
  })

  test(`${surface}: at high tide the line nudges /compact and a toast says so once`, async ($, on) => {
    const { toasts, clock } = world(on)
    await start($)
    await $.session.measure(measured(86, 1.94))
    await $.session.measure(measured(87, 1.96))
    const { ui, look } = await band($, surface)

    expect(toasts).toEqual(["High tide: context is 86% full. Try /compact soon."])
    expect((await look()).words[1]).toContain('87% context · try /compact · $1.96')
    if (surface === 'desktop') {
      // The alt text says how close the tide is once. A fresh session: he waves hello first.
      expect((await look()).svg?.alt).toBe(`Clawd waves hello, then watches the water come in. The tide is high, close to his feet.${starsSaid(clock.now())}`)
    }

    await ui.unmount()
  })

  test(`${surface}: a running tool says what Claude is doing, and todos count up`, async ($, on) => {
    const { clock } = world(on, { tools: false })
    let until: ((check: (view: View) => boolean) => Promise<View>) | undefined
    let editing: View | undefined
    let reading: View | undefined
    let created = 0
    on('tool.call', async ($, e) => {
      // The words follow on the band's next step (within the second each one is held).
      if (e.tool === 'Edit') editing = await until?.(view => view.words[0]?.startsWith('Editing') === true)
      if (e.tool === 'Read') reading = await until?.(view => view.words[0]?.startsWith('Reading') === true)

      return e.tool === 'TaskCreate'
        ? { result: { task: { id: String((created += 1)), subject: String(e.subject) } } }
        : { result: { ok: true } }
    })
    await start($)
    await $.prompt.submit({ text: 'plan it', wait: false, origin: { kind: 'composer' } })
    const mounted = await band($, surface, { ...BAND, isWorking: true })
    until = check => mounted.until(clock, check)

    await $.tool.call({ tool: 'TaskCreate', subject: 'Write the band tests', description: '', activeForm: 'Writing the band tests' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: '' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/agent-plugins/hooks/band.tsx', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Read', file_path: '/work/agent-plugins/hooks/clawd.tsx' })

    expect(editing?.words[0]).toBe('Editing band.tsx · 1 of 2 done')
    expect(reading?.words[0]).toBe('Reading clawd.tsx · 1 of 2 done')
    if (surface === 'terminal') {
      // He is looking ahead as the read starts; the glance over at the words comes a beat later.
      expect(reading?.scene[0]).toContain(HEAD)
    } else {
      // Once the turn has changed something he potters for the rest of it: reading draws just what editing drew.
      expect(reading?.svg?.source).toContain('p-lookR')
      expect(reading?.svg?.source).toBe(editing?.svg?.source)
    }
    // The last tool done, the words wait out a short pause, then go back to the todo at hand.
    expect((await mounted.until(clock, view => view.words[0] === 'Ship it · 1 of 2 done')).words[0]).toBe('Ship it · 1 of 2 done')

    await mounted.ui.unmount()
  })

  test(`${surface}: a finished turn reports what it did while Clawd spins`, async ($, on) => {
    const { clock } = world(on)
    await start($)
    const { ui, look, wait } = await band($, surface)

    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    await $.turn.complete({ answer: 'Done.', durationMs: 41_000, isAborted: false, turnId: 't1', reason: 'answer' })

    const done = await look()
    expect(done.words[0]).toBe('✻ Done in 41s · 2 tools · 1 file changed')
    // One of his sparkles in his clay, then "Done" in the success color while the moment lasts, on both surfaces.
    expect(runs(done.rows.at(-3))[0]).toMatchObject({ text: '✻', color: 'claude' })
    expect(runs(done.rows.at(-3))[2]).toMatchObject({ text: 'Done', color: 'success', bold: true })
    if (surface === 'terminal') {
      const heads: string[] = []
      for (let i = 0; i < 16; i++) {
        await wait(250)
        heads.push((await look()).scene[0] ?? '')
      }
      expect(heads.some(head => head.includes(EDGE_ON) && !head.includes(HEAD))).toBe(true)
      await wait(3000)
      expect((await look()).scene[0]).toContain(HEAD)
    } else {
      expect(done.svg?.source).toContain('m-spin6')
      expect(done.svg?.source).toContain('class="spark"')
      // The sparkles pop up from a point and shrink back to one, never fading (a half-faded clay
      // star is a muddy smudge on the dark page).
      expect(done.svg?.source).toMatch(/@keyframes star0\{[^@]*100%\{transform:scale\(0\)\}\}/)
      const twinkles = [...(done.svg?.source ?? '').matchAll(/@keyframes (?:spark|star\d)\{(?:[^{}]*\{[^}]*\})*\}/gu)].map(m => m[0])
      expect(twinkles.length).toBeGreaterThan(0)
      for (const twinkle of twinkles) expect(twinkle).not.toContain('opacity')
      // A redraw while he spins hands the frame the same source, so the spin never restarts.
      await clock.advance(1_000)
      await $.session.measure(measured(42, 0.4))
      expect((await look()).svg?.source).toBe(done.svg?.source)
      // When the moment is over the band redraws by itself: plain words, no spin in the source.
      await clock.advance(4_000)
      const after = await look()
      // The same words, calmed: the ✻ dim, as Claude Code marks a finished turn, and "Done" plain.
      expect(after.words[0]).toBe('✻ Done in 41s · 2 tools · 1 file changed')
      expect(runs(after.rows.at(-3)).find(run => run.text === 'Done')?.color).toBeUndefined()
      expect(after.svg?.source).not.toContain('m-spin6')
    }

    await ui.unmount()
  })

  test(`${surface}: a failing tool splashes Clawd, then the sea settles`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
    const { ui, look, wait } = await band($, surface, { ...BAND, isWorking: true })
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })

    // The verdict first, so a narrow band still says what happened; what failed in quotes, since it
    // reads as an order. The page sets them curly; a terminal keeps straight ones (curly ones may draw two cells wide).
    expect((await look()).words[0]).toBe(surface === 'desktop' ? 'Splash! “Run the tests” failed' : 'Splash! "Run the tests" failed')
    // Once the splash is over, what failed stays, quietly, until another tool runs.
    const failed = surface === 'desktop' ? '“Run the tests” failed' : '"Run the tests" failed'
    // Both clocks, a tick at a time (the session's first), as they run in a session.
    const ticks = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        await clock.advance(Math.min(250, left))
        await wait(Math.min(250, left))
      }
    }
    if (surface === 'terminal') {
      expect((await look()).scene[0]).toContain('▂')
      await ticks(4000)
      expect((await look()).words[0]).toBe(failed)
      expect((await look()).rows[3]?.children?.every(run => (run as { props?: { dimColor?: unknown } }).props?.dimColor === true)).toBe(true)
      expect((await look()).scene[0]).not.toContain('▂')
    } else {
      const splash = (await look()).svg?.source
      expect(splash).toContain('class="surge"')
      // With no frame clock, the band still redraws its words when the splash is over; the frame
      // stays, the wave already slid back out and Clawd at work in it, so its end loads nothing.
      await clock.advance(3_500)
      expect((await look()).words[0]).toBe(failed)
      expect((await look()).svg?.source).toBe(splash)
    }
    await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
    await ticks(2000)
    expect((await look()).words[0]).toBe('Thinking it over')

    await ui.unmount()
  })

  test(`${surface}: after three quiet minutes Clawd curls up by the shell`, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await turn($, clock)
    await clock.advance(40_000)
    const awake = await band($, surface)
    expect((await awake.look()).words[0]).toContain('Done in 41s')
    await awake.ui.unmount()

    await clock.advance(4 * 60_000)
    const { ui, look } = await band($, surface)
    const asleep = await look()

    expect(asleep.words[0]).toBe('Napping · last turn took 41s')
    if (surface === 'terminal') {
      // Head down a row, eyes shut, nestled in the sand.
      expect(asleep.scene[0]).not.toContain('█')
      expect(asleep.scene[1]).toContain('▐▂███▂█')
      expect(asleep.scene[2]).not.toContain(FEET)
    } else {
      expect(asleep.svg?.alt).toContain('naps by a shell')
    }

    await ui.unmount()
  })

  test(`${surface}: /band still holds the beach still and remembers it; /band lively lets it go`, async ($, on) => {
    world(on)
    await start($)

    expect((await run($, 'band', 'still')).text).toMatch(/^Still\. /u)
    const { ui, look, wait } = await band($, surface)
    const first = await look()
    await wait(20_000)
    expect(await look()).toEqual(first)
    if (surface === 'desktop') {
      expect(first.svg?.source).not.toContain('animation')
      expect(first.svg?.source).not.toContain('@keyframes')
    }
    await ui.unmount()

    expect((await run($, 'band', 'sparkly')).text).toContain('not "sparkly".')
    // A new session remembers it.
    await start($)
    expect((await run($, 'band')).text).toMatch(/^Tide, still\. /u)
    expect((await run($, 'band', 'lively')).text).toMatch(/^Lively\. /u)
    expect((await run($, 'band')).text).toMatch(/^Tide, lively\. /u)
  })
}

test('terminal: clicking Clawd shows a heart', async ($, on) => {
  world(on)
  await start($)
  const { ui, look, wait } = await band($, 'terminal')

  await ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' })
  await wait(500)
  expect((await look()).scene[0]).toContain(HEART)

  await wait(3000)
  expect((await look()).scene.join('')).not.toContain(HEART)
})

test('terminal: his legs stand in front of a whole row of sand, and nothing above it wears its color', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 97, 12.5)
  await turn($, clock)

  for (const columns of [64, 100, 140]) {
    for (const isWorking of [false, true]) {
      const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns, isWorking })
      if (isWorking) {
        await $.tool.call({ tool: 'Bash', command: 'fail', description: 'Fail on purpose' })
      } else {
        await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't2', reason: 'answer' })
      }
      for (let i = 0; i < 40; i++) {
        const { rows } = await look()
        for (const row of rows.slice(0, 2)) {
          for (const cell of runs(row)) {
            expect(SAND_COLORS).not.toContain(cell.backgroundColor)
          }
        }
        // The ground row is whole: every cell has its sand, water or Clawd behind it, no holes.
        for (const cell of runs(rows[2])) {
          expect(cell.backgroundColor).toBeDefined()
        }
        await wait(250)
      }
      await ui.unmount()
    }
  }
})

// His feet are Claude Code's clay, which sits on the damp tan at about 1.1:1, so the damp strip stops
// where he stands: through a splash and its ebb (lively, and still, which holds the splash at its
// peak) and high tide's laps, at every width, his feet stand on dry sand or in the water itself.
test('terminal: Clawd\'s feet never stand on damp sand, where his clay all but vanishes: through a splash, lively or still, and high tide, at every width', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const beneath = new Map<unknown, string[]>()
  const feet = (view: View, at: string) => {
    for (const cell of cellsOf(view.rows[2])) {
      if (cell.color === 'clawd_body' && cell.ch !== ' ') beneath.set(cell.bg, [...(beneath.get(cell.bg) ?? []), at])
    }
  }
  const WIDTHS = [34, 40, 46, 52, 58, 64, 88, 100, 122, 140, 160]
  let n = 0
  for (const motion of ['lively', 'still'] as const) {
    await run($, 'band', motion)
    for (const columns of WIDTHS) {
      const props = { ...BAND, bodyColumns: columns, isWorking: true }
      const { ui, look, wait } = await band($, 'terminal', props)
      await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
      await $.tool.call({ tool: 'Bash', command: 'npm run fail', description: 'Run the tests' })
      // The splash, its ebb and the damp sand it leaves, to the end.
      for (let t = 0; t < 36; t++) {
        feet(await look(), `${motion} splash at ${columns}, tick ${t}`)
        await wait(250)
        await clock.advance(250)
      }
      n += 1
      await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `t${n}`, reason: 'answer' })
      await clock.advance(10_000)
      await ui.unmount()
    }
  }
  // High tide: he backs up to the water's edge, and the water runs under his feet now and then.
  await run($, 'band', 'lively')
  await $.session.measure(measured(97, 0.31))
  for (const columns of [46, 64, 100, 140]) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    for (let t = 0; t < 160; t++) {
      feet(await look(), `high tide at ${columns}, tick ${t}`)
      await wait(250)
      await clock.advance(250)
    }
    await ui.unmount()
  }
  expect((beneath.get(WET) ?? []).slice(0, 5)).toEqual([])
  expect([beneath.has(SAND), beneath.has(SEA)]).toEqual([true, true])
})

test('terminal: three rows at every width and in every mood, never padded, only safe glyphs', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await start($, 97, 12.5)

  for (const columns of [64, 100, 140]) {
    for (const isWorking of [false, true]) {
      const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns, isWorking })
      if (isWorking) {
        await $.tool.call({ tool: 'Bash', command: 'false fail', description: 'Fail on purpose' })
      }
      await ui.pointer({ type: 'down', x: 6, y: 1, button: 'left', in: 'band' })
      for (let i = 0; i < 24; i++) {
        const view = await look()
        expect(view.scene).toHaveLength(3)
        expect(view.words).toHaveLength(3)
        for (const row of view.scene) {
          expect(row).toMatch(SAFE)
          expect([...row].length).toBeLessThanOrEqual(columns - 2)
        }
        for (const row of view.words) {
          expect(row).toMatch(SAFE)
        }
        // Ink closes bold and dim with one code: a bold run never touches a dim one.
        for (const text of view.rows) {
          const all = runs(text)
          all.forEach((one, j) => {
            const next = all[j + 1]
            if (next !== undefined) {
              expect(one.bold === true && next.dimColor === true).toBe(false)
              expect(one.dimColor === true && next.bold === true).toBe(false)
            }
          })
        }
        await wait(250)
      }
      await ui.unmount()
    }
  }
})

test('terminal: a narrow band drops whole parts of a line, never half a word', async ($, on) => {
  world(on)
  await start($)
  const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: 64 })
  const narrow = await look()

  // 34 cells of words: the parts go from the end, the model first, then the count, whole. Never a
  // later part after an earlier one has gone, so nothing comes back as the band narrows.
  expect(narrow.words[2]).toBe('agent-plugins · main')
  for (const line of narrow.words) expect(line).not.toMatch(/[·\s]$/)
  await ui.resize({ columns: 100, rows: 3, in: 'band' })
  expect((await look()).words[2]).toBe('agent-plugins · main · 2 uncommitted · Opus 5.5')
  await ui.unmount()
})

test('terminal: below 56 columns the beach stays small and the words stay, the tide line among them', async ($, on) => {
  world(on)
  await start($)
  let before: string | undefined
  for (const columns of [36, 40, 50, 55, 56, 64]) {
    const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    const view = await look()
    expect(view.scene).toHaveLength(3)
    expect(view.words).toHaveLength(3)
    expect(view.words[1]).toMatch(/^42% context/)
    // A small beach: 18 to 24 cells below 56 columns (growing a cell a column from 52, so the words'
    // room never shrinks as the band widens), 25 from there.
    for (const row of view.scene) expect([...row].length).toBeLessThanOrEqual(columns < 52 ? 22 : columns < 56 ? 24 : 25)
    expect(view.scene[0]).toContain(HEAD)
    // Crossing 56 columns keeps the same lines: nothing jumps away.
    if (columns === 56) expect(view.words[1]?.startsWith(before ?? '-')).toBe(true)
    before = view.words[1]
    await ui.unmount()
  }
})

test('terminal: at high tide a narrow band keeps the /compact nudge before the cost and the limit', async ($, on) => {
  world(on)
  await start($, 86, 1.94)
  const lines: Array<[number, string]> = [
    [140, '86% context · try /compact · $1.94 · 5h limit 23%'],
    [84, '86% context · try /compact · $1.94 · 5h limit 23%'],
    [64, '86% context · try /compact · $1.94'],
    [55, '86% context · try /compact'],
    [50, '86% · try /compact'],
    [40, '86% · try /compact'],
    // Narrower, the separator goes, then the nudge whole: never a bare "/compact".
    [39, '86% try /compact'],
    [38, '86% try /compact'],
    [37, '86%'],
    [34, '86%'],
  ]
  for (const [columns, line] of lines) {
    const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    const view = await look()
    expect([columns, view.words[1]]).toEqual([columns, line])
    // The nudge is in Claude's clay, as the hearth's "Getting full" is; so is the number before it:
    // one color for the one warning. Its separator is dim like every other dot on the line, even
    // right after the bold number (a plain space parts the two, so the bold never bleeds into it).
    const row = runs(view.rows.at(-2))
    if (line.includes('/compact')) expect(row.find(run => run.text.includes('/compact'))?.color).toBe('claude')
    const dot = row.find(run => run.text.includes('·'))
    if (line.includes(' · ')) expect([columns, dot?.color === 'claude', dot?.dimColor === true, dot?.bold === true]).toEqual([columns, false, true, false])
    // The cell before the dot is a space that is not bold.
    const at = row.findIndex(run => run.text.includes('·'))
    const before = row[at]?.text.startsWith(' ') === true ? row[at] : row[at - 1]
    if (line.includes(' · ')) expect([columns, before?.text.endsWith(' ') === true || row[at]?.text.startsWith(' ') === true, before?.bold === true]).toEqual([columns, true, false])
    expect(runs(view.rows.at(-2)).find(run => run.text.includes('86%'))?.color).toBe('claude')
    await ui.unmount()
  }
})

// The longest look right in a desktop loop, in seconds: the longest run of its lookR keyframes at opacity 1.
function longestLook(source: string): number {
  const period = Number(/\.walk\{animation:walk ([\d.]+)s/.exec(source)?.[1] ?? 0)
  const stops = [...(/@keyframes v-lookR\{(.*?)\}\}/.exec(source)?.[1] ?? '').matchAll(/([\d.]+)%\{opacity:(\d)\}/g)].map(
    match => [Number(match[1]), Number(match[2])] as const,
  )
  let longest = 0
  stops.forEach(([at, value], i) => {
    if (value === 1) longest = Math.max(longest, (stops[i + 1]?.[0] ?? 100) - at)
  })

  return (longest / 100) * period
}

// Where the sea starts in the ground row: the first cell drawn on the sea's color.
function seaStart(view: View): number {
  let col = 0
  for (const run of runs(view.rows[2])) {
    if (run.backgroundColor === SEA) return col
    col += [...run.text].length
  }

  return col
}

test('terminal: a splash runs up the sand and slides back a cell or two at a time', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  for (const columns of [64, 100, 140]) {
    // Well past the last splash, so the band mounts on a calm sea.
    await clock.advance(10_000)
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns, isWorking: true })
    const calm = seaStart(await look())
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    const edges = [seaStart(await look())]
    for (let i = 0; i < 24; i++) {
      await wait(250)
      edges.push(seaStart(await look()))
    }
    const nearest = Math.min(...edges)
    expect(nearest).toBeLessThan(calm - 6)
    const back = edges.slice(edges.indexOf(nearest))
    // On its way back out the water never moves more than two cells in a tick, and gets home.
    back.forEach((edge, i) => {
      if (i > 0) expect(edge - (back[i - 1] ?? edge)).toBeLessThanOrEqual(2)
    })
    expect(back.at(-1)).toBeGreaterThanOrEqual(calm - 1)
    await ui.unmount()
  }
})

// Cold feet: after the hit (eyes shut, arms up) he hops from one pair of feet to the other while the
// water is at them, a second, then stands on both; still, the hit is the one held frame.
for (const motion of ['lively', 'still'] as const) {
  test(`terminal, ${motion}: splashed, he ${motion === 'lively' ? 'hops from one pair of feet to the other, then stands' : 'holds the hit, both feet down'}`, async ($, on) => {
    const { clock } = world(on)
    await start($)
    if (motion === 'still') await run($, 'band', 'still')
    await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, isWorking: true })
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    const film: string[] = []
    for (let i = 0; i < 14; i++) {
      const view = await look()
      const x = Math.min(...clawdAt(view))
      const feet = cellsOf(view.rows[2]).flatMap((cell, col) => (cell.color === 'clawd_body' && cell.ch !== ' ' ? [col - x] : []))
      const arms = (view.scene[0] ?? '').includes('▗▟') ? 'up' : 'down'
      film.push(`${arms} ${feet.includes(1) ? 'L' : '-'}${feet.includes(6) ? 'R' : '-'}`)
      await wait(250)
      await clock.advance(250)
    }
    const shown = film.join(', ')
    if (motion === 'still') {
      // The hit held for the splash's seconds, then at rest: never a foot lifted.
      const held = film.filter(tick => tick === 'up LR').length
      expect([shown, held >= 8, film.slice(held).every(tick => tick === 'down LR')]).toEqual([shown, true, true])
    } else {
      // The hit, then four ticks of hops, one pair down at a time, then both feet down for good.
      const hops = film.map(tick => tick.endsWith('L-') || tick.endsWith('-R'))
      const first = hops.indexOf(true)
      expect([shown, film.slice(0, first).every(tick => tick.endsWith('LR')), film.slice(first, first + 4)]).toEqual([shown, true, ['down L-', 'down -R', 'down L-', 'down -R']])
      expect([shown, film.slice(first + 4).every(tick => tick === 'down LR')]).toEqual([shown, true])
    }
    await ui.unmount()
  })
}

test('desktop: splashed, he hops on his cold feet, and the spray arcs out to land in the sea past the calm line, all by 2.2 s', async ($, on) => {
  world(on)
  await start($)
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  const source = (await look()).svg?.source ?? ''
  // His hop, eyes shut, one pair of feet and then the other, between the hit and his look round.
  expect(source).toContain('class="pose p-hopL"')
  expect(source).toContain('class="pose p-hopR"')
  const lead = /@keyframes m-hopL\{([^@]*?)\}\}/u.exec(source)?.[1] ?? ''
  expect(lead).toContain('opacity:1')
  // Each drop flies out at an even pace in a group of its own while it rises and falls, so its path is
  // an arc; it lands past the calm line (inside the picture) and shrinks into the water as it does.
  const width = Number(/viewBox="0 -5 (\d+) 64"/u.exec(source)?.[1]) / 3
  for (const i of [0, 1, 2, 3]) {
    const out = Number(new RegExp(`@keyframes dropx${i}\\{from\\{transform:translateX\\(0\\)\\}to\\{transform:translateX\\(([\\d.]+)px\\)\\}\\}`, 'u').exec(source)?.[1])
    const cx = Number(new RegExp(`<g class="dropx${i}"><circle class="drop drop${i}" cx="([\\d.]+)"`, 'u').exec(source)?.[1])
    expect([i, out > 0, cx + out < width]).toEqual([i, true, true])
    expect(source).toMatch(new RegExp(`\\.dropx${i}\\{animation:dropx${i} ([\\d.]+)s linear ([\\d.]+)s 1 both\\}`, 'u'))
    expect(source).toMatch(new RegExp(`@keyframes drop${i}\\{[^@]*100%\\{transform:translate\\(0,1px\\) scale\\(0\\)\\}\\}`, 'u'))
  }
  await ui.unmount()
})

test('terminal: a beat after Claude starts reading, Clawd glances over at the words, then back', async ($, on) => {
  const { release, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'look', wait: false, origin: { kind: 'composer' } })
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, isWorking: true })
  void $.tool.call({ tool: 'Read', file_path: '/work/held.ts' }).catch(() => undefined)
  await clock.settle()

  // The words follow on the band's next tick, while he still looks ahead.
  await wait(250)
  expect((await look()).words[0]).toBe('Reading held.ts')
  expect((await look()).scene[0]).toContain(HEAD)
  await wait(500)
  expect((await look()).scene[0]).toContain(HEAD_RIGHT)
  await wait(2500)
  expect((await look()).scene[0]).toContain(HEAD)
  release()
  await ui.unmount()
})

test('terminal: in a busy turn of reads he glances at the words once, not at every read', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, release } = world(on)
  await start($)
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, isWorking: true })
  let glances = 0
  let reads = 0
  let wasGlancing = false
  // The session's clock first, then the band's frame clock, as in a session: a tick finds what the facts say then.
  const step = async () => {
    await clock.advance(250)
    await wait(250)
    const view = await look()
    const isGlancing = view.scene[0]?.includes(HEAD_RIGHT) === true
    glances += isGlancing && !wasGlancing ? 1 : 0
    wasGlancing = isGlancing
    return view
  }
  // Four reads of a second each, a second apart: the words show each one.
  for (let i = 0; i < 4; i++) {
    const reading = $.tool.call({ tool: 'Read', file_path: `/work/held-${i}.ts` }).catch(() => undefined)
    await clock.settle()
    let isShown = false
    for (let k = 0; k < 4; k++) isShown ||= (await step()).words[0] === `Reading held-${i}.ts`
    expect([i, isShown]).toEqual([i, true])
    reads += 1
    release()
    await reading
    for (let k = 0; k < 4; k++) await step()
  }

  expect(reads).toBe(4)
  expect(glances).toBe(1)
  await ui.unmount()
})

test('terminal: Clawd rests with his eyes open; a glance right is short, in every mood', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, release } = world(on)
  await start($)
  await turn($, clock)

  // The share of ticks over a minute that he spends looking right.
  const share = async (props: RenderPropsOf['AbovePrompt']) => {
    const { ui, look, wait } = await band($, 'terminal', props)
    let right = 0
    for (let i = 0; i < 240; i++) {
      right += (await look()).scene[0]?.includes(HEAD_RIGHT) === true ? 1 : 0
      await wait(250)
    }
    await ui.unmount()

    return right / 240
  }

  expect(await share(BAND)).toBeLessThanOrEqual(0.15)
  await $.prompt.submit({ text: 'think', wait: false, origin: { kind: 'composer' } })
  expect(await share({ ...BAND, isWorking: true })).toBeLessThanOrEqual(0.3)
  void $.tool.call({ tool: 'Read', file_path: '/work/held.ts' }).catch(() => undefined)
  await clock.settle()
  expect(await share({ ...BAND, isWorking: true })).toBeLessThanOrEqual(0.3)
  release()
  await clock.settle()
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.session.measure(measured(88, 2))
  await clock.advance(20_000)
  expect(await share(BAND)).toBeLessThanOrEqual(0.3)
})

test('terminal: the shore wave and the shell are drawn whole, from block elements', async ($, on) => {
  world(on)
  await start($)
  const { ui, look } = await band($, 'terminal')
  const { scene } = await look()

  // The wave: a foam lip curling over its foot toward the sand, its shoulder, a gentle back.
  expect(scene[1]).toContain(CREST)
  // The scallop: a ribbed dome, its lower half sunk in the sand and narrowing toward its hinge.
  expect(scene[1]?.startsWith(SHELL + ' ')).toBe(true)
  expect(scene[2]).toMatch(SAND_BY_SHELL)
  await ui.unmount()
})

test('a burst of quick tools is one calm stretch: at most 3 changes on the terminal, one Svg on the desktop', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, during } = world(on)
  await start($)

  for (const surface of SURFACES) {
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    const { ui, look } = await band($, surface, { ...BAND, isWorking: true })
    const frames: string[] = []
    const sources = new Set<string>()
    const step = async (ms: number) => {
      if (surface === 'terminal') await ui.advance(ms)
      await clock.advance(ms)
      const view = await look()
      frames.push(JSON.stringify(view.tree))
      sources.add(view.svg?.source ?? '')
    }
    await step(250)
    // Six tools, Read and Grep in turn, each running 60 ms with 60 ms between them.
    during.tool = () => step(60)
    for (let i = 0; i < 6; i++) {
      await $.tool.call(i % 2 === 0 ? { tool: 'Read', file_path: `/work/f${i}.ts` } : { tool: 'Grep', pattern: `needle${i}` })
      await step(60)
    }
    during.tool = null
    const changes = frames.slice(1).filter((frame, i) => frame !== frames[i]).length
    expect([surface, changes <= 3]).toEqual([surface, true])
    if (surface === 'desktop') {
      expect(sources.size).toBe(1)
      // The words name a tool within the burst and never blink back to "Thinking" between two of them.
      const first = frames.findIndex(frame => /Reading|Searching/.test(frame))
      expect(first).toBeGreaterThan(0)
      for (const frame of frames.slice(first)) expect(frame).toMatch(/Reading|Searching/)
    } else {
      const first = frames.findIndex(frame => /Reading|Searching/.test(frame))
      expect(first).toBeGreaterThan(0)
      for (const frame of frames.slice(first)) expect(frame).not.toContain('Thinking')
    }
    await ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 2_000, isAborted: false, turnId: `t-${surface}`, reason: 'answer' })
    await clock.advance(10_000)
  }
})

test('terminal: a new prompt during the spin lets it play out, and the words move on with the next tick', async ($, on) => {
  world(on)
  await start($)
  const { ui, look, wait } = await band($, 'terminal')
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw(BAND)
  await wait(750)
  // Three frames into the spin, a new prompt. The spin has changed the frame on each of its last
  // ticks, so the second has no room for one more change between ticks: the words move on with the
  // spin's next frame, never a fifth change in the second (see pace.ts).
  await $.prompt.submit({ text: 'and again', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  expect((await look()).words[0]).toContain('Done')
  await wait(250)
  expect((await look()).words[0]).toBe('Thinking it over')
  const heads: string[] = []
  for (let i = 0; i < 12; i++) {
    heads.push((await look()).scene[0] ?? '')
    await wait(250)
  }
  // The spin goes on through edge-on and his back, then he faces front with his arms down (no arms-up cheer).
  expect(heads.findIndex(head => head.includes(EDGE_ON))).toBeGreaterThanOrEqual(0)
  expect(heads.some(head => head.includes('▐██████'))).toBe(true)
  expect((await look()).scene[0]).toContain(HEAD)
  expect((await look()).scene[0]).not.toContain('▗▟')
  await ui.unmount()
})

// A pet mid-spin turns him to face you; when it ends, going back through the spin's last
// three-quarter frame before his arms go up would be the one pose in all his walks that looks like
// a reverse.
test('terminal: a pet during the cheer\'s spin leaves him facing you until his arms go up, never turning back', async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (const [columns, after] of [[80, 2], [100, 0], [64, 5]] as const) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    await ui.redraw({ ...BAND, bodyColumns: columns, isWorking: true })
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `t${columns}`, reason: 'answer' })
    await ui.redraw({ ...BAND, bodyColumns: columns })
    await wait(250 * after)
    await ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' })
    const heads: string[] = []
    for (let i = 0; i < 24; i++) {
      await wait(250)
      heads.push((await look()).scene[0] ?? '')
    }
    // From the pet (his wink, on the first tick with room for a change, see pace.ts) to his arms up
    // (a ✻ in the sky beside him), he faces you: a wink, then open eyes.
    const petted = heads.findIndex(head => head.includes('▛███▂█'))
    const up = heads.findIndex(head => [...head].some(isBurst))
    expect([columns, petted >= 0 && petted <= 1, up > petted + 8]).toEqual([columns, true, true])
    for (const [i, head] of heads.slice(petted, up).entries()) {
      expect([columns, i, /▛███[▛▂]█/u.test(head)]).toEqual([columns, i, true])
    }
    await ui.unmount()
    await clock.advance(20_000)
  }
})

// Petted late in a cheer, he winks and his heart comes and goes; his arms going up with both
// sparkles for a single tick before the cheer ends would be a flash. The ending keeps a second or
// is left out, at every tide, width and motion, in Apple's Terminal too.
for (const [env, motion] of [[undefined, 'lively'], [undefined, 'still'], [{ TERM_PROGRAM: 'Apple_Terminal' }, 'lively']] as const) {
  test(`terminal, ${motion}${env === undefined ? '' : ', in Apple’s Terminal'}: petted at any moment of a cheer, his arms-up ending holds a second or is left out, never a flash`, { timeoutMs: 120_000 }, async ($, on) => {
    const { clock } = world(on, { env })
    await start($)
    if (motion === 'still') await run($, 'band', 'still')
    for (const percent of [42, 86]) {
      await $.session.measure(measured(percent, 1))
      for (const columns of [34, 48, 80]) {
        for (let at = 0; at <= 4000; at += 250) {
          const props = { ...BAND, bodyColumns: columns }
          const { ui, look, wait } = await band($, 'terminal', props)
          await wait(1_000)
          await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
          await ui.redraw({ ...props, isWorking: true })
          await wait(500)
          await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `p${columns}-${at}`, reason: 'answer' })
          await ui.redraw(props)
          // Each tick: arms up (his raised claw, in the cheer or the pet's wink), the sparkles, the wink.
          const ticks: Array<{ up: boolean; sparkle: boolean; wink: boolean }> = []
          for (let i = 0; i < 36; i++) {
            if (i * 250 === at) await ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'band' })
            await wait(250)
            const top = (await look()).scene[0] ?? ''
            ticks.push({ up: top.includes('▗▟'), sparkle: SPARKLE.test(top), wink: top.includes('▂') })
          }
          const film = ticks.map(t => (t.sparkle ? 'U' : t.wink ? 'W' : t.up ? 'u' : '.')).join('')
          // Every stretch of arms up, and every stretch of sparkles, holds a second (4 ticks), unless
          // the person's own pet cuts it: then the very next tick is his wink.
          for (const key of ['up', 'sparkle'] as const) {
            let from = -1
            for (let i = 0; i <= ticks.length; i++) {
              const isOn = i < ticks.length && ticks[i]![key]
              if (isOn && from < 0) from = i
              if (!isOn && from >= 0) {
                const isCut = i < ticks.length && ticks[i]!.wink
                const isOpen = i === ticks.length
                expect([percent, columns, at, key, film, i - from >= 4 || isCut || isOpen]).toEqual([percent, columns, at, key, film, true])
                from = -1
              }
            }
          }
          await ui.unmount()
          await clock.advance(30_000)
        }
      }
    }
  })
}

// Quadrant glyphs whose ink reaches the right edge of their cell, and the left edge: a sparkle in the
// cell beside such an edge sits flush against him (`▄✻`), where it reads as part of his claw.
const INK_RIGHT = '▝▗▐▀▄█▙▛▜▟▚▞'
const INK_LEFT = '▘▖▌▀▄█▙▛▜▟▚▞'

// By the band's edge on a narrow beach (still, in Apple's Terminal, or lively with the tide in), a
// cheer where he stands, a cell in from the edge, would leave no sky left of him for the ✶, and the
// finale would squeeze one ✻ flush against his raised claw (`▗▟▛███▛█▄✻`). So every cheer by the
// edge steps a cell in first, as the lively spin does.
for (const [env, motion] of [[undefined, 'lively'], [undefined, 'still'], [{ TERM_PROGRAM: 'Apple_Terminal' }, 'lively']] as const) {
  test(`terminal, ${motion}${env === undefined ? '' : ', in Apple’s Terminal'}: at every width from 34 to 60 and every tide, his cheer holds up a sparkle each side of him, each with a breath of sky off his claws, never flush`, { timeoutMs: 300_000 }, async ($, on) => {
    const { clock } = world(on, { env })
    await start($)
    if (motion === 'still') await run($, 'band', 'still')
    for (const percent of [0, 42, 83, 84, 86, 100]) {
      await $.session.measure(measured(percent, 1))
      for (let columns = 34; columns <= 60; columns++) {
        const props = { ...BAND, bodyColumns: columns }
        const { ui, look, wait } = await band($, 'terminal', props)
        await wait(1_000)
        await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
        await ui.redraw({ ...props, isWorking: true })
        await wait(500)
        // Where he stood before the cheer: still, his spot (at high tide, the water's edge).
        const stood = Math.min(...clawdAt(await look()))
        await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `e${percent}-${columns}`, reason: 'answer' })
        await ui.redraw(props)
        let pairs = 0
        // Where the wave's lip stands each tick: it stands back for the ✻ and rolls back a cell a tick.
        const crests: number[] = []
        const home = motion === 'still' ? stood : columns >= 56 ? SHELL.length + 1 : 1
        let isHome = -1
        for (let i = 0; i < SPIN.length + 9 + 24; i++) {
          await wait(250)
          const view = await look()
          crests.push(cellsOf(view.rows[1]).findIndex(cell => cell.ch === '▀' && cell.color === FOAM))
          expect([percent, columns, i, view.scene[1], armToLip(view) >= 1]).toEqual([percent, columns, i, view.scene[1], true])
          if (i >= SPIN.length + 9) {
            // Once the cheer is over he is back on his spot: still, where he stood, as his arms come
            // down; lively, he pads home once he has settled.
            if (isHome < 0 && Math.min(...clawdAt(view)) === home) isHome = i
            continue
          }
          const top = cellsOf(view.rows[0])
          const isHim = (col: number) => (top[col]?.color === 'clawd_body' && top[col]?.ch !== ' ') || top[col]?.bg === 'clawd_body'
          const him = clawdAt(view)
          const marks = top.flatMap(({ ch }, col) => (isSparkle(ch) ? [col] : []))
          const where = [percent, columns, i, view.scene[0]]
          for (const col of marks) {
            // Off the band's edge, and a breath of sky off his claws on both sides.
            const flush = (isHim(col - 1) && INK_RIGHT.includes(top[col - 1]?.ch ?? ' ')) || (isHim(col + 1) && INK_LEFT.includes(top[col + 1]?.ch ?? ' ')) || top[col - 1]?.bg === 'clawd_body' || top[col + 1]?.bg === 'clawd_body'
            expect([...where, col, col >= 1, flush]).toEqual([...where, col, true, false])
          }
          if (marks.length > 0) {
            // A sparkle in each claw: the ✶ by his left, the ✻ by his right.
            const [star, burst] = [top.findIndex(({ ch }) => isStar(ch)), top.findIndex(({ ch }) => isBurst(ch))]
            expect([...where, marks.length, star >= 0 && star < Math.min(...him), burst > Math.max(...him)]).toEqual([...where, 2, true, true])
            pairs += 1
          }
        }
        // His arms are up for the finale, sparkles and all.
        expect([percent, columns, pairs >= 4]).toEqual([percent, columns, true])
        // Lively, the crest rolls a cell a tick, never jumping (still, nothing rolls: it is simply back
        // as his arms come down, in that one frame).
        const film = crests.join(' ')
        crests.forEach((at, i) => {
          if (i > 0 && motion === 'lively') expect([percent, columns, i, film, Math.abs(at - (crests[i - 1] ?? at)) <= 1]).toEqual([percent, columns, i, film, true])
        })
        // (Lively at high tide, settled, he goes down to the water's edge instead, a cell or two.)
        if (motion === 'still' || percent < 80) expect([percent, columns, isHome >= 0 && isHome <= SPIN.length + 9 + (motion === 'still' ? 0 : 20)]).toEqual([percent, columns, true])
        await ui.unmount()
        await clock.advance(30_000)
      }
    }
  })
}

// A resize mid-cheer: he cheers on at the new width with a sparkle each side of him, never flush
// against a claw, stepping out from his new home where the band's edge would squeeze the ✶ (as a band
// that comes up mid-cheer does), and the cheer over, he is home on the new beach. Still, he is back
// on his spot as his arms come down, the very spot the resize alone would have him on, so his still
// home never moves; lively at high tide, he never stays out a cell with the water at it.
for (const motion of ['still', 'lively'] as const) {
  test(`terminal, ${motion}: resized mid-cheer between 34 and 60 columns, at 42%, 84% and 90%, he keeps a sparkle each side and ends the cheer at home on the new beach`, { timeoutMs: 300_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    if (motion === 'still') await run($, 'band', 'still')
    let n = 0
    for (const percent of [42, 84, 90]) {
      await $.session.measure(measured(percent, 1))
      for (const [from, to] of [[40, 48], [48, 40], [60, 40], [36, 44], [44, 34]] as const) {
        for (const at of motion === 'still' ? [2] : [4, SPIN.length + 2]) {
          n += 1
          const props = { ...BAND, bodyColumns: from }
          const { ui, look, wait } = await band($, 'terminal', props)
          await wait(1_000)
          await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
          await ui.redraw({ ...props, isWorking: true })
          await wait(500)
          await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `r${n}`, reason: 'answer' })
          await ui.redraw(props)
          const where = [percent, from, to, at]
          let pairs = 0
          for (let i = 0; i < SPIN.length + 9; i++) {
            if (i === at) await ui.resize({ columns: to, rows: 3, in: 'band' })
            await wait(250)
            if (i < at) continue
            const view = await look()
            const top = cellsOf(view.rows[0])
            const isHim = (col: number) => (top[col]?.color === 'clawd_body' && top[col]?.ch !== ' ') || top[col]?.bg === 'clawd_body'
            const marks = top.flatMap(({ ch }, col) => (isSparkle(ch) ? [col] : []))
            if (marks.length === 0) continue
            const him = clawdAt(view)
            const [star, burst] = [top.findIndex(({ ch }) => isStar(ch)), top.findIndex(({ ch }) => isBurst(ch))]
            const flush = marks.some(col => (isHim(col - 1) && INK_RIGHT.includes(top[col - 1]?.ch ?? ' ')) || (isHim(col + 1) && INK_LEFT.includes(top[col + 1]?.ch ?? ' ')))
            expect([...where, i, view.scene[0], marks.length, star >= 1 && star < Math.min(...him), burst > Math.max(...him), flush]).toEqual([...where, i, view.scene[0], 2, true, true, false])
            pairs += 1
          }
          // His arms went up after the resize, a sparkle in each claw.
          expect([...where, pairs >= 3]).toEqual([...where, true])
          // The cheer over and settled, where he stands, and where the sea starts, a tick at a time.
          const after: Array<{ left: number; right: number; sea: number }> = []
          for (let i = 0; i < 24; i++) {
            await wait(250)
            const view = await look()
            const him = clawdAt(view)
            after.push({ left: Math.min(...him), right: Math.max(...him), sea: seaStart(view) })
          }
          if (motion === 'still') {
            // Back on his spot as his arms came down, and there to stay: the spot the same resize puts
            // him on with no cheer about.
            await clock.advance(30_000)
            const twin = await band($, 'terminal', { ...BAND, bodyColumns: from })
            await twin.wait(1_000)
            await twin.ui.resize({ columns: to, rows: 3, in: 'band' })
            await twin.wait(500)
            const spot = Math.min(...clawdAt(await twin.look()))
            await twin.ui.unmount()
            expect([...where, after.map(({ left }) => left)]).toEqual([...where, after.map(() => spot)])
          } else {
            // Lively, he pads home once settled, or, at high tide, down to the water's edge: never out a
            // cell with the water right at his feet.
            const last = after.slice(-8)
            expect([...where, last.every(({ right, sea }) => right <= sea - 2)]).toEqual([...where, true])
            if (percent < 80) expect([...where, after.some(({ left }) => left === (to >= 56 ? SHELL.length + 1 : 1))]).toEqual([...where, true])
          }
          await ui.unmount()
          await clock.advance(30_000)
        }
      }
    }
  })
}

// Out a cell for his cheer, with the next turn already under way, and the tide coming in fast: he pads
// back home as the water reaches the cell he stepped out to, whatever his mood, never standing his
// ground with the sea at his feet.
test('terminal, lively: stepped out for a cheer, he pads home when the tide comes up to him, even with the next turn at work', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (const columns of [34, 40, 46]) {
    await $.session.measure(measured(42, 1))
    const props = { ...BAND, bodyColumns: columns }
    const { ui, look, wait } = await band($, 'terminal', props)
    await wait(1_000)
    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    await ui.redraw({ ...props, isWorking: true })
    await wait(500)
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `w${columns}`, reason: 'answer' })
    await ui.redraw(props)
    const cheer: number[] = []
    for (let i = 0; i < SPIN.length + 9; i++) {
      await wait(250)
      cheer.push(Math.min(...clawdAt(await look())))
    }
    // He stepped out a cell to cheer, and is out there still as his arms come down.
    expect([columns, cheer.at(-1)]).toEqual([columns, 2])
    // The next turn, and the context all but full: the tide rolls in a cell a tick.
    await $.prompt.submit({ text: 'and the rest', wait: false, origin: { kind: 'composer' } })
    await $.session.measure(measured(100, 1))
    await ui.redraw({ ...props, isWorking: true })
    const lefts: number[] = []
    for (let i = 0; i < 40; i++) {
      await wait(250)
      lefts.push(Math.min(...clawdAt(await look())))
    }
    expect([columns, lefts.slice(-8)]).toEqual([columns, lefts.slice(-8).map(() => 1)])
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `x${columns}`, reason: 'answer' })
    await ui.unmount()
    await clock.advance(60_000)
  }
})

// Lively on a narrow beach with the tide in, he pads home from the cell he stepped out to for his
// cheer on a tick the wave has drawn back from his feet: a foot lifted beside water washing up would
// read as stepping out of the sea. Wherever the wave is in its lap as the cheer ends.
test('terminal, lively: at high tide on a narrow beach, his step home after the cheer never lands while a wave washes up to his feet', { timeoutMs: 300_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const isWater = (cell: { color: unknown; bg: unknown } | undefined) => cell !== undefined && [cell.color, cell.bg].some(color => color === SEA || color === FOAM)
  let steps = 0
  let n = 0
  for (const percent of [86, 100]) {
    await $.session.measure(measured(percent, 1))
    for (const columns of [34, 40]) {
      // Over a whole cycle of the high tide's laps, two ticks at a time.
      for (let offset = 0; offset < 100; offset += 2) {
        n += 1
        const props = { ...BAND, bodyColumns: columns }
        const { ui, look, wait } = await band($, 'terminal', props)
        await wait(1_000 + offset * 250)
        await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
        await ui.redraw({ ...props, isWorking: true })
        await wait(500)
        await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `h${n}`, reason: 'answer' })
        await ui.redraw(props)
        await wait((SPIN.length + 7) * 250)
        let was = Math.min(...clawdAt(await look()))
        for (let i = 0; i < 40; i++) {
          await wait(250)
          const view = await look()
          const at = Math.min(...clawdAt(view))
          if (at < was) {
            // A step home: the cell beside his right foot is sand, not a wave washing up.
            const ground = cellsOf(view.rows[2])
            const foot = Math.max(...ground.flatMap((cell, col) => (cell.color === 'clawd_body' && cell.ch !== ' ') || cell.bg === 'clawd_body' ? [col] : []))
            expect([percent, columns, offset, i, view.scene[2], isWater(ground[foot + 1])]).toEqual([percent, columns, offset, i, view.scene[2], false])
            steps += 1
          }
          was = at
        }
        await ui.unmount()
        await clock.advance(60_000)
      }
    }
  }
  // He did step home, many times over.
  expect(steps >= 20).toBe(true)
})

// His glyphs, each at its place in him, and whether his sparkles or the heart are up: the same pose
// drawn a cell along reads the same. (Apple's Clawd has no arms: his sparkles are his cheer's pose.)
function poseOf(view: View): string {
  const him = clawdAt(view)
  const x = Math.min(...him)
  const sprite = view.rows
    .slice(0, 3)
    .map(row => cellsOf(row).flatMap((cell, col) => ((cell.color === 'clawd_body' && cell.ch !== ' ') || cell.bg === 'clawd_body' ? [`${col - x}${cell.ch}`] : [])).join(''))
    .join('|')

  return `${sprite} ${SPARKLE.test(view.scene[0] ?? '') ? 'sparkles' : ''} ${heartAt(view) >= 0 ? 'heart' : ''}`
}

// Where the pet's heart is drawn (its first cell on the top row), or -1.
function heartAt(view: View): number {
  return cellsOf(view.rows[0]).findIndex(cell => cell.color === TERMINAL_HEART)
}

// Still (or in Apple's Terminal, still too), stepped a cell out by the band's edge to cheer: a pet at
// any moment of the cheer takes him home on a pose change of its own, never on a tick where nothing
// else about him changes, and the heart he holds never parts from him.
for (const env of [undefined, { TERM_PROGRAM: 'Apple_Terminal' }]) {
  test(`terminal, still${env === undefined ? '' : ', in Apple’s Terminal'}: petted at any moment of a cheer by the band's edge, he never slides a cell on his own, and the heart stays with him while it shows`, { timeoutMs: 300_000 }, async ($, on) => {
    const { clock } = world(on, { env })
    await start($)
    await run($, 'band', 'still')
    for (const percent of [42, 86]) {
      await $.session.measure(measured(percent, 1))
      for (const columns of [34, 40, 48]) {
        for (let at = 500; at <= 4500; at += 250) {
          const props = { ...BAND, bodyColumns: columns }
          const { ui, look, wait } = await band($, 'terminal', props)
          await wait(1_000)
          await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
          await ui.redraw({ ...props, isWorking: true })
          await wait(500)
          const home = Math.min(...clawdAt(await look()))
          await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `s${percent}-${columns}-${at}`, reason: 'answer' })
          await ui.redraw(props)
          let was = await look()
          const film: string[] = []
          for (let i = 0; i < 40; i++) {
            if (i * 250 === at) await ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'band' })
            await wait(250)
            const view = await look()
            const where = [percent, columns, at, i, view.scene[0], view.scene[1]]
            film.push(`${Math.min(...clawdAt(view))}${heartAt(view) >= 0 ? 'h' : ''}`)
            // He moves only with a change of pose: the same sprite a cell along is a slide.
            if (poseOf(view) === poseOf(was)) expect([...where, film.join(' '), Math.min(...clawdAt(view))]).toEqual([...where, film.join(' '), Math.min(...clawdAt(was))])
            // While the heart shows, it keeps its place beside him, and he his.
            if (heartAt(view) >= 0 && heartAt(was) >= 0) {
              expect([...where, heartAt(view) - Math.min(...clawdAt(view))]).toEqual([...where, heartAt(was) - Math.min(...clawdAt(was))])
              expect([...where, Math.min(...clawdAt(view))]).toEqual([...where, Math.min(...clawdAt(was))])
            }
            was = view
          }
          // The cheer and the pet over, he is back on his spot.
          expect([percent, columns, at, film.join(' '), Math.min(...clawdAt(was))]).toEqual([percent, columns, at, film.join(' '), home])
          await ui.unmount()
          await clock.advance(30_000)
        }
      }
    }
  })
}

for (const env of [undefined, { TERM_PROGRAM: 'Apple_Terminal' }]) {
  test(`terminal${env === undefined ? '' : ', in Apple’s Terminal'}: cheering at home by the shell, his sparkles never cover it or sit on it`, async ($, on) => {
    const { clock } = world(on, { env })
    await start($)
    await turn($, clock)
    await clock.advance(5 * 60_000)
    for (const columns of [64, 100, 140]) {
      const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
      expect((await look()).words[0]).toContain('Napping')
      // A quick answer, no tools: he cheers from where he napped.
      await $.prompt.submit({ text: 'quick one', wait: false, origin: { kind: 'composer' } })
      await ui.redraw({ ...BAND, bodyColumns: columns, isWorking: true })
      await $.turn.complete({ answer: 'Done.', durationMs: 2_000, isAborted: false, turnId: `q${columns}`, reason: 'answer' })
      await ui.redraw({ ...BAND, bodyColumns: columns })
      let sparkles = 0
      for (let i = 0; i < 24; i++) {
        const { scene } = await look()
        expect([columns, i, scene[1]?.startsWith(SHELL + ' '), SAND_BY_SHELL.test(scene[2] ?? '')]).toEqual([columns, i, true, true])
        sparkles += [...scene.join('')].some(isStar) ? 1 : 0
        // Nor right on top of it: a sparkle over the shell would read as the shell's.
        const [top = '', middle = ''] = scene
        const below = [...middle]
        for (const [col, ch] of [...top].entries()) {
          if (isSparkle(ch)) expect([columns, i, top, middle, col < SHELL.length && below[col] !== ' ']).toEqual([columns, i, top, middle, false])
        }
        await wait(250)
      }
      // The second sparkle still shows, just not on the shell.
      expect(sparkles).toBeGreaterThan(0)
      await ui.unmount()
      await clock.advance(5 * 60_000)
    }
  })
}

test('terminal, in Apple’s Terminal: wherever he cheers, a sparkle a cell out from his claw keeps clear of the shell, a corner away too', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on, { env: { TERM_PROGRAM: 'Apple_Terminal' } })
  await start($)
  for (const columns of [56, 100]) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    // Where he stands as each cheer starts (his leftmost cell): the test must see him a cell right
    // of home, where a sparkle a cell out from his left claw would sit a corner off the shell.
    const stands = new Set<number>()
    for (let n = 0; n < 24; n++) {
      // A while idle, so he scuttles along the sand now and then, then a quick answer and its cheer.
      await wait(20_000 + ((n * 7) % 11) * 9_000)
      await $.prompt.submit({ text: 'quick one', wait: false, origin: { kind: 'composer' } })
      await ui.redraw({ ...BAND, bodyColumns: columns, isWorking: true })
      await $.turn.complete({ answer: 'Done.', durationMs: 2_000, isAborted: false, turnId: `a${columns}-${n}`, reason: 'answer' })
      await ui.redraw({ ...BAND, bodyColumns: columns })
      for (let i = 0; i < 12; i++) {
        const view = await look()
        stands.add(Math.min(...clawdAt(view)))
        const top = cellsOf(view.rows[0])
        const below = cellsOf(view.rows[1])
        const isShell = (col: number) => col >= 0 && col < SHELL.length && (below[col]?.ch ?? ' ') !== ' '
        const isHim = (col: number) => (top[col]?.color === 'clawd_body' && top[col]?.ch !== ' ') || top[col]?.bg === 'clawd_body'
        for (const [col, { ch }] of top.entries()) {
          // A sparkle with sky between it and him stands out on its own, so it must read as his.
          if (isSparkle(ch) && !isHim(col - 1) && !isHim(col + 1)) {
            expect([columns, n, i, view.scene[0], view.scene[1], isShell(col - 1) || isShell(col) || isShell(col + 1)]).toEqual([columns, n, i, view.scene[0], view.scene[1], false])
          }
        }
        await wait(250)
      }
      await clock.advance(10_000)
    }
    if (columns === 100) expect([...stands].includes(SHELL.length + 2)).toBe(true)
    await ui.unmount()
  }
})

for (const when of ['up as the turn ends', 'put up mid-spin'] as const) {
  test(`terminal, ${when}: cheering from home, the spin carries him a cell out, so a sparkle never sits flush on the edge or a corner off the shell; settled, he pads home`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    // A narrow beach (no shell) and wide ones. (At 64 columns the tide leaves no room for the step:
    // the right-hand sparkle would lose its cell of air off his claw, so he cheers at home.)
    for (const columns of [40, 100, 140]) {
      const props = { ...BAND, bodyColumns: columns }
      const home = columns >= 56 ? SHELL.length + 1 : 1
      let shown = await band($, 'terminal', props)
      await shown.wait(1_000)
      expect([columns, Math.min(...clawdAt(await shown.look()))]).toEqual([columns, home])
      await $.prompt.submit({ text: 'quick one', wait: false, origin: { kind: 'composer' } })
      await shown.ui.redraw({ ...props, isWorking: true })
      if (when === 'put up mid-spin') await shown.ui.unmount()
      await $.turn.complete({ answer: 'Done.', durationMs: 2_000, isAborted: false, turnId: `o${columns}`, reason: 'answer' })
      if (when === 'put up mid-spin') {
        await clock.advance(1_000)
        shown = await band($, 'terminal', props)
      } else {
        await shown.ui.redraw(props)
      }
      const { ui, look, wait } = shown
      let pairs = 0
      for (let i = 0; i < 24; i++) {
        const view = await look()
        const top = [...(view.scene[0] ?? '')]
        const below = [...(view.scene[1] ?? '')]
        const isShell = (col: number) => col >= 0 && col < SHELL.length && (below[col] ?? ' ') !== ' '
        const marks = top.flatMap((ch, col) => (isSparkle(ch) ? [col] : []))
        pairs += marks.length === 2 ? 1 : 0
        for (const col of marks) {
          // A cell of sky at least off the band's edge, and nothing of the shell under it or a corner away.
          const where = [columns, i, view.scene[0], view.scene[1]]
          expect([...where, col >= 1]).toEqual([...where, true])
          expect([...where, isShell(col - 1) || isShell(col) || isShell(col + 1)]).toEqual([...where, false])
        }
        await wait(250)
      }
      expect([columns, pairs > 0]).toEqual([columns, true])
      // Arms down and settled, he pads back to his spot by the shell (or the edge) on his own.
      let back = -1
      for (let i = 0; i < 40 && back < 0; i++) {
        if (Math.min(...clawdAt(await look())) === home) back = i
        await wait(250)
      }
      expect([columns, back >= 0]).toEqual([columns, true])
      await ui.unmount()
      await clock.advance(20_000)
    }
  })
}

test('terminal: waking from a nap, he stands with a stretch, his eyes still shut, before opening them', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(5 * 60_000)
  const { ui, look, wait } = await band($, 'terminal')
  expect((await look()).scene[1]).toContain('▐▂███▂█')
  await $.prompt.submit({ text: 'wake up', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  // Standing (his head back in the top row) with his arms up in a stretch, eyes still shut.
  expect((await look()).scene[0]).toContain('▗▟▂███▂█▄')
  expect((await look()).scene[2]).toContain(FEET)
  // Half a second on, his arms come down, eyes still shut; a beat later he opens them.
  await wait(500)
  expect((await look()).scene[0]).toContain('▐▂███▂█')
  await wait(250)
  expect((await look()).scene[0]).toContain(HEAD)
  await ui.unmount()
})

test('terminal: at low tide a whole wave rolls in on open water, at every width', async ($, on) => {
  world(on)
  await start($, 3, 0.02)
  for (const columns of [64, 80, 100, 140]) {
    const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    const view = await look()
    const swell = view.scene[1] ?? ''
    // The whole wave (a narrow band's open sea is a cell shorter, so its back is too).
    const crest = /▀▛█▄+▖$/u.exec(swell)?.[0] ?? ''
    expect([columns, crest.length >= CREST.length - 1]).toEqual([columns, true])
    // Beyond the wave, calm sea: at least a cell of flat water in the ground row past its end.
    const crestEnd = [...swell].length
    const ground = runs(view.rows[2]).reduce((sum, run) => sum + [...run.text].length, 0)
    expect(ground - crestEnd).toBeGreaterThanOrEqual(1)
    expect(seaStart(view)).toBe(crestEnd - crest.length + 1)
    await ui.unmount()
  }
})

test('terminal: the heart and the z never cover the wave, even with the water at his feet', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 100, 3)
  await turn($, clock)
  for (const columns of [40, 50, 64, 100]) {
    const pet = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    await pet.ui.pointer({ type: 'down', x: 6, y: 1, button: 'left', in: 'band' })
    for (let i = 0; i < 8; i++) {
      const { scene } = await pet.look()
      expect([columns, i, scene[1]?.includes('▀▛')]).toEqual([columns, i, true])
      await pet.wait(250)
    }
    expect((await pet.look()).scene.join('')).toMatch(/[▟▙▜▛]/u)
    await pet.ui.unmount()
  }
  await clock.advance(5 * 60_000)
  for (const columns of [40, 64, 100]) {
    const nap = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    let zs = 0
    for (let i = 0; i < 80; i++) {
      const { scene } = await nap.look()
      expect([columns, i, scene[1]?.includes('▀▛')]).toEqual([columns, i, true])
      zs += scene.join('').includes('z') ? 1 : 0
      await nap.wait(250)
    }
    expect(zs).toBeGreaterThan(0)
    await nap.ui.unmount()
  }
})

// Each cell of a row, left to right, with its colors.
function cellsOf(row: unknown): Array<{ ch: string; color: unknown; bg: unknown }> {
  return runs(row).flatMap(run => [...run.text].map(ch => ({ ch, color: run.color, bg: run.backgroundColor })))
}

// How many cells of sky part his arm from the wave's lip in the middle row (Infinity with no lip in it).
function armToLip(view: View): number {
  const cells = cellsOf(view.rows[1])
  let arm = -1
  cells.forEach((cell, i) => {
    if (cell.color === 'clawd_body' && cell.ch !== ' ') arm = i
  })
  const lip = cells.findIndex(cell => cell.color === FOAM && cell.ch !== ' ')

  return lip < 0 ? Infinity : lip - arm - 1
}

test('terminal: a cell of sky always parts his arm from the wave, and the wave keeps its head', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.9)
  await turn($, clock)
  for (const percent of [86, 100]) {
    await $.session.measure(measured(percent, 2))
    for (const columns of [40, 50, 64, 100, 140]) {
      const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
      // Long enough for him to wander to the water and for a high-tide lap to run up to his feet.
      for (let i = 0; i < 100; i++) {
        const view = await look()
        expect([percent, columns, i, armToLip(view) >= 1]).toEqual([percent, columns, i, true])
        expect([percent, columns, i, view.scene[1]?.includes('▀▛')]).toEqual([percent, columns, i, true])
        await wait(250)
      }
      await ui.unmount()
    }
  }
})

test('terminal: at 64 columns a pet shows a whole heart, clear of the wave, at any tide', async ($, on) => {
  const { clock } = world(on)
  await start($, 3, 0.1)
  await turn($, clock)
  for (const percent of [3, 42, 86, 100]) {
    await $.session.measure(measured(percent, 1))
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: 64 })
    await ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' })
    await wait(500)
    const { scene } = await look()
    // Two rows of heart: its lobes on top, its point below.
    expect([percent, scene[0]?.includes(HEART), scene[1]?.includes('▝▜▛▘')]).toEqual([percent, true, true])
    // The wave stands clear of it, a cell of sky between: its lip after the heart's point, never against it.
    const middle = scene[1] ?? ''
    expect([percent, middle.indexOf('▀▛') - (middle.indexOf('▝▜▛▘') + 4) >= 1]).toEqual([percent, true])
    await ui.unmount()
  }
})

test('terminal: below 46 columns the beach drops the shell and keeps a shore for the tide', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 3, 0.1)
  await turn($, clock)
  for (const columns of [30, 36, 40, 45]) {
    const at = async (percent: number) => {
      await $.session.measure(measured(percent, 1))
      const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
      const edges: number[] = []
      for (let i = 0; i < 40; i++) {
        const view = await look()
        expect(view.scene[1]).not.toContain(SHELL)
        // He never touches the band's left edge or the wave.
        expect([columns, percent, i, cellsOf(view.rows[1])[0]?.ch]).toEqual([columns, percent, i, ' '])
        expect([columns, percent, i, armToLip(view) >= 1]).toEqual([columns, percent, i, true])
        edges.push(seaStart(view))
        await wait(250)
      }
      await ui.unmount()

      return Math.min(...edges)
    }
    // The tide still comes in: three cells or more of sand go under as the context fills.
    const low = await at(3)
    const high = await at(100)
    expect([columns, low - high >= 3]).toEqual([columns, true])
  }
})

test('terminal: a long branch loses its prefix, then is shortened with an ellipsis, never dropped while a later part shows', async ($, on) => {
  world(on, { branch: 'robin/a-really-long-branch-name' })
  await start($)
  const lines: string[] = []
  for (const columns of [40, 50, 56, 64, 80, 100, 120, 140]) {
    const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    const line = (await look()).words[2] ?? ''
    lines.push(line)
    // The parts in order, and nothing after the branch unless the branch is there too.
    expect([columns, /^agent-plugins( · (robin\/)?a-really[^·]*?(…)?( · 2 uncommitted)?( · Opus 5\.5)?)?$/u.test(line)]).toEqual([columns, true])
    if (line.includes('…')) expect([columns, /uncommitted|Opus/u.test(line)]).toEqual([columns, false])
    await ui.unmount()
  }
  // At 64 columns the branch, its prefix gone, is cut short; with room it is whole and the rest follows.
  expect(lines[3]).toMatch(/^agent-plugins · a-really-l[a-z-]*…$/u)
  expect(lines.at(-1)).toBe('agent-plugins · robin/a-really-long-branch-name · 2 uncommitted · Opus 5.5')
})

test('terminal: a branch or a todo in CJK or emoji is measured in terminal cells, so a line never runs past its room', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on, { tools: false, branch: 'claude/日本語のブランチ' })
  on('tool.call', ($, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: '1', subject: String(e.subject) } } } : { result: { ok: true } }))
  await start($)
  await $.prompt.submit({ text: 'draw a crab', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'TaskCreate', subject: '🦀 カニを描く', description: '', activeForm: '🦀 カニを描いています' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  // "Planning" has its second, then the todo under way has the line.
  await clock.advance(1_250)

  const shortened = new Set<string>()
  for (let columns = 34; columns <= 160; columns++) {
    const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: columns, isWorking: true })
    const { beach, gutter } = layoutOf(columns)
    const room = columns - 2 - beach - gutter
    const { words } = await look()
    for (const line of words) {
      // A line of several parts fits its room as the terminal draws it, the ellipsis counted as two;
      // only a lone first part may be longer, and Ink cuts that one.
      if (line.includes(' · ')) {
        expect([columns, line, cells(line) + (line.match(/…/gu)?.length ?? 0) <= room]).toEqual([columns, line, true])
      }
      if (line.includes('…')) shortened.add(line.split(' · ').find(part => part.includes('…')) ?? '')
    }
    if (columns === 100) {
      expect(words[0]).toBe('🦀 カニを描いています · 0 of 1 done')
      // The branch's prefix goes before anything after it does.
      expect(words[2]).toBe('agent-plugins · 日本語のブランチ · 2 uncommitted · Opus 5.5')
    }
    await ui.unmount()
  }
  // A wide name was shortened somewhere along the way, a whole character before its ellipsis.
  expect([...shortened].some(part => /[\u3040-\u9fff]…$/u.test(part))).toBe(true)
})

test('terminal: on a narrow band a splash shortens what failed after a whole word, and the line still ends in "failed"; a quote that would end on a little word gives way', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: 64, isWorking: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the whole test suite' })
  expect((await look()).words[0]).toMatch(/^Splash! "Run the whole(?: test)?…" failed$/u)
  await ui.resize({ columns: 100, rows: 3, in: 'band' })
  expect((await look()).words[0]).toBe('Splash! "Run the whole test suite" failed')
  // Narrower, never '"Run the…"' (a little word before the ellipsis) nor '"Run…"' (the verb alone): a word for what failed.
  await ui.resize({ columns: 52, rows: 3, in: 'band' })
  expect((await look()).words[0]).toBe('Splash! A command failed')
  await ui.unmount()
})

test('desktop: the alt text says when a wave splashes him or he spins with joy', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  const splash = (await look()).svg?.alt
  // The frame goes on into his work, and so does what it says: the wave slides back out, then he works on.
  expect(splash).toContain('A wave splashes Clawd and slides back out, then he potters about on the sand')
  await clock.advance(3_500)
  expect((await look()).svg?.alt).toBe(splash)
  await ui.unmount()
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const resting = await band($, 'desktop')
  expect((await resting.look()).svg?.alt).toContain('spins with joy')
  await resting.ui.unmount()
})

test('desktop: waking from a nap, he stands with his eyes shut a moment, then watches the words', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(5 * 60_000)
  await $.prompt.submit({ text: 'wake up', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  const woke = (await look()).svg
  expect(woke?.alt).toContain('wakes up')
  // A stretch, arms up and eyes shut, then his arms down, eyes still shut, before he watches the words.
  expect(woke?.source).toMatch(/@keyframes m-stretch\{0%\{opacity:1\}/u)
  expect(woke?.source).toContain('m-blink')
  // The wake is part of the turn's first loop: tools coming and going leave it be.
  await clock.advance(2_000)
  await $.tool.call({ tool: 'Read', file_path: '/w/a.ts' })
  expect((await look()).svg?.source).toBe(woke?.source)
  await ui.unmount()
})

test('terminal: idle, the beach is mostly still (0.3 changes a second at most)', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)

  for (const columns of [64, 100, 140]) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    const first = await changes(look, wait, 60)
    const second = await changes(look, wait, 60)

    expect(first).toBeGreaterThan(2)
    expect(first / 60).toBeLessThanOrEqual(0.3)
    expect(second / 60).toBeLessThanOrEqual(0.3)
    await ui.unmount()
  }
})

test('terminal: napping, almost nothing moves (0.15 changes a second at most)', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(5 * 60_000)

  for (const columns of [64, 100, 140]) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    const first = await changes(look, wait, 60)
    const second = await changes(look, wait, 60)

    expect(first).toBeGreaterThan(0)
    expect(first / 60).toBeLessThanOrEqual(0.15)
    expect(second / 60).toBeLessThanOrEqual(0.15)
    await ui.unmount()
  }
})

test('terminal: never more than four changes a second, even while working', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await start($)
  const { ui, look } = await band($, 'terminal', { ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  let last = JSON.stringify(await look())
  const perSecond: number[] = []
  for (let second = 0; second < 30; second++) {
    let count = 0
    for (let i = 0; i < 8; i++) {
      await ui.advance(125)
      const now = JSON.stringify(await look())
      count += now === last ? 0 : 1
      last = now
    }
    perSecond.push(count)
  }

  expect(perSecond.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(3)
  expect(Math.max(...perSecond)).toBeLessThanOrEqual(4)
  await ui.unmount()
})

test('the person prefers reduced motion: nothing on the terminal moves on its own, in any mood', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, release } = world(on)
  on('settings.read', () => ({ value: { prefersReducedMotion: true } }))
  await start($)
  await turn($, clock)

  const holds = async (props: RenderPropsOf['AbovePrompt'], label: string) => {
    const { ui, look, wait } = await band($, 'terminal', props)
    const first = JSON.stringify(await look())
    for (let i = 0; i < 80; i++) {
      await wait(250)
      expect([label, JSON.stringify(await look())]).toEqual([label, first])
    }
    await ui.unmount()
  }

  await holds(BAND, 'idle')
  await $.prompt.submit({ text: 'think', wait: false, origin: { kind: 'composer' } })
  await holds({ ...BAND, isWorking: true }, 'thinking')
  void $.tool.call({ tool: 'Read', file_path: '/work/held.ts' }).catch(() => undefined)
  await clock.settle()
  await holds({ ...BAND, isWorking: true }, 'reading')
  release()
  await clock.settle()
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.session.measure(measured(88, 2))
  await clock.advance(20_000)
  await holds(BAND, 'high')
  await clock.advance(5 * 60_000)
  await holds(BAND, 'nap')
})

test('desktop: a turn watches the words until it changes something, then potters; tools never reload the Svg', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'work', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  const reading = new Set<string>()
  const working = new Set<string>()
  const thinking = (await look()).svg
  expect(thinking?.alt).toContain('watches the words')
  reading.add(thinking?.source ?? '')
  await clock.advance(1_500)
  await $.tool.call({ tool: 'Read', file_path: '/w/a.ts' })
  reading.add((await look()).svg?.source ?? '')
  await clock.advance(1_500)
  await $.tool.call({ tool: 'Grep', pattern: 'band' })
  reading.add((await look()).svg?.source ?? '')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Tidy up', description: '' })
  await $.session.measure(measured(42, 0.35))
  reading.add((await look()).svg?.source ?? '')
  await clock.advance(1_500)
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
  working.add((await look()).svg?.source ?? '')
  expect((await look()).svg?.alt).toContain('potters about')
  await clock.advance(1_500)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  working.add((await look()).svg?.source ?? '')
  await $.session.measure(measured(41, 0.38))
  await $.tool.call({ tool: 'Read', file_path: '/w/b.ts' })
  working.add((await look()).svg?.source ?? '')

  // One loop while Claude reads, one once it changes something: never more than one reload a turn.
  expect(reading.size).toBe(1)
  expect(working.size).toBe(1)
  // Reading, his looks over at the words are longer than his glances while pottering.
  expect(longestLook([...reading][0] ?? '')).toBeGreaterThan(longestLook([...working][0] ?? '') * 1.5)
  await ui.unmount()
})

test('desktop: idle redraws at the same tide leave the Svg source byte-identical', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  const first = (await look()).svg?.source
  await clock.advance(5_000)
  await $.session.measure(measured(42, 0.31))
  const second = (await look()).svg?.source
  await clock.advance(5_000)
  await $.session.measure(measured(41, 0.32))

  expect(second).toBe(first)
  expect((await look()).svg?.source).toBe(first)
  await ui.unmount()
})

test('desktop: a new prompt during the cheer lets it play out; the new turn begins its loop when it ends', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const resting = await band($, 'desktop')
  const cheer = (await resting.look()).svg
  expect(cheer?.source).toContain('m-spin6')
  expect(cheer?.alt).toContain('spins with joy')
  await resting.ui.unmount()

  await clock.advance(2_000)
  await $.session.measure(measured(44, 0.4))
  await $.prompt.submit({ text: 'and again', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  // The same source, so the frame does not reload: the spin carries on where it was.
  expect((await look()).svg?.source).toBe(cheer?.source)
  // The words move on at once.
  expect((await look()).words[0]).toBe('Thinking it over')
  // When the cheer is over the band redraws by itself, into the new turn's loop.
  await clock.advance(3_000)
  const after = (await look()).svg
  expect(after?.source).not.toContain('m-spin')
  expect(after?.alt).toContain('watches the words')
  await ui.unmount()
})

test('desktop: the tide holds through a turn, so the context creeping up never reloads the frame', async ($, on) => {
  const { clock } = world(on)
  await start($, 31)
  await $.prompt.submit({ text: 'work', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  const first = (await look()).svg?.source
  for (const percent of [33, 34, 36, 38, 41, 44]) {
    await clock.advance(1_000)
    await $.tool.call({ tool: 'Read', file_path: `/w/${percent}.ts` })
    await $.session.measure(measured(percent, 0.4))
    expect([percent, (await look()).svg?.source]).toEqual([percent, first])
  }
  // A big jump within one turn still shows, in a stride: a moment later, in case the turn is
  // landing (its cheer's frame would replace the stride's at once).
  await $.session.measure(measured(52, 0.5))
  expect((await look()).svg?.source).toBe(first)
  await clock.advance(STRIDE_WAIT_MS + 20)
  expect((await look()).svg?.source).toContain('data-tide="45"')
  expect((await look()).words[1]).toContain('52% context')
  // The next stride in the same turn waits its own moment, then shows by itself, with no other
  // event to draw it (each wait lets go of its timer as it fires).
  const strode = (await look()).svg?.source
  await $.session.measure(measured(70, 0.6))
  expect((await look()).svg?.source).toBe(strode)
  await clock.advance(STRIDE_WAIT_MS + 20)
  expect((await look()).svg?.source).not.toBe(strode)
  await ui.unmount()

  // The turn over and its moment played, the tide catches up.
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5_000)
  const after = await band($, 'desktop')
  expect((await after.look()).svg?.source).toContain('data-tide="70"')
  await after.ui.unmount()
})

test('desktop: a redraw during the nap hands the frame the same source, so the z\'s never restart', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(4 * 60_000)
  const { ui, look } = await band($, 'desktop')
  const asleep = (await look()).svg?.source
  expect((await look()).svg?.alt).toContain('naps by a shell')
  for (const wait of [10_000, 45_000, 120_000]) {
    await clock.advance(wait)
    await $.session.measure(measured(42, 0.31))
    expect((await look()).svg?.source).toBe(asleep)
  }
  await ui.unmount()
})

test('desktop: the z\'s pop up one after another and drift off together, at full color all the while', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(4 * 60_000)
  const { ui, look } = await band($, 'desktop')
  const source = (await look()).svg?.source ?? ''
  const frames = [0, 1, 2].map(i => new RegExp(`@keyframes z${i}\\{(.*?)\\}\\}`).exec(source)?.[1] ?? '')
  const stops = frames.map(body => /^0%,([\d.]+)%\{opacity:1;transform:translateY\(\.5px\) scale\(0\).*?([\d.]+)%,100%\{opacity:1;transform:translateY\(-1\.2px\) scale\(0\)$/u.exec(body))
  const appear = stops.map(match => Number(match?.[1]))
  const fade = stops.map(match => match?.[2])
  // Never a half-faded z (a muddy slate on the dark page): each pops up from a point and shrinks back to one.
  for (const body of frames) for (const opacity of body.match(/opacity:[^;}]*/gu) ?? []) expect(opacity).toBe('opacity:1')
  // The first only once he has curled up, never on his standing arm (he stands eyes shut until 1.4 s).
  const period = Number(/\.z0\{animation:z0 ([\d.]+)s/.exec(source)?.[1] ?? 0)
  expect(((appear[0] ?? 0) / 100) * period).toBeGreaterThanOrEqual(1.4)
  expect(appear[0]).toBeLessThan(appear[1] ?? 0)
  expect(appear[1]).toBeLessThan(appear[2] ?? 0)
  expect(stops.every(match => match !== null)).toBe(true)
  expect(new Set(fade).size).toBe(1)
  await ui.unmount()
})

test('desktop: words drop whole parts by the width the host gives, and keep them all when it gives none', async ($, on) => {
  world(on)
  await start($, 86, 1.94)
  for (const [columns, line] of [
    [0, '86% context · try /compact · $1.94 · 5h limit 23%'],
    [64, '86% context · try /compact · $1.94'],
    [140, '86% context · try /compact · $1.94 · 5h limit 23%'],
  ] as const) {
    const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns })
    expect([columns, (await look()).words[1]]).toEqual([columns, line])
    await ui.unmount()
  }
})

test('desktop: Clawd falls asleep on his own after three quiet minutes', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  expect((await look()).svg?.alt).toContain('strolls on the sand')

  // Nothing else happens: no tool, no measure. The band still redraws once the nap is due.
  await clock.advance(3 * 60_000)
  expect((await look()).svg?.alt).toContain('naps by a shell')
  expect((await look()).words[0]).toBe('Napping · last turn took 41s')
  await ui.unmount()
})

test('desktop: glancing eyes stay inside his head, on clay, in every pose', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  for (const props of [BAND, { ...BAND, isWorking: true }]) {
    const { ui, look } = await band($, 'desktop', props)
    const source = (await look()).svg?.source ?? ''
    expect(source).toContain('p-lookR')
    expect(source).toContain('p-walkR1')
    expect(source).not.toMatch(EYE_ON_TOP)
    await ui.unmount()
  }
})

// The desktop's CSS, seeked: what Clawd's poses and his walk show `t` seconds after the frame opened.
// Each element's animations are listed in order, and the last that has an effect wins (a lead with
// no fill has none once it is over).
type Run = { name: string; period: number; wait: number; count: number; fill: string }
type Parsed = { frames: Map<string, Array<[number, string]>>; walk: Run[]; poses: Array<{ name: string; runs: Run[]; still: string }> }
const PARSED = new Map<string, Parsed>()
function parseDesk(source: string): Parsed {
  const known = PARSED.get(source)
  if (known !== undefined) return known
  const motion = /@media \(prefers-reduced-motion:no-preference\)\{(.*)\}<\/style>/u.exec(source)?.[1] ?? ''
  const frames = new Map<string, Array<[number, string]>>()
  for (const m of motion.matchAll(/@keyframes ([\w-]+)\{((?:[^{}]*\{[^}]*\})*)\}/gu)) {
    frames.set(m[1] ?? '', [...(m[2] ?? '').matchAll(/([\d.,%]+)\{([^}]*)\}/gu)].flatMap(stop => (stop[1] ?? '').split(',').map(at => [Number(at.replace('%', '')) / 100, stop[2] ?? ''] as [number, string])))
  }
  const runsOf = (className: string): Run[] => {
    const list = new RegExp(`(?:^|\\})\\.${className}\\{animation:([^}]*)\\}`, 'u').exec(motion)?.[1]
    return (list ?? '').split(',').filter(entry => entry.trim() !== '').map(entry => {
      const [name = '', length = '', , delay = '', count = '', fill = ''] = entry.trim().split(' ')
      return { name, period: Number(length.replace('s', '')), wait: Number(delay.replace('s', '')), count: count === 'infinite' ? Infinity : Number(count), fill }
    })
  }
  const names = [...new Set([...source.matchAll(/<g class="pose p-([\w-]+)">/gu)].map(m => m[1] ?? ''))]
  const parsed: Parsed = {
    frames,
    walk: runsOf('walk'),
    poses: names.map(name => ({ name, runs: runsOf(`p-${name}`), still: [...motion.matchAll(new RegExp(`\\.p-${name}\\{opacity:(\\d)\\}`, 'gu'))].at(-1)?.[1] ?? '0' })),
  }
  PARSED.set(source, parsed)
  return parsed
}
function seekDesk(source: string, t: number): { pose: string; x: number } {
  const { frames, walk, poses } = parseDesk(source)
  const valueOf = (runs: readonly Run[], pattern: RegExp): string | null => {
    let value: string | null = null
    for (const run of runs) {
      const local = t - run.wait
      const stops = frames.get(run.name) ?? []
      const at = (fraction: number) => {
        let found = stops[0]?.[1] ?? ''
        for (const [when, what] of stops) if (when <= fraction + 1e-5) found = what
        return found
      }
      if (local < 0) {
        if (run.fill === 'both') value = at(0)
      } else if (local >= run.period * run.count) {
        if (run.fill === 'both') value = at(1)
      } else {
        value = at((local % run.period) / run.period)
      }
    }
    return value === null ? null : (pattern.exec(value)?.[1] ?? null)
  }
  const shown = poses.filter(pose => (valueOf(pose.runs, /opacity:(\d)/u) ?? pose.still) === '1').map(pose => pose.name)

  return { pose: shown.join('+'), x: Number(valueOf(walk, /translateX\((-?[\d.]+)px\)/u) ?? 0) }
}

// An edit that starts while the line still holds a read: the beach's picture changes to his potter
// with the words that name the edit, never under "Reading" a moment before them: the Svg never
// reloads to the potter as the edit starts, half a second before the line names it.
test('desktop: his potter comes in with the words that name the work, never under a read the line still holds', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, during } = world(on)
  await start($)
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  await $.prompt.submit({ text: 'tidy the hooks', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await clock.advance(1_500)
  const frames: Array<{ at: number; words: string; alt: string }> = []
  let at = 0
  const step = async (ms: number) => {
    for (let left = ms; left > 0; left -= 10) {
      await clock.advance(10)
      at += 10
      const seen = await look()
      frames.push({ at, words: seen.words.join(' ').replace(/\s+/gu, ' '), alt: seen.svg?.alt ?? '' })
    }
  }
  await $.tool.call({ tool: 'Read', file_path: '/work/hooks/alpha.ts' })
  await step(300)
  during.tool = () => step(2_000)
  await $.tool.call({ tool: 'Edit', file_path: '/work/hooks/charlie.ts', old_string: 'a', new_string: 'b' })
  during.tool = null
  await step(1_000)
  const potters = frames.filter(frame => frame.alt.includes('potters'))
  expect(potters.length).toBeGreaterThan(0)
  // From the first frame of his potter, the words name the edit (or have moved past it): never the read.
  expect(potters.filter(frame => frame.words.includes('Reading alpha.ts')).map(frame => frame.at)).toEqual([])
  // And the words named the edit no earlier than the picture went to it, either.
  const edited = frames.find(frame => frame.words.includes('Editing charlie.ts'))
  expect(potters[0]?.at).toBe(edited?.at)
  await ui.unmount()
})

// The turn is written down as over a moment before the host says the work is: in that moment the
// picture keeps what it had (the read, when the line never came to the edit; the potter, when it
// did), so a turn you stop is one new frame, Clawd at rest (a cheer is one frame whatever he did).
for (const isNamed of [false, true]) {
  test(`desktop: a turn stopped ${isNamed ? 'after the words named its edit keeps his potter' : 'while the line still holds a read never brings his potter in'} for the moment before the host's word, so the stop is one new frame`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
    await $.prompt.submit({ text: 'tidy the hooks', wait: false, origin: { kind: 'composer' } })
    await ui.redraw({ ...BAND, isWorking: true })
    await clock.advance(1_500)
    await $.tool.call({ tool: 'Read', file_path: '/work/hooks/alpha.ts' })
    await clock.advance(300)
    await $.tool.call({ tool: 'Edit', file_path: '/work/hooks/charlie.ts', old_string: 'a', new_string: 'b' })
    await clock.advance(isNamed ? 1_000 : 100)
    const before = (await look()).svg
    expect(before?.alt ?? '').toContain(isNamed ? 'potters' : 'watches the words')
    await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: true, turnId: 't-stop', reason: 'aborted' } as TurnCompleteInput)
    const sources = new Map<string, string>()
    for (let at = 0; at < 120; at += 10) {
      if (at === 60) await ui.redraw(BAND)
      const seen = (await look()).svg
      if (seen !== null && seen.source !== before?.source) sources.set(seen.source, seen.alt)
      await clock.advance(10)
    }
    expect([...sources.values()]).toEqual([expect.stringContaining('strolls on the sand')])
    await ui.unmount()
  })
}

// The pet on the desktop: Clawd is an image (an interactive frame blanks as its source changes), so a
// pointer resting on the beach brings a second picture, the heart, over it from where it is parked.
// Both load in the same render and run on the page's one clock, so the heart's walk must be his walk,
// step for step: the loop, the lead into it, and a cheer's or a splash's.
test('desktop: the heart a pet brings walks his walk step for step, in his loops and through a cheer or a splash', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const frames: Array<{ label: string; source: string; heart: string }> = []
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await clock.advance(3_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  frames.push({ label: 'splash', ...(await seen()) })
  await clock.advance(6_000)
  frames.push({ label: 'work', ...(await seen()) })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw(BAND)
  frames.push({ label: 'cheer', ...(await seen()) })
  await clock.advance(20_000)
  await ui.redraw(BAND)
  frames.push({ label: 'idle', ...(await seen()) })
  async function seen() {
    const view = await look()
    return { source: view.svg?.source ?? '', heart: view.heart }
  }
  for (const { label, source, heart } of frames) {
    expect([label, heart]).toEqual([label, expect.stringMatching(/^<svg /u)])
    expect([label, /@keyframes walk\{/u.test(heart)]).toEqual([label, true])
    const off: string[] = []
    for (let t = 0; t < 16; t += 0.05) {
      const [his, its] = [seekDesk(source, t).x, seekDesk(heart, t).x]
      if (his !== its) off.push(`${label} ${t.toFixed(2)}: ${its} against his ${his}`)
    }
    expect(off.slice(0, 4)).toEqual([])
  }
  // His view box with a row of sky above it, lifted a row as it shows, so the two pictures lie one
  // on the other.
  const boxOf = (svg: string) => (/viewBox="([^"]+)"/u.exec(svg)?.[1] ?? '').split(' ').map(Number)
  const tallOf = (svg: string) => Number(/ height="([^"]+)"/u.exec(svg)?.[1])
  expect(HEART_SHOWN * ROW_PX + ROW_PX).toBe(0)
  for (const { label, source, heart } of frames) {
    const [x, y, w, h] = boxOf(source)
    expect([label, boxOf(heart), tallOf(heart)]).toEqual([label, [x, y! - ROW_PX, w, h! + ROW_PX], tallOf(source) + ROW_PX])
  }
  await ui.unmount()
})

test('desktop: resting the pointer on the beach brings a parked heart over it; motion only where no one asked for less; no script', async ($, on) => {
  world(on)
  await start($)
  const { ui, look } = await band($, 'desktop')
  const { tree, svg, heart } = await look()
  const motion = '@media (prefers-reduced-motion:no-preference){'

  // Parked across the band's bottom edge (absolute, so moving it moves nothing) until the band's own
  // hover lifts it over the beach; never revealed, which the desktop would draw as a card and restart
  // his walk in.
  expect(find(tree, 'Box').filter(box => box.props?.display === 'none')).toEqual([])
  const parked = find(tree, 'Box').find(box => (box as { hover?: unknown }).hover !== undefined)
  expect([parked?.props?.position, parked?.props?.top, parked?.props?.left]).toEqual(['absolute', HEART_PARKED, 0])
  // The drawn tree carries a Box's hover beside its props.
  expect((parked as { hover?: unknown } | undefined)?.hover).toEqual({ top: HEART_SHOWN })
  // Never an empty alt: the desktop app draws no Svg whose alt is empty, and the heart never showed.
  expect(find(parked, 'Svg')[0]?.props?.alt).toBe(HEART_ALT)
  for (const source of [svg?.source ?? '', heart]) {
    const css = /<style>(.*)<\/style>/.exec(source)?.[1] ?? ''
    expect(css).toContain(motion)
    // Outside the motion block nothing animates: that is what a person who prefers reduced motion sees.
    expect(css.slice(0, css.indexOf(motion))).not.toContain('animation')
    expect(source).not.toMatch(/<script|on[a-z]+=|:hover/i)
    expect(source.length).toBeLessThan(131_072)
  }
  // Shown, the heart is already up (its picture loaded with the beach), so it beats softly.
  expect(heart).toContain('.heart{animation:beat 1.6s ease-in-out infinite}')

  await ui.unmount()
})

test('the reduced-motion setting is read again on /band, and the toast rounds the percent', async ($, on) => {
  const { toasts } = world(on)
  let prefersReducedMotion = false
  on('settings.read', () => ({ value: { prefersReducedMotion } }))
  await start($)
  const moving = await band($, 'desktop')
  expect((await moving.look()).svg?.source).toContain('@keyframes')
  await moving.ui.unmount()

  prefersReducedMotion = true
  expect((await run($, 'band', 'tide')).text).toBe('Tide, still for reduced motion. Try /band hearth or /config.')
  const still = await band($, 'desktop')
  expect((await still.look()).svg?.source).not.toContain('@keyframes')
  await still.ui.unmount()

  await $.session.measure(measured(86.4, 1.9))
  expect(toasts).toEqual(["High tide: context is 86% full. Try /compact soon."])
})

// Which way his eyes look, from the head in the top row: open, right, left, shut, or ? (curled, spinning).
function eyesOf(view: View): string {
  const head = view.scene[0] ?? ''
  if (head.includes('▛███▛█')) return 'O'
  if (head.includes('█▟███▟')) return 'R'
  if (head.includes('▟███▟█')) return 'L'
  if (head.includes('▂███▂')) return '-'

  return '?'
}

test('terminal: waking up and after a cheer, he looks at you before he looks away', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  for (const columns of [64, 100, 140]) {
    for (const minutes of [4, 9]) {
      const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
      // A long nap, on both clocks: every idle timer from before it is long overdue.
      for (let i = 0; i < minutes * 240; i++) {
        await wait(250)
        await clock.advance(250)
      }
      await $.prompt.submit({ text: 'wake up', wait: false, origin: { kind: 'composer' } })
      await ui.redraw({ ...BAND, bodyColumns: columns, isWorking: true })
      let woke = ''
      for (let i = 0; i < 20; i++) {
        woke += eyesOf(await look())
        await wait(250)
        await clock.advance(250)
      }
      // Up with his eyes shut for three quarters of a second (a stretch, then his arms down), then
      // eyes open for 3 s at least: no glance out to sea (his pupils on the head's top edge, which a
      // dark terminal swallows) before that.
      expect([columns, minutes, woke]).toEqual([columns, minutes, expect.stringMatching(/^-{3}O{12}/u)])

      await $.turn.complete({ answer: 'Done.', durationMs: 3_000, isAborted: false, turnId: 'w', reason: 'answer' })
      await ui.redraw({ ...BAND, bodyColumns: columns })
      let cheered = ''
      for (let i = 0; i < 40; i++) {
        cheered += eyesOf(await look())
        await wait(250)
        await clock.advance(250)
      }
      // The spin, his arms up (1.75 s), then 3 s more of looking back before any glance or stroll. The
      // turn lands just after a tick, and the spin's first frame keeps the next one too (see pace.ts).
      expect([columns, minutes, cheered]).toEqual([columns, minutes, expect.stringMatching(/^\?{14}O{19}/u)])
      await ui.unmount()
    }
  }
})

test('terminal: petting him while he naps gives him a heart, and he sleeps on, lively or still', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(4 * 60_000)
  for (const [columns, motion] of [[40, 'lively'], [64, 'lively'], [100, 'lively'], [40, 'still'], [64, 'still'], [100, 'still']] as const) {
    await run($, 'band', motion)
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    expect((await look()).scene[1]).toContain('▐▂███▂█')
    await ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' })
    for (let i = 0; i < 16; i++) {
      const view = await look()
      // Still curled up, eyes shut, his head down a row; the words still say he naps.
      expect([columns, i, view.scene[1]?.includes('▐▂███▂█'), view.words[0]?.startsWith('Napping')]).toEqual([columns, i, true, true])
      if (i < 8) {
        expect([columns, i, view.scene[0]?.includes(HEART), view.scene.join('').includes('z')]).toEqual([columns, i, true, false])
      }
      expect([columns, i, view.scene[1]?.includes('▀▛')]).toEqual([columns, i, true])
      await wait(250)
    }
    expect((await look()).scene.join('')).not.toContain(HEART)
    await ui.unmount()
  }
})

test('terminal: on the narrowest beaches a pet never takes the wave\'s head', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 3, 0.1)
  await turn($, clock)
  for (const columns of [36, 40, 42, 44]) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    let hearts = 0
    // Five minutes of strolls along the little beach, and a pet every 4 s wherever he is.
    for (let i = 0; i < 1200; i++) {
      if (i % 16 === 0) {
        await ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' })
      }
      const view = await look()
      expect([columns, i, view.scene[1]?.includes('▀▛'), armToLip(view) >= 1]).toEqual([columns, i, true, true])
      hearts += view.scene[0]?.includes(HEART) === true ? 1 : 0
      await wait(250)
    }
    expect([columns, hearts > 0]).toEqual([columns, true])
    await ui.unmount()
  }
})

// At 34 to 40 columns with the tide well in, he stands by the water a cell or two from home, with no
// room beside him for the heart, so a pet is never only a wink; nor is the heart a size down there
// (three cells read as a pink "Y": a quadrant cell is tall, and the lobes stand up like posts). The
// one heart there is, four cells, is held up in his raised claw where it has no room beside him, the
// wave's crest standing back a cell for it, and a wave lapping up the sand mid-pet never takes the
// heart away for a moment: the crest keeps its cell of sky from the heart while it shows.
test('terminal: every pet shows the one heart for its whole 2 s, held up in his raised claw on the narrowest beach with the tide in, never a three-cell "Y"', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 3, 0.1)
  await turn($, clock)
  const held: Record<string, number> = {}
  const none: Record<string, number> = {}
  for (const [percent, columns, pets] of [
    [83, 34, 12],
    [83, 40, 12],
    [100, 34, 6],
    [3, 34, 6],
    [3, 44, 50],
    [42, 100, 50],
  ] as const) {
    await $.session.measure(measured(percent, 1))
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    const at = `${percent}% ${columns}c`
    held[at] = 0
    none[at] = 0
    for (let pet = 0; pet < pets; pet++) {
      await ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' })
      // The heart shows for its first eight ticks; every one of them.
      for (let k = 0; k < 7; k++) {
        await wait(250)
        const view = await look()
        const [top = '', middle = ''] = view.scene
        const col = top.indexOf('▟▙▟▙')
        // Never the three-cell heart, anywhere.
        expect([at, pet, k, /█▄█|▝█▘/u.test(top + middle)]).toEqual([at, pet, k, false])
        if (col < 0) {
          none[at] = (none[at] ?? 0) + 1
          continue
        }
        // Its lobes, and its point right under them...
        expect([at, pet, k, middle.slice(col, col + 4)]).toEqual([at, pet, k, '▝▜▛▘'])
        // ...a cell of sky from the wave's lip, which keeps its head, and him a cell from the wave.
        expect([at, pet, k, middle.includes('▀▛'), middle.indexOf('▀▛') < col || middle.indexOf('▀▛') - (col + 4) >= 1, armToLip(view) >= 1]).toEqual([at, pet, k, true, true, true])
        // Held up in his raised claw ("█▄▟▙▟▙"): flush against him, with no cell between; and never
        // flush against his lowered arm ("█▀▝▜▛▘"), where heart and body run together.
        held[at] = (held[at] ?? 0) + (col > 0 && top[col - 1] !== ' ' ? 1 : 0)
        expect([at, pet, k, middle.slice(col - 1, col + 4)]).not.toEqual([at, pet, k, '▀▝▜▛▘'])
      }
      await wait(250 * 9)
    }
    await ui.unmount()
  }
  // The heart shows on every frame of every pet: beside him wherever it has room, and held up in his
  // claw by the water on the narrowest beach.
  expect(none).toEqual({ '83% 34c': 0, '83% 40c': 0, '100% 34c': 0, '3% 34c': 0, '3% 44c': 0, '42% 100c': 0 })
  // (Held up in his claw for all seven frames looked at: he holds it as long as it shows, and lowers
  // his claw as it goes, never with the heart still up, where the heart's point would meet his arm,
  // `▀▝`, one blob of body and heart.)
  expect(held).toEqual({ '83% 34c': 12 * 7, '83% 40c': 12 * 7, '100% 34c': 0, '3% 34c': 0, '3% 44c': 0, '42% 100c': 0 })
})

// A splash a band appears in the middle of picks up as far in as the next whole tick, so it ends with
// the facts' wave or a tick before it, never a tick after; with less than four ticks of it left, he is
// at rest.
test('terminal: a splash carried on as the band appears picks up at the next whole tick', () => {
  expect([resumeSplash(0), resumeSplash(1), resumeSplash(1_000), resumeSplash(1_100), resumeSplash(1_249), resumeSplash(2_001)]).toEqual([-0, -1, -4, -5, -5, -9])
  expect([resumeSplash(null), resumeSplash(-50), resumeSplash(2_250), resumeSplash(3_000)]).toEqual([-1_000_000, -1_000_000, -1_000_000, -1_000_000])
})

test('terminal: the narrowest bands keep a splash\'s verdict and the /compact nudge', async ($, on) => {
  world(on)
  await start($, 100, 4.2)
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: 50, isWorking: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  for (const [columns, splash, tide] of [
    // One step down at a time: the verdict alone, "A tool failed" (which any failure is), a word for
    // what failed, then the quote.
    [36, 'Splash!', '100%'],
    [40, 'Splash!', '100% try /compact'],
    [42, 'Splash!', '100% · try /compact'],
    [48, 'Splash! A tool failed', '100% · try /compact'],
    // Room for '"Run the…"', but a quote never ends on a little word: the line says what failed in a word.
    [52, 'Splash! A command failed', '100% · try /compact'],
    [60, 'Splash! "Run the tests" failed', '100% context · try /compact'],
  ] as const) {
    await ui.resize({ columns, rows: 3, in: 'band' })
    expect([columns, (await look()).words.slice(0, 2)]).toEqual([columns, [splash, tide]])
  }
  await ui.unmount()
})

test('desktop: a narrow beach keeps the /compact nudge, giving up "context" and then its separator, never "try"', async ($, on) => {
  world(on)
  await start($, 86, 1.94)
  for (const [columns, tide] of [
    [100, '86% context · try /compact · $1.94 · 5h limit 23%'],
    [64, '86% context · try /compact · $1.94'],
    [56, '86% context · try /compact'],
    [48, '86% · try /compact'],
    [41, '86% try /compact'],
    [40, '86% try /compact'],
    [36, '86% try /compact'],
    [35, '86%'],
    [34, '86%'],
  ] as const) {
    const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns })
    expect([columns, (await look()).words[1]]).toEqual([columns, tide])
    await ui.unmount()
  }
})

test('desktop: he dozes off where he stood and walks home to the shell; a pet\'s heart rides home with him and settles over him as he curls up', async ($, on) => {
  // (Just after a step of the sky, which would be a new frame of its own: see "the sky's steps".)
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  await turn($, clock)
  await clock.advance(10_000)
  const { ui, look } = await band($, 'desktop')
  const idle = (await look()).svg?.source ?? ''
  expect(idle).toContain('@keyframes walk')
  // The nap comes due 151 s into the idle loop (three quiet minutes after the turn), 14 s into its
  // sixth time round: he is out on the sand, at the far end of his scuttle.
  await clock.advance(151_000)
  const nap = (await look()).svg?.source ?? ''
  expect((await look()).svg?.alt).toContain('naps by a shell')
  const homeward = /@keyframes homeward\{(.*?)\}\}/.exec(nap)?.[1] ?? ''
  const steps = [...homeward.matchAll(/translateX\((\d+)px\)/g)].map(match => Number(match[1]))
  // He starts out on the sand, a pixel at a time back to the shell, never jumping.
  expect(steps[0]).toBeGreaterThan(0)
  expect(steps.at(-1)).toBe(0)
  steps.slice(1).forEach((x, i) => expect((steps[i] ?? 0) - x).toBeLessThanOrEqual(1))
  // The walk, a moment standing with his eyes shut, then the curl; the z's wait for it.
  const intro = Number(/\.homeward\{animation:homeward ([\d.]+)s/.exec(nap)?.[1])
  expect(nap).toContain(`.curl{animation:reveal ${intro}s`)
  expect(Math.round(Number(/\.z0\{animation:z0 [\d.]+s ease-in-out ([\d.]+)s/.exec(nap)?.[1]) * 100)).toBe(Math.round((intro - 1.4) * 100))
  // For a pointer resting on him, the heart rides his walk home beside his claw, on his very steps,
  // and is handed over where it stood the moment he curls up, drifting up to its place above his
  // head: one heart all the while, never a beat without one and never a second one.
  const heart = (await look()).heart
  expect(/@keyframes homeward\{(.*?)\}\}/.exec(heart)?.[1]).toBe(homeward)
  expect(heart).toContain(`.homeward{animation:homeward ${intro}s step-end 1 both}`)
  expect(heart).toContain(`.sleepy{animation:hide ${intro}s step-end 1 both}`)
  const handoff = /\.napheart\{animation:napheart ([\d.]+)s linear 1 both\}@keyframes napheart\{0%\{transform:translate\(([-\d.]+)px,([-\d.]+)px\) scale\(0\);animation-timing-function:step-end\}([\d.]+)%\{transform:translate\(\2px,\3px\) scale\(1\);animation-timing-function:ease-in-out\}100%\{transform:translate\(0,0\) scale\(1\)\}\}/u.exec(heart)
  expect(handoff).not.toBeNull()
  const [glide, dx, dy, shown] = (handoff ?? []).slice(1).map(Number) as [number, number, number, number]
  expect(Math.abs((shown / 100) * glide - intro)).toBeLessThan(0.01)
  expect(glide - intro).toBeGreaterThan(0.4)
  // The walk heart's place (his claw, home at the shell) less the sleeper's: one spot on the page.
  const walkHeart = /<g class="homeward"><g class="heart" fill="[^"]+"[^>]*><path d="M([-\d.]+) ([-\d.]+)L/u.exec(heart)
  const napHeart = /<g class="napheart"><g class="heart" fill="[^"]+"[^>]*><path d="M([-\d.]+) ([-\d.]+)L/u.exec(heart)
  expect(Math.abs(Number(napHeart?.[1]) + dx - Number(walkHeart?.[1]))).toBeLessThan(0.01)
  expect(Math.abs(Number(napHeart?.[2]) + dy - Number(walkHeart?.[2]))).toBeLessThan(0.01)
  // Redraws while he sleeps keep the source, walk and all.
  await clock.advance(30_000)
  await $.session.measure(measured(42, 0.31))
  expect((await look()).svg?.source).toBe(nap)
  await ui.unmount()
})

// A new frame while he walks home for his nap (a step of the sky, half a minute's walk on the widest
// beach) opens him where the walk has him, never back by the shell; curled up, he is home.
test('desktop: a frame opened during his walk home for a nap starts him where that walk has him', () => {
  const nap: Scene = { mood: 'nap', tide: 30, still: false, moment: null, from: 45, width: 224, wave: 0, night: false, treasure: null, castle: 0, built: false, sky: 10, sea: null }
  // A look home, then a step every 0.56 s.
  const walked = [0, 400, 6_000, 12_000].map(ms => positionAt(nap, ms))
  expect(walked[0]).toBe(45)
  expect(walked.every((x, i) => i === 0 || x <= (walked[i - 1] ?? 0))).toBe(true)
  expect([(walked[2] ?? 0) > 30, (walked[3] ?? 0) > 20]).toEqual([true, true])
  expect([positionAt(nap, 60_000), positionAt({ ...nap, curled: true }, 0), positionAt({ ...nap, still: true }, 6_000)]).toEqual([0, 0, 0])
})

test('desktop: a long nap sleeps on through the sky\'s steps: each new frame opens with him curled up and his z\'s where they were', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  await clock.advance(4 * 60_000)
  await ui.redraw(BAND)
  const first = (await look()).svg?.source ?? ''
  expect(first).toContain('<g class="clawd sleepy">')
  // An hour asleep: three steps of the sky, each a new frame that the band draws by itself.
  const frames = new Set<string>([first])
  for (let i = 0; i < 60; i++) {
    await clock.advance(60_000)
    frames.add((await look()).svg?.source ?? '')
  }
  const last = (await look()).svg?.source ?? ''
  expect(frames.size).toBeGreaterThan(3)
  // Curled from the first beat, never the walk home and the stand with his eyes shut.
  expect([last.includes('<g class="clawd sleepy">'), last.includes('class="clawd curl"'), last.includes('@keyframes homeward')]).toEqual([false, true, false])
  await ui.unmount()
})

test('desktop: a nap carried on by /band still and lively, or by a new width, opens with him curled up, never standing to lie down again', async ($, on) => {
  // (Just after a step of the sky, which would be a new frame of its own.)
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  await clock.advance(5 * 60_000)
  await ui.redraw(BAND)
  const source = async () => (await look()).svg?.source ?? ''
  // The nap's first frame walks him home and stands him a moment with his eyes shut, then curls him up.
  expect(await source()).toContain('<g class="clawd sleepy">')
  await clock.advance(20_000)
  await run($, 'band', 'still')
  await ui.redraw(BAND)
  await clock.advance(5_000)
  await run($, 'band', 'lively')
  await ui.redraw(BAND)
  // Lively again, he sleeps on from the first frame, the first z already up, as the still frame had it.
  const lively = await source()
  expect([lively.includes('sleepy'), lively.includes('<g class="clawd curl">'), /\.z0\{animation:z0 [\d.]+s ease-in-out -2\.1s/u.test(lively)]).toEqual([false, true, true])
  // A new width mid-nap rebuilds the frame: curled up from the first too.
  await clock.advance(20_000)
  await ui.redraw({ ...BAND, bodyColumns: 44 })
  const narrow = await source()
  expect([narrow !== lively, narrow.includes('sleepy'), narrow.includes('<g class="clawd curl">')]).toEqual([true, false, true])
  await ui.unmount()
})

test('desktop: a nap carried into a new frame keeps its z\'s where they were, so a "zzZ" never drops back to one small z', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  // He dozes off on his own a while after the turn: wait for the nap's frame, to know when it loaded.
  for (let k = 0; k < 5 * 60 && !((await look()).svg?.source ?? '').includes('class="clawd curl"'); k++) {
    await clock.advance(1_000)
  }
  // Where each frame's z loop begins (its CSS delay, seconds), the same for all three z's.
  const delay = async () => {
    const source = (await look()).svg?.source ?? ''
    const found = [0, 1, 2].map(i => Number(new RegExp(`\\.z${i}\\{animation:z${i} 7\\.5s ease-in-out (-?[\\d.]+)s infinite both\\}`, 'u').exec(source)?.[1]))
    expect([found.every(n => Number.isFinite(n)), new Set(found).size]).toEqual([true, 1])
    return { source, at: found[0] ?? NaN }
  }
  // Seconds into the z loop a frame is `ms` after it loaded, from that frame's delay.
  const into = (at: number, ms: number) => Math.round(((ms / 1000 - at) % 7.5) * 100) / 100
  const first = await delay()
  expect(first.source).toContain('<g class="clawd sleepy">')
  // A new width 13 s in, with "zzZ" up: the new frame opens curled, its z's just where they were.
  await clock.advance(13_000)
  await ui.redraw({ ...BAND, bodyColumns: 46 })
  const wide = await delay()
  expect([wide.source.includes('sleepy'), wide.at]).toEqual([false, -into(first.at, 13_000)])
  // Another 4 s on, another width: carried on again from the frame before.
  await clock.advance(4_000)
  await ui.redraw({ ...BAND, bodyColumns: 40 })
  const narrow = await delay()
  expect([narrow.source.includes('sleepy'), narrow.at]).toEqual([false, -into(wide.at, 4_000)])
  // Not the old restart at one small z: these handoffs fall mid-loop, all three z's up.
  expect([into(first.at, 13_000) > 3.4, into(first.at, 13_000) < 5.6]).toEqual([true, true])
  await ui.unmount()
})

test('a turn you stop with Esc, or one the model declines, reads "Stopped after 41s": calm, no Done and no spin', async ($, on) => {
  world(on)
  await start($)
  const endings = [
    { reason: 'aborted', isAborted: true },
    { reason: 'refusal', isAborted: false, refusal: { category: null, explanation: null } },
  ] as const

  for (const ending of endings) {
    for (const surface of SURFACES) {
      // One band watching as the turn ends (and Claude Code stops working), and one drawn afresh after it.
      const watching = await band($, surface, { ...BAND, isWorking: true })
      await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
      await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
      await $.turn.complete({ answer: '', durationMs: 41_000, turnId: 't1', ...ending } as TurnCompleteInput)
      await watching.ui.redraw(BAND)
      const fresh = await band($, surface)
      for (const { ui, look, wait } of [watching, fresh]) {
        const view = await look()
        expect(view.words[0]).toBe('Stopped after 41s')
        expect(runs(view.rows.at(-3)).some(run => run.color === 'success')).toBe(false)
        if (surface === 'terminal') {
          // No spin: he never turns edge-on.
          for (let i = 0; i < 12; i++) {
            await wait(250)
            const head = (await look()).scene[0] ?? ''
            expect(head.includes(EDGE_ON) && !head.includes(HEAD)).toBe(false)
            expect((await look()).words[0]).toBe('Stopped after 41s')
          }
        } else {
          expect(view.svg?.alt).not.toContain('spins with joy')
          expect(view.svg?.source).not.toContain('m-spin6')
        }
        await ui.unmount()
      }
    }
  }
})

test('when Claude Code says the work is over before the turn is written down, the beach waits for it', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  // A turn before, so there is an old summary that must not flash up.
  await turn($, clock)
  await clock.advance(60_000)

  for (const surface of SURFACES) {
    const { ui, look, wait } = await band($, surface, { ...BAND, isWorking: true })
    const step = async (ms: number) => {
      await wait(ms)
      await clock.advance(ms)
    }
    const seen: Array<{ now: string; alt: string }> = []
    const snap = async () => {
      const view = await look()
      seen.push({ now: view.words[0] ?? '', alt: (view.svg?.alt ?? '').split('. ')[0] ?? '' })
    }
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Edit', file_path: '/work/c.ts', old_string: 'a', new_string: 'b' })
    await step(2000)
    await snap()
    // Claude Code flips to idle; the turn's own write lands a moment later.
    await ui.redraw({ ...BAND, isWorking: false })
    for (let k = 0; k < 4; k++) {
      await step(100)
      await snap()
    }
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't2', reason: 'answer' })
    await snap()

    // Still at work until the turn is written down: never the last turn's summary in between.
    expect(seen.slice(0, -1).map(shot => shot.now)).toEqual(Array(5).fill('Thinking it over'))
    expect(seen[seen.length - 1]?.now).toBe('✻ Done in 9s · 1 tool · 1 file changed')
    if (surface === 'desktop') {
      // Clawd goes from pottering to the cheer, with no Clawd sitting idle in between (one reload, not two).
      expect([...new Set(seen.map(shot => shot.alt))]).toEqual(['Clawd potters about on the sand', 'Clawd spins with joy, then throws his arms up'])
    }
    await ui.unmount()

    // And when the write never comes, the beach settles by itself a second and a half later.
    const late = await band($, surface, { ...BAND, isWorking: true })
    await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Read', file_path: '/work/c.ts' })
    // Both clocks, a tick at a time (the session's first): the read has its second, then a pause.
    const ticks = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        await clock.advance(Math.min(250, left))
        await late.wait(Math.min(250, left))
      }
    }
    await ticks(2000)
    await late.ui.redraw({ ...BAND, isWorking: false })
    expect((await late.look()).words[0]).toBe('Thinking it over')
    await ticks(1750)
    expect((await late.look()).words[0]).not.toBe('Thinking it over')
    await late.ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't3', reason: 'answer' })
    await clock.advance(60_000)

    // Two quiet stretches in one turn: each has its own wait, and the second settles by itself too
    // (a wait that already ended, or one that work cut short, never stands in for the next).
    const twice = await band($, surface, { ...BAND, isWorking: true })
    const both = async (ms: number) => {
      await twice.wait(ms)
      await clock.advance(ms)
    }
    await $.prompt.submit({ text: 'twice', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Read', file_path: '/work/c.ts' })
    await both(2000)
    await twice.ui.redraw({ ...BAND, isWorking: false })
    await both(500)
    await twice.ui.redraw({ ...BAND, isWorking: true })
    await both(2000)
    await twice.ui.redraw({ ...BAND, isWorking: false })
    expect((await twice.look()).words[0]).toBe('Thinking it over')
    await both(1750)
    expect((await twice.look()).words[0]).not.toBe('Thinking it over')
    await twice.ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't4', reason: 'answer' })
    await clock.advance(60_000)
  }
})

test('the beach starts a turn as the prompt is written, so Claude Code saying it is working changes nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(60_000)

  for (const surface of SURFACES) {
    const { ui, look, wait } = await band($, surface)
    const resting = await look()
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    const prompted = await look()
    expect(prompted.words[0]).toBe('Thinking it over')
    await wait(250)
    await clock.advance(250)
    await ui.redraw({ ...BAND, isWorking: true })
    const working = await look()
    expect(working.words[0]).toBe('Thinking it over')
    if (surface === 'desktop') {
      // One reload at the prompt, none when the host catches up.
      expect(prompted.svg?.alt).toContain('watches the words')
      expect(prompted.svg?.source).not.toBe(resting.svg?.source)
      expect(working.svg?.source).toBe(prompted.svg?.source)
    }
    await ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `t-${surface}`, reason: 'answer' })
    await clock.advance(60_000)

    // When the host never says it is working, the beach gives the start up a second and a half after the prompt.
    const quiet = await band($, surface)
    await $.prompt.submit({ text: 'and again', wait: false, origin: { kind: 'composer' } })
    expect((await quiet.look()).words[0]).toBe('Thinking it over')
    await quiet.wait(1750)
    await clock.advance(1750)
    const after = await quiet.look()
    expect(after.words[0]).toBe('✻ Done in 9s')
    if (surface === 'desktop') expect(after.svg?.alt).toContain('strolls on the sand')
    await quiet.ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `u-${surface}`, reason: 'answer' })
    await clock.advance(60_000)
  }

  // Waking from a nap: the prompt wakes him at once, and the host's word keeps the very same frame
  // (he never stands up idle at the prompt first, which would reload the frame again into the wake).
  await clock.advance(4 * 60_000)
  const napping = await band($, 'desktop')
  expect((await napping.look()).svg?.alt).toContain('naps by a shell')
  await $.prompt.submit({ text: 'wake up', wait: false, origin: { kind: 'composer' } })
  const woken = (await napping.look()).svg
  expect(woken?.alt).toContain('wakes up by his shell')
  await clock.advance(250)
  await napping.ui.redraw({ ...BAND, isWorking: true })
  expect((await napping.look()).svg?.source).toBe(woken?.source)
  await napping.ui.unmount()
})

test("a survey takes the band's place", async ($, on) => {
  world(on)
  on('ui.render', () => ({ type: 'Text', children: ['How is Claude doing?'] }))
  const ui = await $.ui.mount({ plugin: 'session-band', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })

  expect(await ui.find({ text: 'How is Claude doing?' })).toBeDefined()
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
})

// Each line's width as the surface measures it: cells on the terminal, pixels of the page's font on the desktop.
function measure(surface: Surface, row: Node): number {
  return runs(row).reduce((sum, run) => sum + (surface === 'terminal' ? cells(run.text) : textPx(run.text, run.bold === true)), 0)
}

test('desktop: from 34 to 52 columns the beach narrows, so every line fits beside it; the frame is 64 px tall at every width', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.94)
  const widths: Array<[number, number]> = []
  const check = async (what: string) => {
    for (let columns = 34; columns <= 160; columns += columns < 52 ? 1 : 12) {
      const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns })
      const view = await look()
      const svg = find(view.tree, 'Svg')[0]
      expect([columns, svg?.props?.height]).toEqual([columns, 64])
      const width = Number(svg?.props?.width)
      if (what === 'idle') widths.push([columns, width])
      // The words' room: the band's width less the diorama and its two-cell margin.
      const room = columns * 7.6 - width - 2 * 7.6
      for (const row of view.rows) {
        expect([what, columns, textOf(row), measure('desktop', row) <= room]).toEqual([what, columns, textOf(row), true])
      }
      await ui.unmount()
    }
  }
  await check('idle')
  await $.prompt.submit({ text: 'read it', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Draw the narrow beach', description: '', activeForm: 'Drawing the narrow beach' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await check('thinking')
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  await check('splash')
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await check('cheer')
  await clock.advance(20_000)
  // 120 px at the narrowest, 6 px wider a column, 192 px from 48 columns, then wider again once the
  // words have their room, 6 px a column at most, up to 672 px: never narrower as the band widens, and
  // never so much wider that the words' room shrinks.
  expect(widths.slice(0, 3).map(([, w]) => w)).toEqual([120, 120, 120])
  expect(widths.filter(([columns]) => columns >= 48 && columns <= 64).map(([, w]) => w)).toEqual([192, 192, 192, 192, 192, 192])
  expect(widths.at(-1)).toEqual([160, 672])
  widths.slice(1).forEach(([columns, w], i) => {
    const [was, before] = widths[i] ?? [0, 0]
    expect([columns, w >= before, w - before <= 6 * (columns - was)]).toEqual([columns, true, true])
  })
})

test('nothing comes back as the band narrows: each line only loses words, on both surfaces, in every mood', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on, { branch: 'claude/first-mod' })
  await start($, 64, 1.94)
  const sweep = async (what: string, isWorking: boolean) => {
    for (const surface of SURFACES) {
      let wider: Array<{ width: number; text: string }> | null = null
      // Each line's parts that a wider band showed and a narrower one has since dropped: gone for good.
      const gone = [new Set<string>(), new Set<string>(), new Set<string>()]
      for (let columns = 160; columns >= 34; columns--) {
        const { ui, look } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking })
        const view = await look()
        const rows = surface === 'terminal' ? view.rows.slice(3) : view.rows
        const now = rows.map(row => ({ width: measure(surface, row), text: textOf(row) }))
        // On the terminal bold never touches dim, at any width (Ink closes both with one code).
        if (surface === 'terminal') {
          for (const row of rows) {
            const all = runs(row)
            all.forEach((one, j) => {
              const next = all[j + 1]
              const isBleed = next !== undefined && ((one.bold === true && next.dimColor === true) || (one.dimColor === true && next.bold === true))
              expect([what, columns, textOf(row), isBleed]).toEqual([what, columns, textOf(row), false])
            })
          }
        }
        now.forEach((line, i) => {
          if (what === 'full, and at the limit' && i === 1) expect([what, surface, columns, line.text.includes('/compact')]).toEqual([what, surface, columns, false])
          // A name is cut only while 7 characters of it show (the project, the last thing left, 5).
          const cut = /(?:^|· |: |"|“)([^·:"“]*?)…/u.exec(line.text)?.[1]
          if (cut !== undefined) expect([what, surface, columns, line.text, [...cut].length >= (i === 2 ? 5 : 7)]).toEqual([what, surface, columns, line.text, true])
          // Near the limit, it shows wherever the cost does.
          if (what === 'near the limit' && i === 1 && line.text.includes('$')) expect([what, surface, columns, line.text]).toEqual([what, surface, columns, expect.stringContaining('5h limit 86%')])
          const before = wider?.[i]
          if (before === undefined) return
          // Never wider than at a wider band, and a part once gone stays gone.
          expect([what, surface, columns, line.text, line.width <= before.width]).toEqual([what, surface, columns, line.text, true])
          for (const part of ['Opus 5.5', 'uncommitted', 'claude/', '$1.94', 'context', 'try /compact', '5h limit', '5h', ' done', 'Next up', 'Next', '13m', '20s', 'resets']) {
            if (before.text.includes(part) && !line.text.includes(part)) gone[i]?.add(part)
            expect([what, surface, columns, line.text, part, line.text.includes(part) && gone[i]?.has(part) === true]).toEqual([what, surface, columns, line.text, part, false])
          }
        })
        wider = now
        await ui.unmount()
      }
    }
  }
  await turn($, clock)
  await sweep('idle', false)
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  type Status = 'pending' | 'in_progress' | 'completed'
  const todos: Array<{ content: string; status: Status; activeForm: string }> = [
    { content: 'Read the band', status: 'completed', activeForm: 'Reading the band' },
    { content: 'Lay out the beach and its shell', status: 'in_progress', activeForm: 'Laying out the beach and its shell' },
    { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
  ]
  await $.tool.call({ tool: 'TodoWrite', todos })
  await sweep('thinking', true)
  await $.turn.complete({ answer: 'Done.', durationMs: 800_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.tool.call({ tool: 'TodoWrite', todos: todos.map(todo => (todo.status === 'in_progress' ? { ...todo, status: 'pending' as const } : todo)) })
  await clock.advance(20_000)
  await sweep('next up', false)
  await $.session.measure(measured(64, 1.94, 86))
  await sweep('near the limit', false)
  // Context high as well: the nudge and the limit both hold their places as the band narrows.
  await $.session.measure(measured(88, 1.94, 91))
  await sweep('full, and near the limit', false)
  // Full, and at the limit: the limit is the story (a /compact would not help until it resets), so
  // the nudge is off at every width, and "limit" never goes and comes back.
  await $.session.measure(measured(86, 1.94, 100))
  await sweep('full, and at the limit', false)
})

test('terminal: in Apple’s Terminal the beach draws Claude Code’s simpler Clawd, who cheers with his arms up and no spin', async ($, on) => {
  const { clock } = world(on, { env: { TERM_PROGRAM: 'Apple_Terminal' } })
  await start($)
  const { ui, look, wait } = await band($, 'terminal')
  await wait(1000)
  const resting = await look()
  expect(resting.scene[0]).toContain('▗ ▗   ▖ ▖')
  expect(resting.scene.join('')).not.toContain(HEAD)
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const spins = SPIN.map(frame => frame[0].trim())
  for (let i = 0; i < 20; i++) {
    const { scene } = await look()
    for (const frame of spins) expect(scene.join('\n')).not.toContain(frame)
    await wait(250)
    await clock.advance(250)
  }
  await ui.unmount()
})

test('terminal: a look switch in a cheer’s last second starts the beach at rest, never on its last beat alone', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  // A second in, the beach carries the cheer on...
  await clock.advance(1000)
  const early = await band($, 'terminal')
  const cheering = await early.look()
  expect(cheering.words[0]).toMatch(/^✻ Done/)
  expect(runs(cheering.rows[3]).find(run => run.text === 'Done')?.color).toBe('success')
  await early.ui.unmount()
  // ...a second before its end, it starts at rest.
  await clock.advance(3000)
  const late = await band($, 'terminal')
  const view = await late.look()
  expect(view.words[0]).toMatch(/^✻ Done in 9s/)
  expect(runs(view.rows[3]).find(run => run.text === 'Done')?.color).toBeUndefined()
  expect(view.scene.join('')).not.toMatch(SPARKLE)
  await late.ui.unmount()
})

test('desktop: still, a cheer is one frame: arms up and the sparkles held; where motion plays, it ends at rest', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await run($, 'band', 'still')
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const still = (await look()).svg?.source ?? ''
  expect(still).not.toContain('@keyframes')
  expect(still).toContain('.pose{opacity:0}.p-up{opacity:1}')
  expect(still).toContain('class="spark"')
  expect(still).not.toContain('spin0')
  await clock.advance(5000)
  expect((await look()).svg?.source).not.toContain('class="spark"')

  await run($, 'band', 'lively')
  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't2', reason: 'answer' })
  const lively = (await look()).svg?.source ?? ''
  // The still frame for a page that asks for less motion; the spin, then the loop's first pose, for the rest.
  expect(lively).toContain('.pose{opacity:0}.p-up{opacity:1}')
  expect(lively).toMatch(/@media \(prefers-reduced-motion:no-preference\)\{.*\.p-up\{opacity:0\}\.p-stand\{opacity:1\}/u)
  expect(lively).toContain('spin0')
  await ui.unmount()
})

// In Ghostty, Claude Code's spinner draws its ✽ as a ✻: the cheer's ✻ holds there while the ✶ twinkles.
test('terminal, in Ghostty: the finale\'s ✻ never swells to a ✽, as Claude Code\'s spinner\'s never does there', async ($, on) => {
  const { clock } = world(on, { env: { TERM: 'xterm-ghostty' } })
  await start($)
  const { ui, look, wait } = await band($, 'terminal')
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const finale: string[] = []
  for (let i = 0; i < SPIN.length + 10; i++) {
    const top = cellsOf((await look()).rows[0])
    const marks = top.flatMap(({ ch }) => (isSparkle(ch) ? [ch] : []))
    if (marks.length > 0) finale.push(marks.join(''))
    await wait(250)
    await clock.advance(250)
  }
  expect(finale).toEqual(['✶✻', '✶✻', '✢✻', '✢✻', '✶✻', '✶✻', '✢✻'])
  await ui.unmount()
})

// The finale, a tick at a time from his arms going up: lively, his sparkles twinkle every other half
// second in their own cells (the ✻ swelling to a heavy ✽ as the ✶ draws in to a ✢, as Claude Code's
// spinner does) while his feet dance to the same beat, one pair lifted and then the other; still, it
// is one held frame, ✶ and ✻, both feet down.
for (const motion of ['lively', 'still'] as const) {
  test(`terminal, ${motion}: his cheer's finale ${motion === 'lively' ? 'twinkles its sparkles and dances his feet to one beat' : 'is one held frame'}`, async ($, on) => {
    const { clock } = world(on)
    await start($)
    if (motion === 'still') await run($, 'band', 'still')
    const { ui, look, wait } = await band($, 'terminal')
    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
    const finale: Array<{ sparkles: string; at: string; feet: string }> = []
    for (let i = 0; i < SPIN.length + 10; i++) {
      const view = await look()
      const top = cellsOf(view.rows[0])
      const marks = top.flatMap(({ ch }, col) => (isSparkle(ch) ? [{ ch, col }] : []))
      if (marks.length > 0) {
        const x = Math.min(...clawdAt(view))
        // Which of his two pairs of feet stand on the sand: his left (two cells in), his right (six in).
        const feet = cellsOf(view.rows[2]).flatMap((cell, col) => (cell.color === 'clawd_body' && cell.ch !== ' ' ? [col - x] : []))
        const pairs = `${feet.includes(1) ? 'L' : '-'}${feet.includes(6) ? 'R' : '-'}`
        finale.push({ sparkles: marks.map(({ ch }) => ch).join(''), at: marks.map(({ col }) => col).join(' '), feet: pairs })
      }
      await wait(250)
      await clock.advance(250)
    }
    // Every tick of it in the same two cells.
    expect(new Set(finale.map(tick => tick.at)).size).toBe(1)
    if (motion === 'still') {
      expect(finale.length).toBeGreaterThanOrEqual(4)
      expect([...new Set(finale.map(tick => `${tick.sparkles} ${tick.feet}`))]).toEqual(['✶✻ LR'])
    } else {
      expect(finale.map(tick => `${tick.sparkles} ${tick.feet}`)).toEqual(['✶✻ LR', '✶✻ LR', '✢✽ L-', '✢✽ L-', '✶✻ -R', '✶✻ -R', '✢✽ LR'])
    }
    await ui.unmount()
  })
}

test('desktop: his cheer hops twice for joy as his arms go up and each sparkle glints once, only where motion plays', async ($, on) => {
  const { clock } = world(on)
  await start($)
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const lively = (await look()).svg?.source ?? ''
  const motion = lively.slice(lively.indexOf('@media (prefers-reduced-motion:no-preference)'))
  // His poses hop in a group of their own inside his walk, so the walk, his shadow and the sparkles stay put.
  expect(lively).toMatch(/<g class="walk clawd"><ellipse class="shadow" [^>]*\/><g class="hop">/u)
  const hop = /@keyframes hop\{([^@]*?)\}\}/u.exec(motion)?.[1] ?? ''
  const heights = [...hop.matchAll(/translateY\((-?[\d.]+)px\)/gu)].map(found => Number(found[1]))
  // Up a unit, down, up a touch less, down: at rest on his whole pixels before and after.
  expect(heights).toEqual([0, -1, 0, 0, -0.67, 0])
  expect(motion).toMatch(/\.hop\{animation:hop 4\.2s linear 1 both\}/u)
  // His shadow stays on the sand, narrower while he is up, in step with the hop.
  const shadow = /@keyframes shadow\{([^@]*?)\}\}/u.exec(motion)?.[1] ?? ''
  expect([...shadow.matchAll(/scaleX\(([\d.]+)\)/gu)].map(found => Number(found[1]))).toEqual([1, 0.8, 1, 1, 0.86, 1])
  // (The same beats: its keyframes' times are the hop's.)
  expect(shadow.replace(/\{[^}]*\}?/gu, '')).toBe(hop.replace(/\{[^}]*\}?/gu, ''))
  expect(motion).toMatch(/\.shadow\{animation:shadow 4\.2s linear 1 both\}/u)
  // Each of the three sparkles swells and turns once while held, then shrinks away as before.
  for (const i of [0, 1, 2]) {
    expect(motion).toMatch(new RegExp(`@keyframes star${i}\\{[^@]*scale\\(1\\.25\\) rotate\\(15deg\\)[^@]*100%\\{transform:scale\\(0\\)\\}\\}`, 'u'))
  }
  // A page that asks for less motion, and /band still, get no hop and no glint.
  expect(lively.slice(0, lively.indexOf('@media'))).not.toContain('hop{')
  await run($, 'band', 'still')
  await clock.advance(20_000)
  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't2', reason: 'answer' })
  const still = (await look()).svg?.source ?? ''
  expect(still).toContain('class="spark"')
  expect(still).not.toContain('@keyframes')
  await ui.unmount()
})

test('terminal: a jump in the context rolls the tide in a cell a tick, never all at once', async ($, on) => {
  world(on)
  await start($, 12)
  const { ui, look, wait } = await band($, 'terminal')
  await wait(1000)
  const shore = async () => {
    const row = (await look()).rows[2]
    let col = 0
    for (const run of runs(row)) {
      if (run.backgroundColor === SEA) return col
      col += cells(run.text)
    }
    return col
  }
  const from = await shore()
  await $.session.measure(measured(86, 0.31))
  const seen = [from]
  for (let i = 0; i < 16; i++) {
    await wait(250)
    seen.push(await shore())
  }
  seen.slice(1).forEach((col, i) => expect(Math.abs(col - (seen[i] ?? col))).toBeLessThanOrEqual(1))
  expect(seen.at(-1)).toBeLessThan(from - 1)
  await ui.unmount()
})

// One claw up (Claude Code's wave): open eyes, his right claw raised, the left down.
const WAVING = '▛███▛█▄'

test('a fresh session’s beach waves hello once, half a second in: never again when the band comes back', async ($, on) => {
  const { clock } = world(on)
  await start($)
  const hello = async (surface: Surface) => {
    const { ui, look, wait } = await band($, surface)
    const seen: boolean[] = []
    let svg: View['svg'] = null
    if (surface === 'terminal') {
      for (let i = 0; i < 16; i++) {
        const row = (await look()).scene[0] ?? ''
        seen.push(row.includes(WAVING) && !row.includes('▗▟'))
        await wait(250)
      }
    } else {
      svg = (await look()).svg
    }
    await ui.unmount()

    return { seen, svg }
  }

  const terminal = await hello('terminal')
  // At rest as the band appears, then up for 750 ms, down, and up again: twice, and done.
  expect(terminal.seen.slice(0, 2)).toEqual([false, false])
  expect(terminal.seen.map(up => (up ? 'U' : '.')).join('')).toBe('..UUU..UUU......')
  const desktop = await hello('desktop')
  expect(desktop.svg?.source).toContain('p-wave')
  expect(desktop.svg?.alt).toBe(`Clawd waves hello, then strolls on the sand. The tide is partway in.${starsSaid(clock.now())}`)
  // The greeting's seconds run out: the frame keeps its source (the wave has played; the loop goes on).
  await clock.advance(6_000)
  expect((await hello('desktop')).svg?.source).toBe(desktop.svg?.source)

  // A dialog hid the band for a minute; it comes back without a second hello.
  await clock.advance(60_000)
  expect((await hello('terminal')).seen.some(Boolean)).toBe(false)
  const back = (await hello('desktop')).svg
  expect(back?.source).not.toContain('p-wave')
  expect(back?.alt).toBe(`Clawd strolls on the sand. The tide is partway in.${starsSaid(clock.now())}`)
})

test('a still beach, or one switched to after the session began, has no hello', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await run($, 'band', 'still')
  for (const surface of SURFACES) {
    const { ui, look, wait } = await band($, surface)
    for (let i = 0; i < 12; i++) {
      const view = await look()
      expect(view.scene[0]?.includes(WAVING) ?? false).toBe(false)
      expect(view.svg?.source ?? '').not.toContain('p-wave')
      await wait(250)
    }
    await ui.unmount()
  }
  // Lively again, but the hearth was on first: the beach a second later starts at rest.
  await run($, 'band', 'lively')
  await run($, 'band', 'hearth')
  await clock.advance(1_000)
  await run($, 'band', 'tide')
  for (const surface of SURFACES) {
    const { ui, look, wait } = await band($, surface)
    for (let i = 0; i < 12; i++) {
      const view = await look()
      expect(view.scene[0]?.includes(WAVING) ?? false).toBe(false)
      expect(view.svg?.source ?? '').not.toContain('p-wave')
      await wait(250)
    }
    await ui.unmount()
  }
})

// The columns of the scene his cells take (his color as ink, or as a cell's ground), every row.
function clawdAt(view: View): number[] {
  return view.rows.slice(0, 3).flatMap(row => {
    let col = 0
    const out: number[] = []
    for (const run of runs(row)) {
      for (const ch of run.text) {
        if ((run.color === 'clawd_body' && ch !== ' ') || run.backgroundColor === 'clawd_body') out.push(col)
        col += cells(ch)
      }
    }
    return out
  })
}

const CURLED = '▐▂███▂█'

// Walking home for his nap, a grain never vanishes three cells ahead of him while another comes back
// behind him a second later, which would read as a grain jumping across the beach.
test('terminal: a sand grain stays put, hidden only while he stands on it or a cell from it', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 3, 0.1)
  await turn($, clock)
  for (const columns of [100, 140, 64]) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    let before: { grains: Set<number>; ground: Array<{ ch: string; bg: unknown }>; him: number[] } | null = null
    let most = 0
    const off: string[] = []
    // Five minutes: he strolls, and walks home for his nap.
    for (let i = 0; i < 1200; i++) {
      const view = await look()
      const ground = cellsOf(view.rows[2])
      const grains = new Set(ground.flatMap((cell, col) => (cell.ch === '▖' ? [col] : [])))
      const him = clawdAt(view)
      if (before !== null) {
        const near = (col: number, cells: number[]) => cells.some(c => Math.abs(c - col) <= 1)
        // A grain that goes goes under him (or the tide took its sand); one that comes back, he has just left.
        for (const col of before.grains) {
          if (!grains.has(col) && ground[col]?.bg === before.ground[col]?.bg && !near(col, him)) off.push(`${i}: the grain at ${col} went with him at ${Math.min(...him)}`)
        }
        for (const col of grains) {
          if (!before.grains.has(col) && ground[col]?.bg === before.ground[col]?.bg && !near(col, before.him)) off.push(`${i}: a grain came back at ${col} with him at ${Math.min(...before.him)}`)
        }
      }
      most = Math.max(most, grains.size)
      before = { grains, ground, him }
      await wait(250)
    }
    expect((await look()).words[0]).toContain('Napping')
    expect([columns, off.slice(0, 4), most >= 1]).toEqual([columns, [], true])
    await ui.unmount()
  }
})

test('terminal: a question for you is a wait: he sits at home, never pottering off, and the line says so in the quiet dim', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, during } = world(on)
  await start($)
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, isWorking: true })
  await $.prompt.submit({ text: 'plan it', wait: false, origin: { kind: 'composer' } })
  // A turn that has changed something: while Claude works, he potters about the sand.
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(1_250)
  await wait(1_250)
  const places = new Set<number>()
  const lines = new Set<string>()
  const eyes: string[] = []
  let isDim = true
  during.tool = async () => {
    // "Thinking it over" has its second, then the question is up.
    await clock.advance(1_250)
    await ui.redraw({ ...BAND, isWorking: true })
    await wait(1_250)
    // Half a minute of waiting on the answer: long past a pottering stroll's 10 to 18 s.
    for (let i = 0; i < 120; i++) {
      await clock.advance(250)
      await wait(250)
      const view = await look()
      places.add(Math.min(...clawdAt(view)))
      lines.add(view.words[0]?.trim() ?? '')
      eyes.push(eyesOf(view))
      isDim &&= runs(view.rows[3]).filter(run => run.text.trim() !== '').every(run => run.dimColor === true)
    }
  }
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which way should sign-in go?', header: 'Auth method', options: [{ label: 'OAuth', description: 'A browser sign-in' }, { label: 'Keys', description: 'An API key' }], multiSelect: false }],
  })
  during.tool = null
  expect([...lines]).toEqual(['Asking you: Auth method'])
  expect(isDim).toBe(true)
  expect([...places]).toEqual([5])
  // He rests as between turns, a look round a minute or so, never watching about him every ten
  // seconds as he does while Claude thinks.
  const looks = eyes.filter((eye, i) => (eye === 'L' || eye === 'R') && eyes[i - 1] !== eye)
  expect(looks.length).toBeLessThanOrEqual(1)
  await ui.unmount()
})

test('terminal: a resize never walks Clawd over the shell, and never wakes him', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  // Awake: from a narrow beach (home a cell in, no shell) to a wide one (the shell at 0 to 3,
  // home at 5) and back. He is simply at his place on the new beach, from its very first frame.
  for (const [from, to] of [[36, 64], [34, 100], [46, 80], [36, 140], [100, 46]] as const) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: from })
    // A minute on the little beach: time for a stroll or two.
    await wait(60_000)
    await ui.resize({ columns: to, rows: 3, in: 'band' })
    for (let i = 0; i < 16; i++) {
      const view = await look()
      const left = Math.min(...clawdAt(view))
      expect([from, to, i, left >= (to >= 56 ? 5 : 1)]).toEqual([from, to, i, true])
      await wait(250)
    }
    await ui.unmount()
  }
  // Asleep: curled by the shell through every resize, never up on his feet.
  await clock.advance(4 * 60_000)
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: 80 })
  for (const columns of [46, 80, 36, 64, 140, 34]) {
    await ui.resize({ columns, rows: 3, in: 'band' })
    for (let i = 0; i < 16; i++) {
      const view = await look()
      expect([columns, i, view.scene[1]?.includes(CURLED), Math.min(...clawdAt(view)) === (columns >= 56 ? 5 : 1)]).toEqual([columns, i, true, true])
      await wait(250)
    }
  }
  await ui.unmount()
})

test('terminal: at high tide with nothing to do he settles at the water\'s edge, where a band that appears then (a look switch, a dialog closing) finds him too', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 42, 0.31)
  const running = await band($, 'terminal', BAND)
  await running.wait(1_000)
  // The tide comes in while he rests at home: he goes down to watch it.
  await $.session.measure(measured(86, 1.94))
  for (let i = 0; i < 60; i++) {
    await clock.advance(250)
    await running.wait(250)
  }
  const settled = Math.min(...clawdAt(await running.look()))
  const fresh = await band($, 'terminal', BAND)
  const appeared = Math.min(...clawdAt(await fresh.look()))
  expect([settled, appeared]).toEqual([appeared, appeared])
  expect(settled).toBeGreaterThan(5)
  await fresh.ui.unmount()
  await running.ui.unmount()
})

// Four quiet minutes on the band's own clock, then a pet: still, he is curled up by the shell for
// his nap, wherever he stood before, and the pet leaves him asleep (no jumping up and flopping down).
async function stillNap(look: () => Promise<View>, wait: (ms: number) => Promise<void>, pet: () => Promise<unknown>, label: string) {
  const before = await look()
  // At high tide he stands at the water's edge, away from the shell.
  expect([label, Math.min(...clawdAt(before)) > 5]).toEqual([label, true])
  await wait(4 * 60_000)
  const asleep = await look()
  expect([label, asleep.words[0]?.startsWith('Napping'), asleep.scene[1]?.includes(CURLED), Math.min(...clawdAt(asleep))]).toEqual([label, true, true, 5])
  await pet()
  let hearts = 0
  for (let i = 0; i < 16; i++) {
    const view = await look()
    // Curled the whole time: his head a row down, nothing of him in the top row.
    expect([label, i, view.scene[1]?.includes(CURLED), view.scene[0]?.includes('█'), view.words[0]?.startsWith('Napping')]).toEqual([label, i, true, false, true])
    const hasHeart = view.scene[0]?.includes(HEART) === true
    hearts += hasHeart ? 1 : 0
    // The heart gone, his z is back on the very same frame: never a sleeper with neither.
    if (hearts > 0 && !hasHeart) expect([label, i, /z/.test(`${view.scene[0]}${view.scene[1]}`)]).toEqual([label, i, true])
    await wait(250)
  }
  expect([label, hearts > 0]).toEqual([label, true])
}

test('terminal: /band still, a nap finds Clawd curled up by the shell, and a pet leaves him asleep', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.9)
  await turn($, clock)
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: 80 })
  await wait(1000)
  await run($, 'band', 'still')
  await stillNap(look, wait, () => ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' }), '/band still')
  await ui.unmount()
})

test('terminal: with reduced motion, a nap at high tide finds Clawd curled up by the shell, and a pet leaves him asleep', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  on('settings.read', () => ({ value: { prefersReducedMotion: true } }))
  await start($, 86, 1.9)
  await turn($, clock)
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: 80 })
  await stillNap(look, wait, () => ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' }), 'reduced motion')
  await ui.unmount()
})

// Where a desktop source's CSS has Clawd `t` seconds after its frame opened, in pixels across the
// diorama: the group's place, then the lead's translateX while it plays (it is listed last, so it
// wins), then the loop's, from its delay on.
function deskX(source: string, t: number): number {
  const start = Number(/<g transform="translate\(([\d.]+) [\d.]+\)"><g class="walk clawd">/.exec(source)?.[1] ?? NaN)
  const walk = /\.walk\{animation:walk ([\d.]+)s step-end ([\d.]+)s infinite both(?:,lead ([\d.]+)s step-end 0s 1 none)?\}/.exec(source)
  if (walk === null) return start
  const [period, delay, lead] = [Number(walk[1]), Number(walk[2]), walk[3] === undefined ? 0 : Number(walk[3])]
  const stops = (name: string) =>
    [...(new RegExp(`@keyframes ${name}\\{(.*?)\\}\\}`).exec(source)?.[1] ?? '').matchAll(/([\d.]+)%\{transform:translateX\((-?\d+)px\)/g)].map(
      match => [Number(match[1]) / 100, Number(match[2])] as const,
    )
  const pick = (list: ReadonlyArray<readonly [number, number]>, fraction: number) => {
    let x = list[0]?.[1] ?? 0
    // (A stop's percent is rounded to 1e-5 of the period.)
    for (const [at, value] of list) if (at <= fraction + 1e-5) x = value
    return x
  }
  if (t < lead) return start + pick(stops('lead'), t / lead)
  if (t < delay) return start + pick(stops('walk'), 0)

  return start + pick(stops('walk'), ((t - delay) % period) / period)
}

// Where a desktop source's loop starts him.
function loopStart(source: string): number {
  return Number(/<g transform="translate\(([\d.]+) [\d.]+\)"><g class="walk clawd">/.exec(source)?.[1] ?? NaN)
}

test('desktop: a failure splashes him; a second in the wave’s first rush rides along, a later one splashes him again, and a measure never does', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  const source = async () => (await look()).svg?.source ?? ''
  const fail = () => $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await fail()
  const first = await source()
  expect(first).toContain('class="surge"')
  // A second failure as the wave first rushes in rides along with it (as on the terminal).
  await clock.advance(500)
  await fail()
  expect(await source()).toBe(first)
  // The context moves a whole stride while the wave plays: the frame plays on.
  await clock.advance(1000)
  await $.session.measure(measured(70, 0.5))
  expect(await source()).toBe(first)
  // A third failure, once the rush is over, splashes him again: a new frame, from its first beat.
  await clock.advance(800)
  await fail()
  const again = await source()
  expect(again).not.toBe(first)
  expect(again).toContain('class="surge"')
  expect(again).toMatch(/@keyframes m-splash\{0%\{opacity:1\}/)
  // It is that one frame while it plays, and the same holds with the tide unmoved.
  await clock.advance(1000)
  expect(await source()).toBe(again)
  await clock.advance(1000)
  await fail()
  const fourth = await source()
  // (The same Clawd, played from his first beat; the sea rushes on from where the last one had it.)
  expect(fourth).not.toBe(again)
  expect(clawdOf(fourth)).toBe(clawdOf(again))
  expect(fourth).toMatch(/@keyframes surge\{0%\{transform:translateX\(-[\d.]+px\)/)
  await ui.unmount()
})

// A failure that rides along with the wave (in its first rush) is the wave's: the terminal's art
// plays on as for the lone failure, tick for tick, never starting the wave over (a crest jumping
// back, the splash's pose a tick longer). Its words are the same too: what failed last.
test('terminal: a failure riding along with the wave never restarts its art: the frames are the lone failure\'s, tick for tick', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const fail = () => $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  const film = async (riding: number | null) => {
    await clock.advance(30_000)
    const busy = { ...BAND, bodyColumns: 80, isWorking: true }
    const term = await band($, 'terminal', busy)
    await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
    await term.ui.redraw(busy)
    for (let t = 0; t < 500; t += 50) {
      await clock.advance(50)
      await term.ui.advance(50)
    }
    await fail()
    const frames: string[] = []
    for (let t = 0; t < 4_500; t += 50) {
      if (t === riding) await fail()
      frames.push(`${t} ${(await term.look()).scene.join('|')}`)
      await clock.advance(50)
      await term.ui.advance(50)
    }
    await term.ui.unmount()
    await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: false, turnId: `f${riding ?? 0}`, reason: 'error' })
    return frames
  }
  const lone = await film(null)
  for (const riding of [300, 700, 1_100]) expect([riding, await film(riding)]).toEqual([riding, lone])
})

// A todo ticked off while a step holds line 1, with the next step already waiting to take it: the
// tally comes up with that step, so line 1 changes once, never on its own just before the step (as
// little as 10 ms: two changes of the line in a tenth of a second).
test('terminal: a todo ticked off while the next step waits comes up with that step: line 1 changes once', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 40)
  const todos = (done: number) => ({ tool: 'TodoWrite', todos: [0, 1, 2].map(i => ({ content: `Step ${i}`, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending', activeForm: `Doing step ${i}` })) })
  for (const [into, gap] of [[100, 50], [600, 50], [950, 50], [990, 10], [600, 300]] as const) {
    const term = await band($, 'terminal', { ...BAND, bodyColumns: 100, isWorking: true })
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    await term.ui.redraw({ ...BAND, bodyColumns: 100, isWorking: true })
    let ms = 0
    const seen: Array<{ at: number; line: string }> = []
    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await term.ui.advance(10)
        await clock.advance(10)
        ms += 10
        const line = (await term.look()).words[0] ?? ''
        if (line !== seen.at(-1)?.line) seen.push({ at: ms, line })
      }
    }
    await $.tool.call(todos(0) as never)
    await step(100)
    // A search holds line 1 its second; a todo is ticked off `into` it, and a read starts `gap` after.
    await $.tool.call({ tool: 'Glob', pattern: '**/*.5.ts' })
    await step(into / 10)
    await $.tool.call(todos(1) as never)
    await step(gap / 10)
    await $.tool.call({ tool: 'Read', file_path: '/w/f6.ts' })
    await step(200)
    const label = `${into} ${gap}`
    const lines = seen.map(run => run.line)
    const searched = lines.indexOf('Searching for **/*.5.ts · 0 of 3 done')
    expect([label, lines.slice(searched, searched + 2)]).toEqual([label, ['Searching for **/*.5.ts · 0 of 3 done', 'Reading f6.ts · 1 of 3 done']])
    for (const [i, run] of seen.slice(1).entries()) expect([label, run.line, run.at - (seen[i]?.at ?? 0) >= 250]).toEqual([label, run.line, true])
    await term.ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `t${label}`, reason: 'answer' })
    await clock.advance(60_000)
  }
})

// A step that starts just as a lone splash ends takes the line straight from the splash, and keeps it
// its whole second on the terminal as on the desktop; the quiet line ('"Lint the code" failed'), when
// it goes up, stays a tick at least. Put up between ticks, the quiet line would hold a read 100 to
// 300 ms after the wave's end behind it until the tick after, up to 420 ms behind the desktop, with
// only 810 ms of its second.
test('terminal: a read just after a lone splash ends keeps its whole second, a tick at most behind the desktop', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 40)
  for (const gap of [60, 160, 240, 300, 400, 560]) {
    const term = await band($, 'terminal', { ...BAND, bodyColumns: 64, isWorking: true })
    const desk = await band($, 'desktop', { ...BAND, bodyColumns: 64, isWorking: true })
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    await term.ui.redraw({ ...BAND, bodyColumns: 64, isWorking: true })
    await desk.ui.redraw({ ...BAND, bodyColumns: 64, isWorking: true })
    let ms = 0
    const seen: Array<{ at: number; side: 'term' | 'desk'; line: string }> = []
    const last = { term: '', desk: '' }
    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await term.ui.advance(10)
        await clock.advance(10)
        ms += 10
        for (const [side, view] of [['term', term], ['desk', desk]] as const) {
          const line = (await view.look()).words[0] ?? ''
          if (line !== last[side]) seen.push({ at: ms, side, line })
          last[side] = line
        }
      }
    }
    await step(30)
    await $.tool.call({ tool: 'Bash', command: 'npm run lint -- fail', description: 'Lint the code' }).catch(() => undefined)
    // The wave ends 3,050 ms after the failure; the read comes from 90 ms before that to 410 ms after.
    await step(290 + gap / 10)
    await $.tool.call({ tool: 'Read', file_path: '/w/after.ts' })
    await step(220)
    const runOf = (side: 'term' | 'desk', line: RegExp) => {
      const i = seen.findIndex(run => run.side === side && line.test(run.line))
      const next = seen.slice(i + 1).find(run => run.side === side)

      return i < 0 ? null : { at: seen[i]?.at ?? 0, for: (next?.at ?? Infinity) - (seen[i]?.at ?? 0) }
    }
    const [termRead, deskRead, quiet] = [runOf('term', /^Reading after\.ts/u), runOf('desk', /^Reading after\.ts/u), runOf('term', /^"Lint the code" failed/u)]
    expect([gap, termRead !== null, deskRead !== null]).toEqual([gap, true, true])
    expect([gap, (termRead?.for ?? 0) >= 990, (termRead?.at ?? 0) - (deskRead?.at ?? 0) <= 250]).toEqual([gap, true, true])
    if (quiet !== null) expect([gap, quiet.for >= 240]).toEqual([gap, true])
    await term.ui.unmount()
    await desk.ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `r${gap}`, reason: 'answer' })
    await clock.advance(60_000)
  }
})

// A failure in a new turn is that turn's own, however soon after the last turn's: it splashes him
// again from its first beat, and its words last its whole wave, on both surfaces: it never rides along
// with the last turn's wave inside its first rush, with no new wave and "Splash!" cut short.
test('desktop and terminal: a failure in a new turn splashes him again, however soon after the last turn\'s failure', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  const desk = await band($, 'desktop')
  const term = await band($, 'terminal', { ...BAND, bodyColumns: 100 })
  const source = async () => (await desk.look()).svg?.source ?? ''
  const fail = () => $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  const busy = async (isWorking: boolean) => {
    await desk.ui.redraw({ ...BAND, isWorking })
    await term.ui.redraw({ ...BAND, bodyColumns: 100, isWorking })
  }
  // Time on both clocks, the terminal's a tick at a time.
  const go = async (ms: number) => {
    for (let left = ms; left > 0; left -= 250) {
      await clock.advance(Math.min(250, left))
      await term.wait(Math.min(250, left))
    }
  }
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  await busy(true)
  await fail()
  const first = await source()
  expect(first).toContain('class="surge"')
  // The turn lands 300 ms later, and the next fails 900 ms after the first failure, in its rush.
  await go(300)
  await $.turn.complete({ answer: 'They fail.', durationMs: 4_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await busy(false)
  await go(300)
  await $.prompt.submit({ text: 'fix it', wait: false, origin: { kind: 'composer' } })
  await busy(true)
  await go(300)
  await fail()
  const again = await source()
  expect(again).not.toBe(first)
  expect(again).toContain('class="surge"')
  expect(again).toMatch(/@keyframes m-splash\{0%\{opacity:1\}/)
  // Its words are its wave's: "Splash!" still 2.5 s on, on both surfaces, gone by its end.
  await go(2_500)
  expect([(await desk.look()).words[0], (await term.look()).words[0]]).toEqual(['Splash! “Run the tests” failed', 'Splash! "Run the tests" failed'])
  await go(1_000)
  expect([(await desk.look()).words[0], (await term.look()).words[0]].map(line => line?.startsWith('Splash!'))).toEqual([false, false])
  await desk.ui.unmount()
  await term.ui.unmount()
})

for (const motion of ['lively', 'still'] as const) {
  test(`desktop and terminal, ${motion}: a turn that lands mid-splash has its cheer at once on both surfaces, "Done" and his arms or his spin, never the splash played on`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await turn($, clock)
    if (motion === 'still') await run($, 'band', 'still')
    const desk = await band($, 'desktop')
    const term = await band($, 'terminal', { ...BAND, bodyColumns: 80 })
    const busy = async (isWorking: boolean) => {
      await desk.ui.redraw({ ...BAND, isWorking })
      await term.ui.redraw({ ...BAND, bodyColumns: 80, isWorking })
    }
    // Time on both clocks, the terminal's a tick at a time.
    const go = async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        await clock.advance(Math.min(250, left))
        await term.wait(Math.min(250, left))
      }
    }
    await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
    await busy(true)
    await go(500)
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    await go(750)
    expect((await term.look()).words[0]).toBe('Splash! "Run the tests" failed')
    await $.turn.complete({ answer: 'They fail.', durationMs: 30_000, isAborted: false, turnId: 't-land', reason: 'answer' })
    await busy(false)
    // Within a tick, both say it is done, and he cheers: his eyes open (never the splash's shut eyes).
    await go(250)
    for (let i = 0; i < 8; i++) {
      const [said, seen] = [(await desk.look()).words[0], await term.look()]
      expect([motion, i, said, seen.words[0]]).toEqual([motion, i, '✻ Done in 30s · 1 tool', '✻ Done in 30s · 1 tool'])
      expect([motion, i, seen.scene[0], (seen.scene[0] ?? '').includes('▂')]).toEqual([motion, i, seen.scene[0], false])
      await go(250)
    }
    await desk.ui.unmount()
    await term.ui.unmount()
  })
}

test('desktop: still, a splash is one held frame, the wave at his feet and his eyes shut, and the alt says so', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await run($, 'band', 'still')
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  const view = await look()
  const source = view.svg?.source ?? ''
  expect(view.words[0]).toBe('Splash! “Run the tests” failed')
  expect(view.svg?.alt).toBe(`A wave splashes over Clawd's feet. The tide is partway in.${starsSaid(clock.now())}`)
  expect(source).toContain('.p-splash{opacity:1}')
  expect(source).toMatch(/\.surge\{transform:translateX\(-[\d.]+px\)\}/)
  expect(source).toMatch(/\.drop0\{transform:translate\(/)
  // Nothing moves.
  expect(source).not.toContain('animation')
  // The splash over, he is back at work, still: standing, as the alt says (never "potters about").
  await clock.advance(3_500)
  expect((await look()).svg?.source).not.toContain('class="surge"')
  expect((await look()).svg?.alt).toBe(`Clawd stands on the sand while Claude works. The tide is partway in.${starsSaid(clock.now())}`)
  // The turn over, he stands at rest, as the still frame shows him (never "sits", nor "strolls").
  await $.turn.complete({ answer: 'They fail.', durationMs: 5_000, isAborted: false, turnId: 't-held', reason: 'answer' })
  await ui.redraw(BAND)
  await clock.advance(5_000)
  expect((await look()).svg?.alt).toBe(`Clawd stands on the sand. The tide is partway in.${starsSaid(clock.now())}`)
  await ui.unmount()
})

test('desktop: a new frame starts Clawd where the last one had him, so a turn ending, a splash or a prompt never jumps him', async ($, on) => {
  const { clock } = world(on)
  await start($)
  const { ui, look } = await band($, 'desktop')
  const source = async () => (await look()).svg?.source ?? ''

  // Ten seconds into the idle loop he is out on the sand; a prompt's frame starts him there.
  await clock.advance(10_000)
  const idle = await source()
  const out = deskX(idle, 10)
  expect(out).toBeGreaterThan(loopStart(idle))
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  const read = await source()
  expect(read).not.toBe(idle)
  expect(deskX(read, 0)).toBe(out)
  // He walks back a pixel at a time to where his reading loop starts, never jumping.
  for (let t = 0; t < 12; t += 0.05) expect(Math.abs(deskX(read, t + 0.05) - deskX(read, t))).toBeLessThanOrEqual(1)

  // At work, seven seconds into his pottering, a tool fails: the splash hits him where he stands.
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  const work = await source()
  expect((await look()).svg?.alt).toContain('potters')
  await clock.advance(7000)
  const at = deskX(work, 7)
  // (Out on the sand, past where the loop starts: a frame that started him over would jump him.)
  expect(at).toBeGreaterThan(loopStart(work))
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  const splash = await source()
  expect((await look()).svg?.alt).toContain('splashes')
  expect(deskX(splash, 0)).toBe(at)
  expect(deskX(splash, 2)).toBe(at)
  // The sea surges up to his feet there, not to his starting spot.
  const run = Number(/@keyframes surge\{[^}]*\}24%\{transform:translateX\(-([\d.]+)px\)/.exec(splash)?.[1])
  expect(run).toBeGreaterThan(0)

  // The splash over, he potters again in the splash's own frame (its end loads nothing); seven
  // seconds on, the turn lands and he cheers where that frame has him.
  await clock.advance(3200)
  expect(await source()).toBe(splash)
  await clock.advance(7000)
  const landed = deskX(splash, 10.2)
  await $.turn.complete({ answer: 'Done.', durationMs: 18_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw(BAND)
  const cheer = await source()
  expect((await look()).svg?.alt).toContain('spins with joy')
  expect(deskX(cheer, 0)).toBe(landed)
  expect(deskX(cheer, 4)).toBe(landed)
  // The cheer's sparkles stand with him.
  if (landed !== deskX(cheer, 30)) expect(cheer).toMatch(/\.at\{transform:translateX\(-?\d+px\)\}/)
  // As it ends, the idle frame starts him where the cheer's frame has him.
  await clock.advance(4600)
  const rest = await source()
  expect(rest).not.toBe(cheer)
  expect(deskX(rest, 0)).toBe(deskX(cheer, 4.6))
  await ui.unmount()
})


// ── Still splashes, the cheer by the wave, a hello carried on, limits, still frames ───

for (const how of ['/band still', 'reduced motion'] as const) {
  for (const columns of [100, 140]) {
    test(`terminal: ${how}, a splash at ${columns} columns holds the water right up to his feet, the spray just off its lip`, async ($, on) => {
      const { clock } = world(on)
      if (how === 'reduced motion') on('settings.read', () => ({ value: { prefersReducedMotion: true } }))
      await start($, 12)
      if (how === '/band still') await run($, 'band', 'still')
      const props = { ...BAND, bodyColumns: columns }
      const { ui, look, wait } = await band($, 'terminal', props)
      await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
      await ui.redraw({ ...props, isWorking: true })
      await wait(1000)
      await clock.advance(1000)
      const ground = (view: View) => cellsOf(view.rows[2])
      const feetAt = (view: View) => ground(view).findIndex(cell => cell.ch === '▝' && cell.color === 'clawd_body') - 1
      const calm = await look()
      const x = feetAt(calm)
      // At 12% the sea is far out: dry sand under him and beside him.
      for (let col = x + 2; col <= x + 8; col++) expect([how, columns, 'calm', col, ground(calm)[col]?.bg]).toEqual([how, columns, 'calm', col, SAND_COLORS[0]])
      await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
      const held = await look()
      expect(held.words[0]).toBe('Splash! "Run the tests" failed')
      for (let i = 0; i < 11; i++) {
        const view = await look()
        // One held frame for the whole splash: nothing moves.
        expect([how, columns, i, view.scene]).toEqual([how, columns, i, held.scene])
        await wait(250)
      }
      expect(feetAt(held)).toBe(x)
      // The water runs right up to his feet: its foamy edge comes in between his two pairs, and from
      // there on his right pair stands in the sea. The sand under his left pair stays dry, so his clay
      // feet still show against it.
      const under = ground(held)
      const edge = under.findIndex(cell => cell.ch === '▟' && cell.color === FOAM)
      expect([how, columns, edge > x + 2 && edge < x + 6]).toEqual([how, columns, true])
      for (const col of [x + 6, x + 7]) expect([how, columns, col, under[col]?.bg]).toEqual([how, columns, col, SEA])
      for (let col = edge + 1; col <= x + 8; col++) expect([how, columns, col, under[col]?.bg]).toEqual([how, columns, col, SEA])
      for (let col = x + 1; col < edge; col++) expect([how, columns, col, under[col]?.bg]).toEqual([how, columns, col, SAND_COLORS[0]])
      // The spray hangs just off the wave's lip, never out over dry sand.
      const lip = cellsOf(held.rows[1]).findIndex(cell => cell.ch === '▀' && cell.color === FOAM)
      const spray = cellsOf(held.rows[0]).flatMap((cell, col) => (cell.color === SEA ? [col] : []))
      expect(lip).toBe(x + 10)
      expect(spray.length).toBeGreaterThan(0)
      for (const col of spray) expect([how, columns, col, Math.abs(col - lip) <= 4]).toEqual([how, columns, col, true])
      // The splash over, the beach is as it was: the sea back out, the sand dry, no spray.
      await wait(1000)
      await clock.advance(4000)
      const after = await look()
      for (let col = x + 2; col <= x + 8; col++) expect([how, columns, 'after', col, ground(after)[col]?.bg]).toEqual([how, columns, 'after', col, SAND_COLORS[0]])
      expect(cellsOf(after.rows[0]).some(cell => cell.color === SEA)).toBe(false)
      await ui.unmount()
    })
  }
}

for (const [percent, env] of [[12], [42], [86], [70, { TERM_PROGRAM: 'Apple_Terminal' }]] as const) {
  const apple = env === undefined ? '' : ', in Apple’s Terminal'
  test(`terminal: at ${percent}%${apple}, the cheer's sparkles stand a cell of sky apart, a breath of air off his claws, and never touch the wave or sit on the shell`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on, { env })
    await start($, percent)
    for (const columns of [34, 40, 44, 46, 52, 55, 56, 64, 100, 140]) {
      const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
      await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
      await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `t${columns}`, reason: 'answer' })
      // Past the spin, his arms are up with his sparkles held, in the same places to the cheer's end.
      await wait(SPIN.length * 250 + 250)
      const seen = new Set<string>()
      for (let tick = 0; tick < 6; tick++) {
        const [top = '', middle = ''] = (await look()).scene
        const row = [...top]
        const below = [...middle]
        const [one, two] = [row.findIndex(isBurst), row.findIndex(isStar)]
        const where = [columns, row.join(''), below.join('')]
        expect([...where, one >= 0]).toEqual([...where, true])
        seen.add(`${one} ${two}`)
        for (const col of [one, two].filter(col => col >= 0)) {
          // A sparkle with sky on both sides of it stands off from him: nothing of the wave below it
          // or a corner away, and no shell under it.
          const isSky = (ch: string | undefined) => ch === undefined || ch === ' '
          if (isSky(row[col - 1]) && isSky(row[col + 1])) {
            const near = [below[col - 1], below[col], below[col + 1]]
            expect([...where, col, near.some(ch => ch !== undefined && '▀▛█▄▖'.includes(ch))]).toEqual([...where, col, false])
            expect([...where, col, near.some(ch => ch !== undefined && '▟▌▐▙'.includes(ch))]).toEqual([...where, col, false])
          }
        }
        // The ✻ keeps a cell of sky from the wave's lip below it to the right, even with the tide in:
        // the crest stands a cell further off while his arms are up.
        expect([...where, '▀▛█▄▖'.includes(below[one + 1] ?? ' ')]).toEqual([...where, false])
        if (two >= 0) expect([...where, Math.abs(one - two) >= 2]).toEqual([...where, true])
        // One each side of him wherever the tide leaves room, at every width (a narrow beach's Clawd
        // spins a cell in from the edge first); a cell of sky between the ✻ and his claw with the tide
        // out, and with it in too wherever the beach leaves the crest room to stand back two cells
        // (never '▄✻', flush, which reads as part of his arm).
        if ((env === undefined && percent < 50) || columns >= 64) expect([...where, two >= 0 && two < one]).toEqual([...where, true])
        if ((columns >= 64 && percent < 50) || (env === undefined && percent > 80 && columns >= 44)) expect([...where, row[one - 1]]).toEqual([...where, ' '])
        await wait(250)
      }
      expect([columns, seen.size]).toEqual([columns, 1])
      await ui.unmount()
      await clock.advance(20_000)
    }
  })
}

test('terminal: at high tide the crest stands back two cells for the cheer\'s ✻, a cell on the spin\'s last frame and one as his arms go up, and rolls back in a cell a tick when they come down, never jumping', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 86)
  for (const columns of [44, 64, 100]) {
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: `t${columns}`, reason: 'answer' })
    // Where the wave's lip stands (its foam lip and shoulder, `▀▛`), from the spin's first frame; and
    // the ✻ on the first frame his arms are up.
    const crests: number[] = []
    let [star, up] = [-1, -1]
    for (let tick = 0; tick < SPIN.length + 13; tick++) {
      const [top = '', middle = ''] = (await look()).scene
      if (up < 0 && [...top].some(isBurst)) [star, up] = [[...top].findIndex(isBurst), tick]
      crests.push([...middle].join('').indexOf('▀▛'))
      await wait(250)
    }
    const raised = crests.slice(up)
    // A cell of sky from his claw to the ✻ and one from the ✻ to the lip while his arms are up; two
    // cells nearer once it has rolled back, a cell of sky from him as ever.
    expect([columns, up > 0, (raised[0] ?? 0) - star, (raised[0] ?? 0) - (raised[11] ?? 0)]).toEqual([columns, true, 2, 2])
    // The wave draws back over two beats, as it comes back in: never two cells in one frame.
    crests.forEach((at, i) => {
      const moved = at - (crests[i - 1] ?? at)
      if (i > 0) expect([columns, i, moved, Math.abs(moved) <= 1]).toEqual([columns, i, moved, true])
    })
    await ui.unmount()
    await clock.advance(20_000)
  }
})

// Gives the band's hello frames: whether his claw is up (the head row with a raised claw: ▄).
async function waves(look: () => Promise<View>, wait: (ms: number) => Promise<void>, clock: ReturnType<typeof mock.clock>, ticks: number): Promise<boolean[]> {
  const up: boolean[] = []
  for (let i = 0; i < ticks; i++) {
    up.push((await look()).scene[0]?.includes('▄') === true)
    await wait(250)
    await clock.advance(250)
  }

  return up
}

function upRuns(frames: boolean[]): number {
  return frames.filter((isUp, i) => isUp && frames[i - 1] !== true).length
}

test('terminal: a band that comes back mid-hello carries the wave on, never waving from the start again', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  await $.session.measure(measured(42, 0.31))
  const first = await band($, 'terminal')
  const before = await waves(first.look, first.wait, clock, 6)
  await first.ui.unmount()
  // A dialog took the prompt's place for a moment: the band is back 1.5 s into the session.
  const again = await band($, 'terminal')
  const after = await waves(again.look, again.wait, clock, 14)
  await again.ui.unmount()
  // Two waves in all, the second after the first, as one hello.
  expect([before, after].map(upRuns)).toEqual([1, 1])
  expect(after[0]).toBe(false)
  // Back once the second wave is under way: only a claw's last moment would be left, so no hello.
  const late = await band($, 'terminal')
  expect(upRuns(await waves(late.look, late.wait, clock, 12))).toBe(0)
  await late.ui.unmount()
})

test('words: a 5h limit near its end outlasts "context" on a narrow band, then its own label', { timeoutMs: 60_000 }, async ($, on) => {
  world(on)
  await start($, 42, 3.4)
  const at = async (surface: Surface, columns: number) => {
    const { ui, look } = await band($, surface, { ...BAND, bodyColumns: columns })
    const line = (await look()).words[1] ?? ''
    await ui.unmount()

    return line
  }
  await $.session.measure(measured(42, 3.4, 86))
  expect(await at('terminal', 140)).toMatch(/^42% context · 5h limit 86% · resets \S+ · \$3\.40$/u)
  for (const surface of SURFACES) {
    // From the narrowest band up, the limit shows: never the bare percent while the limit is near.
    for (const columns of [34, 40, 46, 52, 58]) {
      const line = await at(surface, columns)
      expect([surface, columns, line]).toEqual([surface, columns, expect.stringMatching(/^42%( context)? · 5h( limit)? 86%/u)])
    }
  }
  expect(await at('terminal', 34)).toBe('42% · 5h 86%')
  // Bold never touches dim there (Ink closes both with one code, so the dim words would come out bold).
  for (const columns of [34, 40, 46, 52, 58]) {
    const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    const all = runs((await look()).rows[4])
    all.forEach((one, j) => {
      const next = all[j + 1]
      if (next !== undefined) expect([columns, one.text, next.text, one.bold === true && next.dimColor === true]).toEqual([columns, one.text, next.text, false])
    })
    await ui.unmount()
  }
  // Context high too: the nudge and the limit both stay, "context" goes first.
  await $.session.measure(measured(86, 3.4, 91))
  for (const surface of SURFACES) {
    for (const columns of [60, 64, 70]) {
      const line = await at(surface, columns)
      expect([surface, columns, line]).toEqual([surface, columns, expect.stringMatching(/^86%( context)? · try \/compact · 5h( limit)? 91%/u)])
    }
  }
  // At the limit nothing more runs until it resets: the limit keeps its place on every band, down
  // to the narrowest, where it stands alone ("5h 100%"; the water still shows the context).
  for (const [percent, five] of [[42, 100], [86, 100], [42, 104]] as const) {
    await $.session.measure(measured(percent, 3.4, five))
    for (const surface of SURFACES) {
      for (const columns of [34, 35, 36, 40, 46, 52, 58, 64]) {
        const line = await at(surface, columns)
        expect([percent, surface, columns, line]).toEqual([percent, surface, columns, expect.stringMatching(new RegExp(`(^|· )5h( limit)? ${five}%`, 'u'))])
      }
    }
    const narrowest = await at('terminal', 34)
    expect([percent, five, narrowest]).toEqual([percent, five, expect.stringMatching(new RegExp(`^(${percent}% · )?5h ${five}%$`, 'u'))])
  }
})

// /band still holds him where he stood on his walk, inside the sand this tide leaves him, and /band
// lively walks him on from there: neither switch moves him, never back to his loop's start (a jump
// of up to 21 px along the sand, as the frame changes).
test('desktop: /band still holds Clawd where he stood on his walk, and /band lively opens there: neither jumps him', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  const keptScene = sceneWrites(on)
  // The tide far out: sand for a long walk.
  await start($, 5)
  await clock.advance(10_000)
  const { ui, look } = await band($, 'desktop')
  let isAway = false
  // (His walk takes him out along the sand from 7 s into a frame, and back from 20 s.)
  for (const idle of [3_000, 12_000, 9_000, 16_000]) {
    await clock.advance(idle)
    // Where the lively frame on screen has him now.
    const lively = await keptScene(clock)
    expect(lively).not.toBe(null)
    if (lively === null) return
    const stood = positionAt(lively.scene, clock.now() - lively.at)
    await run($, 'band', 'still')
    const source = (await look()).svg?.source ?? ''
    const still = await keptScene(clock)
    expect([idle, still?.scene.still]).toEqual([idle, true])
    if (still === null) return
    // Where he stood, to the pixel; his loop's start lies under it, the frame's own CSS moving him there.
    const held = positionAt(still.scene, 0)
    expect([idle, Math.abs(held - stood) <= 0.5]).toEqual([idle, true])
    const home = positionAt({ ...still.scene, from: null }, 0)
    if (Math.abs(held - home) >= 6) isAway = true
    // The still frame's one pose stands there by its own CSS (its loop's start, moved along the sand).
    if (held !== home) expect([idle, source]).toEqual([idle, expect.stringContaining(`.walk{transform:translateX(${held - home}px)}`)])
    await clock.advance(1_000)
    await run($, 'band', 'lively')
    await look()
    const again = await keptScene(clock)
    expect([idle, again?.scene.still === true, positionAt(again?.scene ?? still.scene, 0)]).toEqual([idle, false, held])
  }
  // (Some of those moments had him well out along his walk, far from his loop's start.)
  expect(isAway).toBe(true)
  await ui.unmount()
})

// Still, a nap curls him by the shell, a step in from where he stands. The first frame up from it
// stands him at his usual spot, not where the curl had him (a still frame otherwise holds him where
// the last one had him), or his still home would quietly move a step for the rest of the session.
test('desktop, still: up from a nap, Clawd stands at his usual spot again, and stays there through the turn and its cheer', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  const keptScene = sceneWrites(on)
  await start($, 42)
  await run($, 'band', 'still')
  const { ui, look } = await band($, 'desktop')
  await turn($, clock)
  await look()
  const before = await keptScene(clock)
  expect(before?.scene.still).toBe(true)
  if (before === null) return
  const spot = positionAt(before.scene, 0)
  await clock.advance(4 * 60_000)
  await look()
  expect((await keptScene(clock))?.scene.mood).toBe('nap')
  await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await look()
  const spots: Array<[string, number | null]> = []
  const note = async (label: string) => {
    const kept = await keptScene(clock)
    spots.push([label, kept === null || kept.scene.mood === 'nap' ? null : positionAt(kept.scene, 0)])
  }
  await note('up')
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2_000)
  await look()
  await note('working')
  await $.turn.complete({ answer: 'Done.', durationMs: 4_000, isAborted: false, turnId: 'n2', reason: 'answer' })
  await ui.redraw(BAND)
  await look()
  await note('cheer')
  await clock.advance(20_000)
  await look()
  await note('after')
  expect(spots).toEqual([['up', spot], ['working', spot], ['cheer', spot], ['after', spot]])
  await ui.unmount()
})

type Kept = { key: string; at: number; scene: Scene }

// The desktop's last scene, as the hooks module keeps it in `$.state`: each write the
// test sees on its way down, the newest one kept. Registered before the test's first call.
function sceneWrites(on: On): (clock: ReturnType<typeof mock.clock>) => Promise<Kept | null> {
  let last: Kept | null = null
  on('state.set', ($, e, next) => {
    const write = e as { plugin?: string; key?: string; value?: unknown }
    if (write.plugin === 'session-band' && write.key === 'scene') last = (write.value ?? null) as Kept | null

    return next(e)
  })

  // The write lands a moment after the frame that settled it.
  return async clock => {
    await clock.advance(1)

    return last
  }
}

/**
 * Each loop a desktop source keeps on the sea's clock (the crests, the glints and the stars, the
 * clouds, the boat, the gulls, the fish, the flag) and its place as the frame opens: its period, and
 * the seconds into it.
 */
function loops(source: string): Map<string, { period: number; into: number }> {
  const found = source.matchAll(/\.([a-z]+\d*)\{animation:[a-z]+ ([\d.]+)s (?:linear|ease-in-out) -([\d.]+)s infinite\}/gu)

  return new Map([...found].map(([, name, period, into]) => [name ?? '', { period: Number(period), into: Number(into) }]))
}

for (const columns of [100, 60, 44]) {
  test(`desktop: at ${columns} columns no new frame snaps the sea back: the crests roll on and the water's front stays where it was`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    const keptScene = sceneWrites(on)
    await start($)
    const props = { ...BAND, bodyColumns: columns }
    const { ui, look } = await band($, 'desktop', props)
    const scenes: Array<{ what: string; at: number; scene: Scene; source: string }> = []
    // The kept scene first (it lands a moment after its frame), then the frame on screen: a redraw
    // due in that moment (a moment's end) is then in both.
    const note = async (what: string) => {
      const kept = await keptScene(clock)
      const source = (await look()).svg?.source ?? ''
      if (kept !== null && kept.at !== scenes[scenes.length - 1]?.at) scenes.push({ what, at: kept.at, scene: kept.scene, source })
    }
    const go = async (ms: number) => {
      for (let left = ms; left > 0; left -= 50) {
        await clock.advance(50)
        await note('time')
      }
    }
    const fail = () => $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    await note('hello')
    await go(3_100)
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    await ui.redraw({ ...props, isWorking: true })
    await note('prompt')
    await go(2_300)
    await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
    await note('edit')
    await go(5_150)
    await fail()
    await note('splash')
    await go(1_600)
    await fail()
    await note('splash again')
    await go(3_400)
    // The tide moves a stride, and the turn lands as its frame does: the cheer takes the sea over
    // mid-glide.
    await $.session.measure(measured(58, 0.45))
    await go(400)
    await go(100)
    await $.turn.complete({ answer: 'Done.', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await ui.redraw(props)
    await note('cheer')
    await go(6_000)
    await $.session.measure(measured(86, 0.5))
    await note('high tide')
    await go(5_600)
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    await ui.redraw({ ...props, isWorking: true })
    await note('prompt at high tide')
    await go(3_000)
    await $.turn.complete({ answer: 'Done.', durationMs: 3_000, isAborted: false, turnId: 't2', reason: 'answer' })
    await ui.redraw(props)
    await note('cheer at high tide')
    await go(7_000)
    await $.session.measure(measured(18, 0.6))
    await note('compact')
    await go(3_000)
    await clock.advance(4 * 60_000)
    await note('nap')
    await go(2_100)
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    await ui.redraw({ ...props, isWorking: true })
    await note('wake')
    await ui.unmount()

    // (The splash's end loads no frame: the splash's frame goes on into the work.)
    expect(scenes.map(one => one.what)).toEqual(['hello', 'prompt', 'edit', 'splash', 'splash again', 'time', 'cheer', 'time', 'high tide', 'prompt at high tide', 'cheer at high tide', 'time', 'compact', 'nap', 'wake'])
    const waited: string[] = []
    let carried = 0
    for (let i = 1; i < scenes.length; i++) {
      const [was, now] = [scenes[i - 1], scenes[i]]
      if (was === undefined || now === undefined) continue
      const [end, open] = [seaAt(was.scene, now.at - was.at), seaAt(now.scene, 0)]
      // The front within a quarter of a pixel (the water's glide is kept to a twentieth of a unit, and
      // in the splash's rush the water covers a unit in a few hundredths of a second); the crests in step.
      expect([now.what, Math.abs(end.front - open.front) * 3 < 0.25]).toEqual([now.what, true])
      for (const crest of ['roll', 'roll2'] as const) {
        const gap = Math.abs(end[crest] - open[crest])
        expect([now.what, crest, Math.min(gap, 1 - gap) < 0.01]).toEqual([now.what, crest, true])
      }
      // Clawd opens the frame where the last one had him, even when the tide has just come in a stride
      // while he stood at the far end of his scuttle (the water waits there for him to walk back).
      // A nap curls him by the shell, and a splash's surge runs to wherever he stands.
      if (!now.scene.still && now.scene.mood !== 'nap' && was.scene.mood !== 'nap' && now.scene.moment !== 'splash') {
        expect([now.what, positionAt(now.scene, 0)]).toEqual([now.what, positionAt(was.scene, now.at - was.at)])
        // A frame that carries the last one's walk on opens on the very pose it had him in.
        if (now.scene.phase !== undefined) expect([now.what, poseAt(now.scene, 0)]).toEqual([now.what, poseAt(was.scene, now.at - was.at)])
        // When the water waits for him (he stood further out than this tide leaves him room), it
        // glides in on a step of his walk back, never while he still stands where he opened.
        const wait = Math.round(Number(/\.glide\{animation:glide [\d.]+s ease-in-out ([\d.]+)s 1 both\}/u.exec(now.source)?.[1] ?? 0) * 1000)
        if (wait > 0) {
          const [opened, before, after] = [positionAt(now.scene, 0), positionAt(now.scene, wait - 10), positionAt(now.scene, wait)]
          expect([now.what, opened >= before, before > after]).toEqual([now.what, true, true])
          const glide = (ms: number) => seaAt(now.scene, ms).glide
          expect([now.what, glide(0) > 0, glide(wait - 10) === glide(0), glide(wait + 300) < glide(0)]).toEqual([now.what, true, true, true])
          waited.push(now.what)
        }
      }
      // And the frame's own CSS carries it: the crests' delays, from the sea's clock.
      const clockAt = now.scene.sea?.clock ?? 0
      expect([now.what, now.source]).toEqual([now.what, expect.stringContaining(`roll 9s linear -${Math.round((clockAt % 9) * 1000) / 1000}s infinite`)])
      // The glints on the water and the stars over it keep that time too, so a new frame never cuts
      // one short or pops one up afresh.
      const before = loops(was.source)
      for (const [name, { period, into }] of loops(now.source)) {
        const last = before.get(name)
        if (last === undefined) continue
        const gap = (((last.into + (now.at - was.at) / 1000 - into) % period) + period) % period
        expect([now.what, name, Math.min(gap, period - gap) < 0.01]).toEqual([now.what, name, true])
        carried++
      }
    }
    expect(carried).toBeGreaterThan(scenes.length)
    // Something did move across those frames: the surge, the tide coming in and going out.
    expect(scenes.some(one => (one.scene.sea?.glide ?? 0) !== 0)).toBe(true)
    // The tide coming in to high while he strolled out on the sand: the water waited for him, on the
    // narrow beach and the 64-unit one. (On the wide beach a 100-column band has, the stride finds him
    // back home.)
    if (columns < 100) expect(waited.length).toBeGreaterThan(0)
    // The stride's frame (straight from the splash's, which went on into the work), then the
    // cheer's a moment into its glide (which the cheer carries on).
    const [beforeStride, stride, cheer] = scenes.slice(4, 7)
    expect([beforeStride?.scene.tide === stride?.scene.tide, (cheer?.at ?? 0) - (stride?.at ?? 0) < 200, (cheer?.scene.sea?.glide ?? 0) !== 0]).toEqual([false, true, true])
  })
}

test('desktop: a frame that takes the sea over keeps the wave lip and the crests exactly where the last frame had them, whatever the millisecond: the same lap going on (the cheer handing over to his sit), or a nap\'s slower lap waiting for the last to run out', async () => {
  const cheer: Scene = { mood: 'idle', tide: 30, still: false, moment: 'cheer', from: null, width: 64, wave: 0, night: false, treasure: null, castle: 0, built: false, sky: 0, sea: null }
  const handovers: Array<[Scene, Scene]> = [
    [cheer, { ...cheer, moment: null, from: 0 }],
    [{ ...cheer, moment: null }, { ...cheer, moment: null, mood: 'nap', from: 0 }],
  ]
  const off: string[] = []
  for (const [was, next] of handovers) {
    for (let ms = 0; ms <= 16_000; ms += 5) {
      const sea = seaAfter(was, ms, next)
      const [end, open] = [seaAt(was, ms), seaAt({ ...next, sea }, 0)]
      if (Math.abs(end.front - open.front) > 1e-6) off.push(`${next.mood} ${ms}: ${end.front} against ${open.front}`)
      // And the crests roll on from exactly where they were.
      for (const crest of ['roll', 'roll2'] as const) {
        if (Math.abs(end[crest] - open[crest]) > 1e-6) off.push(`${next.mood} ${ms}: ${crest} ${end[crest]} against ${open[crest]}`)
      }
    }
  }
  expect(off.slice(0, 6)).toEqual([])
})

for (const columns of [100, 140]) {
  test(`desktop: at ${columns} columns a stride of the tide far out to sea carries his walk straight on: the same step, the same way, never a turn back`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    const keptScene = sceneWrites(on)
    await start($, 12)
    const props = { ...BAND, bodyColumns: columns, isWorking: true }
    const { ui } = await band($, 'desktop', props)
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    await ui.redraw(props)
    await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
    // Strides at many points of his potter: each new frame opens on the step he was taking.
    let percent = 12
    let carried = 0
    for (const ms of [6_100, 4_300, 7_700]) {
      await clock.advance(ms)
      await ui.redraw(props)
      const was = await keptScene(clock)
      percent += 16
      await $.session.measure(measured(percent, 0.4))
      await ui.redraw(props)
      // The stride's frame waits a moment, in case the turn is landing.
      await clock.advance(450)
      await ui.redraw(props)
      const now = await keptScene(clock)
      if (was === null || now === null || now.at === was.at) continue
      const swap = now.at - was.at
      expect([percent, now.scene.tide !== was.scene.tide]).toEqual([percent, true])
      expect([percent, now.scene.phase === undefined]).toEqual([percent, false])
      carried += 1
      expect([percent, poseAt(now.scene, 0), positionAt(now.scene, 0)]).toEqual([percent, poseAt(was.scene, swap), positionAt(was.scene, swap)])
      // And on: a second later he is where the old frame would have had him.
      expect([percent, positionAt(now.scene, 1_000), poseAt(now.scene, 1_000)]).toEqual([percent, positionAt(was.scene, swap + 1_000), poseAt(was.scene, swap + 1_000)])
    }
    expect(carried).toBe(3)
    await ui.unmount()
  })
}

test('desktop: a module reload hands the frame the very same source, from the scene kept in $.state', async ($, on) => {
  const { clock } = world(on)
  const keptScene = sceneWrites(on)
  await start($)
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2_000)
  const kept = await keptScene(clock)
  const source = (await look()).svg?.source
  expect(kept?.scene.mood).toBe('work')
  // /config changes warnAt: session.start runs again in the fresh activation, which draws the beach.
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  expect((await look()).svg?.source).toBe(source)
  await ui.unmount()
})

test('desktop: the frame is whole pixels, 64 tall, the picture drawn at exactly three to a unit', async ($, on) => {
  world(on)
  await start($)
  for (const columns of [34, 40, 44, 48, 100, 160]) {
    const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns })
    const source = (await look()).svg?.source ?? ''
    const [, width] = /viewBox="0 -5 (\d+) 64" width="(\d+)" height="64"/u.exec(source) ?? []
    expect([columns, Number(width) % 3, /viewBox="0 -5 (\d+) 64" width="\1" height="64"/u.test(source)]).toEqual([columns, 0, true])
    expect([columns, source.includes('<g transform="scale(3)">')]).toEqual([columns, true])
    await ui.unmount()
  }
})

test('desktop: every heart is drawn crisp on whole screen pixels, each pixel two wide and three tall as the hearth\'s, the sleeper\'s too, lively or still', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  const hearts = async (label: string) => {
    const source = (await look()).heart
    const found = [...source.matchAll(/<g class="heart"([^>]*)><path d="([^"]+)"\/><\/g>/gu)]
    expect([label, found.length > 0]).toEqual([label, true])
    for (const [, attributes = '', d = ''] of found) {
      expect([label, attributes.includes('shape-rendering="crispEdges"')]).toEqual([label, true])
      // Every corner on a whole screen pixel (a unit is three), every pixel of it two screen pixels
      // wide and three tall: 16 by 12, the hearth's heart, never the squat 16 by 8 bow.
      const px = (d.match(/-?[\d.]+/gu) ?? []).map(n => Number(n) * 3)
      expect([label, d, px.every(n => Math.abs(n - Math.round(n)) < 0.01)]).toEqual([label, d, true])
      const top = /^M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (?:-?[\d.]+)L(?:-?[\d.]+) (-?[\d.]+)L/u.exec(d)
      expect([label, Math.round((Number(top?.[3]) - Number(top?.[1])) * 3)]).toEqual([label, 4])
      expect([label, Math.round((Number(top?.[4]) - Number(top?.[2])) * 3)]).toEqual([label, 3])
      const ys = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/gu)].map(match => Number(match[2]) * 3)
      expect([label, Math.round(Math.max(...ys) - Math.min(...ys))]).toEqual([label, 12])
    }
  }
  await hearts('awake')
  await clock.advance(5 * 60_000)
  await ui.redraw(BAND)
  await hearts('napping')
  await run($, 'band', 'still')
  await ui.redraw(BAND)
  await hearts('napping, still')
  await ui.unmount()
})

test('desktop: the spray leaps from the water just right of Clawd, drawn over him, never across his body', async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (const columns of [100, 44]) {
    const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns, isWorking: true })
    await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
    await clock.advance(2_000)
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    const source = (await look()).svg?.source ?? ''
    const drops = [...source.matchAll(/<circle class="drop drop\d" cx="([\d.]+)"/gu)].map(match => Number(match[1]))
    expect([columns, drops.length]).toEqual([columns, 4])
    expect([columns, source.indexOf('class="drop drop0"') > source.indexOf('class="walk clawd"')]).toEqual([columns, true])
    for (const cx of drops) expect([columns, cx, cx - 1 > deskX(source, 0) + 18]).toEqual([columns, cx, true])
    await ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 4_000, isAborted: false, turnId: `t${columns}`, reason: 'answer' })
    await clock.advance(30_000)
  }
})

test('desktop: the splash\'s drops swell up out of the crest and shrink away at full color, never fading, and are all back in the sea by 2.2 s', async ($, on) => {
  world(on)
  await start($)
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  const source = (await look()).svg?.source ?? ''
  // A fade (in or out) passes a drop through a slate gray on the dark page.
  const flights = [...source.matchAll(/@keyframes drop\d\{(?:[^{}]*\{[^}]*\})*\}/gu)].map(match => match[0])
  expect(flights.length).toBe(4)
  for (const flight of flights) expect([flight, flight.includes('opacity')]).toEqual([flight, false])
  // Each swells from nothing as it leaves the crest, at the moment its flight starts.
  expect(source).toContain('@keyframes swell{from{scale:0}to{scale:1}}')
  const timed = [...source.matchAll(/\.drop(\d)\{animation:drop\1 ([\d.]+)s ease-out ([\d.]+)s 1 both,swell [\d.]+s ease-out ([\d.]+)s 1 both\}/gu)]
  expect(timed.length).toBe(4)
  for (const [, i, length, delay, swell] of timed) {
    expect([i, swell]).toEqual([i, delay])
    // Down by 2.2 s, all of them: no lone speck left hanging after the rest.
    expect([i, Math.abs(Number(delay) + Number(length) - 2.2) < 0.011]).toEqual([i, true])
  }
  await ui.unmount()
})

// Night over the beach comes by the person's own clock: these times are local, so the tests hold in
// any time zone (a summer's day far from any change of the clocks).
const localAt = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 6, day, hour, minute, second).getTime()

test('night falls at 8pm and day breaks at 6am, and the sun and the moon cross the sky a step every 20 minutes, by the person\'s own clock', () => {
  const hours: Array<[number, number]> = [[19, 59], [20, 0], [23, 30], [0, 0], [5, 59], [6, 0], [13, 0]]
  expect(hours.map(([hour, minute]) => isNightAt(localAt(15, hour, minute)))).toEqual([false, true, true, true, true, false, false])
  // The sun's steps count from daybreak, 42 of them; the moon's from nightfall, 30.
  expect([[6, 0], [6, 19], [6, 20], [13, 0], [19, 59]].map(([hour, minute]) => skyStepAt(localAt(15, hour ?? 0, minute)))).toEqual([0, 0, 1, 21, 41])
  expect([skyStepAt(localAt(15, 20)), skyStepAt(localAt(15, 23, 30)), skyStepAt(localAt(16, 0, 10)), skyStepAt(localAt(16, 5, 59))]).toEqual([0, 10, 12, 29])
  expect([skySteps(false), skySteps(true)]).toEqual([42, 30])
  // The next step comes on the twenty minutes; nightfall and daybreak are steps.
  expect(skyTurnsIn(localAt(15, 13))).toBe(20 * 60_000)
  expect(skyTurnsIn(localAt(15, 19, 50))).toBe(10 * 60_000)
  expect(skyTurnsIn(localAt(15, 5, 59, 30))).toBe(30_000)
})

// The stars in a terminal band: their cells (row, column, glyph), each faint.
function starsOf(view: View): Array<{ row: number; col: number; ch: string; isDim: boolean }> {
  return view.rows.slice(0, 3).flatMap((row, r) => {
    let col = 0
    const found: Array<{ row: number; col: number; ch: string; isDim: boolean }> = []
    for (const run of runs(row)) {
      for (const ch of run.text) {
        // (A cheer's ✢ is bright: a star's is faint.)
        if (ch === '·' || ((ch === '✢' || ch === '✳') && run.dimColor === true)) found.push({ row: r, col, ch, isDim: run.dimColor === true })
        col += cells(ch)
      }
    }
    return found
  })
}

for (const motion of ['lively', 'still'] as const) {
  test(`terminal, ${motion}: at night faint stars come out over the sea, two cells of sky clear of anything; by day there are none`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on, { now: localAt(15, 22) })
    await start($)
    if (motion === 'still') await run($, 'band', 'still')
    await turn($, clock)
    for (const columns of [34, 40, 56, 64, 100, 140]) {
      const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
      const view = await look()
      const stars = starsOf(view)
      // A star or two from the narrowest beach up, three and more from 100 columns.
      expect([columns, stars.length >= (columns >= 100 ? 3 : 1)]).toEqual([columns, true])
      for (const star of stars) {
        const row = [...(view.scene[star.row] ?? '')]
        const around = [-2, -1, 1, 2].map(d => row[star.col + d] ?? ' ')
        expect([columns, star, view.scene[star.row], star.row < 2 && star.isDim && around.every(ch => ch === ' ')]).toEqual([columns, star, view.scene[star.row], true])
      }
      await ui.unmount()
    }
    // Noon the next day: the sky is clear.
    await clock.set(localAt(16, 12))
    const { ui, look } = await band($, 'terminal', { ...BAND, bodyColumns: 100 })
    expect(starsOf(await look())).toEqual([])
    await ui.unmount()
  })
}

// A dot over him (curled up asleep, his head below the sky row) reads as resting on him, and one over
// the wave's crest as its spray: a star keeps the cells just below it open too.
for (const percent of [42, 86]) {
  test(`terminal: at ${percent}%, at night no star sits over him, awake or asleep, nor over his z's, the wave or the shell, at any width`, { timeoutMs: 240_000 }, async ($, on) => {
    const { clock } = world(on, { now: localAt(15, 22) })
    await start($, percent)
    await turn($, clock)
    const crowded: string[] = []
    for (const mood of ['awake', 'asleep'] as const) {
      if (mood === 'asleep') await clock.advance(200_000)
      for (let columns = 34; columns <= 160; columns += 2) {
        const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
        await wait(500)
        const view = await look()
        for (const star of starsOf(view)) {
          const below = cellsOf(view.rows[star.row + 1]).slice(Math.max(0, star.col - 1), star.col + 2)
          // Below a star in the sky row, open sky or the wave's sea behind its foam; below one low over
          // the water, the sand or the sea, never him.
          const isSea = (cell: { ch: string; color: unknown; bg: unknown }) => cell.color === '#4C7FAF' && cell.bg === undefined && '█▄▖'.includes(cell.ch)
          const isOpen = star.row === 0 ? below.every(cell => (cell.ch === ' ' && cell.bg === undefined) || isSea(cell)) : below.every(cell => cell.color !== 'clawd_body')
          if (!isOpen) crowded.push(`${mood} ${columns}: ${star.row}:${star.col}\n${view.scene.join('\n')}`)
        }
        await ui.unmount()
      }
    }
    expect(crowded.slice(0, 3)).toEqual([])
  })
}

// A splash holds the water's edge, so a lap starting or ending under it changes nothing else: no star
// twinkles then, wherever in the splash the lap falls.
const FIRST_LAP = 40 + dice(2, 32)
for (const back of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
  test(`terminal: a splash ${back} ticks before the first lap never twinkles a star on a frame of its own`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on, { now: localAt(15, 22) })
    await start($)
    await turn($, clock)
    const { ui, look, wait } = await band($, 'terminal')
    await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
    for (let i = 0; i < FIRST_LAP - back; i++) {
      await wait(250)
      await clock.advance(250)
    }
    await $.tool.call({ tool: 'Bash', command: 'npm test fail', description: 'Run the tests' })
    const sky = (view: View) => starsOf(view).map(star => `${star.row}:${star.col}:${star.ch}`).join(' ')
    // Everything but the stars (and the ✳ that once twinkled them).
    const rest = (view: View) => JSON.stringify(view.tree).replace(/[·✢✳]/gu, ' ')
    let last = await look()
    const alone: string[] = []
    for (let i = 0; i < 20; i++) {
      await wait(250)
      await clock.advance(250)
      const now = await look()
      if (sky(now) !== sky(last) && rest(now) === rest(last)) alone.push(`${i}: ${sky(last)} -> ${sky(now)}`)
      last = now
    }
    expect(alone).toEqual([])
    await ui.unmount()
  })
}

test('terminal: a star twinkles only on the frames where a wave washes up the sand, so the sky never asks a frame of its own', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 22) })
  await start($)
  await turn($, clock)
  const { ui, look, wait } = await band($, 'terminal')
  let last = await look()
  let twinkles = 0
  for (let i = 0; i < 4 * 80; i++) {
    await wait(250)
    await clock.advance(250)
    const now = await look()
    const sky = (view: View) => starsOf(view).map(star => `${star.row}:${star.col}:${star.ch}`).join(' ')
    twinkles += sky(now).includes('✢') && !sky(last).includes('✢') ? 1 : 0
    if (sky(now) !== sky(last)) {
      // The ground row (the water's edge) or Clawd moved too: the star changed on a frame that changed anyway.
      const moved = now.scene[2] !== last.scene[2] || JSON.stringify(clawdAt(now)) !== JSON.stringify(clawdAt(last))
      expect([i, sky(last), sky(now), moved]).toEqual([i, sky(last), sky(now), true])
    }
    last = now
  }
  expect(twinkles).toBeGreaterThanOrEqual(1)
  await ui.unmount()
})

test('desktop: at night a crescent moon and twinkling stars hang over the sea, and the alt says so; by day there are none', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 22) })
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  const night = (await look()).svg
  const source = night?.source ?? ''
  expect(night?.alt).toMatch(/ The stars are out\.$/u)
  expect(source).toMatch(/<g class="sky">.*<path class="moon" d="M/u)
  // Four over the sea, and on this wide beach more over the sand; the narrow beach has the four.
  expect([...source.matchAll(/class="twinkle twinkle\d+"/gu)].length).toBeGreaterThan(4)
  const { ui: narrow, look: lookNarrow } = await band($, 'desktop', { ...BAND, bodyColumns: 44 })
  expect([...((await lookNarrow()).svg?.source ?? '').matchAll(/class="twinkle twinkle\d+"/gu)].length).toBe(4)
  await narrow.unmount()
  // The sky is drawn first, behind the sand, the sea and him.
  expect(source.indexOf('class="sky"')).toBeLessThan(source.indexOf('clipPath id="sand"'))
  // They twinkle only where motion plays, shrinking to a glint and back, never fading.
  const motion = source.slice(source.indexOf('@media (prefers-reduced-motion:no-preference)'))
  expect(motion).toMatch(/@keyframes twinkle\{[^@]*scale\(\.3\)/u)
  expect(source.slice(0, source.indexOf('@media'))).not.toContain('animation')
  expect(/@keyframes twinkle\{[^}]*\}[^@]*/u.exec(source)?.[0]).not.toContain('opacity')
  // Still, the stars shine on without a twinkle.
  await run($, 'band', 'still')
  const still = (await look()).svg?.source ?? ''
  expect(still).toContain('class="sky"')
  expect(still).not.toContain('@keyframes')
  await run($, 'band', 'lively')
  // Noon the next day: no moon, no stars, and the alt says nothing of them.
  await clock.set(localAt(16, 12))
  const day = (await look()).svg
  expect(day?.source).not.toMatch(/class="moon"|twinkle/u)
  expect(day?.alt).not.toContain('stars')
  await ui.unmount()
})

test('desktop: a soft shadow lies under him on the sand: it walks with him, stays down when he hops, and goes home with him for his nap', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(10_000)
  const { ui, look } = await band($, 'desktop')
  const idle = (await look()).svg?.source ?? ''
  // One shadow, first in his walk (so it walks with him, under his feet), outside his hop, and drawn
  // smooth under his crisp pixels.
  expect([...idle.matchAll(/class="shadow"/gu)].length).toBe(1)
  expect(idle).toMatch(/<g class="walk clawd"><ellipse class="shadow" [^>]*shape-rendering="geometricPrecision"\/><g class="hop">/u)
  // The sand a shade darker, and see-through: never a gray smudge on either page.
  const [red, green, blue, alpha] = (/class="shadow"[^>]*fill="rgba\(([^)]*)\)"/u.exec(idle)?.[1] ?? '').split(',').map(Number)
  expect([(red ?? 0) > (green ?? 0), (green ?? 0) > (blue ?? 0), (alpha ?? 0) > 0.1 && (alpha ?? 1) < 0.4]).toEqual([true, true, true])
  // It moves only with his hop.
  expect(idle).not.toContain('.shadow{animation')
  // Dozing off, he takes it home with him; curled up, half in the sand, he covers it.
  await clock.advance(151_000)
  const nap = (await look()).svg?.source ?? ''
  expect(nap).toMatch(/<g class="homeward"><ellipse class="shadow" /u)
  expect(nap.slice(nap.indexOf('class="clawd curl"'))).not.toContain('class="shadow"')
  await ui.unmount()
})

test('desktop: glints of light come and go out on the water, the sun\'s white by day and the moon\'s gold under it by night; never in a still frame', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 14) })
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  const glints = (source: string) => [...source.matchAll(/<path class="glint glint\d" d="M([\d.]+) [^"]*" fill="([^"]+)"\/>/gu)].map(([, x, fill]) => ({ x: Number(x), fill }))
  const front = (source: string) => Number(/<clipPath id="water"><path d="M([\d.]+) /u.exec(source)?.[1])
  const day = (await look()).svg?.source ?? ''
  expect(glints(day).map(glint => glint.fill)).toEqual(['#FFFFFF', '#FFFFFF', '#FFFFFF'])
  // In the water's own clip, after its crests: they ride its lap and its surge, and never show on the sand.
  expect(day).toMatch(/<g clip-path="url\(#water\)"><path class="roll2"[^>]*\/><path class="roll"[^>]*\/>(<path class="glint glint\d"[^>]*\/>){3}<\/g>/u)
  // Each pops up from a point and shrinks away, never fading, and only where motion plays: a page
  // that asks for less motion keeps them out of sight.
  const motion = day.slice(day.indexOf('@media (prefers-reduced-motion:no-preference)'))
  expect(/@keyframes glint\{[^@]*?\}\}/u.exec(motion)?.[0]).not.toContain('opacity')
  expect(day.slice(0, day.indexOf('@media'))).toContain('.glint{transform-box:fill-box;transform-origin:center;transform:scale(0)}')
  // At the lowest tide, only those out on the water show, clear of its front.
  await $.session.measure(measured(0, 0.31))
  await turn($, clock)
  const low = (await look()).svg?.source ?? ''
  expect([glints(low).length > 0, glints(low).length < 3]).toEqual([true, true])
  glints(low).forEach(glint => expect(glint.x).toBeGreaterThan(front(low) + 1.5))
  // Their periods, and the stars', divide the sea clock's wrap, so they go on in step across it.
  await $.session.measure(measured(42, 0.31))
  // At 10pm the moon has only just risen, over the sand: no moonlight on the water yet.
  await clock.set(localAt(15, 22))
  expect(glints((await look()).svg?.source ?? '')).toEqual([])
  await clock.set(localAt(16, 2))
  const night = (await look()).svg?.source ?? ''
  const glinting = (source: string) => [...loops(source).keys()].filter(name => name.startsWith('glint'))
  expect([glinting(day).length, glinting(night).length]).toEqual([3, 3])
  for (const source of [day, night]) {
    for (const { period } of loops(source).values()) expect(Math.abs(126 / period - Math.round(126 / period))).toBeLessThan(1e-9)
  }
  // By night, a path of moonlight on the water under the moon, wherever it has crossed to.
  const moon = Number(/<path class="moon" d="M([\d.]+) /u.exec(night)?.[1])
  const moonlit = glints(night)
  expect(moonlit.map(glint => glint.fill)).toEqual(['#E9C77E', '#E9C77E', '#E9C77E'])
  moonlit.forEach(glint => expect(Math.abs(glint.x - moon)).toBeLessThan(2))
  // Still, none.
  await run($, 'band', 'still')
  expect((await look()).svg?.source).not.toContain('glint')
  await ui.unmount()
})

for (const surface of SURFACES) {
  test(`${surface}: the stars come out as night falls, with nothing else to redraw the band`, async ($, on) => {
    // (A turn takes twenty quiet seconds after it: 7:59:40pm.)
    const { clock } = world(on, { now: localAt(15, 19, 59, 20) })
    await start($)
    await turn($, clock)
    const { ui, look, wait } = await band($, surface)
    const hasStars = async () => {
      const view = await look()
      return surface === 'terminal' ? starsOf(view).length > 0 : (view.svg?.source ?? '').includes('class="moon"')
    }
    expect(await hasStars()).toBe(false)
    // 8pm comes and goes on both clocks, a tick at a time, with no event of the session's.
    for (let i = 0; i < 4 * 24; i++) {
      await clock.advance(250)
      await wait(250)
    }
    expect(await hasStars()).toBe(true)
    await ui.unmount()
  })
}

// ── The wide desktop beach ──────────────────────────────────────────────────────

test('desktop: a wider band\'s beach widens into the room its words leave, two units a column, so the words\' room never shrinks', () => {
  const place = (...texts: string[]): Words => texts.map((text, i) => (i === 0 ? { text } : { text, tone: 'dim' as const }))
  const usual = place('42% context', ' · $0.31', ' · 5h limit 23%')
  const short = place('aaronpak', ' · Opus 5.5')
  const long = place('agent-plugins', ' · claude/first-mod · 3 uncommitted', ' · Opus 5.5')
  // The narrow rule up to 48 columns, then 64 units until the words have their room.
  expect([36, 44, 48, 60, 66].map(columns => beachWidth(columns, [usual, short]))).toEqual([40, 56, 64, 64, 64])
  // The Mac app's 768 px column (96 columns): 122 units beside a folder and the model, 78 beside a
  // branch and a count. At most 224.
  expect([beachWidth(96, [usual, short]), beachWidth(96, [usual, long]), beachWidth(200, [usual, short])]).toEqual([122, 78, 224])
  // The context line whole too: with the limit's reset time, and at high tide with every part.
  const resets = place('42% context', ' · $1.94', ' · 5h limit 61%', ' · resets 2:27am')
  const full = place('86% context', ' · try /compact', ' · 5h limit 81%', ' · resets 12:27am', ' · $11.94')
  expect([beachWidth(96, [resets, short]), beachWidth(96, [full, short])]).toEqual([96, 68])
  // A count going from 9 to 10, or a cost from $9.99 to $10.00, never moves it.
  const count = (n: number) => place('agent-plugins', ` · claude/first-mod · ${n} uncommitted`, ' · Opus 5.5')
  expect(beachWidth(120, [usual, count(10)])).toBe(beachWidth(120, [usual, count(9)]))
  const cost = (usd: string) => place('86% context', ' · try /compact', ` · ${usd}`)
  expect(beachWidth(120, [cost('$10.00'), short])).toBe(beachWidth(120, [cost('$9.99'), short]))
  // The words' room only grows as the band widens, and beside a widened beach it keeps 290 px and
  // both lines whole.
  for (const lines of [[usual, short], [usual, long], [resets, short], [full, long]]) {
    const widest = Math.max(...lines.map(line => line.reduce((sum, piece) => sum + textPx(piece.text, false), 0)))
    let room = Number.NEGATIVE_INFINITY
    for (let columns = 34; columns <= 220; columns++) {
      const width = beachWidth(columns, lines)
      const now = columns * 7.6 - width * 3 - 3 * 7.6 - 1
      expect([columns, now >= room, width <= 64 || now >= Math.max(290, widest)]).toEqual([columns, true, true])
      room = now
    }
  }
})

// The engine draws no Svg source over 131,072 characters (it draws its own band instead). The widest
// beach's cheer at the end of a long walk home (a high tide, here at a low warnAt, put him at the
// water) holds the most: each pose of his walk keeps only the stops that change it, with room to spare.
for (const warnAt of [80, 30]) {
  test(`desktop: at warnAt ${warnAt}, the widest beach's cheer after a long walk home stays well inside the engine's Svg limit`, { options: { warnAt }, timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on, { now: localAt(15, 22) })
    await start($, 31)
    const props = { ...BAND, bodyColumns: 300 }
    const { ui, look } = await band($, 'desktop', props)
    await clock.advance(5_000)
    await ui.redraw(props)
    await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
    const working = { ...props, isWorking: true }
    await ui.redraw(working)
    for (let i = 0; i < 9; i++) {
      await $.tool.call({ tool: 'Read', file_path: `/work/b${i}.ts` })
      await clock.advance(10_000)
      await ui.redraw(working)
    }
    await $.turn.complete({ answer: 'Done.', durationMs: 91_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(10)
    await ui.redraw(props)
    const cheer = (await look()).svg
    expect(cheer?.alt).toContain('spins with joy')
    expect((cheer?.source ?? '').length).toBeLessThan(80_000)
    await ui.unmount()
  })
}

// The context line keeps its room beside the beach: at the Mac app's width, high tide with a limit
// near its end says all of it (the nudge, the limit, its reset and the cost), as beside the 64-unit beach.
test('desktop: at 96 and 100 columns the context line shows whole beside the beach, its reset time and cost too', async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.94)
  await $.session.measure(measured(86, 1.94, 81))
  await turn($, clock)
  for (const columns of [96, 100, 120]) {
    const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns })
    const line = (await look()).words.find(row => row.includes('context')) ?? ''
    expect([columns, line]).toEqual([columns, expect.stringMatching(/^86% context · try \/compact · 5h limit 81% · resets \d+:\d\d[ap]m · \$1\.94$/u)])
    await ui.unmount()
  }
})

// The sun's place in a desktop source, and the moon's.
function sunOf(source: string): { x: number; y: number; r: number; fill: string } | null {
  const found = /<circle class="sun" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="(#[0-9A-F]{6})"\/>/u.exec(source)

  return found === null ? null : { x: Number(found[1]), y: Number(found[2]), r: Number(found[3]), fill: found[4] ?? '' }
}
const moonOf = (source: string) => Number(/<path class="moon" d="M([\d.]+) /u.exec(source)?.[1] ?? Number.NaN)

test('desktop: on a wide beach the sun crosses the sky through the day, warmer and larger as it rises and sets, and the moon through the night; each step is a frame the band draws by itself', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 6, 20) })
  await start($)
  await turn($, clock)
  const { ui, look, wait } = await band($, 'desktop')
  const at = async (day: number, hour: number, minute = 0) => {
    await clock.set(localAt(day, hour, minute))
    return (await look()).svg?.source ?? ''
  }
  const [morning, noon, evening] = [sunOf(await at(15, 6, 30)), sunOf(await at(15, 13)), sunOf(await at(15, 19, 30))]
  // Up from over the sand, high at midday, down over the sea: and never over his stroll.
  expect([(morning?.x ?? 0) < (noon?.x ?? 0), (noon?.x ?? 0) < (evening?.x ?? 0)]).toEqual([true, true])
  expect([(noon?.y ?? 9) < (morning?.y ?? 0), (noon?.y ?? 9) < (evening?.y ?? 0)]).toEqual([true, true])
  // A soft gold at midday; a warmer one, a little larger, as it rises and sets.
  expect(noon?.fill).toBe('#F0C35B')
  expect([morning?.fill !== noon?.fill, evening?.fill !== noon?.fill, (morning?.r ?? 0) > (noon?.r ?? 9), (evening?.r ?? 0) > (noon?.r ?? 9)]).toEqual([true, true, true, true])
  // By night the moon crosses the same way, and the sun has set.
  const [late, midnight, dawn] = [await at(15, 21), await at(16, 1), await at(16, 5, 30)]
  expect(sunOf(late)).toBeNull()
  expect([moonOf(late) < moonOf(midnight), moonOf(midnight) < moonOf(dawn)]).toEqual([true, true])
  // A step every 20 minutes, which nothing in the session announces: the band draws it by itself.
  const before = sunOf(await at(16, 13, 19))
  for (let i = 0; i < 4 * 80; i++) {
    await clock.advance(250)
    await wait(250)
  }
  expect((sunOf((await look()).svg?.source ?? '')?.x ?? 0) > (before?.x ?? 0)).toBe(true)
  await ui.unmount()
})

test('desktop: a step of the sky during a long tool waits for the frame\'s next change, so his walk never starts over; the sky catches up then', async ($, on) => {
  const { clock, release } = world(on, { now: localAt(15, 13, 5) })
  await start($)
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'run the long tests', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  const running = $.tool.call({ tool: 'Read', file_path: '/work/held.ts' })
  await clock.advance(1_000)
  const working = (await look()).svg?.source ?? ''
  // 13:20 comes and goes 15 minutes into the tool: the frame his walk is on stays up.
  for (let i = 0; i < 18; i++) await clock.advance(60_000)
  expect((await look()).svg?.source).toBe(working)
  release()
  await running
  await $.turn.complete({ answer: 'Done.', durationMs: 1_100_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw(BAND)
  const cheer = (await look()).svg?.source ?? ''
  expect((sunOf(cheer)?.x ?? 0) > (sunOf(working)?.x ?? 0)).toBe(true)
  await ui.unmount()
})

// A moment still on (the stretch up from a nap, which lasts as long as he reads; a cheer; a splash)
// plays once: a step of the sky, or a starfish washed up, waits for the moment's own end.
test('desktop: a step of the sky while he stretches up from a nap waits for the stretch to end, so it never plays again; the sun moves on as he gets to work', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13, 34, 30) })
  await start($)
  await turn($, clock)
  await clock.advance(5 * 60_000)
  await $.prompt.submit({ text: 'wake up', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  const woke = (await look()).svg?.source ?? ''
  expect(woke).toContain('@keyframes m-stretch')
  // 13:40 comes as he reads.
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  await clock.advance(7_000)
  expect((await look()).svg?.source).toBe(woke)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(1_000)
  const working = (await look()).svg?.source ?? ''
  expect([working === woke, working.includes('m-stretch'), (sunOf(working)?.x ?? 0) > (sunOf(woke)?.x ?? 0)]).toEqual([false, false, true])
  await ui.unmount()
})

test('desktop: a compaction as he stretches up from a nap leaves its starfish once the stretch is over, never playing it again', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13, 1) })
  await start($, 90)
  await turn($, clock)
  await clock.advance(5 * 60_000)
  await $.prompt.submit({ text: 'wake up', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  const woke = (await look()).svg?.source ?? ''
  expect(woke).toContain('@keyframes m-stretch')
  await clock.advance(8_000)
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY, SUMMARY] })
  await $.session.measure(measured(20, 0.31))
  await clock.advance(200)
  expect((await look()).svg?.source).toBe(woke)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(1_000)
  const working = (await look()).svg?.source ?? ''
  expect([working.includes('m-stretch'), working.includes('class="starfish"')]).toEqual([false, true])
  await ui.unmount()
})

test('desktop: a step of the sky in the middle of a cheer never starts the cheer over: the sun moves on with the frame after it', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13, 39) })
  await start($)
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(57_500)
  await $.turn.complete({ answer: 'Done.', durationMs: 58_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw(BAND)
  const cheer = (await look()).svg
  expect(cheer?.alt).toContain('spins with joy')
  const frames: Array<{ source: string; alt: string }> = []
  for (let i = 0; i < 12; i++) {
    await clock.advance(500)
    const view = (await look()).svg
    if ((frames.at(-1)?.source ?? cheer?.source) !== view?.source) frames.push({ source: view?.source ?? '', alt: view?.alt ?? '' })
  }
  // One new frame, his sit after the cheer, under the sun's next step.
  expect(frames.map(frame => frame.alt.includes('spins with joy'))).toEqual([false])
  expect((sunOf(frames[0]?.source ?? '')?.x ?? 0) > (sunOf(cheer?.source ?? '')?.x ?? 0)).toBe(true)
  await ui.unmount()
})

test('desktop: a splash\'s frame kept on into a long command waits out a step of the sky as any working frame does, so his walk never starts over', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, during } = world(on, { now: localAt(15, 13, 33) })
  await start($)
  await turn($, clock)
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  const { ui, look } = await band($, 'desktop', { ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2_000)
  await $.tool.call({ tool: 'Bash', command: 'npm run fail', description: 'Run the tests' })
  const splash = (await look()).svg?.source ?? ''
  expect(splash).toContain('data-wave')
  // Eight minutes of a command, past the sky's step at 13:40.
  const frames = new Set<string>()
  during.tool = async () => {
    for (let i = 0; i < 32; i++) {
      await clock.advance(15_000)
      frames.add((await look()).svg?.source ?? '')
    }
  }
  await $.tool.call({ tool: 'Bash', command: 'sleep 480', description: 'Wait a while' })
  during.tool = null
  expect([...frames].map(frame => frame === splash)).toEqual([true])
  await ui.unmount()
})

test('desktop: nightfall comes at once to a frame a long wait holds, though a step of the sky alone waits for its next change', async ($, on) => {
  const { clock, release } = world(on, { now: localAt(15, 19, 30) })
  await start($)
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'plan it', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  const running = $.tool.call({ tool: 'Read', file_path: '/work/held.ts' })
  await clock.advance(1_000)
  const working = (await look()).svg
  // 19:40 comes and goes: the frame his walk is on stays up.
  for (let i = 0; i < 12; i++) await clock.advance(60_000)
  expect((await look()).svg?.source).toBe(working?.source)
  // 8pm: the stars are out over the desktop's beach as over the terminal's.
  for (let i = 0; i < 20; i++) await clock.advance(60_000)
  const night = (await look()).svg
  expect([working?.alt.includes('The stars are out.'), night?.alt.includes('The stars are out.'), night?.source.includes('class="moon"')]).toEqual([false, true, true])
  release()
  await running
  await ui.unmount()
})

test('desktop: a stride of the tide after a step of the sky a long tool held still waits its moment, in case the turn is landing', async ($, on) => {
  const { clock, release } = world(on, { now: localAt(15, 13, 5) })
  await start($)
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'run the long tests', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  const running = $.tool.call({ tool: 'Read', file_path: '/work/held.ts' })
  await clock.advance(1_000)
  const working = (await look()).svg?.source ?? ''
  for (let i = 0; i < 18; i++) await clock.advance(60_000)
  expect((await look()).svg?.source).toBe(working)
  await $.session.measure(measured(60, 0.4))
  await clock.advance(100)
  expect((await look()).svg?.source).toBe(working)
  await clock.advance(STRIDE_WAIT_MS)
  const stride = (await look()).svg?.source ?? ''
  expect([stride === working, (sunOf(stride)?.x ?? 0) > (sunOf(working)?.x ?? 0)]).toEqual([false, true])
  release()
  await running
  await ui.unmount()
})

test('desktop: the narrow beach\'s sky never moves, so its step never reloads the frame; its moon hangs over the sea all night', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 22) })
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: 44 })
  const first = (await look()).svg?.source ?? ''
  // Asleep across a step (22:20): the very same source, so the frame never reloads.
  await clock.advance(4 * 60_000)
  await ui.redraw({ ...BAND, bodyColumns: 44 })
  const napping = (await look()).svg?.source ?? ''
  await clock.set(localAt(15, 22, 21))
  await ui.redraw({ ...BAND, bodyColumns: 44 })
  expect([napping.includes('curl'), (await look()).svg?.source === napping]).toEqual([true, true])
  await clock.set(localAt(16, 3))
  await ui.redraw({ ...BAND, bodyColumns: 44 })
  const later = (await look()).svg?.source ?? ''
  expect(moonOf(later)).toBe(moonOf(first))
  // By day it has no sun, nor clouds or a boat: the 56-unit beach as it always was.
  await clock.set(localAt(16, 13))
  await ui.redraw({ ...BAND, bodyColumns: 44 })
  expect((await look()).svg?.source).not.toMatch(/class="(?:sun|cloud|boat|castle|umbrella|gull)/u)
  await ui.unmount()
})

test('desktop: the wide beach\'s scenery comes in by width: a sailboat, clouds, gulls and a leaping fish, the sandcastle, then the umbrella; a still frame keeps only what stands still', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  await turn($, clock)
  const has = (source: string) => ({
    sun: source.includes('class="sun"'),
    clouds: [...source.matchAll(/class="cloud cloud\d"/gu)].length,
    boat: source.includes('class="boat"'),
    gulls: source.includes('class="gull gull0"'),
    fish: source.includes('class="fishx"'),
    castle: source.includes('class="castle"'),
    umbrella: source.includes('class="umbrella"'),
  })
  const at = async (columns: number) => {
    const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns })
    const source = (await look()).svg?.source ?? ''
    await ui.unmount()
    return source
  }
  // 64 units (60 columns), 108 (100), 148 (120).
  expect(has(await at(60))).toEqual({ sun: true, clouds: 2, boat: true, gulls: false, fish: false, castle: false, umbrella: false })
  const wide = await at(100)
  expect(has(wide)).toEqual({ sun: true, clouds: 2, boat: true, gulls: true, fish: true, castle: true, umbrella: false })
  expect(has(await at(120))).toEqual({ sun: true, clouds: 2, boat: true, gulls: true, fish: true, castle: true, umbrella: true })
  // The scenery stands behind him: drawn before his walk, the sky before the sand.
  for (const name of ['sky', 'castle', 'boat']) expect([name, wide.indexOf(`class="${name}"`) < wide.indexOf('class="walk clawd"')]).toEqual([name, true])
  expect(wide.indexOf('class="sky"')).toBeLessThan(wide.indexOf('clipPath id="sand"'))
  // The fish swims behind the water, which hides it until it leaps, and glides with it as a tide comes
  // in or goes out, so it never lies on the sand a moment.
  expect(wide.indexOf('class="fishx"')).toBeLessThan(wide.indexOf('<clipPath id="water">'))
  expect(wide).toContain('<g class="glide"><g class="fishx">')
  // By night: a lantern at the boat's masthead and now and then a shooting star; no gulls.
  await clock.set(localAt(15, 23))
  const night = await at(100)
  expect([night.includes('class="lantern"'), night.includes('class="meteor"'), night.includes('class="gull')]).toEqual([true, true, false])
  // Still: the boat, the clouds and the castle stand where they are; nothing comes and goes.
  await clock.set(localAt(16, 13))
  await run($, 'band', 'still')
  const still = await at(100)
  expect([still.includes('@keyframes'), has(still).clouds, has(still).boat, has(still).castle, has(still).gulls, has(still).fish]).toEqual([false, 2, true, true, false, false])
})

// Before the first reading the sea is at its narrowest, with no room on it for the sailboat (its hull
// would run off the picture, its lantern into a star): it sails in with the first reading.
test('desktop: the sailboat sails in with the first reading, the sea before it too narrow for it', async ($, on) => {
  world(on, { now: localAt(15, 23) })
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  const { ui, look } = await band($, 'desktop')
  expect((await look()).svg?.source).not.toContain('class="boat"')
  await $.session.measure(measured(8, 0.1))
  expect((await look()).svg?.source).toContain('class="lantern"')
  await ui.unmount()
})

// The wider the beach, the further he strolls out on it: 10 units on the 64-unit beach, a unit more for
// every 4 a wider one adds.
test('desktop: on a wider beach he strolls further out on the sand', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  await turn($, clock)
  const farthest: number[] = []
  for (const columns of [60, 100, 160]) {
    const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns })
    const walk = /@keyframes walk\{([^@]*?)\}\}/u.exec((await look()).svg?.source ?? '')?.[1] ?? ''
    farthest.push(Math.max(...[...walk.matchAll(/translateX\((-?[\d.]+)px\)/gu)].map(m => Number(m[1]))))
    await ui.unmount()
  }
  expect(farthest).toEqual([10, 21, 50])
})

test('desktop: the clouds keep their places in the sky past where he strolls, swaying a little, so none ever crosses his head', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  await turn($, clock)
  for (const columns of [60, 100, 120, 160]) {
    const { ui, look } = await band($, 'desktop', { ...BAND, bodyColumns: columns })
    const source = (await look()).svg?.source ?? ''
    // His farthest right: where his loop starts, out as far as it walks him, and his 18 units.
    const start = Number(/<g transform="translate\(([\d.]+) 4\)"><g class="walk clawd">/u.exec(source)?.[1])
    const reach = Math.max(...[...(/@keyframes walk\{(.*?)\}\}/u.exec(source)?.[1] ?? '').matchAll(/translateX\(([\d.]+)px\)/gu)].map(([, x]) => Number(x)))
    const lefts = [...source.matchAll(/<g class="cloud cloud\d"><g fill="#[0-9A-F]{6}" transform="[^"]*"><rect x="([\d.]+)"/gu)].map(([, x]) => Number(x))
    expect(lefts.length).toBeGreaterThan(0)
    for (const left of lefts) expect([columns, left - 1.2 > start + reach + 18]).toEqual([columns, true])
    expect(source).toContain('@keyframes sway{0%,100%{transform:translateX(-1.2px)}50%{transform:translateX(1.2px)}}')
    await ui.unmount()
  }
})

test('desktop: his sandcastle grows a piece at a time with the conversation\'s answered turns, the new piece popping up in its cheer; /clear starts the next one from nothing', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13) })
  const keptScene = sceneWrites(on)
  await start($)
  const { ui, look } = await band($, 'desktop')
  const source = async () => (await look()).svg?.source ?? ''
  // A turn answered, and the frame of its cheer.
  const answer = async () => {
    await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't', reason: 'answer' })
    const cheer = await source()
    await clock.advance(10_000)
    return cheer
  }
  expect(await source()).not.toContain('class="castle"')
  const stages: number[] = []
  const built: boolean[] = []
  for (let turns = 1; turns <= 13; turns++) {
    const cheer = await answer()
    stages.push((await keptScene(clock))?.scene.castle ?? -1)
    built.push(cheer.includes('<g class="built">'))
  }
  // A mound, a tower, a wall and a second tower, a door, windows, a flag: at 1, 2, 3, 5, 8 and 13.
  expect(stages).toEqual([1, 2, 3, 3, 4, 4, 4, 5, 5, 5, 5, 5, 6])
  expect(built).toEqual([true, true, true, false, true, false, false, true, false, false, false, false, true])
  const flagged = await source()
  expect(flagged).toContain('<g class="flag">')
  // The settled frame after the cheer has the piece simply standing.
  expect(flagged).not.toContain('class="built"')
  // Asleep, the z's drifting up from him by the shell stay clear of the flag's pole and its pennant.
  await clock.advance(4 * 60_000)
  const napping = await source()
  const z = /<path class="z z2" d="M([\d.]+) [\d.]+h([\d.]+)/u.exec(napping)
  const pole = Number(/<g class="flag"><path d="M([\d.]+) /u.exec(napping)?.[1])
  expect(Number(z?.[1]) + Number(z?.[2]) + 0.6).toBeLessThan(pole)
  // /clear: the next conversation starts its own.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(1_000)
  expect(await source()).not.toContain('class="castle"')
  const first = await answer()
  expect([first.includes('class="castle"'), (await keptScene(clock))?.scene.castle]).toEqual([true, 1])
  await ui.unmount()
})

test('desktop: the cheer that builds a piece of the castle pops it up out of the sand as his arms go up, and a still cheer just shows it', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const lively = (await look()).svg?.source ?? ''
  // Grown from nothing at its foot, with a bounce, once, as the sparkles pop up; only where motion plays.
  expect(lively).toMatch(/@keyframes build\{0%\{transform:scale\(0\)\}55%\{transform:scale\(1\.18\)\}100%\{transform:scale\(1\)\}\}\.built\{animation:build \.5s ease-out [\d.]+s 1 both\}/u)
  expect(lively.slice(0, lively.indexOf('@media'))).toContain('.built{transform-box:fill-box;transform-origin:center bottom}')
  const delay = Number(/\.built\{animation:build \.5s ease-out ([\d.]+)s/u.exec(lively)?.[1])
  const sparkle = Number(/@keyframes star0\{0%,([\d.]+)%/u.exec(lively)?.[1]) / 100
  expect(Math.abs(delay - sparkle * 4.2)).toBeLessThan(0.05)
  await clock.advance(10_000)
  await run($, 'band', 'still')
  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'Done.', durationMs: 9_000, isAborted: false, turnId: 't2', reason: 'answer' })
  const still = (await look()).svg?.source ?? ''
  expect([still.includes('class="castle"'), still.includes('class="built"')]).toEqual([true, false])
  await ui.unmount()
})

test('desktop: the beach umbrella stands midway out on the sand past his stroll, and is packed away when the tide comes up to its shade', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  await turn($, clock)
  const props = { ...BAND, bodyColumns: 120 }
  const { ui, look } = await band($, 'desktop', props)
  const source = (await look()).svg?.source ?? ''
  expect([source.includes('class="umbrella"'), source.includes('class="towel"')]).toEqual([true, true])
  // Its shade and towel lie on the sand, under the castle and him; the umbrella stands before the sea.
  expect(source.indexOf('class="towel"')).toBeLessThan(source.indexOf('class="walk clawd"'))
  expect(source.indexOf('class="umbrella"')).toBeLessThan(source.indexOf('<clipPath id="water">'))
  // The tide coming up to it: packed away, towel and all.
  await $.session.measure(measured(70, 0.5))
  await turn($, clock)
  const high = (await look()).svg?.source ?? ''
  expect([high.includes('class="umbrella"'), high.includes('class="towel"')]).toEqual([false, false])
  await ui.unmount()
})

test('desktop: at sunrise and sunset the clouds blush peach underneath and the glints on the water turn gold', async ($, on) => {
  const { clock } = world(on, { now: localAt(15, 13) })
  await start($)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  const colors = (source: string) => ({
    under: /<g class="cloud cloud0"><g fill="(#[0-9A-F]{6})"/u.exec(source)?.[1],
    glints: [...source.matchAll(/<path class="glint glint\d" d="[^"]*" fill="(#[0-9A-F]{6})"\/>/gu)].map(([, fill]) => fill),
  })
  const noon = colors((await look()).svg?.source ?? '')
  await clock.set(localAt(15, 19, 45))
  const dusk = colors((await look()).svg?.source ?? '')
  expect([noon.under, noon.glints[0]]).toEqual(['#C3D0DB', '#FFFFFF'])
  expect([dusk.under !== noon.under, dusk.glints.length > 0 && dusk.glints.every(fill => fill !== '#FFFFFF')]).toEqual([true, true])
  await ui.unmount()
})

// The starfish in a terminal band: its column in the ground row, or -1.
function starfishOf(view: View): number {
  return cellsOf(view.rows[2]).findIndex(cell => cell.ch === '✶')
}

test('terminal: a compaction lets the tide out and leaves a starfish on the sand where the water stood; he looks over as it shows, and the tide coming back washes it away', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.9)
  await turn($, clock)
  const { ui, look, wait } = await band($, 'terminal')
  const high = seaStart(await look())
  expect(starfishOf(await look())).toBe(-1)
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY, SUMMARY] })
  await $.session.measure(measured(12, 1.95))
  // The water rolls out a cell a tick; the starfish shows on the sand it leaves, where it stood.
  let shown = -1
  let looked = false
  for (let i = 0; i < 16; i++) {
    await wait(250)
    await clock.advance(250)
    const view = await look()
    if (shown < 0 && starfishOf(view) >= 0) shown = i
    if (shown >= 0 && (view.scene[0] ?? '').includes(HEAD_RIGHT)) looked = true
  }
  const view = await look()
  const at = starfishOf(view)
  // Where the water's edge stood at 86% on the 32-cell beach: 32 - 8 cells of open sea - 86% of 9.
  expect([at, high - 1]).toEqual([16, 16])
  // Claude's sparkle in his clay, lying on the sand, which shows round it.
  expect(cellsOf(view.rows[2])[at]).toEqual({ ch: '✶', color: 'claude', bg: SAND })
  expect([shown >= 0, looked]).toEqual([true, true])
  // No grain crowds it.
  expect(cellsOf(view.rows[2]).slice(at - 1, at + 2).filter(cell => cell.ch === '▖')).toEqual([])
  // The context climbs back to where it was: the tide washes over it, and it is gone for good.
  await $.session.measure(measured(86, 2))
  for (let i = 0; i < 16; i++) {
    await wait(250)
    await clock.advance(250)
  }
  expect(starfishOf(await look())).toBe(-1)
  await $.session.measure(measured(40, 2.1))
  for (let i = 0; i < 16; i++) {
    await wait(250)
    await clock.advance(250)
  }
  expect(starfishOf(await look())).toBe(-1)
  await ui.unmount()
})

// His clay on the damp tan all but vanishes, so the starfish keeps its cell of sand dry, as he does,
// wherever the tide leaves it: in the damp strip by the water too.
for (const [columns, before, after] of [[80, 85, 30], [80, 86, 12], [64, 90, 25], [100, 86, 40], [140, 86, 30], [40, 90, 20], [50, 90, 20]] as const) {
  test(`terminal: at ${columns} columns, from ${before}% to ${after}%, the starfish lies on dry sand from the moment it shows`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($, before, 1.9)
    await turn($, clock)
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    await $.session.compact({ trigger: 'manual', messages: [SUMMARY, SUMMARY] })
    await $.session.measure(measured(after, 1.95))
    const seen: unknown[] = []
    for (let i = 0; i < 24; i++) {
      await wait(250)
      await clock.advance(250)
      const view = await look()
      const at = starfishOf(view)
      if (at >= 0) seen.push(cellsOf(view.rows[2])[at]?.bg)
    }
    expect(seen.length).toBeGreaterThan(0)
    expect([...new Set(seen)]).toEqual([SAND])
    await ui.unmount()
  })
}

// The tide coming back rolls in a cell a tick: the starfish lies on until the water reaches it, never
// leaving bare sand ahead of the water (however far the context jumps).
for (const [columns, back] of [[100, 90], [140, 92], [100, 87]] as const) {
  test(`terminal: at ${columns} columns, the tide coming back to ${back}% washes the starfish away only as the water reaches it`, { timeoutMs: 60_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($, 86, 1.9)
    await turn($, clock)
    const { ui, look, wait } = await band($, 'terminal', { ...BAND, bodyColumns: columns })
    await $.session.compact({ trigger: 'manual', messages: [SUMMARY, SUMMARY] })
    await $.session.measure(measured(12, 1.95))
    for (let i = 0; i < 24; i++) {
      await wait(250)
      await clock.advance(250)
    }
    const at = starfishOf(await look())
    expect(at).toBeGreaterThan(0)
    await $.session.measure(measured(back, 2))
    const bare: string[] = []
    for (let i = 0; i < 24; i++) {
      const view = await look()
      const cell = cellsOf(view.rows[2])[at]
      // Gone, its cell is the water's (the sea, or a wave washing up), never dry sand, unless he stands over it.
      const him = clawdAt(view)
      const isUnderHim = at >= Math.min(...him) - 1 && at <= Math.max(...him) + 1
      if (starfishOf(view) < 0 && cell?.bg === SAND && !isUnderHim) bare.push(`tick ${i}: ${view.scene[2]}`)
      await wait(250)
      await clock.advance(250)
    }
    expect(bare).toEqual([])
    expect(starfishOf(await look())).toBe(-1)
    await ui.unmount()
  })
}

// He looks over at a starfish as it shows, once whatever he was doing is done (a moment, here a pet,
// then his settle).
test('terminal: a starfish that shows during a pet gets his look once the pet and his settle are over', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.9)
  await turn($, clock)
  const { ui, look, wait } = await band($, 'terminal')
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY, SUMMARY] })
  await $.session.measure(measured(12, 1.95))
  await ui.pointer({ type: 'down', x: 8, y: 1, button: 'left', in: 'band' })
  let looked = -1
  for (let i = 0; i < 60 && looked < 0; i++) {
    await wait(250)
    await clock.advance(250)
    if (((await look()).scene[0] ?? '').includes(HEAD_RIGHT)) looked = i
  }
  expect(looked).toBeGreaterThan(0)
  await ui.unmount()
})


test('only a compaction of the conversation that went through leaves a starfish, where the water stood before it ran: not a precompute, a subagent\'s, or one a hook skipped; /clear takes it with the conversation', async ($, on) => {
  const { clock, during } = world(on)
  await start($, 86, 1.9)
  await turn($, clock)
  const { ui, look, wait } = await band($, 'terminal')
  const settle = async (percent: number) => {
    await $.session.measure(measured(percent, 1.95))
    for (let i = 0; i < 16; i++) {
      await wait(250)
      await clock.advance(250)
    }
  }
  await $.session.compact({ trigger: 'precompute', messages: [SUMMARY, SUMMARY] })
  await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: [SUMMARY, SUMMARY] })
  during.skipCompact = 'not now'
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY, SUMMARY] })
  during.skipCompact = null
  await settle(12)
  expect(starfishOf(await look())).toBe(-1)
  // The engine's own, at its threshold: it leaves one where the water stood before it ran, even when
  // a measure lands while it runs.
  await settle(86)
  during.compact = () => $.session.measure(measured(12, 1.95))
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY, SUMMARY] })
  during.compact = null
  await settle(12)
  expect(starfishOf(await look())).toBe(16)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await settle(12)
  expect(starfishOf(await look())).toBe(-1)
  await ui.unmount()
})

test('desktop: a compaction leaves a starfish on the sand at the tide\'s old edge, the alt says so, and the tide coming back washes it away', async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.9)
  await turn($, clock)
  const { ui, look } = await band($, 'desktop')
  expect((await look()).svg?.source).not.toContain('class="starfish"')
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY, SUMMARY] })
  await $.session.measure(measured(12, 1.95))
  await clock.advance(1_000)
  const left = (await look()).svg
  expect(left?.source).toContain('class="starfish"')
  expect(left?.alt).toContain('The tide is out. A starfish lies where the tide was.')
  // It lies in the sand, before the sea and him: the water washes over it, and he walks in front of it.
  const source = left?.source ?? ''
  expect(source.indexOf('class="starfish"')).toBeLessThan(source.indexOf('clip-path="url(#water)"'))
  // Over the damp sand by the water, never under it, where his clay would wash out.
  expect(source.indexOf('fill="url(#damp)"')).toBeLessThan(source.indexOf('class="starfish"'))
  expect(source.indexOf('class="starfish"')).toBeLessThan(source.indexOf('class="walk clawd"'))
  await $.session.measure(measured(90, 2))
  await clock.advance(1_000)
  const back = (await look()).svg
  expect(back?.source).not.toContain('class="starfish"')
  expect(back?.alt).not.toContain('starfish')
  // Washed away for good: the tide going out again (a model with a wider window) never brings it back.
  await $.session.measure(measured(40, 2.1))
  await clock.advance(1_000)
  expect((await look()).svg?.source).not.toContain('class="starfish"')
  await ui.unmount()
})

test('desktop: a measure just before the turn ends draws one new frame, the cheer, and never a stride first', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const { ui, look } = await band($, 'desktop')
  await $.prompt.submit({ text: 'read it', wait: false, origin: { kind: 'composer' } })
  await ui.redraw({ ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Read', file_path: '/w/a.ts' })
  await clock.advance(3_000)
  const source = async () => (await look()).svg?.source ?? ''
  const working = await source()
  const seen = [working]
  // The tide comes in a step (42% to 48%) a tenth of a second before the answer lands.
  await $.session.measure(measured(48, 0.4))
  await clock.advance(100)
  seen.push(await source())
  await $.turn.complete({ answer: 'Done.', durationMs: 3_200, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw(BAND)
  for (let i = 0; i < 30; i++) {
    seen.push(await source())
    await clock.advance(50)
  }
  expect(new Set(seen).size).toBe(2)
  expect(seen[1]).toBe(working)
  expect((await look()).svg?.alt).toContain('spins with joy')
  expect(seen.at(-1)).toMatch(/data-tide="50"/u)
  await ui.unmount()
})

for (const isSwitched of [false, true]) {
  test(`terminal: a new reading shows on the next tick, after a redraw that changed nothing${isSwitched ? ', on a look /band switched back to' : ''}`, async ($, on) => {
    const { clock } = world(on)
    await start($)
    if (isSwitched) {
      for (const args of ['hearth', 'tide']) {
        await $.command.run({ command: 'band', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
      }
    }
    const { ui, look, wait } = await band($, 'terminal')
    await wait(3_000)
    await clock.advance(5_000)
    // The time this look has been on ticks on with every redraw: nothing the beach shows.
    await ui.redraw(BAND)
    await wait(250)
    await $.session.measure(measured(48, 0.4))
    await wait(250)
    expect((await look()).words[1]).toMatch(/^48% context/u)
    await ui.unmount()
  })
}

test('terminal: in a long turn of reads, a glance at the words comes at most once in ten seconds', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, release } = world(on)
  await start($)
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, isWorking: true })
  const starts: number[] = []
  let tick = 0
  let wasGlancing = false
  const step = async () => {
    await wait(250)
    await clock.advance(250)
    tick += 1
    const isGlancing = (await look()).scene[0]?.includes(HEAD_RIGHT) === true
    if (isGlancing && !wasGlancing) starts.push(tick)
    wasGlancing = isGlancing
  }
  // Ten reads of a second each, a second apart: twenty seconds of starting to read again and again.
  for (let i = 0; i < 10; i++) {
    const reading = $.tool.call({ tool: 'Read', file_path: `/work/held-${i}.ts` }).catch(() => undefined)
    await clock.settle()
    for (let k = 0; k < 4; k++) await step()
    release()
    await reading
    for (let k = 0; k < 4; k++) await step()
  }
  expect(starts.length).toBeGreaterThanOrEqual(2)
  starts.forEach((at, i) => {
    if (i > 0) expect(at - (starts[i - 1] ?? at)).toBeGreaterThanOrEqual(40)
  })
  await ui.unmount()
})

test('before the first reading the beach says so in whole words, down to "No reading", and shows no "$0.00" before any spend', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  let alt = ''
  const said = async (surface: Surface, columns: number) => {
    const { ui, look } = await band($, surface, { ...BAND, bodyColumns: columns })
    const view = await look()
    alt = view.svg?.alt ?? ''
    await ui.unmount()
    return view.words
  }
  for (const [columns, line] of [[100, 'No context reading yet'], [64, 'No context reading yet'], [36, 'No reading yet'], [35, 'No reading'], [34, 'No reading']] as const) {
    expect([columns, (await said('terminal', columns))[1]]).toEqual([columns, line])
  }
  expect((await said('desktop', 100))[1]).toBe('No context reading yet')
  // The page reads out what the words say, not a tide it does not know.
  expect(alt.endsWith(`. No context reading yet.${starsSaid(clock.now())}`)).toBe(true)
  expect(alt).not.toContain('tide')
  expect((await said('desktop', 34))[1]).toMatch(/^No reading( yet)?$/u)
  // The first reading, before a cent is spent: no cost at all, rather than "$0.00".
  await $.session.measure(measured(42, 0))
  for (const surface of SURFACES) {
    const words = await said(surface, 100)
    expect([surface, words[1]]).toEqual([surface, expect.stringMatching(/^42% context/u)])
    expect([surface, words.join(' ').includes('$')]).toEqual([surface, false])
    if (surface === 'desktop') expect(alt.endsWith(`. The tide is partway in.${starsSaid(clock.now())}`)).toBe(true)
  }
})

test('a web search keeps its query in the middle widths, in whole words down to "Searching for ink…", before a bare "Searching"', async ($, on) => {
  const { clock, during } = world(on)
  await start($)
  await $.prompt.submit({ text: 'look it up', wait: false, origin: { kind: 'composer' } })
  // The search runs until the test lets it go.
  let release: () => void = () => undefined
  const done = new Promise<void>(resolve => {
    release = resolve
  })
  during.tool = () => done
  const searching = $.tool.call({ tool: 'WebSearch', query: 'ink terminal hyperlinks', mode: 'standard' }).catch(() => undefined)
  await clock.settle()
  await clock.advance(1_500)
  const lines = new Map<string, string>()
  for (const surface of SURFACES) {
    for (const columns of [100, 60, 52, 44, 40]) {
      const { ui, look, wait } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
      await wait(1_500)
      lines.set(`${surface} ${columns}`, (await look()).words[0] ?? '')
      await ui.unmount()
    }
  }
  for (const surface of SURFACES) {
    expect(lines.get(`${surface} 100`)).toBe('Searching the web for ink terminal hyperlinks')
    expect(lines.get(`${surface} 52`)).toMatch(/^Searching for ink( terminal)?…$/u)
  }
  expect(lines.get('terminal 44')).toBe('Searching for ink…')
  expect(lines.get('terminal 40')).toBe('Searching')
  // Never a cut "Searching the w…", nor a query cut mid-word: the long verb goes whole or not at
  // all, and the query keeps whole words.
  for (const [where, line] of lines) {
    expect([where, line]).toEqual([where, expect.stringMatching(/^Searching( the web for ink terminal hyperlinks| for ink terminal hyperlinks| for ink terminal…| for ink…)?$/u)])
  }
  release()
  await searching
})

test('a subagent and a raw command read as words on the beach: "Delegating: Explore the hooks folder", cut only after a whole word', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, during } = world(on)
  await start($)
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  const cases = [
    { call: () => $.tool.call({ tool: 'Agent', description: 'Explore the hooks folder', prompt: 'x', subagent_type: 'Explore' }), lead: 'Delegating: ', said: 'Explore the hooks folder', alone: 'Delegating' },
    { call: () => $.tool.call({ tool: 'Bash', command: 'git log --oneline --graph --decorate' }), lead: 'Running ', said: 'git log --oneline --graph --decorate', alone: 'Running' },
  ]
  for (const one of cases) {
    let release: () => void = () => undefined
    const done = new Promise<void>(resolve => {
      release = resolve
    })
    during.tool = () => done
    const running = one.call().catch(() => undefined)
    await clock.settle()
    await clock.advance(1_500)
    for (const surface of SURFACES) {
      for (const columns of [34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 64, 70, 80, 100, 140]) {
        const { ui, look, wait } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await wait(1_500)
        const line = (await look()).words[0] ?? ''
        // Whole; or cut right after a whole word, while seven characters of it show; or the verb alone.
        // Never "Delegating Explore…" (two orders run together) nor "Delegating: Explore t…".
        const shown = line.replace(/…$/u, '')
        const kept = shown.slice(one.lead.length)
        const isCut = line.endsWith('…') && shown.startsWith(one.lead) && one.said.startsWith(kept) && /^\s/u.test(one.said.slice(kept.length)) && [...kept].length >= 7
        expect([surface, columns, line, line === one.lead + one.said || line === one.alone || isCut]).toEqual([surface, columns, line, true])
        if (columns === 140) expect([surface, line]).toEqual([surface, one.lead + one.said])
        await ui.unmount()
      }
    }
    during.tool = null
    release()
    await running
  }
})

test('a raw command with no space early on shows a part of itself, cut after a part of its path, never inside a word nor on a shell joint', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, during } = world(on)
  await start($)
  await $.prompt.submit({ text: 'test it', wait: false, origin: { kind: 'composer' } })
  for (const command of ['node_modules/.bin/vitest-run-everything-without-spaces --watch', 'cd /Users/robin/projects/agent-plugins && npm test']) {
    let release: () => void = () => undefined
    during.tool = () => new Promise<void>(resolve => {
      release = resolve
    })
    const running = $.tool.call({ tool: 'Bash', command }).catch(() => undefined)
    await clock.settle()
    await clock.advance(1_500)
    for (const surface of SURFACES) {
      for (const columns of [34, 40, 46, 50, 56, 64, 80, 100, 140]) {
        const { ui, look, wait } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await wait(1_500)
        const line = (await look()).words[0] ?? ''
        // Something of it from 56 columns: never the bare verb, as when only a whole first word would do.
        if (columns >= 56) expect([surface, columns, line]).toEqual([surface, columns, expect.stringMatching(/^Running ./u)])
        if (line.endsWith('…')) {
          const shown = line.replace(/^Running /u, '').replace(/…$/u, '')
          const isPart = command.startsWith(shown) && /^[\s/._-]/u.test(command.slice(shown.length)) && [...shown].length >= 7 && !/(&&|\|)$/u.test(shown)
          expect([surface, columns, line, isPart]).toEqual([surface, columns, line, true])
        }
        await ui.unmount()
      }
    }
    during.tool = null
    release()
    await running
  }
})

test('a raw command that fails is quoted as the Running line cuts it: never ending on a shell joint, never jumping from the whole path to no quote at all', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'test it', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'cd /Users/robin/projects/agent-plugins && npm test -- fail' })
  const joint = /(?:&&|\|\||\||;|&)\s*…/u
  const widths = [34, 40, 46, 50, 56, 64, 72, 80, 88, 92, 98, 100, 120, 140]
  // During the splash, and once it is over (the dim line that says what failed).
  for (const when of ['splash', 'after'] as const) {
    for (const surface of SURFACES) {
      for (const columns of widths) {
        const { ui, look } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        const line = (await look()).words[0] ?? ''
        expect([when, surface, columns, line, joint.test(line)]).toEqual([when, surface, columns, line, false])
        if (when === 'splash') expect([surface, columns, line]).toEqual([surface, columns, expect.stringMatching(/^Splash!/u)])
        // Where a quote has room, it shows something of the command, as the Running line does.
        if (columns >= 64) expect([when, surface, columns, line]).toEqual([when, surface, columns, expect.stringMatching(/cd \/Users\/robin/u)])
        await ui.unmount()
      }
    }
    await clock.advance(3_500)
  }
})

// A quote of a verb and a name ("Read a-file…") keeps its verb with the name, as the Running line
// does; it never quotes the verb alone ('"Read…" failed' says nothing of what was read).
const FAILED_NAMES = [
  { call: { tool: 'Read', file_path: '/work/notes/a-file-that-will-never-load.ts' }, verb: 'Read', name: 'a-file-that-will-never-load.ts' },
  { call: { tool: 'Edit', file_path: '/work/hooks/register.tsx', old_string: 'a', new_string: 'b' }, verb: 'Edit', name: 'register.tsx' },
  // A page fetched is quoted with its working line's verb ("Reading docs…", '"Read docs…" failed').
  { call: { tool: 'WebFetch', url: 'https://docs.anthropic.com/en/docs', prompt: 'read it' }, verb: 'Read', name: 'docs.anthropic.com' },
] as const

test('a failed Read, Edit or WebFetch is quoted as its verb and as much of its name as fits, never its verb alone, during the splash and after it', { timeoutMs: 240_000 }, async ($, on) => {
  const { clock } = world(on, { tools: false })
  on('tool.call', async () => ({ result: { stdout: '', stderr: 'boom' }, isError: true, text: 'boom' }))
  await start($)
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  for (const { call, verb, name } of FAILED_NAMES) {
    await $.tool.call(call as never)
    const at80: string[] = []
    for (const when of ['splash', 'after'] as const) {
      for (const surface of SURFACES) {
        for (let columns = 34; columns <= 160; columns += 2) {
          const { ui, look } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
          const line = (await look()).words[0] ?? ''
          const quote = /[“"]([^”"]*)[”"]/u.exec(line)?.[1]
          // A quote holds the verb and a name after it: whole, or cut to seven characters at least.
          if (quote !== undefined) {
            const shown = quote.slice(verb.length + 1).replace(/…$/u, '')
            expect([verb, when, surface, columns, line, quote.startsWith(`${verb} `) && name.startsWith(shown) && (shown === name || [...shown].length >= 7)]).toEqual([verb, when, surface, columns, line, true])
          }
          expect([verb, when, surface, columns, line]).toEqual([verb, when, surface, columns, when === 'splash' ? expect.stringMatching(/^Splash!(?:.* failed)?$/u) : expect.stringMatching(/(?:failed|Failed)$/u)])
          if (surface === 'terminal' && columns === 80) at80.push(line)
          await ui.unmount()
        }
      }
      await clock.advance(3_500)
    }
    // At 80 columns the terminal names what failed, the name whole or in part.
    for (const line of at80) expect([verb, line]).toEqual([verb, expect.stringContaining(`"${verb} ${[...name].slice(0, 7).join('')}`)])
    await $.prompt.submit({ text: 'and the next', wait: false, origin: { kind: 'composer' } })
  }
})

test('a cut of words a person wrote never ends on a little word ("the", "at", "why"): one that would ("Run the…") gives way to a shorter form', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, during } = world(on)
  await start($)
  await $.prompt.submit({ text: 'test it', wait: false, origin: { kind: 'composer' } })
  const said = 'Investigate why the desktop band reloads twice at startup'
  let release: () => void = () => undefined
  during.tool = () => new Promise<void>(resolve => {
    release = resolve
  })
  const running = $.tool.call({ tool: 'Bash', command: 'npm test', description: said }).catch(() => undefined)
  await clock.settle()
  await clock.advance(1_500)
  const little = /\s(?:a|an|and|at|by|for|from|in|into|of|on|or|the|to|why|with)$/iu
  const seen = new Set<string>()
  for (const surface of SURFACES) {
    for (let columns = 34; columns <= 110; columns += 2) {
      const { ui, look, wait } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
      await wait(1_500)
      const line = (await look()).words[0] ?? ''
      seen.add(line)
      if (line.endsWith('…')) expect([surface, columns, line, little.test(line.replace(/…$/u, ''))]).toEqual([surface, columns, line, false])
      await ui.unmount()
    }
  }
  // Where "…why the…" or "…twice at…" would fit, the line ends a whole word earlier.
  expect([...seen]).toEqual(expect.arrayContaining(['Investigate…', 'Investigate why the desktop band reloads twice…', said]))
  during.tool = null
  release()
  await running
})

// The finer cuts, across every width: a task may stop after its first real word ("Survey…", never
// the stub "Survey the…"); a name never stops inside its extension ("register.t…"); a command never
// stops on a one-letter flag whose argument is gone ("--noEmit -p…").
const FINE_CUTS = [
  { call: { tool: 'Agent', prompt: 'look', subagent_type: 'Explore', description: 'Survey the hooks folder' }, never: /Survey the…$/u, seen: 'Delegating: Survey…' },
  // Nor a letter or two short of its stem ("registe…" reads as a typo).
  { call: { tool: 'Read', file_path: '/work/hooks/register.tsx' }, never: /(?:register\.[a-z]{0,2}|registe|regist)…$/u, seen: 'Reading register…' },
  // Too short before its dot to keep seven characters there: whole, or not at all.
  { call: { tool: 'Read', file_path: '/work/public/site.webmanifest' }, never: /site(?:\.[a-z]*)?…$/u, seen: 'Reading site.webmanifest' },
  { call: { tool: 'WebFetch', url: 'https://docs.anthropic.com/en/docs', prompt: 'read it' }, never: /docs\.anthropic\.[a-z]{0,2}…$/u, seen: 'Reading docs.anthropic…' },
  { call: { tool: 'NotebookRead', notebook_path: '/work/notes/analysis.ipynb' }, never: /(?:analysis\.[a-z]{0,4}|analysi|analys)…$/u, seen: 'Reading analysis…' },
  { call: { tool: 'Grep', pattern: 'useEffect' }, never: /useEff?e?…$/u, seen: 'Searching for useEffect' },
  // A test's double extension is one: never half of it ("…name.test…").
  { call: { tool: 'Read', file_path: '/work/hooks/an-extraordinarily-long-component-name.test.tsx' }, never: /\.(?:t|te|tes|test)(?:\.[a-z]*)?…$/u, seen: 'Reading an-extraordinarily-long-component-name…' },
  // A described command never stops on a little word ("Run the…"): whole, or a shorter form.
  { call: { tool: 'Bash', command: 'npm test', description: 'Run the tests' }, never: /Run the…$/u, seen: 'Run the tests' },
  { call: { tool: 'Bash', command: 'npx tsc --noEmit -p tsconfig.build.json' }, never: /\s-\p{L}…$/u, seen: 'Running npx tsc --noEmit…' },
] as const

test('the finer cuts: a task may stop after its first real word, a name never inside its extension, a command never on a flag that lost its argument', { timeoutMs: 240_000 }, async ($, on) => {
  const { clock, during } = world(on)
  await start($)
  await $.prompt.submit({ text: 'test it', wait: false, origin: { kind: 'composer' } })
  for (const { call, never, seen } of FINE_CUTS) {
    let release: () => void = () => undefined
    during.tool = () => new Promise<void>(resolve => {
      release = resolve
    })
    const running = $.tool.call(call as never).catch(() => undefined)
    await clock.settle()
    await clock.advance(1_500)
    for (const surface of SURFACES) {
      const lines = new Set<string>()
      for (let columns = 34; columns <= 140; columns += 2) {
        const { ui, look, wait } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        await wait(1_500)
        const line = (await look()).words[0] ?? ''
        lines.add(line)
        expect([call.tool, surface, columns, line, never.test(line)]).toEqual([call.tool, surface, columns, line, false])
        await ui.unmount()
      }
      expect([call.tool, surface, lines.has(seen)]).toEqual([call.tool, surface, true])
    }
    during.tool = null
    release()
    await running
  }
})

// A splash narrows one step at a time: the quote, a word for what failed (where there is one: "A
// subagent", "A command", "A skill", "A web search", "A file read"; else "A tool"), then the verdict
// alone. A web search is quoted one way, as its Running line comes to say it ('"Search for
// ink…"'): never ending on "web" or "for", and never '"Search the web for…"' too. A skill's quote
// keeps "skill" after its cut name. A tool whose words are a set phrase is no order to quote: the
// phrase says it.
const SPLASHED = [
  { call: { tool: 'Agent', prompt: 'look', subagent_type: 'Explore', description: 'Survey the hooks folder' }, noun: 'A subagent', quote: /^Splash! "Survey the hooks folder" failed$/u },
  { call: { tool: 'Bash', command: 'npm test', description: 'Run the whole test suite' }, noun: 'A command', quote: /^Splash! "Run the whole(?: test)?…" failed$/u },
  { call: { tool: 'WebSearch', query: 'ink terminal renderer bold dim' }, noun: 'A web search', quote: /^Splash! "Search for ink(?: terminal(?: renderer(?: bold(?: dim)?)?)?)?…?" failed$/u },
  { call: { tool: 'Read', file_path: '/work/hooks/register.tsx' }, noun: 'A file read', quote: /^Splash! "Read register(?:\.tsx|…)" failed$/u },
  { call: { tool: 'Skill', skill: 'plugin-authoring' }, noun: 'A skill', quote: /^Splash! "Use the plugin-\S*?…? skill" failed$/u },
  { call: { tool: 'ToolSearch', query: 'select:Read' }, noun: 'Finding tools', quote: null },
  { call: { tool: 'BashOutput', bash_id: 'b1' }, noun: 'Checking on a command', quote: null },
] as const

test('a splash narrows one step at a time: the quote, a word for what failed, then "Splash!" alone, during the splash and after it', { timeoutMs: 240_000 }, async ($, on) => {
  const { clock } = world(on, { tools: false })
  on('tool.call', async () => ({ result: { stdout: '', stderr: 'boom' }, isError: true, text: 'boom' }))
  await start($)
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  for (const { call, noun, quote } of SPLASHED) {
    await $.tool.call(call as never)
    for (const when of ['splash', 'after'] as const) {
      for (const surface of SURFACES) {
        const seen: string[] = []
        for (let columns = 34; columns <= 160; columns += 2) {
          const { ui, look } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
          const line = ((await look()).words[0] ?? '').replace(/[“”]/gu, '"')
          if (seen.at(-1) !== line) seen.push(line)
          // Never a quote that ends on a little word or on "web" ("Search the web…"), or says "the web".
          expect([call.tool, when, surface, columns, line, /(?:\bweb|\bfor|\bthe)…|"Search the web/u.test(line)]).toEqual([call.tool, when, surface, columns, line, false])
          await ui.unmount()
        }
        const words = seen.map(line => (when === 'after' ? `Splash! ${line.replace(/^Failed$/u, '')}`.trim() : line))
        // Narrow to wide: the verdict alone, "A tool failed", "A command failed" under a command's
        // own phrase, the word for what failed, then quotes only.
        const nouns = [...new Set([noun, ...(noun === 'A command' || noun === 'Checking on a command' ? ['A command'] : []), 'A tool'])]
        const steps = ['Splash!', ...[...nouns].reverse().map(one => `Splash! ${one} failed`)]
        const plain = words.filter(line => !line.includes('"'))
        // Each a step of the ladder, in its order (two rungs a cell apart may fall between two widths
        // two columns apart), up to the word for what failed; the terminal's narrowest has the verdict
        // alone, and a desktop's narrowest beach may still have room for more.
        expect([call.tool, when, surface, plain]).toEqual([call.tool, when, surface, steps.filter(step => plain.includes(step))])
        expect([call.tool, when, surface, plain.at(-1), surface === 'desktop' || plain[0] === 'Splash!']).toEqual([call.tool, when, surface, `Splash! ${noun} failed`, true])
        if (quote === null) {
          expect([call.tool, when, surface, words.length]).toEqual([call.tool, when, surface, plain.length])
        } else {
          expect([call.tool, when, surface, words.slice(plain.length).every(line => quote.test(line) || /^Splash! "[^"]+" failed$/u.test(line))]).toEqual([call.tool, when, surface, true])
          expect([call.tool, when, surface, words.some(line => quote.test(line))]).toEqual([call.tool, when, surface, true])
        }
      }
      await clock.advance(3_500)
    }
    await $.prompt.submit({ text: 'and the next', wait: false, origin: { kind: 'composer' } })
  }
})

test('a subagent sent with no task in words that fails reads "Splash! A subagent failed": a stand-in is never quoted as an order', async ($, on) => {
  const { clock } = world(on, { tools: false })
  on('tool.call', async ($, e) => (e.tool === 'Agent' ? { result: { stdout: '', stderr: 'boom' }, isError: true, text: 'boom' } : { result: { ok: true } }))
  await start($)
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Agent', prompt: 'look', subagent_type: 'Explore' } as never)
  await wait(250)
  expect((await look()).words[0]).toBe('Splash! A subagent failed')
  await wait(3_500)
  await clock.advance(3_500)
  expect((await look()).words[0]).toBe('A subagent failed')
  await ui.unmount()
})

test('terminal: once the splash is over the line says what failed, down to "Failed" on the narrowest band', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.prompt.submit({ text: 'run it', wait: false, origin: { kind: 'composer' } })
  const { ui, look, wait } = await band($, 'terminal', { ...BAND, isWorking: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  await wait(3_500)
  await clock.advance(3_500)
  const said: string[] = []
  for (const columns of [100, 56, 46, 40, 34]) {
    await ui.resize({ columns, rows: 3, in: 'band' })
    said.push((await look()).words[0] ?? '')
  }
  expect(said[0]).toBe('"Run the tests" failed')
  expect(said.at(-1)).toBe('Failed')
  // A word for what failed ("A command failed"), then "A tool failed", which any failure is, and
  // "Failed" alone only where that has no room (twelve cells of words at 34 columns).
  for (const line of said) expect(line).toMatch(/(?:^"[^"]+" failed|^A command failed|^A tool failed|^Failed)$/u)
  await ui.unmount()
})
