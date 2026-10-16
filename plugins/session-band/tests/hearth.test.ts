import { expect, mock, test as kitTest } from 'claude-code/testing'
import type { Engine, TestBody, TestOptions } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf, SessionMeasureInput, TurnCompleteInput } from 'claude-code'

import Band from '../hooks/hearth/band'
import { SPIN, cells, cut, textPx } from '../hooks/clawd'
import { panelMost } from '../hooks/hearth/words'
import { NAP_AFTER_MS, NAP_LATE_MS, clockText } from '../hooks/facts'
import type { BandProps } from '../hooks/hearth/types'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

// Every test here draws the hearth: the look /config holds for them (the tide is the default).
function test(name: string, ...rest: [TestBody] | [TestOptions, TestBody]): void {
  const [given, body] = rest.length === 1 ? [{}, rest[0]] : rest
  kitTest(name, { ...given, options: { look: 'hearth', ...given.options } }, body)
}

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const T0 = 1_000_000

// The terminal band's layout: a margin, Clawd (9 cells), his marks (4) and a gap before the words.
const LEFT = 15

// The engine beneath the plugin: a session in agent-plugins on branch main with two changed files.
type WorldOptions = {
  env?: Record<string, string>
  /** Read each time the band asks, so a test can change a setting mid-session. */
  settings?: Record<string, unknown>
  /** Runs as a tool is called, while the band shows it at work. */
  onCall?: (tool: string) => Promise<void>
  branch?: string
}

function world(on: On, options: WorldOptions = {}) {
  const toasts: string[] = []
  mock.store(on)
  mock.env(on, options.env ?? {})
  const clock = mock.clock(on, { now: T0 })
  let created = 0
  let held: string | null = null
  let waiting: Array<() => void> = []
  on('settings.read', () => ({ value: options.settings ?? {} }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: T0 - 12 * 60_000, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.repo', () => ({ value: { root: '/work/agent-plugins', remote: null, internal: false, name: null } }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('rev-parse') ? `${options.branch ?? 'main'}\n` : ' M README.md\n?? notes.md\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', async ($, e) => {
    if (held !== null && e.tool === held) {
      await new Promise<void>(resolve => waiting.push(resolve))
    }
    await options.onCall?.(String(e.tool))
    if (e.tool === 'Bash' && String(e.command).includes('fail')) {
      return { result: { stdout: '', stderr: 'boom' }, isError: true, text: 'boom' }
    }

    return e.tool === 'TaskCreate'
      ? { result: { task: { id: String((created += 1)), subject: String(e.subject) } } }
      : { result: { ok: true } }
  })

  return {
    toasts,
    clock,
    /** Tools of this name wait, mid-call, until `release`. */
    hold: (tool: string) => {
      held = tool
    },
    release: () => {
      held = null
      const all = waiting
      waiting = []
      for (const resolve of all) resolve()
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

async function start($: Engine, percent = 42, usd = 0.31, five = 23): Promise<void> {
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  await $.session.measure(measured(percent, usd, five))
}

type Ending = Pick<TurnCompleteInput, 'reason' | 'isAborted'> & Partial<TurnCompleteInput>
const ANSWERED: Ending = { reason: 'answer', isAborted: false }

async function prompt($: Engine, text = 'tidy up'): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function turn($: Engine, ending: Ending = ANSWERED): Promise<void> {
  await prompt($)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', ...ending } as TurnCompleteInput)
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function text(node: unknown): string {
  return typeof node === 'string' ? node : ((node as Node).children ?? []).map(text).join('')
}

function kids(node: unknown): Node[] {
  return ((node as Node).children ?? []).filter((child): child is Node => typeof child === 'object' && child !== null)
}

function walk(node: unknown, visit: (node: Node) => void): void {
  if (typeof node === 'object' && node !== null) {
    visit(node as Node)
    for (const child of kids(node)) walk(child, visit)
  }
}

// The band as rows of text. Terminal: Clawd's row, his marks and that row's words, side by
// side (the module draws three columns). Desktop: the three lines beside the Svg.
// `lines` keeps each line's left and right words apart, and its tree.
// `squeeze` is the part of a line Ink may cut at its end when room runs short (the branch).
type Words = { left: string; squeeze: string; right: string; node: Node }
type Read = { rows: string[]; clawd: string[]; marks: string[]; words: string[]; lines: Words[]; panel: number; tree: RenderElement }

async function band($: Engine, surface: Surface, props = BAND) {
  const ui = await $.ui.mount({ plugin: 'session-band', surface, component: 'AbovePrompt', props })
  if (surface === 'terminal') {
    await ui.resize({ columns: props.bodyColumns, rows: 3, in: 'hearth' })
  }

  const read = async (): Promise<Read> => {
    if (surface === 'terminal') {
      const tree = await ui.drawn({ in: 'hearth' })
      const [sprite, marks, panel] = kids(tree)
      const clawd = kids(sprite).map(text)
      const marked = kids(marks).map(row => text(row).trimEnd())
      const lines = kids(panel).map(line => {
        const [left, right] = kids(line)
        const squeeze = kids(left).find(part => part.type === 'Box' && part.props?.flexShrink === 1)
        return { left: text(left), squeeze: squeeze === undefined ? '' : text(squeeze), right: right === undefined ? '' : text(right), node: line }
      })
      const words = lines.map(line => (line.right === '' ? line.left : `${line.left}  ${line.right}`))
      const rows = clawd.map((row, i) => `${row.padEnd(9)}${(marked[i] ?? '').padEnd(4)} ${words[i] ?? ''}`)

      return { rows, clawd, marks: marked, words, lines, panel: Number(panel?.props?.width ?? 0), tree }
    }
    const tree = await ui.drawn()
    const [, info] = kids(tree)
    const lines = kids(info).map(line => {
      const [left, right] = kids(line)
      return { left: text(left), squeeze: '', right: right === undefined ? '' : text(right), node: line }
    })
    const words = lines.map(line => (line.right === '' ? line.left : `${line.left}  ${line.right}`))

    return { rows: words, clawd: [], marks: [], words, lines, panel: 0, tree }
  }

  return { ui, read }
}

// The words' panel at a band width: what the module draws (asserted against the tree elsewhere).
function panel(columns: number): number {
  return Math.min(columns - 2 - LEFT, 80, 68 + Math.max(0, Math.floor((columns - 100) / 4)))
}

// A line's words fit its panel as composed, measured in terminal cells: all but the
// squeezed part (a branch, a file name, a todo), which keeps a cell at least and is never a figure.
function expectFits(line: Words, room: number): void {
  const fixed = cells(line.left) - cells(line.squeeze) + (line.right === '' ? 0 : 2 + cells(line.right))
  expect(fixed).toBeLessThanOrEqual(room)
  if (line.squeeze !== '') {
    expect(room - fixed).toBeGreaterThanOrEqual(1)
    expect(line.squeeze).not.toMatch(/\d%|\$\d/)
  }
}

// The text a line draws, leaf by leaf, with whether each is bold or dim.
type Leaf = { text: string; isBold: boolean; isDim: boolean }

function leaves(node: Node): Leaf[] {
  const out: Leaf[] = []
  walk(node, one => {
    const children = one.children ?? []
    if (one.type === 'Text' && children.length > 0 && children.every(child => typeof child === 'string')) {
      const color = one.props?.color
      out.push({
        text: children.join(''),
        isBold: one.props?.bold === true,
        isDim: one.props?.dimColor === true || color === 'inactive' || color === 'subtle',
      })
    }
  })

  return out.filter(leaf => leaf.text !== '')
}

// Bold never sits right beside dim (they share the terminal's reset, SGR 22): a plain leaf always comes between.
function expectBoldApartFromDim(row: Leaf[]): void {
  for (let i = 1; i < row.length; i++) {
    const [a, b] = [row[i - 1], row[i]]
    expect(Boolean((a?.isBold && b?.isDim) || (a?.isDim && b?.isBold))).toBe(false)
  }
}

// Clawd's own picture (not the hover heart over him, nor the meter's).
function isClawd(node: Node): boolean {
  return node.type === 'Svg' && String(node.props?.source).includes('class="hh-hop"')
}

// The heart the band lays over him when a pointer rests on him: the picture in the Box its hover moves.
function heartOf(tree: unknown): string {
  let found = ''
  walk(tree, node => {
    const svg = node.type === 'Box' && (node as { hover?: unknown }).hover !== undefined ? node.children?.[0] : undefined
    if (svg !== undefined && (svg as Node).type === 'Svg') found = String((svg as Node).props?.source)
  })

  return found
}

function svgOf(tree: unknown): { source: string; alt: string } | undefined {
  let found: { source: string; alt: string } | undefined
  walk(tree, node => {
    if (isClawd(node)) {
      found = { source: String(node.props?.source), alt: String(node.props?.alt) }
    }
  })

  return found
}

// The desktop's layout, as the band budgets it: text at its pixel width (bold
// wider), an Svg at its own, a Box its children side by side (or the widest, in a
// column) with its gaps and margins, never under its minWidth. A cell is 7.6 px,
// a little under the 7.8 measured in a desktop preview.
const DESK_CELL = 7.6

function deskWidth(node: unknown, isBold = false): number {
  if (typeof node === 'string') return textPx(node, isBold)
  if (typeof node !== 'object' || node === null) return 0
  const { type, props = {}, children = [] } = node as Node
  if (type === 'Text') return children.reduce((sum: number, child) => sum + deskWidth(child, isBold || props.bold === true), 0)
  if (type === 'Svg') return Number(props.width)
  const widths = children.filter(child => typeof child === 'object' && child !== null).map(child => deskWidth(child))
  const isColumn = props.flexDirection === 'column'
  let width = isColumn ? Math.max(0, ...widths) : widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * Number(props.gap ?? 0) * DESK_CELL
  if (typeof props.minWidth === 'number') width = Math.max(width, props.minWidth * DESK_CELL)
  if (typeof props.width === 'number') width = props.width * DESK_CELL

  return width + (Number(props.marginLeft ?? 0) + Number(props.marginRight ?? 0)) * DESK_CELL
}

/** A figure: a percentage, a cost, the model, a todo tally. */
const FIGURE = /\d+%|\$\d|Opus \d|\d+( of |\/)\d+/

async function run($: Engine, command: string, args = '') {
  return $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
}

const HEAD = {
  open: ' ▐▛███▛█',
  closed: ' ▐▂███▂█',
}
/** His eyes on a head row: looking left or right (the terminal's pupils in the top quadrants). */
function isSideways(head: string): boolean {
  return head.includes('▟███▟█') || head.includes('█▟███▟')
}

// Where each extra around desktop Clawd can reach: its pixels, moved as far as
// any of its keyframes moves it.
function reach(source: string, classes: string): { top: number; bottom: number; left: number; right: number } {
  const group = new RegExp(`<g class="${classes}"[^>]*>(.*?)</g>`).exec(source)?.[1] ?? ''
  const xs: number[] = []
  const ys: number[] = []
  for (const rect of group.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    xs.push(Number(rect[1]), Number(rect[1]) + Number(rect[3]))
    ys.push(Number(rect[2]), Number(rect[2]) + Number(rect[4]))
  }
  for (const path of group.matchAll(/d="([^"]+)"/g)) {
    const numbers = (path[1] ?? '').match(/-?[\d.]+/g)?.map(Number) ?? []
    numbers.forEach((n, i) => (i % 2 === 0 ? xs : ys).push(n))
  }
  const moves = classes
    .split(' ')
    .flatMap(name => [...source.matchAll(new RegExp(`\\.${name}\\{[^}]*animation:([a-z-]+) `, 'g'))].map(m => m[1]))
  let dx = [0]
  let dy = [0]
  for (const move of moves) {
    const frames = new RegExp(`@keyframes ${move}\\{(.*?\\})\\}`).exec(source)?.[1] ?? ''
    for (const t of frames.matchAll(/translate\(([-\d.]+)(?:px)?,([-\d.]+)(?:px)?\)/g)) {
      dx = [...dx, Number(t[1])]
      dy = [...dy, Number(t[2])]
    }
  }

  return {
    top: Math.min(...ys) + Math.min(...dy),
    bottom: Math.max(...ys) + Math.max(...dy),
    left: Math.min(...xs) + Math.min(...dx),
    right: Math.max(...xs) + Math.max(...dx),
  }
}

// A keyframes rule as [percent, opacity] steps.
function keyframes(source: string, name: string): Array<[number, number]> {
  const body = new RegExp(`@keyframes ${name}\\{(.*?\\})\\}`).exec(source)?.[1] ?? ''
  const steps: Array<[number, number]> = []
  for (const m of body.matchAll(/([\d.%,]+)\{opacity:([\d.]+)/g)) {
    for (const pct of (m[1] ?? '').split(',')) steps.push([parseFloat(pct), Number(m[2])])
  }

  return steps.sort((a, b) => a[0] - b[0])
}

// Opacity at a percent: held to the next step (step-end), or, eased, above zero between steps unless both are zero.
function opacityAt(steps: Array<[number, number]>, isStepped: boolean): (pct: number) => number {
  return pct => {
    const i = steps.findLastIndex(([at]) => at <= pct)
    const [at, a] = steps[i] ?? [0, 0]
    const b = steps[i + 1]?.[1] ?? a
    if (isStepped || at === pct) return a

    return a === 0 && b === 0 ? 0 : Math.max(a, b)
  }
}

// Frame changes, tick by tick (250 ms): never three ticks running, never more than four in a second.
function expectCalm(frames: string[]): void {
  const changed = frames.map((frame, i) => i > 0 && frame !== frames[i - 1])
  for (let i = 2; i < changed.length; i++) {
    expect(changed[i] && changed[i - 1] && changed[i - 2]).toBe(false)
  }
  for (let i = 0; i + 4 <= changed.length; i++) {
    expect(changed.slice(i, i + 4).filter(Boolean).length).toBeLessThanOrEqual(4)
  }
}

// Runs of equal values: [value, first index, length].
function runs<T>(values: T[]): Array<[T, number, number]> {
  const out: Array<[T, number, number]> = []
  values.forEach((value, i) => {
    const last = out[out.length - 1]
    if (last !== undefined && last[0] === value) {
      last[2] += 1
    } else {
      out.push([value, i, 1])
    }
  })

  return out
}

test('Hearth shows where you are, how full things are and what is happening, on terminal and desktop', async ($, on) => {
  world(on)
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    const { words } = await read()
    const [where, fill, now] = words

    expect(where).toContain('agent-plugins on main · 2 uncommitted')
    expect(where).toContain('Opus 5.5')
    expect(fill).toContain('context')
    expect(fill).toContain('42%')
    expect(fill).toContain('5h limit')
    expect(fill).toContain('23%')
    expect(fill).toContain('$0.31')
    expect(now).toContain('Ready when you are')

    await ui.unmount()
  }
})

test('the terminal draws Claude Code’s own Clawd with theme colors, in three rows that never pad to the edge', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await start($, 86, 1.94)
  const { ui, read } = await band($, 'terminal')
  await ui.advance(3000)
  const { clawd, tree, lines } = await read()

  expect(clawd).toEqual([HEAD.open, '▝▜██████▀', ' ▝▝   ▝▝'])
  const colors = new Set<string>()
  walk(tree, node => {
    for (const key of ['color', 'backgroundColor'] as const) {
      const value = node.props?.[key]
      if (typeof value === 'string') colors.add(value)
    }
  })
  expect(colors.has('clawd_body')).toBe(true)
  expect(colors.has('clawd_background')).toBe(true)
  expect([...colors].some(color => /^#0{3,6}$/.test(color))).toBe(false)
  // The bead of sweat is the theme's own blue, so it follows a custom theme.
  for (let i = 0; i < 64 && !colors.has('ide'); i++) {
    await ui.advance(250)
    walk((await read()).tree, node => {
      if (node.props?.color === 'ide' && /[▘▖]/.test(text(node))) colors.add('ide')
    })
  }
  expect(colors.has('ide')).toBe(true)

  const root = tree as Node
  expect(root.props?.height).toBe(3)
  const words = kids(root)[2]
  expect(Number(words?.props?.width)).toBe(panel(BAND.bodyColumns))
  expect(Number(words?.props?.width)).toBeLessThanOrEqual(BAND.bodyColumns - 2 - LEFT)
  // Each number hugs its meter: "━━ 86%", not "━━   86%".
  expect(lines[1]?.left).toMatch(/━ 86% {4}5h limit ━+ 23%/)
  await ui.unmount()
})

test('at every width from 34 to 160 columns, with long figures, every word fits in cells and no figure is ever cut', { timeoutMs: 60_000 }, async ($, on) => {
  const { hold, release, clock } = world(on, { branch: 'claude/first-mod' })
  await start($, 100, 123.45, 100)
  await prompt($)
  for (const subject of ['Read the band', 'Fit the second line', 'Ship it']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: '', activeForm: `${subject}, carefully and well` })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  const allowed = /^[\x20-\x7e─-▟·✢✳✶✻✽⎿]*$/u

  const sweep = async (isWorking: boolean, check: (columns: number, now: Read) => void) => {
    for (let columns = 34; columns <= 160; columns++) {
      const { ui, read } = await band($, 'terminal', { ...BAND, bodyColumns: columns, isWorking })
      const now = await read()
      expect(now.rows).toHaveLength(3)
      expect((now.tree as Node).props?.height).toBe(3)
      for (const row of now.rows) expect(row).toMatch(allowed)
      expect(now.panel).toBe(panel(columns))
      expect(now.panel + LEFT).toBeLessThanOrEqual(columns - 2)
      for (const line of now.lines) {
        expectFits(line, now.panel)
        expectBoldApartFromDim(leaves(line.node))
      }
      // Line 2's figures are whole or gone: the context figure always, the 5h figure while there is room for it.
      const fill = now.words[1] ?? ''
      expect(fill).toMatch(/^context (━+ )?100%/)
      for (const figure of fill.match(/\S*%/g) ?? []) expect(figure).toBe('100%')
      if (fill.includes('$')) expect(fill).toContain('$123.45')
      if (columns >= 38) expect(fill).toMatch(/ 5h( limit)? (━+ )?100%/)
      if (columns >= 50) expect(fill).toContain('$123.45')
      // Where the old meters overflowed (78 to 82 columns), meters, the 5h figure and the cost all show.
      if (columns >= 64) expect(fill).toMatch(/━ 100% +5h( limit)? ━+ 100% +\$123\.45$/)
      check(columns, now)
      await ui.unmount()
    }
  }

  // At work on a file with a long name, a todo under way.
  hold('Read')
  const reading = $.tool.call({ tool: 'Read', file_path: '/work/hooks/a-rather-long-file-name-for-the-band.tsx' }).catch(() => undefined)
  await clock.settle()
  // The plan's line has its second (on both surfaces: the facts hold it), then the read has the line.
  await clock.advance(1_250)
  await sweep(true, (columns, now) => {
    if (columns >= 64) {
      // The branch loses its prefix, then the model goes, and the count goes whole: never a bare number.
      const where = now.lines[0]
      expect(where?.left).toContain('agent-plugins on ')
      // (The whole branch with its count and the model takes 59 cells; with the prefix gone, 52.)
      expect(where?.squeeze).toBe(now.panel < 59 ? 'first-mod' : 'claude/first-mod')
      expect(where?.right).toBe(now.panel < 52 ? '' : 'Opus 5.5')
      expect(where?.left).toMatch(/ · 2 uncommitted$/)
      expect(cells(where?.left ?? '') + (where?.right === '' ? 0 : 2 + cells('Opus 5.5'))).toBeLessThanOrEqual(now.panel)
      expect(now.words[2]).toContain('Reading a-rather-long')
      // The tally shows only beside the whole file name: it gives way before the name is cut.
      expect(now.lines[2]?.right).toMatch(/^(1 of 3 done|1\/3 done)?$/)
      if (now.lines[2]?.right !== '') expect(now.words[2]).toContain('Reading a-rather-long-file-name-for-the-band.tsx')
      if (now.panel >= 61) expect(now.lines[2]?.right).toBe('1 of 3 done')
    }
  })
  release()
  await reading

  // The turn lands with the context full: while he cheers the words say what finished, then that it is full.
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', ...ANSWERED } as TurnCompleteInput)
  await sweep(false, (columns, now) => {
    expect(now.words[2]).toMatch(/^Done/)
  })
  await clock.advance(5000)
  // Then the 5h limit, reached: nothing more runs until it resets, so it comes before the context's
  // own "Full" (which has its own test).
  await sweep(false, (columns, now) => {
    expect(now.words[2]).toMatch(/^At (the )?5h limit/)
    if (columns >= 70) expect(now.words[2]).toContain('At the 5h limit · resets')
    expect(now.words[2]).not.toContain('Getting')
  })

  // Near the five-hour limit, with its countdown.
  await $.session.measure(measured(100, 123.45, 100))
  await sweep(false, () => undefined)
})

test('a branch or a todo in CJK or emoji is measured in terminal cells, as the terminal draws it', { timeoutMs: 60_000 }, async ($, on) => {
  expect(cells('日本語')).toBe(6)
  expect(cells('🦀')).toBe(2)
  expect(cells('❤️')).toBe(2)
  expect(cells('✅ done')).toBe(7)
  expect(cells('é')).toBe(1)
  expect(cells('━━ 42% · ✻')).toBe(10)

  const { clock } = world(on, { branch: 'claude/日本語のブランチ' })
  await start($)
  await prompt($)
  await $.tool.call({ tool: 'TaskCreate', subject: '🦀 カニを描く', description: '', activeForm: '🦀 カニを描いています' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  // "Planning" has its second, then the todo under way has the line.
  await clock.advance(1_250)

  const cuts = new Set<string>()
  for (let columns = 34; columns <= 160; columns++) {
    const { ui, read } = await band($, 'terminal', { ...BAND, bodyColumns: columns, isWorking: true })
    const now = await read()
    for (const line of now.lines) expectFits(line, now.panel)
    // A part Ink must cut gets a box as wide as what shows of it and the ellipsis, so the
    // cut lands on a cell boundary, never inside a wide character: no stray blank cell opens up.
    for (const line of now.lines) {
      walk(line.node, node => {
        if (node.type !== 'Box' || node.props?.flexShrink !== 1 || typeof node.props?.width !== 'number') return
        const room = node.props.width
        cuts.add(text(node))
        expect(cells(text(node))).toBeGreaterThan(room)
        expect(cells(cut(text(node), room - 1))).toBe(room - 1)
      })
    }
    if (columns === 64 || columns === 100) {
      // The branch whole: 64 columns gives up its prefix, the model and the count (whole, never a bare
      // number), 100 has room for it all.
      const where = now.lines[0]
      expect(where?.squeeze).toBe(columns === 64 ? '日本語のブランチ' : 'claude/日本語のブランチ')
      expect(where?.left).toBe(columns === 64 ? 'agent-plugins on 日本語のブランチ' : 'agent-plugins on claude/日本語のブランチ · 2 uncommitted')
      expect(where?.right).toBe(columns === 64 ? '' : 'Opus 5.5')
      expect(cells(where?.left ?? '') + 2 + cells(where?.right ?? '')).toBeLessThanOrEqual(now.panel)
      expect(now.words[2]).toContain('🦀 カニを描いています')
      expect(now.words[2]).not.toContain('Now ')
    }
    await ui.unmount()
  }
  // Both the branch and the todo were cut somewhere along the way.
  expect(cuts).toEqual(new Set(['日本語のブランチ', '🦀 カニを描いています']))
})

test('on the desktop, a band the host gives no width keeps all three lines beside him, in a 100-column panel', async ($, on) => {
  world(on)
  await start($)
  const { ui, read } = await band($, 'desktop', { ...BAND, bodyColumns: 0 })
  const { tree, words } = await read()
  expect(words).toHaveLength(3)
  expect(Number(kids(tree)[1]?.props?.width)).toBe(panelMost(100))
  await ui.unmount()
})

test('on the desktop, at every width from 34 to 160 with long figures, every line fits and no figure or label is ever clipped', { timeoutMs: 60_000 }, async ($, on) => {
  const { hold, release, clock } = world(on, { branch: 'claude/first-mod' })
  await start($, 100, 123.45, 100)
  await prompt($)
  for (const subject of ['Read the band', 'Fit the second line', 'Ship it']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: '', activeForm: `${subject}, carefully and well` })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  const sweep = async (isWorking: boolean, check: (columns: number, third: string) => void, context = '100%') => {
    for (let columns = 34; columns <= 160; columns++) {
      const { ui, read } = await band($, 'desktop', { ...BAND, bodyColumns: columns, isWorking })
      const { tree, words } = await read()
      const column = kids(tree)[1]
      const panel = Math.min(columns - 14, panelMost(columns))
      expect(Number(column?.props?.width)).toBe(panel)
      const lines = kids(column)
      expect(lines).toHaveLength(3)
      for (const line of lines) {
        // Laid out as the band budgets it, each line fits its panel: nothing is left to be clipped.
        expect(deskWidth(line)).toBeLessThanOrEqual(panel * DESK_CELL)
        // Even on a page whose cells run narrow (7.2 px), where the panel shrinks beside Clawd's 96 px.
        const narrow = Math.min(panel * 7.2, (columns - 1) * 7.2 - 96)
        expect([columns, deskWidth(line) <= narrow + 0.01]).toEqual([columns, true])
        // A box that clips holds only words that may be cut (a branch, a file name, a todo), never a figure.
        walk(line, node => {
          if (node.type === 'Box' && node.props?.overflow === 'hidden') expect(text(node)).not.toMatch(FIGURE)
        })
      }
      // Line 2 has no box that clips at all, and its figures and labels are whole or gone.
      const fill = lines[1]
      walk(fill, node => expect(node.props?.overflow).not.toBe('hidden'))
      const figures = text(fill)
      expect(figures.startsWith(`context${context}`)).toBe(true)
      for (const figure of figures.match(/\d+%/g)?.slice(1) ?? []) expect(figure).toBe('100%')
      if (figures.includes('$')) expect(figures).toMatch(/%\$123\.45$/)
      if (columns >= 40) expect(figures).toMatch(/%5h( limit)?100%/)
      if (columns >= 50) expect(figures).toContain('$123.45')
      // The pills come back from 61 columns, both at once (the room is counted at a narrow 7.2 px cell).
      const pills: number[] = []
      walk(fill, node => {
        if (node.type === 'Svg') pills.push(Number(node.props?.width))
      })
      expect(pills.length === 0 || pills.length === 2).toBe(true)
      if (columns >= 61) expect(pills.length).toBe(2)
      if (columns >= 80) expect(pills).toEqual([72, 48])
      check(columns, words[2] ?? '')
      await ui.unmount()
    }
  }

  // At work on a file with a long name: the name is cut with an ellipsis, the words before it never.
  hold('Read')
  const reading = $.tool.call({ tool: 'Read', file_path: '/work/hooks/a-rather-long-file-name-for-the-band.tsx' }).catch(() => undefined)
  await clock.settle()
  await clock.advance(1100)
  await sweep(true, (columns, third) => {
    expect(third).toMatch(columns >= 50 ? /^Reading a-rather/ : /^Reading/)
  })
  release()
  await reading

  // Landed: "Done" while he cheers; after, the 5h limit it has reached, ahead of the context's "Full"
  // (nothing more runs until the reset).
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', ...ANSWERED } as TurnCompleteInput)
  await sweep(false, (columns, third) => expect(third).toMatch(/^Done/))
  await clock.advance(5000)
  await sweep(false, (columns, third) => {
    expect(third).toMatch(/^At (the )?5h limit/)
    expect(third).not.toContain('…')
  })

  // At the 5h limit: the message takes a shorter form; it is never cut. (At 100%, never "Near".)
  await $.session.measure(measured(60, 123.45, 100))
  await sweep(false, (columns, third) => {
    expect(third).toMatch(/^At (the )?5h limit/)
    expect(third).not.toContain('…')
    if (columns >= 64) expect(third).toMatch(/^At the 5h limit/)
  }, '60%')
})

// A step that fails while "Thinking it over" is up (a quick one the line never named) takes line 3
// over at once on the terminal, as the facts' line does, never waiting out the thought's second.
test('terminal: a failure while "Thinking it over" is up shows its hiccup at once, and he flinches with it', async ($, on) => {
  world(on)
  await start($)
  const { ui, read } = await band($, 'terminal')
  await ui.advance(1_000)
  // The turn begins: "Thinking it over" goes up, and has been up 400 ms as the step fails.
  await prompt($, 'run it')
  await ui.redraw({ ...BAND, isWorking: true })
  await ui.advance(400)
  expect((await read()).words[2]).toContain('Thinking it over')
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  const now = await read()
  expect([now.words[2], now.clawd[0]]).toEqual([expect.stringContaining('Hiccup · Run the tests'), HEAD.closed])
  await ui.unmount()
})

// A question for you (or a plan to look over) is a wait: on the terminal he rests as he does between
// turns (a blink, and every twenty seconds a look over at the words), never tapping along as at work.
test('terminal: a question for you is a wait: Clawd rests, glancing at the words now and then, never tapping along', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, hold, release } = world(on)
  await start($)
  const { ui, read } = await band($, 'terminal', { ...BAND, isWorking: true })
  await prompt($, 'plan it')
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2_000)
  await ui.advance(2_000)
  hold('AskUserQuestion')
  const asking = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which way should sign-in go?', header: 'Auth method', options: [{ label: 'OAuth', description: 'A browser sign-in' }, { label: 'Keys', description: 'An API key' }], multiSelect: false }],
  } as Parameters<Engine['tool']['call']>[0])
  await clock.settle()
  await ui.redraw({ ...BAND, isWorking: true })
  const heads = new Set<string>()
  const rest = new Set<string>()
  // Half a minute of waiting on the answer.
  for (let i = 0; i < 120; i++) {
    await clock.advance(250)
    await ui.advance(250)
    const now = await read()
    expect([i, now.words[2]]).toEqual([i, expect.stringContaining('Asking you')])
    heads.add(now.clawd[0] ?? '')
    rest.add(`${now.clawd[1]}|${now.clawd[2]}`)
  }
  release()
  await asking
  // No claw up and no step: only his eyes move, open, shut for a blink, or over at the words.
  expect([...heads].every(head => head === HEAD.open || head === HEAD.closed || isSideways(head))).toBe(true)
  expect([...heads].some(isSideways)).toBe(true)
  expect(rest.size).toBe(1)
  await ui.unmount()
})

test('a failed tool owns line 3 for its second, and Clawd flinches with it, even in a burst', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, hold, release } = world(on)
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface, { ...BAND, isWorking: true })
    let t = 0
    const step = async (ms: number) => {
      if (surface === 'terminal') await ui.advance(ms)
      await clock.advance(ms)
      t += ms
    }
    const shots: Array<{ t: number; third: string; isFlinch: boolean }> = []
    const snap = async () => {
      const now = await read()
      const isFlinch = surface === 'terminal' ? now.clawd[0] === HEAD.closed : (svgOf(now.tree)?.source ?? '').includes('@keyframes hh-mf-')
      shots.push({ t, third: now.words[2] ?? '', isFlinch })
    }
    await prompt($, 'look around')
    await step(1000)
    // Five tools of 60 ms, 60 ms apart; the third fails, and the next starts at once.
    const calls: Array<Record<string, unknown> & { tool: string }> = [
      { tool: 'Read', file_path: '/w/a.ts' },
      { tool: 'Grep', pattern: 'band' },
      { tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' },
      { tool: 'Edit', file_path: '/w/b.ts', old_string: 'a', new_string: 'b' },
      { tool: 'Read', file_path: '/w/c.ts' },
    ]
    for (const call of calls) {
      hold(call.tool)
      const pending = $.tool.call(call as Parameters<Engine['tool']['call']>[0]).catch(() => undefined)
      await clock.settle()
      for (let k = 0; k < 2; k++) {
        await step(30)
        await snap()
      }
      release()
      await pending
      for (let k = 0; k < 2; k++) {
        await step(30)
        await snap()
      }
    }
    for (let k = 0; k < 24; k++) {
      await step(125)
      await snap()
    }

    // The hiccup goes up naming the tool that failed, and stays a second.
    const hiccups = shots.filter(shot => shot.third.startsWith('Hiccup'))
    expect(hiccups.length).toBeGreaterThan(0)
    for (const shot of hiccups) expect(shot.third).toBe('Hiccup · Run the tests')
    expect((hiccups[hiccups.length - 1]?.t ?? 0) - (hiccups[0]?.t ?? 0)).toBeGreaterThanOrEqual(875)
    // He flinches as it goes up, never before it, under another tool's name.
    const flinchAt = shots.findIndex(shot => shot.isFlinch)
    expect(flinchAt).toBe(shots.findIndex(shot => shot.third.startsWith('Hiccup')))
    await ui.unmount()
  }
})

test('terminal: Esc within the second of a failure takes it back, and Clawd stops flinching at once rather than playing it on beside "Stopped"', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const { ui, read } = await band($, 'terminal', { ...BAND, isWorking: true })
  const step = async (ms: number) => {
    for (let left = ms; left > 0; left -= 125) {
      await ui.advance(Math.min(125, left))
      await clock.advance(Math.min(125, left))
    }
  }
  await prompt($, 'run the tests')
  await step(1_500)
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  // The hiccup goes up and he flinches, on the next tick.
  await step(375)
  const flinching = await read()
  expect([flinching.clawd[0] === HEAD.closed, flinching.words[2]]).toEqual([true, 'Hiccup · Run the tests'])
  // Esc, 375 ms after the failure: the turn takes it back (nothing failed: the person stopped it).
  await $.turn.complete({ answer: '', durationMs: 5_000, turnId: 't1', reason: 'aborted', isAborted: true } as TurnCompleteInput)
  await ui.redraw(BAND)
  await step(250)
  const stopped = await read()
  expect([stopped.clawd[0] === HEAD.closed, stopped.words.some(line => line.includes('Hiccup')), stopped.words.join(' ').includes('Stopped after 5s')]).toEqual([false, false, true])
  await ui.unmount()
})

// A turn that lands while he still flinches cheers at once, as the beach's cheer takes over from its
// splash: his arms go up on the frame "Done" comes in on, and his cheer plays whole. A flinch that went
// up less than a tick before keeps that tick first.
for (const landAt of [60, 125, 375, 625, 1_000, 1_375]) {
  test(`terminal: a turn that lands ${landAt} ms into his flinch raises his arms with "Done", never "Done" beside the flinch`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    const { ui, read } = await band($, 'terminal', { ...BAND, isWorking: true })
    const step = async (ms: number) => {
      for (let left = ms; left > 0; left -= 5) {
        await ui.advance(Math.min(5, left))
        await clock.advance(Math.min(5, left))
      }
    }
    await prompt($, 'run the tests')
    await step(1_500)
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    let waited = 0
    while ((await read()).clawd[0] !== HEAD.closed && waited < 1_000) {
      await step(5)
      waited += 5
    }
    expect((await read()).words[2]).toBe('Hiccup · Run the tests')
    await step(landAt)
    await $.turn.complete({ answer: 'Done.', durationMs: 5_000, turnId: 't1', reason: 'answer', isAborted: false } as TurnCompleteInput)
    await ui.redraw(BAND)
    const shots: Array<{ t: number; isUp: boolean; isDone: boolean; isFlinch: boolean }> = []
    for (let t = 0; t <= 2_000; t += 5) {
      const now = await read()
      const head = now.clawd[0] ?? ''
      shots.push({ t, isUp: head.startsWith('▗▟'), isDone: (now.words[2] ?? '').startsWith('Done'), isFlinch: head === HEAD.closed || isSideways(head) })
      await step(5)
    }
    // Never "Done" without his arms up, and never his arms up before "Done".
    expect(shots.filter(shot => shot.isDone !== shot.isUp).map(shot => shot.t)).toEqual([])
    // Within a tick, or two for a flinch just begun, and his cheer has its first pose (✶, feet together) a second.
    const upAt = shots.find(shot => shot.isUp)?.t ?? Infinity
    expect(upAt).toBeLessThanOrEqual(landAt < 250 ? 500 : 250)
    // His eyes squeeze shut a tick at least (the flinch was seen up to 5 ms after it went up).
    expect(landAt + upAt).toBeGreaterThanOrEqual(245)
    expect(shots.filter(shot => shot.t >= upAt && shot.t < upAt + 1_000).every(shot => shot.isUp)).toBe(true)
    await ui.unmount()
  })
}

test('a turn that lands with the context full says it is done while he cheers, then that it is getting full', async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.94)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    await turn($)
    expect((await read()).words[2]).toContain('Done in 41s · 2 tools · 1 file changed')
    if (surface === 'terminal') {
      await ui.advance(4500)
    } else {
      // The cheer over, the band redraws by itself.
      await clock.advance(4500)
    }
    expect((await read()).words[2]).toContain('Getting full')
    await ui.unmount()
  }
})

test('when Claude Code says the work is over before the turn is written down, the band waits for it', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  // A turn before, so there is an old summary that must not flash up.
  await turn($)
  await clock.advance(60_000)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface, { ...BAND, isWorking: true })
    const step = async (ms: number) => {
      if (surface === 'terminal') await ui.advance(ms)
      await clock.advance(ms)
    }
    const seen: Array<{ third: string; alt: string }> = []
    const snap = async () => {
      const now = await read()
      seen.push({ third: now.words[2] ?? '', alt: svgOf(now.tree)?.alt ?? '' })
    }
    await prompt($, 'go')
    await $.tool.call({ tool: 'Edit', file_path: '/work/c.ts', old_string: 'a', new_string: 'b' })
    await step(2000)
    await snap()
    // Claude Code flips to idle; the turn's own write lands a moment later.
    await ui.redraw({ ...BAND, isWorking: false })
    for (let k = 0; k < 4; k++) {
      await step(100)
      await snap()
    }
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, turnId: 't2', ...ANSWERED } as TurnCompleteInput)
    await snap()

    expect(seen.map(shot => shot.third).some(third => third.includes('41s'))).toBe(false)
    expect(seen[seen.length - 1]?.third).toContain('Done in 9s')
    if (surface === 'desktop') {
      // Clawd goes from work to the cheer, with no idle Clawd in between (one reload, not two).
      expect([...new Set(seen.map(shot => shot.alt))]).toEqual(['Clawd taps along as Claude works.', 'Clawd cheers for a finished turn.'])
    }
    await ui.unmount()

    // And when the write never comes, the band settles by itself a second and a half later.
    const late = await band($, surface, { ...BAND, isWorking: true })
    await prompt($, 'again')
    await $.tool.call({ tool: 'Read', file_path: '/work/c.ts' })
    // (The facts move on as the clock does, and the terminal takes the line up on its next tick.)
    await clock.advance(2000)
    if (surface === 'terminal') await late.ui.advance(2000)
    await late.ui.redraw({ ...BAND, isWorking: false })
    expect((await late.read()).words[2]).toContain('Thinking')
    if (surface === 'terminal') await late.ui.advance(1750)
    await clock.advance(1750)
    expect((await late.read()).words[2]).not.toContain('Thinking')
    await late.ui.unmount()
    await $.turn.complete({ answer: 'Done.', durationMs: 9_000, turnId: 't3', ...ANSWERED } as TurnCompleteInput)
  }
})

test('the desktop draws Clawd as a crisp Svg and the words with Box and Text, no Client and no character art', async ($, on) => {
  world(on)
  await start($)
  const { ui, read } = await band($, 'desktop')
  const { tree } = await read()

  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  const svg = svgOf(tree)
  // The alt text says what the picture shows: in a session's first moments, his hello.
  expect(svg?.alt).toBe('Clawd waves hello.')
  expect(svg?.source).toContain('shape-rendering="crispEdges"')
  // An image, never an interactive frame, which blanks for a frame or two as its source changes.
  const frames: unknown[] = []
  walk(tree, node => {
    if (node.type === 'Svg' && node.props?.isInteractive === true) frames.push(node)
  })
  expect(frames).toEqual([])
  expect(svg?.source).not.toContain(':hover')
  expect(svg?.source).not.toContain('<script')
  expect(svg?.source.length ?? 0).toBeLessThan(131_072)
  expect(text(tree)).not.toMatch(/[▀-▟]/u)
  // A glance moves his pupils a pixel along the eye row, never up into the top of his head.
  expect(svg?.source).toContain('<g class="hh-el-r" fill="#1B1A19"><rect x="6" y="2" width="1" height="2"/></g>')
  expect(svg?.source).toContain('<g class="hh-er-l" fill="#1B1A19"><rect x="12" y="2" width="1" height="2"/></g>')
  // He sits close to his words: 96 px wide with his extras, 64 tall.
  let size = { width: 0, height: 0 }
  walk(tree, node => {
    if (isClawd(node)) size = { width: Number(node.props?.width), height: Number(node.props?.height) }
  })
  expect(size).toEqual({ width: 96, height: 64 })
  // Each percentage has a box five cells wide, so "100%" never nudges what comes after it.
  const boxes: number[] = []
  walk(tree, node => {
    if (node.type === 'Box' && typeof node.props?.minWidth === 'number' && /^\d+%$/.test(text(node))) boxes.push(node.props.minWidth)
  })
  expect(boxes).toEqual([5, 5])
  await ui.unmount()
})

test('on the desktop every sparkle, z, bead of sweat and heart stays inside Clawd’s frame as it moves', async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.94)
  const { ui, read } = await band($, 'desktop')
  const sources: string[] = []
  const hearts: string[] = []
  await turn($)
  sources.push(svgOf((await read()).tree)?.source ?? '')
  hearts.push(heartOf((await read()).tree))
  await clock.advance(5 * 60_000)
  await $.session.measure(measured(87, 1.95))
  sources.push(svgOf((await read()).tree)?.source ?? '')
  hearts.push(heartOf((await read()).tree))

  for (const source of [...sources, ...hearts]) {
    const [x, y, w, h] = (/viewBox="([^"]+)"/.exec(source)?.[1] ?? '').split(' ').map(Number)
    for (const name of ['hh-sp', 'hh-sp hh-sp2', 'hh-z', 'hh-sw', 'hh-ht']) {
      if (!source.includes(`class="${name}"`)) continue
      const box = reach(source, name)
      expect(box.top).toBeGreaterThanOrEqual(y ?? 0)
      expect(box.left).toBeGreaterThanOrEqual(x ?? 0)
      expect(box.bottom).toBeLessThanOrEqual((y ?? 0) + (h ?? 0))
      expect(box.right).toBeLessThanOrEqual((x ?? 0) + (w ?? 0))
    }
  }
  // The sweat stops above his claw (which starts at y 2 when raised), and asleep he stops sweating.
  expect(reach(sources[0] ?? '', 'hh-sw').bottom).toBeLessThanOrEqual(2)
  expect(sources[1]).toContain('class="hh-z"')
  expect(sources[1]).not.toContain('class="hh-sw"')
  // The z is a soft shape beside a pixel Clawd, in the tide's slate; the heart is the terminal's
  // pixel heart, as the beach draws it: five runs of pixels, one path, in the tide's pink.
  expect(sources[1]).toMatch(/<g class="hh-z" fill="none" stroke="#7E95B5"[^>]*><path d="M[^"]+L/)
  const heart = /<g class="hh-ht" fill="#E9789B"[^>]*><path d="([^"]+)"\/><\/g>/u.exec(hearts[1] ?? '')?.[1] ?? ''
  expect([heart.match(/M/gu)?.length, /[CQ]/u.test(heart)]).toEqual([5, false])
  // Held still (reduced motion, /band still), the heart's edges and the z's strokes fall on whole
  // screen pixels (4 to a unit), so neither is soft beside him at 1x.
  const z = /<g class="hh-z"[^>]*><path d="([^"]+)"/u.exec(sources[1] ?? '')?.[1] ?? ''
  for (const shape of [heart, /<g class="hh-ht" fill="#E9789B"[^>]*><path d="([^"]+)"\/><\/g>/u.exec(hearts[0] ?? '')?.[1] ?? '', z]) {
    const numbers = shape.match(/-?[\d.]+/gu)?.map(Number) ?? []
    expect(numbers.length).toBeGreaterThan(0)
    for (const n of numbers) expect(Math.abs(n * 4 - Math.round(n * 4))).toBeLessThan(0.001)
  }
  // The cheer's sparkle is a four-point twinkle, not a plus.
  expect(sources[0]).toMatch(/<g class="hh-sp"[^>]*><path d="M[^"]+Q/)
  await ui.unmount()
})

test('on the desktop his z carries on from the frame he dozed off in: a turn that stopped dozed off a second before the nap redraw, a cheer never did', async ($, on) => {
  const zAt = (source: string) => /\.hh-z\{[^}]*animation:hh-zz 3s ease-out (-?[\d.]+)s/u.exec(source)?.[1]
  const dozy = (source: string) => /\.hh-z\{[^}]*animation:hh-zz 3s ease-out ([\d.]+)s/u.exec(source)?.[1]
  const { clock } = world(on)
  await start($)
  const { ui, read } = await band($, 'desktop')

  // Stopped: the frame that came as the turn landed was dozy, its z due as the nap falls; the nap's
  // redraw comes a second after that (NAP_LATE_MS), so the z is a second into its drift.
  await turn($, { reason: 'aborted', isAborted: true })
  const landed = svgOf((await read()).tree)?.source ?? ''
  expect(dozy(landed)).toBe(String(NAP_AFTER_MS / 1000))
  await clock.advance(NAP_AFTER_MS + NAP_LATE_MS)
  const stopped = svgOf((await read()).tree)?.source ?? ''
  expect(stopped).toContain('class="hh-z"')
  expect(zAt(stopped)).toBe('-1')

  // Answered: the frame after the cheer has not dozed off when the nap redraws, so the z starts there.
  await turn($)
  await clock.advance(NAP_AFTER_MS + NAP_LATE_MS)
  const answered = svgOf((await read()).tree)?.source ?? ''
  expect(answered).toContain('class="hh-z"')
  expect(zAt(answered)).toBe('0')
  await ui.unmount()
})

test('on the desktop a nap frame that follows one already showing a z (still to lively, the beach to the hearth) carries the z on whole, and redraws through the nap keep its frame', async ($, on) => {
  const zAt = (source: string) => /\.hh-z\{[^}]*animation:hh-zz 3s ease-out (-?[\d.]+)s/u.exec(source)?.[1]
  const { clock } = world(on)
  await start($)
  const { ui, read } = await band($, 'desktop')
  const source = async () => svgOf((await read()).tree)?.source ?? ''
  await turn($)
  await clock.advance(NAP_AFTER_MS + NAP_LATE_MS)
  const dozed = await source()
  expect(zAt(dozed)).toBe('0')
  // A reading, a minute on: the same nap, the same frame.
  await clock.advance(60_000)
  await $.session.measure(measured(44, 0.33))
  expect(await source()).toBe(dozed)

  // Still, his z is drawn whole; lively again, it carries on from there, never shrinking to nothing.
  await run($, 'band', 'still')
  expect(await source()).toContain('.hh-z{opacity:1;transform:none;animation:none}')
  await run($, 'band', 'lively')
  const carried = await source()
  expect(zAt(carried)).toBe('-1')
  await clock.advance(30_000)
  await $.session.measure(measured(45, 0.34))
  expect(await source()).toBe(carried)

  // From the beach's nap, whose z's drift as the switch comes, the same.
  await run($, 'band', 'tide')
  await clock.advance(10_000)
  await run($, 'band', 'hearth')
  expect(zAt(await source())).toBe('-1')
  await ui.unmount()
})

test('while a tool runs the band says what it is, and the todos count up', async ($, on) => {
  let peek: (() => Promise<Read>) | undefined
  let wait: ((ms: number) => Promise<void>) | undefined
  let during: string[] = []
  const { clock } = world(on, {
    onCall: async tool => {
      if (tool !== 'Edit') return
      // What is up stays a second before the next tool shows.
      await wait?.(1250)
      during = (await peek?.())?.words ?? []
    },
  })
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface, { ...BAND, isWorking: true })
    peek = read
    // The facts move on as the clock does, and the terminal takes the line up on its next tick.
    wait = async ms => {
      await clock.advance(ms)
      if (surface === 'terminal') await ui.advance(ms)
    }
    await prompt($, 'go')
    await $.tool.call({ tool: 'TaskCreate', subject: 'Write the band tests', description: '', activeForm: 'Writing the band tests' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: '' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: surface === 'terminal' ? '1' : '3', status: 'completed' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/agent-plugins/hooks/band.tsx', old_string: 'a', new_string: 'b' })

    expect(during[2]).toContain('Editing band.tsx')
    await wait(1500)
    const after = (await read()).words
    expect(after[2]).not.toContain('Editing')
    expect(after[2]).toMatch(/\d of \d done/)
    await ui.unmount()
  }
})

test('a described command reads as its description, starting where every line 3 starts', async ($, on) => {
  let peek: (() => Promise<Read>) | undefined
  let tick: (() => Promise<void>) | undefined
  let during: Read | undefined
  world(on, {
    onCall: async tool => {
      if (tool !== 'Bash') return
      await tick?.()
      during = await peek?.()
    },
  })
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface, { ...BAND, isWorking: true })
    peek = read
    tick = async () => (surface === 'terminal' ? ui.advance(250) : undefined)
    await prompt($, 'go')
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })

    expect(during?.lines[2]?.left).toBe('Run the tests')
    await ui.unmount()
  }
})

test('a long command with no description runs to the edge and ends in an ellipsis after a whole word, never a silent cut', async ($, on) => {
  const command = 'node scripts/check-every-band.mjs --surface terminal --surface desktop --look tide --look hearth --motion still --motion lively --widths 34-160 --verbose'
  let peek: (() => Promise<Read>) | undefined
  let tick: (() => Promise<void>) | undefined
  let during: Read | undefined
  world(on, {
    onCall: async tool => {
      if (tool !== 'Bash') return
      await tick?.()
      during = await peek?.()
    },
  })
  await start($)
  expect(command.length).toBeGreaterThan(140)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface, { ...BAND, bodyColumns: 160, isWorking: true })
    peek = read
    tick = async () => (surface === 'terminal' ? ui.advance(250) : undefined)
    await prompt($, 'go')
    await $.tool.call({ tool: 'Bash', command })

    const third = during?.lines[2]
    if (surface === 'terminal') {
      // The whole command goes to the squeezed box, and Ink's own cut ends it with an ellipsis.
      expect(third?.squeeze).toBe(command)
      expect(cells(third?.squeeze ?? '')).toBeGreaterThan(during?.panel ?? 0)
    } else {
      // Cut to the room after a whole word of the command, on a letter: never "--…", "terminal …" or "term…".
      expect(third?.left).toMatch(/^Running node scripts\/check-every-band\.mjs --surface( \S+)*(?<![\s/._-])…$/u)
      const kept = (third?.left ?? '').replace(/^Running |…$/gu, '')
      expect(command.startsWith(`${kept} `)).toBe(true)
    }
    await ui.unmount()
  }
})

test('a burst of quick tools reads as one calm stretch: at most three terminal changes, and one desktop Clawd', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, hold, release } = world(on)
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface, { ...BAND, isWorking: true })
    // The facts move on as the clock does, and the terminal takes the line up on its next tick.
    const step = async (ms: number) => {
      await clock.advance(ms)
      if (surface === 'terminal') await ui.advance(ms)
    }
    await prompt($, 'look around')
    await step(1000)
    // Six tools of 60 ms, 60 ms apart, then a second and a half of thinking.
    let t = 0
    const shots: Array<{ t: number; tree: string; third: string; source: string }> = []
    const snap = async () => {
      const now = await read()
      shots.push({ t, tree: JSON.stringify(now.tree), third: now.words[2] ?? '', source: svgOf(now.tree)?.source ?? '' })
    }
    await snap()
    for (let i = 0; i < 6; i++) {
      hold(i % 2 === 1 ? 'Grep' : 'Read')
      const call = (i % 2 === 1 ? $.tool.call({ tool: 'Grep', pattern: 'band' }) : $.tool.call({ tool: 'Read', file_path: `/w/f${i}.ts` })).catch(
        () => undefined,
      )
      await clock.settle()
      for (let k = 0; k < 2; k++) {
        await step(30)
        t += 30
        await snap()
      }
      release()
      await call
      for (let k = 0; k < 2; k++) {
        await step(30)
        t += 30
        await snap()
      }
    }
    for (let k = 0; k < 12; k++) {
      await step(125)
      t += 125
      await snap()
    }

    const changes = shots.filter((shot, i) => i > 0 && shot.tree !== shots[i - 1]?.tree).length
    if (surface === 'terminal') {
      expect(changes).toBeLessThanOrEqual(3)
    } else {
      // The desktop's Svg is the same throughout: a tool starting or finishing never reloads Clawd.
      expect(new Set(shots.map(shot => shot.source)).size).toBe(1)
      expect(changes).toBeLessThanOrEqual(3)
    }
    // Whatever the words show, they stay up a second at least (bar the first and the last).
    const held = runs(shots.map(shot => shot.third))
    for (const [, first] of held.slice(1, -1)) {
      const next = held.find(([, from]) => from > first)
      expect((shots[next?.[1] ?? 0]?.t ?? 0) - (shots[first]?.t ?? 0)).toBeGreaterThanOrEqual(960)
    }
    expect(held[held.length - 1]?.[0]).toContain('Thinking')
    await ui.unmount()
  }
})

test('a failed tool is a hiccup, not an alarm, and Clawd flinches', async ($, on) => {
  const { clock } = world(on)
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface, { ...BAND, isWorking: true })
    await prompt($, 'run it')
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    // The hiccup shows on the terminal's next tick, and on the desktop once the command has had its second.
    if (surface === 'terminal') {
      await ui.advance(250)
    } else {
      expect(svgOf((await read()).tree)?.source).toContain('@keyframes hh-mf-')
      await clock.advance(1100)
    }

    const { words, clawd, tree } = await read()
    expect(words[2]).toContain('Hiccup · Run the tests')
    if (surface === 'terminal') {
      expect(clawd[0]).toBe(HEAD.closed)
    } else {
      const flinch = svgOf(tree)
      expect(flinch?.source).toContain('@keyframes hh-mf-')
      // The flinch over, its calm rest and all, he taps along again in that same frame, so its end
      // loads nothing (a turn landing a moment later would load a second frame within the second).
      await clock.advance(2000)
      expect(svgOf((await read()).tree)?.source).toBe(flinch?.source)
      expect(flinch?.alt).toBe('Clawd flinches at a failed step, then taps along again.')
    }
    await ui.unmount()
  }
})

for (const endsAt of [2_100, 2_900, null]) {
  test(`on the desktop a flinch plays out its calm rest in its own frame${endsAt === null ? ', then taps along again in that same frame, three seconds in' : `: a turn that ends ${endsAt} ms in cheers straight from it, in one reload`}`, { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    const { ui, read } = await band($, 'desktop', { ...BAND, isWorking: true })
    await prompt($, 'run it')
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    // Each new frame, with when it came (ms after the failure).
    const frames: Array<{ at: number; source: string }> = []
    const look = async (at: number) => {
      const source = svgOf((await read()).tree)?.source ?? ''
      if (frames[frames.length - 1]?.source !== source) frames.push({ at, source })
    }
    await look(0)
    for (let at = 100; at <= (endsAt ?? 4_000); at += 100) {
      await clock.advance(100)
      await look(at)
    }
    const kinds = () => frames.map(({ source }) => (source.includes('@keyframes hh-mf-') ? 'flinch' : source.includes('@keyframes hh-mc-') ? 'cheer' : 'work'))
    if (endsAt === null) {
      // The flinch's frame holds through its rest and goes on into the taps: no frame for its end.
      expect(kinds()).toEqual(['flinch'])
    } else {
      await $.turn.complete({ answer: 'Done.', durationMs: 9_000, turnId: 'f1', ...ANSWERED } as TurnCompleteInput)
      await ui.redraw(BAND)
      await look(endsAt)
      // One reload, from the flinch's rest to the cheer: never a tap source loaded half a second before it.
      expect(kinds()).toEqual(['flinch', 'cheer'])
    }
    // No frame raises his claw to tap until three seconds after the flinch began, and the frame
    // after the flinch opens on the tap the flinch's own frame had just begun.
    for (const { at, source } of frames.filter(({ source }) => !source.includes('@keyframes hh-mc-'))) {
      const tap = Number(/hh-ml-ra-u [\d.]+s step-end ([\d.]+)s/u.exec(source)?.[1])
      expect([at, at / 1000 + tap >= 2.99, at / 1000 + tap <= 3.11]).toEqual([at, true, true])
    }
    await ui.unmount()
  })
}

for (const change of ['bead', 'still'] as const) {
  test(`on the desktop the flinch's frame, kept on into his taps, gives way to ${change === 'bead' ? 'a bead of sweat' : 'a moment of stillness'} and never comes back`, async ($, on) => {
    const { clock } = world(on)
    await start($)
    const { ui, read } = await band($, 'desktop', { ...BAND, isWorking: true })
    await prompt($, 'run it')
    await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
    await clock.advance(3_000)
    expect(svgOf((await read()).tree)?.alt).toBe('Clawd flinches at a failed step, then taps along again.')
    if (change === 'bead') {
      // The tide comes in high: a bead of sweat, in a frame of its own.
      await $.session.measure(measured(86, 1.94))
      await clock.advance(1_000)
      await ui.redraw({ ...BAND, isWorking: true })
    } else {
      // Still for a moment, then lively again: his taps, never the flinch's frame once more.
      await run($, 'band', 'still')
      await ui.redraw({ ...BAND, isWorking: true })
      expect(svgOf((await read()).tree)?.source).not.toContain('@keyframes hh-mf-')
      await clock.advance(1_000)
      await run($, 'band', 'lively')
      await ui.redraw({ ...BAND, isWorking: true })
    }
    const after = svgOf((await read()).tree)
    expect(after?.source).not.toContain('@keyframes hh-mf-')
    expect(after?.alt).toBe(change === 'bead' ? 'Clawd taps along, a bead of sweat on his brow.' : 'Clawd taps along as Claude works.')
    await ui.unmount()
  })
}

test('on the desktop a second failure while he still flinches from the first makes him flinch again', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const { ui, read } = await band($, 'desktop', { ...BAND, isWorking: true })
  await prompt($, 'run it')
  const flinches: string[] = []
  const thirds = new Set<string>()
  const look = async () => {
    const { words, tree } = await read()
    const source = svgOf(tree)?.source ?? ''
    thirds.add(words[2] ?? '')
    if (/@keyframes hh-mf2?-/.test(source) && flinches[flinches.length - 1] !== source) flinches.push(source)
  }
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  await look()
  for (let k = 0; k < 8; k++) {
    await clock.advance(100)
    await look()
  }
  await $.tool.call({ tool: 'Bash', command: 'npm run lint -- fail', description: 'Lint the band' })
  for (let k = 0; k < 40; k++) {
    await clock.advance(100)
    await look()
  }

  // Two hiccups, two flinches: the second is a source of its own, so the page plays it from the start.
  expect([...thirds].filter(third => third.startsWith('Hiccup'))).toEqual(['Hiccup · Run the tests', 'Hiccup · Lint the band'])
  expect(flinches).toHaveLength(2)
  expect(flinches[1]).toContain('@keyframes hh-mf2-')
  // And then he taps along again in the second flinch's own frame: its end loads nothing.
  expect(svgOf((await read()).tree)?.source).toBe(flinches[1])
  await ui.unmount()
})

test('if the band cannot write its state, the prompt and every tool go on untouched', async ($, on) => {
  let calls = 0
  let isBroken = false
  world(on, {
    onCall: async () => {
      calls += 1
    },
  })
  on('state.set', ($, e, next) => {
    if (isBroken) throw new Error('disk full')

    return next(e)
  })
  await start($)
  isBroken = true

  expect(await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })).toMatchObject({ text: 'go' })
  expect(await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })).toMatchObject({ result: { ok: true } })
  expect(await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })).toMatchObject({ isError: true })
  // Each tool ran exactly once: the band's `.catch` replays what the tool settled to.
  expect(calls).toBe(2)

  isBroken = false
  expect(await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })).toMatchObject({ result: { ok: true } })
  expect(calls).toBe(3)
})

test('a finished turn says how it went, and Clawd raises his arms, hops and settles', async ($, on) => {
  const { clock } = world(on)
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    await turn($)

    const landed = await read()
    expect(landed.words[2]).toContain('Done in 41s · 2 tools · 1 file changed')
    // "Done" is green while he cheers for it, and plain ink once the cheer is over, as on the beach.
    const colors = (tree: unknown) => {
      let seen = ''
      walk(tree, node => {
        seen += ` ${String(node.props?.color ?? '')}`
      })
      return seen
    }
    expect(colors(landed.tree)).toContain('success')
    if (surface === 'terminal') {
      expect(landed.clawd[0]).toMatch(/^▗▟/)
      expect(landed.marks[0]?.trim()).toMatch(/^[✶✻]$/u)
      await ui.advance(5000)
      expect((await read()).clawd[0]).toBe(HEAD.open)
    } else {
      const source = svgOf(landed.tree)?.source ?? ''
      expect(svgOf(landed.tree)?.alt).toBe('Clawd cheers for a finished turn.')
      expect(source).toContain('.hh-hop{animation:hh-hop')
      // His arms stay up for the whole cheer (the two hops carry its beat), as on the terminal:
      // the raised claws show from its first frame to its last, the lowered ones never.
      expect(source).toContain('@keyframes hh-mc-la-u{0%{opacity:1}100%{opacity:1}}')
      expect(source).toContain('@keyframes hh-mc-ra-u{0%{opacity:1}100%{opacity:1}}')
      expect(source).toContain('@keyframes hh-mc-la-d{0%{opacity:0}100%{opacity:0}}')
      // The cheer over, the band redraws by itself and he settles.
      await clock.advance(5000)
      expect(svgOf((await read()).tree)?.alt).toBe('Clawd rests.')
    }
    const settled = await read()
    expect(settled.words[2]).toContain('Done in 41s · 2 tools · 1 file changed')
    expect(colors(settled.tree)).not.toContain('success')
    await ui.unmount()
  }
})

test('a turn that only talked says how long it took, with no "0 tools"', async ($, on) => {
  world(on)
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    await prompt($)
    await $.turn.complete({ answer: 'Sure.', durationMs: 12_000, turnId: 't1', ...ANSWERED } as TurnCompleteInput)

    const third = (await read()).words[2] ?? ''
    expect(third).toContain('Done in 12s')
    expect(third).not.toContain('tool')
    await ui.unmount()
  }
})

test('an interrupted or declined turn is a calm "Stopped", with no green and no cheer', async ($, on) => {
  world(on)
  await start($)
  const endings: Ending[] = [
    { reason: 'aborted', isAborted: true },
    { reason: 'refusal', isAborted: false, refusal: { category: null, explanation: null } } as Ending,
  ]

  for (const ending of endings) {
    for (const surface of SURFACES) {
      const watching = await band($, surface)
      await turn($, ending)
      const fresh = await band($, surface)
      for (const { ui, read } of [watching, fresh]) {
        const { words, clawd, tree } = await read()
        expect(words[2]).toContain('Stopped after 41s')
        expect(words[2]).not.toContain('Done')
        if (surface === 'terminal') {
          expect(clawd[0]).not.toMatch(/^▗▟/)
          let colors = ''
          walk(tree, node => {
            colors += ` ${String(node.props?.color ?? '')}`
          })
          expect(colors).not.toContain('success')
        } else {
          expect(svgOf(tree)?.alt).toBe('Clawd rests.')
          expect(svgOf(tree)?.source).not.toContain('@keyframes hh-mc-')
        }
        await ui.unmount()
      }
    }
  }
})

// The color and weight of the run of text that reads exactly `text`.
function runStyle(node: unknown, wanted: string): { color: unknown; bold: boolean } | null {
  let found: { color: unknown; bold: boolean } | null = null
  walk(node, one => {
    const children = one.children ?? []
    if (found === null && one.type === 'Text' && children.length > 0 && children.every(child => typeof child === 'string') && children.join('').trim() === wanted) {
      found = { color: one.props?.color, bold: one.props?.bold === true }
    }
  })

  return found
}

test('past warnAt the number turns clay and bold, Clawd sweats now and then and a toast suggests /compact', async ($, on) => {
  const { toasts } = world(on)
  await start($)
  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    // Below it, the figure is plain, as every other figure on the line.
    expect([surface, runStyle((await read()).lines[1]?.node, '42%')]).toEqual([surface, { color: undefined, bold: false }])
    await ui.unmount()
  }
  await $.session.measure(measured(86, 1.94))
  expect(toasts).toEqual(["Context is 86% full. Run /compact when you're ready."])

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    const { words, tree, lines } = await read()
    expect(words[1]).toContain('86%')
    // Clay, as Claude Code marks what wants a look, and bold so it reads without color too.
    expect([surface, runStyle(lines[1]?.node, '86%')]).toEqual([surface, { color: 'claude', bold: true }])
    expect(words[2]).toContain("Getting full · /compact when you're ready")
    if (surface === 'terminal') {
      // The bead forms beside his head, a cell clear of it, and slides down; it never touches him.
      // Idle, it comes once in sixteen seconds, on ticks 8 to 13 of its cycle.
      await ui.advance(3000)
      const frames: Read[] = []
      for (let i = 0; i < 80; i++) {
        const now = await read()
        expect(now.clawd[0]).toMatch(/^ ▐[▛▟▂█]{6}$/u)
        frames.push(now)
        await ui.advance(250)
      }
      const beads = frames.map(frame => frame.marks[0] ?? '')
      expect(beads).toContain('▘')
      expect(beads).toContain('▖')
      expect(runs(beads.map(bead => bead !== '')).filter(([isBead]) => isBead)).toHaveLength(1)
      // In a quiet stretch: his pose holds still from two ticks before the bead to two after it.
      beads.forEach((bead, i) => {
        if (bead === '' || i < 2 || i + 2 >= frames.length) return
        for (const d of [-2, -1, 1, 2]) expect(frames[i + d]?.clawd).toEqual(frames[i]?.clawd)
      })
    } else {
      const source = svgOf(tree)?.source ?? ''
      expect(source).toContain('class="hh-sw"')
      // Idle, the drop keeps his loop's time, in the rest before his first blink: never with a glance or a blink.
      const loop = /\.hh-el-r\{[^}]*hh-ml-el-r ([\d.]+)s step-end ([\d.]+)s infinite/.exec(source)
      const sweat = /\.hh-sw\{[^}]*animation:hh-sw ([\d.]+)s ease-in ([\d.]+)s infinite/.exec(source)
      expect(Number(sweat?.[1])).toBeGreaterThan(8)
      expect(sweat?.[1]).toBe(loop?.[1])
      expect(sweat?.[2]).toBe(loop?.[2])
      const glance = opacityAt(keyframes(source, 'hh-ml-el-r'), true)
      const blink = opacityAt(keyframes(source, 'hh-ml-el-c'), true)
      const drop = opacityAt(keyframes(source, 'hh-sw'), false)
      for (let pct = 0; pct < 100; pct += 0.25) {
        expect(drop(pct) > 0 && (glance(pct) > 0 || blink(pct) > 0)).toBe(false)
      }
    }
    await ui.unmount()
  }
})

test('sweating while he works, the bead and his claw take turns: they never share a moment or a cell', { timeoutMs: 30_000 }, async ($, on) => {
  let peek: (() => Promise<Read>) | undefined
  let peekUi: { advance: (ms: number) => Promise<unknown> } | undefined
  let peekDesk: (() => Promise<Read>) | undefined
  let deskSource = ''
  const seen: Record<string, Read[]> = {}
  world(on, {
    onCall: async tool => {
      if (peekDesk !== undefined) {
        deskSource = svgOf((await peekDesk()).tree)?.source ?? ''
        return
      }
      const frames: Read[] = []
      for (let i = 0; i < 64; i++) {
        await peekUi?.advance(250)
        const now = await peek?.()
        if (now !== undefined) frames.push(now)
      }
      seen[tool] = frames
    },
  })
  await start($, 86, 1.94)
  const { ui, read } = await band($, 'terminal', { ...BAND, isWorking: true })
  peek = read
  peekUi = ui
  await prompt($, 'go')
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })

  for (const tool of ['Edit', 'Bash']) {
    const frames = seen[tool] ?? []
    expect(frames).toHaveLength(64)
    // His head never holds the bead; the bead shows only while his claws are down.
    for (const frame of frames) {
      expect(frame.clawd[0]).toMatch(/^ ▐[▛▂]███[▛▂]█▄?$/)
      if (/[▘▖]/.test(frame.marks[0] ?? '')) expect(frame.clawd[0]?.endsWith('▄')).toBe(false)
    }
    // Every eight seconds at work, and a good half second clear of any claw or step.
    const beads = frames.map(frame => /[▘▖]/.test(frame.marks[0] ?? ''))
    expect(runs(beads).filter(([isBead]) => isBead).length).toBeGreaterThanOrEqual(2)
    beads.forEach((isBead, i) => {
      if (!isBead) return
      for (const d of [-2, -1, 1, 2]) {
        const near = frames[i + d]
        if (near !== undefined) expect(near.clawd).toEqual(frames[i]?.clawd)
      }
    })
    if (tool === 'Edit') expect(frames.some(frame => frame.clawd[0]?.endsWith('▄'))).toBe(true)
    expectCalm(frames.map(frame => JSON.stringify(frame.tree)))
  }
  await ui.unmount()

  // On the desktop the drop runs on his work loop's clock (eight seconds): the
  // claw is up in its first 1.5 s, the glance at the words from 4.8 s, the drop
  // shows from 2 s to 4.5 s.
  const desk = await band($, 'desktop', { ...BAND, isWorking: true })
  peekDesk = desk.read
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  const tap = /\.hh-ra-u\{[^}]*animation:hh-ml-ra-u ([\d.]+)s step-end ([\d.]+)s infinite/.exec(deskSource)
  const sweat = /\.hh-sw\{[^}]*animation:hh-sw ([\d.]+)s ease-in ([\d.]+)s infinite/.exec(deskSource)
  expect(tap?.[1]).toBe('8')
  expect(sweat?.[1]).toBe('8')
  expect(sweat?.[2]).toBe(tap?.[2])
  const clawUp = opacityAt(keyframes(deskSource, 'hh-ml-ra-u'), true)
  const glance = opacityAt(keyframes(deskSource, 'hh-ml-el-r'), true)
  const dropShown = opacityAt(keyframes(deskSource, 'hh-sw'), false)
  for (let pct = 0; pct < 100; pct += 0.25) {
    expect(dropShown(pct) > 0 && (clawUp(pct) > 0 || glance(pct) > 0)).toBe(false)
  }
  expect(dropShown(35)).toBeGreaterThan(0)
  expect(clawUp(3)).toBe(1)
  expect(glance(65)).toBe(1)
  await desk.ui.unmount()
})

test('near the five-hour limit both surfaces say when it resets, as a time of day that never goes stale', async ($, on) => {
  const { clock } = world(on)
  await start($, 42, 1.2, 91)
  const when = clockText(T0 + 130 * 60_000, T0)
  expect(when).toMatch(/^\d{1,2}(:\d\d)?[ap]m$/)
  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    expect((await read()).words[2]).toBe(`Near the 5h limit · resets ${when}`)
    // A minute on, it still says the same: nothing in it counts down.
    await clock.advance(60_000)
    expect((await read()).words[2]).toBe(`Near the 5h limit · resets ${when}`)
    await ui.unmount()
  }
})

test('near a limit its meter fills clay with its figure, on both surfaces, and at or past it the line says "At" or "Over", never "Near"', async ($, on) => {
  world(on)
  await start($, 42, 1.2, 23)
  for (const [five, said] of [[79, null], [86, 'Near'], [100, 'At'], [104, 'Over']] as const) {
    await $.session.measure(measured(42, 1.2, five))
    for (const surface of SURFACES) {
      const { ui, read } = await band($, surface)
      const seen = await read()
      if (said !== null) expect([surface, five, seen.words[2]]).toEqual([surface, five, expect.stringMatching(new RegExp(`^${said} the 5h limit · resets `, 'u'))])
      if (surface === 'terminal') {
        // The two meters' runs: the context's fill and track, then the limit's.
        const runs: Array<unknown> = []
        walk(seen.lines[1]?.node, node => {
          const only = (node.children ?? []).every(child => typeof child === 'string')
          if (node.type === 'Text' && only && /^━+$/u.test(text(node))) runs.push(node.props?.color)
        })
        expect([five, runs[2]]).toEqual([five, five >= 80 ? 'claude' : 'inactive'])
      } else {
        let pill = ''
        walk(seen.tree, node => {
          if (node.type === 'Svg' && node.props?.alt === `5h limit ${five}% used`) pill = String(node.props.source)
        })
        expect([five, pill.includes(five >= 80 ? '#D77757' : '#A39E93')]).toEqual([five, true])
      }
      await ui.unmount()
    }
  }
})

test('before the first reading the context says so plainly: the meter an empty track and a dash for its figure, never "0%", and the page reads it out', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  for (const surface of SURFACES) {
    for (const columns of [100, 40, 34]) {
      const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns })
      const seen = await read()
      expect([surface, columns, seen.words[1]]).toEqual([surface, columns, expect.stringMatching(/^context\b.*–/u)])
      expect([surface, columns, seen.words.join(' ').includes('0%')]).toEqual([surface, columns, false])
      if (surface === 'terminal') {
        // Where the meter has room it shows as its empty track, all of it the track's quiet color,
        // and where it has none the line reads "context –".
        const runs: unknown[] = []
        walk(seen.lines[1]?.node, node => {
          const only = (node.children ?? []).every(child => typeof child === 'string')
          if (node.type === 'Text' && only && /^━+$/u.test(text(node))) runs.push(node.props?.color)
        })
        expect([columns, seen.words[1]]).toEqual([columns, expect.stringMatching(columns >= 40 ? /^context ━{8,20} – *$/u : /^context – *$/u)])
        expect([columns, runs]).toEqual([columns, columns >= 40 ? ['subtle'] : []])
      }
      if (surface === 'desktop' && columns >= 40) {
        // The empty meter says it to anyone the page is read to (at 34 the meter gives way to its words).
        const alts: string[] = []
        walk(seen.tree, node => {
          if (node.type === 'Svg') alts.push(String(node.props?.alt))
        })
        expect(alts).toContain('No context reading yet')
      }
      await ui.unmount()
    }
  }
  // The first reading fills the meter in place: its figure takes the dash's cell, and nothing before it moves.
  const { ui, read } = await band($, 'terminal')
  const before = (await read()).words[1] ?? ''
  await $.session.measure(measured(42, 0.31, 23))
  const after = (await read()).words[1] ?? ''
  expect([after.indexOf('42%'), after.indexOf('━'), [...after.slice(0, after.indexOf('42%'))].length]).toEqual([before.indexOf('–'), before.indexOf('━'), [...before.slice(0, before.indexOf('–'))].length])
  await ui.unmount()
})

test('a web search keeps its query as the band narrows, "Searching for ink…", the long verb whole or not at all', async ($, on) => {
  const { clock, hold, release } = world(on)
  await start($)
  await prompt($, 'look it up')
  hold('WebSearch')
  const searching = $.tool.call({ tool: 'WebSearch', query: 'ink terminal hyperlinks', mode: 'standard' }).catch(() => undefined)
  await clock.settle()
  await clock.advance(1_500)
  for (const surface of SURFACES) {
    for (const columns of [100, 60, 46, 40]) {
      const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
      if (surface === 'terminal') await ui.advance(1_500)
      const third = (await read()).words[2] ?? ''
      if (columns === 100) expect([surface, third]).toEqual([surface, 'Searching the web for ink terminal hyperlinks'])
      if (columns <= 46) expect([surface, columns, third]).toEqual([surface, columns, expect.stringMatching(/^Searching for ink( term|…$)/u)])
      // The query is cut after a whole word, never inside one.
      expect([surface, columns, /\w…$/u.test(third) && !/(ink|terminal)…$/u.test(third)]).toEqual([surface, columns, false])
      expect([surface, columns, third]).toEqual([surface, columns, expect.stringMatching(/^Searching( the web for [^…]+| for .+)$/u)])
      await ui.unmount()
    }
  }
  release()
  await searching
})

test('words a person wrote (a described command, a todo, a subagent\'s task, a raw command) are cut only after a whole word, on both surfaces at every width', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, hold, release } = world(on)
  await start($)
  await prompt($, 'test it')
  // `label` is the line's own lead-in ("Next up: "), never cut; `alone`, its shorter forms.
  const sweep = async (said: string, alone: RegExp, label = '', isWorking = true) => {
    for (const surface of SURFACES) {
      for (let columns = 34; columns <= 80; columns++) {
        const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking })
        if (surface === 'terminal') await ui.advance(1_500)
        // On the terminal the module hands Ink the whole text in a box as wide as what should show,
        // and Ink cuts it there with its ellipsis: read it as Ink draws it. The todo's tally aside.
        const seen = await read()
        const line = seen.lines[2]
        const box = line === undefined ? undefined : kids(kids(line.node)[0]).find(part => part.type === 'Box' && part.props?.flexShrink === 1)
        const width = Number(box?.props?.width ?? Number.POSITIVE_INFINITY)
        const squeeze = line?.squeeze ?? ''
        const drawn = squeeze !== '' && cells(squeeze) > width ? (seen.words[2] ?? '').replace(squeeze, `${cut(squeeze, width - 1)}…`) : (seen.words[2] ?? '')
        const third = drawn.replace(/\s+\d+(\/| of )\d+ done$/u, '').trim()
        const shown = third.replace(/…$/u, '')
        // Cut after a whole word, and only while seven characters show: "Regenerate…", never "Regen…".
        const whole = `${label}${said}`
        const isWhole = third === whole || alone.test(third) || (third.endsWith('…') && whole.startsWith(shown) && /^[,;:.]?\s/u.test(whole.slice(shown.length)) && [...shown].length - label.length >= 7)
        expect([surface, columns, third, isWhole]).toEqual([surface, columns, third, true])
        await ui.unmount()
      }
    }
  }
  hold('Bash')
  const running = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Regenerate the test fixtures twice' }).catch(() => undefined)
  await clock.settle()
  await clock.advance(1_500)
  await sweep('Regenerate the test fixtures twice', /^Running$/u)
  release()
  await running
  await $.tool.call({ tool: 'TaskCreate', subject: 'Draw the beach', description: '', activeForm: 'Drawing the whole beach, shell and all' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await clock.advance(1_500)
  await sweep('Drawing the whole beach, shell and all', /^Thinking$/u)
  // Queued next, beside its label: "Next up: Regenerate the test…", two whole words at least, never
  // "Next up: Regenerate…"; narrower, what the line says with nothing queued.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Regenerate the test fixtures', description: '', activeForm: 'Regenerating the fixtures' })
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', ...ANSWERED } as TurnCompleteInput)
  await clock.advance(10_000)
  await sweep('Regenerate the test fixtures', /^Done\b/u, 'Next up: ', false)
  // A subagent's task, and a raw command, are words too: "Delegating: Explore the hooks…", never
  // "Delegating Explore the hoo…"; "Running git log…", never "Running git log --o…".
  await prompt($, 'look around')
  hold('Agent')
  const delegating = $.tool.call({ tool: 'Agent', description: 'Explore the hooks folder', prompt: 'x', subagent_type: 'Explore' }).catch(() => undefined)
  await clock.settle()
  await clock.advance(1_500)
  await sweep('Explore the hooks folder', /^Delegating$/u, 'Delegating: ')
  release()
  await delegating
  hold('Bash')
  const raw = $.tool.call({ tool: 'Bash', command: 'git log --oneline --graph --decorate' }).catch(() => undefined)
  await clock.settle()
  await clock.advance(1_500)
  await sweep('git log --oneline --graph --decorate', /^Running$/u, 'Running ')
  release()
  await raw
  // A raw command that failed: its hiccup keeps whole words too ("Hiccup · npm test…"); narrower,
  // what failed in a word ("Hiccup · A command", "Hiccup · A tool"), then "Hiccup".
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail --reporter=verbose' })
  await clock.advance(1_500)
  await sweep('npm test -- fail --reporter=verbose', /^Hiccup(?: · A (?:command|tool))?$/u, 'Hiccup · ')
})

test('a todo beside its tally is never cut: the tally goes first, and a narrower band never shows more of the todo than a wider one, on both surfaces', { timeoutMs: 240_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'test it')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Draw the beach', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Draw the shell', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the tests for the splash ladder', description: '', activeForm: 'Writing the tests for the splash ladder' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'in_progress' })
  await clock.advance(3_000)
  const tally = /\s+\d+(?:\/| of )\d+ done$/u
  // `label` is the line's own lead-in ("Next up: "); `alone`, what the line says with no room for the todo.
  const sweep = async (todo: string, alone: RegExp, label: string, isWorking: boolean) => {
    for (const surface of SURFACES) {
      let fewer = Number.POSITIVE_INFINITY
      const seen: string[] = []
      for (let columns = 80; columns >= 34; columns--) {
        const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking })
        if (surface === 'terminal') await ui.advance(1_500)
        const third = await drawnThird(read)
        const words = third.replace(tally, '')
        // Beside a tally the todo is whole ("Writing… 2 of 3 done" read as an order cut short, and the
        // tally won over the words it counts).
        if (tally.test(third)) expect([surface, columns, third]).toEqual([surface, columns, `${label}${todo}${third.slice(words.length)}`])
        // How much of the todo shows: never more at a narrower band.
        const shown = alone.test(words) ? 0 : [...words.slice(label.length).replace(/…$/u, '')].length
        expect([surface, columns, third, words.startsWith(label) || alone.test(words)]).toEqual([surface, columns, third, true])
        expect([surface, columns, third, shown <= fewer]).toEqual([surface, columns, third, true])
        fewer = shown
        seen.push(third)
        await ui.unmount()
      }
      // Wide, the whole todo and its tally; narrower, the todo alone, cut after a whole word.
      expect([surface, seen.some(third => tally.test(third)), seen.some(third => /\s\S+…$/u.test(third))]).toEqual([surface, true, true])
    }
  }
  await sweep('Writing the tests for the splash ladder', /^Thinking$/u, '', true)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'pending' })
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, turnId: 't1', ...ANSWERED } as TurnCompleteInput)
  await clock.advance(10_000)
  await sweep('Write the tests for the splash ladder', /^(?:Done|Ready)\b/u, 'Next up: ', false)
})

// Line 3 as it is drawn: on the terminal the module hands Ink the whole text in a box as wide as
// what should show, and Ink cuts it there with its ellipsis.
async function drawnThird(read: () => Promise<Read>): Promise<string> {
  const seen = await read()
  const line = seen.lines[2]
  const box = line === undefined ? undefined : kids(kids(line.node)[0]).find(part => part.type === 'Box' && part.props?.flexShrink === 1)
  const width = Number(box?.props?.width ?? Number.POSITIVE_INFINITY)
  const squeeze = line?.squeeze ?? ''

  return (squeeze !== '' && cells(squeeze) > width ? (seen.words[2] ?? '').replace(squeeze, `${cut(squeeze, width - 1)}…`) : (seen.words[2] ?? '')).trim()
}

test('a raw command with no space early on shows a part of itself on both surfaces, cut after a part of its path, never inside a word nor on a shell joint', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, hold, release } = world(on)
  await start($)
  await prompt($, 'test it')
  for (const command of ['node_modules/.bin/vitest-run-everything-without-spaces --watch', 'cd /Users/robin/projects/agent-plugins && npm test']) {
    hold('Bash')
    const running = $.tool.call({ tool: 'Bash', command }).catch(() => undefined)
    await clock.settle()
    await clock.advance(1_500)
    for (const surface of SURFACES) {
      for (const columns of [34, 40, 46, 52, 64, 80, 100, 140]) {
        const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        if (surface === 'terminal') await ui.advance(1_500)
        const third = await drawnThird(read)
        // Something of it from 52 columns, where the panel has room: never the bare verb, even on
        // the desktop, whose panel never had room for the whole first word.
        if (columns >= 52) expect([surface, columns, third]).toEqual([surface, columns, expect.stringMatching(/^Running ./u)])
        if (third.endsWith('…')) {
          const shown = third.replace(/^Running /u, '').replace(/…$/u, '')
          const isPart = command.startsWith(shown) && /^[\s/._-]/u.test(command.slice(shown.length)) && [...shown].length >= 7 && !/(&&|\|)$/u.test(shown)
          expect([surface, columns, third, isPart]).toEqual([surface, columns, third, true])
        }
        await ui.unmount()
      }
    }
    release()
    await running
  }
})

test('a cut of words a person wrote never ends on a little word ("why", "the", "at"), on either surface', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, hold, release } = world(on)
  await start($)
  await prompt($, 'test it')
  const said = 'Investigate why the desktop band reloads twice at startup'
  hold('Bash')
  const running = $.tool.call({ tool: 'Bash', command: 'npm test', description: said }).catch(() => undefined)
  await clock.settle()
  await clock.advance(1_500)
  const little = /\s(?:a|an|and|at|by|for|from|in|into|of|on|or|the|to|why|with)$/iu
  const seen = new Set<string>()
  for (const surface of SURFACES) {
    for (let columns = 34; columns <= 110; columns += 2) {
      const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
      if (surface === 'terminal') await ui.advance(1_500)
      const third = await drawnThird(read)
      seen.add(third)
      if (third.endsWith('…')) expect([surface, columns, third, little.test(third.replace(/…$/u, ''))]).toEqual([surface, columns, third, false])
      await ui.unmount()
    }
  }
  expect([...seen]).toEqual(expect.arrayContaining(['Investigate…', 'Investigate why the desktop band reloads twice…']))
  release()
  await running
})

// The finer cuts, across every width, as on the beach: a task may stop after its first real word
// ("Survey…", never the stub "Survey the…"); a name never stops inside its extension ("register.t…");
// a command never stops on a one-letter flag whose argument is gone ("--noEmit -p…").
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

test('the finer cuts: a task may stop after its first real word, a name never inside its extension, a command never on a flag that lost its argument, on either surface', { timeoutMs: 240_000 }, async ($, on) => {
  const { clock, hold, release } = world(on)
  await start($)
  await prompt($, 'test it')
  for (const { call, never, seen } of FINE_CUTS) {
    hold(call.tool)
    const running = $.tool.call(call as never).catch(() => undefined)
    await clock.settle()
    await clock.advance(1_500)
    for (const surface of SURFACES) {
      const thirds = new Set<string>()
      for (let columns = 34; columns <= 140; columns += 2) {
        const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking: true })
        if (surface === 'terminal') await ui.advance(1_500)
        const third = await drawnThird(read)
        thirds.add(third)
        expect([call.tool, surface, columns, third, never.test(third)]).toEqual([call.tool, surface, columns, third, false])
        await ui.unmount()
      }
      expect([call.tool, surface, thirds.has(seen)]).toEqual([call.tool, surface, true])
    }
    release()
    await running
  }
})

test('bold never sits right beside dim words, on either surface', async ($, on) => {
  world(on, { branch: 'claude/first-mod' })
  // A full context (a bold clay figure) and a 5h limit near its end (another).
  await start($, 100, 123.45, 100)

  for (const surface of SURFACES) {
    for (const columns of surface === 'terminal' ? [34, 48, 64, 80, 100, 140] : [100]) {
      const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns })
      const { lines } = await read()
      let bolds = 0
      for (const line of lines) {
        if (surface === 'terminal') {
          // One row of the terminal, leaf after leaf, whatever box each sits in.
          const row = leaves(line.node)
          bolds += row.filter(leaf => leaf.isBold).length
          expectBoldApartFromDim(row)
        } else {
          // On the desktop, each run of text.
          walk(line.node, node => {
            if (node.type === 'Text' && kids(node).length > 0) expectBoldApartFromDim(leaves({ ...node, children: kids(node) }))
            if (node.type === 'Text' && node.props?.bold === true) bolds += 1
          })
        }
      }
      expect(bolds).toBeGreaterThanOrEqual(surface === 'terminal' && columns < 38 ? 2 : 3)
      await ui.unmount()
    }
  }
})

test('calm keeps a flinch to one pose: eyes shut the whole time, then open', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await start($)
  expect((await run($, 'band', 'still')).text).toMatch(/^Still\. /u)
  const { ui, read } = await band($, 'terminal', { ...BAND, isWorking: true })
  await prompt($, 'run it')
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })

  // The hiccup goes up at once, over its own tool, as the desktop's does; six frames with his eyes shut.
  const heads: string[] = [(await read()).clawd[0] ?? '']
  for (let i = 0; i < 11; i++) {
    await ui.advance(250)
    heads.push((await read()).clawd[0] ?? '')
  }
  expect(heads.slice(0, 6)).toEqual(Array(6).fill(HEAD.closed))
  expect(heads.slice(6)).toEqual(Array(6).fill(HEAD.open))
  await ui.unmount()
})

test('still, the desktop draws no hello, and its alt text says none: he rests', async ($, on) => {
  world(on)
  await start($)
  await run($, 'band', 'still')
  const { ui, read } = await band($, 'desktop')
  const svg = svgOf((await read()).tree)
  expect([svg?.alt, svg?.source.includes('@keyframes hh-qw-')]).toEqual(['Clawd rests.', false])
  await ui.unmount()
})

// Still, he sits without a move, so the words never say he "taps along".
test('still, at work, the alt text says he sits quietly, never that he taps along; a bead of sweat is said as it shows', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await run($, 'band', 'still')
  const busy = await band($, 'desktop', { ...BAND, isWorking: true })
  const now = async () => svgOf((await busy.read()).tree)
  await prompt($, 'more')
  await $.tool.call({ tool: 'Edit', file_path: '/work/b.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(3_000)
  expect((await now())?.alt).toBe('Clawd sits quietly while Claude works.')
  await $.session.measure(measured(87, 2.2))
  await clock.advance(600)
  expect(await now()).toEqual(expect.objectContaining({ alt: 'Clawd sits quietly while Claude works, a bead of sweat on his brow.', source: expect.stringContaining('class="hh-sw"') }))
  // Lively again, he taps along.
  await run($, 'band', 'lively')
  await clock.advance(600)
  expect((await now())?.alt).toBe('Clawd taps along, a bead of sweat on his brow.')
  await busy.ui.unmount()
})

test('he waves hello when the band first appears in a session, and not each time it comes back', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const raised = async (surface: Surface) => {
    const { ui, read } = await band($, surface)
    let isRaised = false
    if (surface === 'terminal') {
      for (let i = 0; i < 12; i++) {
        isRaised ||= (await read()).clawd[0]?.endsWith('▄') ?? false
        await ui.advance(250)
      }
    } else {
      isRaised = (svgOf((await read()).tree)?.source ?? '').includes('@keyframes hh-mw-')
    }
    await ui.unmount()

    return isRaised
  }

  expect(await raised('terminal')).toBe(true)
  expect(await raised('desktop')).toBe(true)
  // A dialog hid the band for a minute; it comes back without a second hello.
  await clock.advance(60_000)
  expect(await raised('terminal')).toBe(false)
  expect(await raised('desktop')).toBe(false)
})

// The hello as a band that comes and goes shows it: whether his claw is up, tick by tick.
async function claws($: Engine, clock: ReturnType<typeof mock.clock>, ticks: number): Promise<boolean[]> {
  const { ui, read } = await band($, 'terminal')
  const up: boolean[] = []
  for (let i = 0; i < ticks; i++) {
    up.push((await read()).clawd[0]?.endsWith('▄') ?? false)
    await ui.advance(250)
    await clock.advance(250)
  }
  await ui.unmount()

  return up
}

test('terminal: a band back mid-hello carries the wave on from where it was, never from the start', async ($, on) => {
  const { clock } = world(on)
  await start($)
  // Up, down, up again, as one hello: half a second of it, a dialog, then the rest.
  const first = await claws($, clock, 2)
  const rest = await claws($, clock, 10)
  expect([...first, ...rest]).toEqual([true, true, true, false, false, true, true, true, false, false, false, false])
})

test('terminal: a band back late in the hello waves no more: a lone claw going up would not read as hello', async ($, on) => {
  const { clock } = world(on)
  await start($)
  expect(await claws($, clock, 6)).toEqual([true, true, true, false, false, true])
  expect(await claws($, clock, 8)).toEqual(new Array(8).fill(false))
})

test('after a while idle Clawd naps, eyes closed, and the words stay as they were', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($)
  await clock.advance(5 * 60_000)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    const { clawd, words, tree } = await read()
    expect(words[2]).toContain('Done in 41s · 2 tools · 1 file changed')
    if (surface === 'terminal') {
      expect(clawd[0]).toBe(HEAD.closed)
    } else {
      expect(svgOf(tree)?.alt).toBe('Clawd naps.')
    }
    await ui.unmount()
  }
})

// The hearth's words are its readout and Clawd carries the mood, so a nap changes him and not line 3:
// before any turn it still says "Ready when you are", which a prompt makes good at once.
test('a nap before the first turn keeps "Ready when you are" on line 3 while his eyes close', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await clock.advance(5 * 60_000)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    const { clawd, words, tree } = await read()
    expect([surface, words[2]]).toEqual([surface, expect.stringMatching(/^Ready when you are *$/u)])
    if (surface === 'terminal') {
      expect(clawd[0]).toBe(HEAD.closed)
    } else {
      expect(svgOf(tree)?.alt).toBe('Clawd naps.')
    }
    await ui.unmount()
  }
})

test('on the terminal he dozes off by himself while the band stays up, and a z drifts up', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await start($)
  const { ui, read } = await band($, 'terminal')
  await turn($)

  await ui.advance(60_000)
  expect((await read()).clawd[0]).not.toBe(HEAD.closed)
  await ui.advance(150_000)
  const marks: string[] = []
  for (let i = 0; i < 16; i++) {
    const now = await read()
    expect(now.clawd[0]).toBe(HEAD.closed)
    marks.push(now.marks.join('|'))
    await ui.advance(250)
  }
  expect(marks).toContain('| z|')
  expect(marks).toContain('  z||')
  await ui.unmount()
})

test('a fresh session left alone dozes off too, on the terminal as on the desktop', async ($, on) => {
  const { clock } = world(on)
  await start($)
  const term = await band($, 'terminal')
  await term.ui.advance(2 * 60_000)
  expect((await term.read()).clawd[0]).not.toBe(HEAD.closed)
  await term.ui.advance(70_000)
  expect((await term.read()).clawd[0]).toBe(HEAD.closed)
  await term.ui.unmount()

  const desk = await band($, 'desktop')
  expect(svgOf((await desk.read()).tree)?.source).toMatch(/\.hh-el-c\{opacity:0;animation:[^}]*hh-mn-el-c 1s step-end 180s 1 forwards\}/)
  // Three minutes on, a redraw comes by itself and draws him asleep.
  await clock.advance(3 * 60_000 + 2000)
  expect(svgOf((await desk.read()).tree)?.alt).toBe('Clawd naps.')
  await desk.ui.unmount()
})

test('clicking Clawd on the terminal spins him round, then he winks with a pixel heart', async ($, on) => {
  world(on)
  await start($)

  const term = await band($, 'terminal')
  await term.ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'hearth' })
  // The click's frame goes up at once and holds through the next tick, the clock with it, so a
  // click just before a tick never makes a fifth frame in that second, and no frame is lost.
  const clicked = (await term.read()).clawd
  await term.ui.advance(250)
  expect((await term.read()).clawd).toEqual(clicked)
  // Claude Code's own 13 turning frames, a tick each; a second click mid-spin changes nothing.
  const turning: string[][] = []
  for (let i = 0; i < SPIN.length; i++) {
    const now = await term.read()
    turning.push(now.clawd)
    expect(now.marks).toEqual(['', '', ''])
    if (i === 3) await term.ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'hearth' })
    await term.ui.advance(250)
  }
  expect(turning).toEqual(SPIN.map(([head, , , middle, , , feet]) => [head.trimEnd(), middle.trimEnd(), feet.trimEnd()]))
  // Facing you again: a wink, arms up, and a two-row heart beside him that floats up a row.
  const petted = await term.read()
  expect(petted.clawd[0]).toBe('▗▟▛███▂█▄')
  expect(petted.marks).toEqual(['', '▗█▟▙', ' ▀▛▘'])
  await term.ui.advance(1000)
  const after = await term.read()
  expect(after.marks).toEqual(['▗█▟▙', ' ▀▛▘', ''])
  expect(after.clawd[0]).toBe(HEAD.open)
  await term.ui.advance(1500)
  expect((await term.read()).rows.join('\n')).not.toContain('▗█▟▙')
  await term.ui.unmount()
})

test('calm, or in Apple’s Terminal, a click is the wink and the heart alone', { timeoutMs: 30_000 }, async ($, on) => {
  world(on, { env: { TERM_PROGRAM: 'Apple_Terminal' } })
  await start($)

  const apple = await band($, 'terminal')
  await apple.ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'hearth' })
  expect((await apple.read()).marks).toEqual(['', '▗█▟▙', ' ▀▛▘'])
  await apple.ui.unmount()

  await run($, 'band', 'still')
  const calm = await band($, 'terminal')
  await calm.ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'hearth' })
  const marks = new Set<string>()
  for (let i = 0; i < 12; i++) {
    marks.add((await calm.read()).marks.join('|'))
    await calm.ui.advance(250)
  }
  expect([...marks]).toEqual(['|▗█▟▙| ▀▛▘'])
  await calm.ui.unmount()
})

test('on the desktop a pet is a heart beside him, or over his sleeping head clear of the z, and every class and keyframe is his own', async ($, on) => {
  const { clock } = world(on)
  await start($, 86, 1.94)
  const seen: Array<{ clawd: string; heart: string }> = []
  const both = (tree: unknown) => ({ clawd: svgOf(tree)?.source ?? '', heart: heartOf(tree) })
  const desk = await band($, 'desktop', { ...BAND, isWorking: true })
  await prompt($, 'go')
  await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', description: 'Run the tests' })
  seen.push(both((await desk.read()).tree))
  await desk.ui.unmount()
  for (const step of [0, 5 * 60_000]) {
    await clock.advance(step)
    const { ui, read } = await band($, 'desktop')
    if (step === 0) await turn($)
    seen.push(both((await read()).tree))
    await ui.unmount()
  }
  await run($, 'band', 'still')
  const still = await band($, 'desktop')
  seen.push(both((await still.read()).tree))
  await still.ui.unmount()

  for (const [i, { clawd, heart }] of seen.entries()) {
    expect([i, heart]).toEqual([i, expect.stringMatching(/^<svg /u)])
    const box = (source: string, group: string) => {
      const d = new RegExp(`class="${group}"[^>]*><path d="([^"]+)"`).exec(source)?.[1] ?? ''
      const at = [...d.matchAll(/-?[\d.]+/g)].map(found => Number(found[0]))
      const xs = at.filter((_, k) => k % 2 === 0)
      const ys = at.filter((_, k) => k % 2 === 1)
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
    }
    const shown = box(heart, 'hh-ht')
    if (i < 2) {
      // Awake, the heart stands up beside his right claw (he is 1 to 18 across), never on him.
      expect([i, shown.left >= 18, shown.top < 2]).toEqual([i, true, true])
    } else {
      // Asleep (5 minutes on, lively, then still) it is over his head (his body starts at y 0),
      // and never covers the z, the z's pen included.
      const z = box(clawd, 'hh-z')
      const pen = 0.25
      const isApart = shown.right <= z.left - pen || shown.left >= z.right + pen || shown.bottom <= z.top - pen || shown.top >= z.bottom + pen
      expect([i, shown.bottom <= 0, isApart]).toEqual([i, true, true])
    }
    for (const source of [clawd, heart]) {
      const css = /<style>(.*)<\/style>/.exec(source)?.[1] ?? ''
      for (const [, names] of source.matchAll(/class="([^"]+)"/g)) {
        for (const name of (names ?? '').split(' ')) expect(name.startsWith('hh-')).toBe(true)
      }
      for (const [, name] of css.matchAll(/@keyframes ([^{]+)\{/g)) expect(name?.startsWith('hh-')).toBe(true)
      for (const [, name] of css.matchAll(/\.([a-z][\w-]*)/g)) expect(name?.startsWith('hh-')).toBe(true)
      for (const [, uses] of css.matchAll(/animation:([^;}]+)/g)) {
        for (const use of (uses ?? '').split(',')) expect(/^(none|hh-[\w-]+ )/.test(use.trim()) || use.trim() === 'none').toBe(true)
      }
    }
  }
  // Lively, the heart beats softly where the page asks for no less motion; calm, it keeps still.
  for (const { heart } of seen.slice(0, 3)) expect(heart).toContain('@media (prefers-reduced-motion:no-preference){.hh-ht{animation:hh-beat 1.6s ease-in-out infinite}}')
  expect(seen[3]?.heart).not.toContain('animation:')
})

test('on the desktop, as he dozes off by himself the heart a pet brings moves over his head the moment his z comes, clear of it, lively or calm', async ($, on) => {
  world(on)
  await start($, 86, 1.94)
  const box = (source: string, group: string, [dx, dy] = [0, 0]) => {
    const d = new RegExp(`class="${group}"[^>]*><path d="([^"]+)"`).exec(source)?.[1] ?? ''
    const at = [...d.matchAll(/-?[\d.]+/g)].map(found => Number(found[0]))
    const xs = at.filter((_, k) => k % 2 === 0).map(x => x + dx)
    const ys = at.filter((_, k) => k % 2 === 1).map(y => y + dy)
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
  }
  for (const motion of ['lively', 'still'] as const) {
    await run($, 'band', motion)
    const { ui, read } = await band($, 'desktop')
    await turn($)
    const tree = (await read()).tree
    const [clawd, heart] = [svgOf(tree)?.source ?? '', heartOf(tree)]
    // It moves when his z comes: lively, and under reduced motion in the calm timing; held still,
    // only the calm timing is drawn.
    const calmZ = /\.hh-z\{opacity:0;transform:none;animation:hh-on 1s step-end ([\d.]+)s/u.exec(clawd)?.[1]
    const livelyZ = /\.hh-z\{[^}]*animation:hh-zz 3s ease-out ([\d.]+)s/u.exec(clawd)?.[1]
    const moves = [...heart.matchAll(/\.hh-hp\{animation:hh-doze 1s step-end ([\d.]+)s 1 forwards\}/gu)].map(found => found[1])
    expect([motion, calmZ === undefined, moves]).toEqual([motion, false, motion === 'lively' ? [livelyZ, calmZ] : [calmZ]])
    if (motion === 'lively') expect(heart).toContain('@media (prefers-reduced-motion:reduce){.hh-hp{')
    // Moved there, the heart is over his head (his body starts at y 0) and never covers the z, the
    // z's pen included.
    const [, dx = '0', dy = '0'] = /@keyframes hh-doze\{0%,100%\{transform:translate\((-?[\d.]+)px,(-?[\d.]+)px\)\}\}/u.exec(heart) ?? []
    const moved = box(heart, 'hh-ht', [Number(dx), Number(dy)])
    const z = box(clawd, 'hh-z')
    const pen = 0.25
    const isApart = moved.right <= z.left - pen || moved.left >= z.right + pen || moved.bottom <= z.top - pen || moved.top >= z.bottom + pen
    expect([motion, Number(dx) !== 0 || Number(dy) !== 0, moved.bottom <= 0, isApart]).toEqual([motion, true, true, true])
    await ui.unmount()
  }
})

test('the terminal stays still between moments: at most four frames a second, none while idle', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await start($)
  await turn($)

  const idle = await band($, 'terminal')
  await idle.ui.advance(5000)
  const quiet: string[] = []
  for (let i = 0; i < 16; i++) {
    quiet.push(JSON.stringify((await idle.read()).tree))
    await idle.ui.advance(250)
  }
  expect(new Set(quiet).size).toBeLessThanOrEqual(2)
  await idle.ui.unmount()

  const busy = await band($, 'terminal', { ...BAND, isWorking: true })
  const frames: string[] = []
  for (let i = 0; i < 40; i++) {
    frames.push(JSON.stringify((await busy.read()).tree))
    await busy.ui.advance(125)
  }
  const changes = frames.flatMap((frame, i) => (i > 0 && frame !== frames[i - 1] ? [i] : []))
  for (let i = 1; i < changes.length; i++) {
    expect((changes[i] ?? 0) - (changes[i - 1] ?? 0)).toBeGreaterThanOrEqual(2)
  }
  await busy.ui.unmount()
})

test('eyes open is home: at work he looks sideways under 30% of the time, glancing at the words as a read starts', { timeoutMs: 60_000 }, async ($, on) => {
  const kinds: Array<[string, Record<string, unknown> & { tool: string }]> = [
    ['Read', { tool: 'Read', file_path: '/work/clawd.ts' }],
    ['Grep', { tool: 'Grep', pattern: 'eyes' }],
    ['WebFetch', { tool: 'WebFetch', url: 'https://claude.com/brand', prompt: 'colors' }],
    ['Edit', { tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' }],
    ['Bash', { tool: 'Bash', command: 'npm test', description: 'Run the tests' }],
    ['Agent', { tool: 'Agent', description: 'Look around', prompt: 'look' }],
  ]
  let peek: (() => Promise<Read>) | undefined
  let peekUi: { advance: (ms: number) => Promise<unknown> } | undefined
  const seen: Record<string, Read[]> = {}
  const { clock } = world(on, {
    onCall: async tool => {
      const frames: Read[] = []
      for (let i = 0; i < 240; i++) {
        const now = await peek?.()
        if (now !== undefined) frames.push(now)
        await peekUi?.advance(250)
      }
      seen[tool] = frames
    },
  })
  // A full context too: the bead never lands with a glance.
  await start($, 86, 1.94)

  const thinking = await band($, 'terminal', { ...BAND, isWorking: true })
  await prompt($, 'think')
  const thought: Read[] = []
  for (let i = 0; i < 240; i++) {
    thought.push(await thinking.read())
    await thinking.ui.advance(250)
  }
  seen.thinking = thought
  await thinking.ui.unmount()

  for (const [, call] of kinds) {
    // The last tool's line has had its second and its pause, and "Thinking it over" its own second:
    // this one has the line from its start.
    await clock.advance(3_000)
    const { ui, read } = await band($, 'terminal', { ...BAND, isWorking: true })
    peek = read
    peekUi = ui
    await $.tool.call(call as Parameters<Engine['tool']['call']>[0])
    await ui.unmount()
  }

  for (const kind of ['thinking', ...kinds.map(([name]) => name)]) {
    const frames = seen[kind] ?? []
    expect(frames).toHaveLength(240)
    const heads = frames.map(frame => frame.clawd[0] ?? '')
    // Sixty seconds of work: eyes on you most of the time; a blink every five
    // seconds or so and the odd glance, never a flurry.
    const eyes = heads.map(head => head.slice(2, 8))
    expect(heads.filter(isSideways).length).toBeLessThanOrEqual(72)
    expect(eyes.filter(eye => eye === '▛███▛█').length).toBeGreaterThan(160)
    expect(eyes.filter((eye, i) => i > 0 && eye !== eyes[i - 1]).length).toBeLessThanOrEqual(36)
    expectCalm(eyes)
    // The bead keeps clear of every glance and blink.
    frames.forEach((frame, i) => {
      if (/[▘▖]/.test(frame.marks[0] ?? '')) {
        for (const d of [-2, -1, 1, 2]) {
          const near = frames[i + d]
          if (near !== undefined) expect(near.clawd).toEqual(frame.clawd)
        }
      }
    })
    if (kind === 'Read' || kind === 'Grep' || kind === 'WebFetch') {
      // A read starts (shown on the next tick, so the beat he is in has its tick): he looks over at
      // the words for two seconds, then back at you...
      expect(heads[0]).toBe(HEAD.open)
      expect(heads.slice(1, 9).every(head => head.includes('█▟███▟'))).toBe(true)
      expect(heads[9]).toBe(HEAD.open)
      // ...and again every ten to sixteen seconds, two seconds each time.
      const looks = runs(heads.map(head => head.includes('█▟███▟'))).filter(([isLook]) => isLook)
      expect(looks.length).toBeGreaterThanOrEqual(4)
      for (const [, , length] of looks) expect(length).toBe(8)
      for (let i = 1; i < looks.length; i++) {
        const gap = (looks[i]?.[1] ?? 0) - (looks[i - 1]?.[1] ?? 0)
        expect(gap).toBeGreaterThanOrEqual(40)
        expect(gap).toBeLessThanOrEqual(64)
      }
    }
  }
})

test('the terminal module calls setState only when the frame it would draw has changed', () => {
  let sets = 0
  let state: unknown
  const ticks: Array<() => void> = []
  const surface = {
    elements: { Box: 'Box', Text: 'Text' },
    get state() {
      return state
    },
    setState: (next: unknown) => {
      sets += 1
      state = next
    },
    columns: 100,
    rows: 3,
    every: (_ms: number, fn: () => void) => {
      ticks.push(fn)
      return () => undefined
    },
    onPointer: () => () => undefined,
    onKey: () => () => undefined,
    post: () => undefined,
  }
  const props: BandProps = {
    isStill: true,
    isAppleTerminal: false,
    isGreeting: false,
    columns: 100,
    isWorking: false,
    isHigh: false,
    model: 'Opus 5.5',
    project: 'agent-plugins',
    branch: 'main',
    dirty: 2,
    percent: 42,
    cost: '$0.31',
    limit: null,
    idleMs: 10_000,
    activity: null,
    slip: null,
    lastSlip: null,
    slipAgoMs: null,
    flinchAgoMs: null,
    lastTurn: { seconds: 41, tools: 2, files: 1, ending: 'answer' },
    todos: null,
    cheers: 0,
    oops: 0,
    shownForMs: null,
  }
  const draw = Band as unknown as (props: BandProps, surface: unknown) => unknown
  const tick = () => ticks.forEach(fn => fn())

  draw(props, surface)
  expect(sets).toBe(1)
  // New props (the cost went up): the call that draws them is the redraw.
  draw({ ...props, cost: '$0.32' }, surface)
  draw({ ...props, cost: '$0.33', percent: 43 }, surface)
  for (let i = 0; i < 8; i++) tick()
  expect(sets).toBe(1)
})

test('a cheer never ends on a blink: his eyes stay open for the 750 ms after his arms come down', () => {
  const draw = Band as unknown as (props: BandProps, surface: unknown) => unknown
  const props: BandProps = {
    isStill: false,
    isAppleTerminal: false,
    isGreeting: false,
    columns: 100,
    isWorking: false,
    isHigh: false,
    model: 'Opus 5.5',
    project: 'agent-plugins',
    branch: 'main',
    dirty: 2,
    percent: 42,
    cost: '$0.31',
    limit: null,
    idleMs: 10_000,
    activity: null,
    slip: null,
    lastSlip: null,
    slipAgoMs: null,
    flinchAgoMs: null,
    lastTurn: { seconds: 41, tools: 2, files: 1, ending: 'answer' },
    todos: null,
    cheers: 0,
    oops: 0,
    shownForMs: null,
  }
  // The cheer lands at every point of two stretches of his blink rhythm (one blink in each 23 ticks, placed by the dice).
  for (let offset = 0; offset < 46; offset++) {
    let state: { drawn: string } | undefined
    const ticks: Array<() => void> = []
    const surface = {
      elements: { Box: 'Box', Text: 'Text' },
      get state() {
        return state
      },
      setState: (next: { drawn: string }) => {
        state = next
      },
      columns: 100,
      rows: 3,
      every: (_ms: number, fn: () => void) => {
        ticks.push(fn)
        return () => undefined
      },
      onPointer: () => () => undefined,
      onKey: () => () => undefined,
      post: () => undefined,
    }
    const tick = () => ticks.forEach(fn => fn())
    const shut = () => JSON.stringify((JSON.parse(state?.drawn ?? '{}') as { sprite?: unknown[] }).sprite?.[0] ?? '').includes('▂')

    draw(props, surface)
    for (let i = 0; i < offset; i++) tick()
    draw({ ...props, cheers: 1, idleMs: 0, lastTurn: { seconds: 9, tools: 1, files: 1, ending: 'answer' } }, surface)
    const eyes: boolean[] = []
    for (let i = 0; i < 16 + 3; i++) {
      tick()
      eyes.push(shut())
    }
    // Ticks 16 to 18 after the cheer began: his arms are down and his eyes open.
    expect([offset, eyes.slice(15, 18)]).toEqual([offset, [false, false, false]])
  }
})

test('idle, he blinks every 4.5 to 7 seconds, never on a fixed beat', () => {
  const draw = Band as unknown as (props: BandProps, surface: unknown) => unknown
  const props: BandProps = {
    isStill: false,
    isAppleTerminal: false,
    isGreeting: false,
    columns: 100,
    isWorking: false,
    isHigh: false,
    model: 'Opus 5.5',
    project: 'agent-plugins',
    branch: 'main',
    dirty: 2,
    percent: 42,
    cost: '$0.31',
    limit: null,
    idleMs: 10_000,
    activity: null,
    slip: null,
    lastSlip: null,
    slipAgoMs: null,
    flinchAgoMs: null,
    lastTurn: { seconds: 41, tools: 2, files: 1, ending: 'answer' },
    todos: null,
    cheers: 0,
    oops: 0,
    shownForMs: null,
  }
  let state: { drawn: string } | undefined
  const ticks: Array<() => void> = []
  const surface = {
    elements: { Box: 'Box', Text: 'Text' },
    get state() {
      return state
    },
    setState: (next: { drawn: string }) => {
      state = next
    },
    columns: 100,
    rows: 3,
    every: (_ms: number, fn: () => void) => {
      ticks.push(fn)
      return () => undefined
    },
    onPointer: () => () => undefined,
    onKey: () => () => undefined,
    post: () => undefined,
  }
  const shut = () => JSON.stringify((JSON.parse(state?.drawn ?? '{}') as { sprite?: unknown[] }).sprite?.[0] ?? '').includes('▂')
  draw(props, surface)
  // Two minutes idle, well short of a nap.
  const eyes: boolean[] = []
  for (let i = 0; i < 480; i++) {
    ticks.forEach(fn => fn())
    eyes.push(shut())
  }
  const blinks = eyes.flatMap((isShut, i) => (isShut && !eyes[i - 1] ? [i] : []))
  const gaps = blinks.slice(1).map((at, i) => at - (blinks[i] ?? 0))
  expect(blinks.length).toBeGreaterThanOrEqual(15)
  // One tick each, 4.5 s apart at the least; a gap past 7 s is a blink kept clear of a glance.
  expect(eyes.filter(Boolean).length).toBe(blinks.length)
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(18)
  expect(gaps.filter(gap => gap <= 28).length).toBeGreaterThanOrEqual(gaps.length - 3)
  // Not clockwork: at least four different gaps.
  expect(new Set(gaps).size).toBeGreaterThanOrEqual(4)
})

test('lively too, the terminal module never draws a frame that matches the one on screen', () => {
  // A host that draws again on every setState: a draw that comes out the same as the last is a wasted frame.
  const drive = (props: BandProps, ticks: number, clickAt?: number) => {
    let state: unknown
    let sets = 0
    let wasted = 0
    const ticking: Array<() => void> = []
    let poke: ((event: unknown) => void) | undefined
    const surface = {
      elements: { Box: 'Box', Text: 'Text' },
      get state() {
        return state
      },
      setState: (next: unknown) => {
        sets += 1
        state = next
      },
      columns: 100,
      rows: 3,
      every: (_ms: number, fn: () => void) => {
        ticking.push(fn)
        return () => undefined
      },
      onPointer: (fn: (event: unknown) => void) => {
        poke = fn
        return () => undefined
      },
      onKey: () => () => undefined,
      post: () => undefined,
    }
    const draw = Band as unknown as (props: BandProps, surface: unknown) => unknown
    let last = JSON.stringify(draw(props, surface))
    let seen = sets
    const frames = new Set([last])
    for (let i = 0; i < ticks; i++) {
      if (i === clickAt) poke?.({ type: 'down', x: 4, y: 1, button: 'left' })
      ticking.forEach(fn => fn())
      if (sets !== seen) {
        seen = sets
        const frame = JSON.stringify(draw(props, surface))
        if (frame === last) wasted += 1
        frames.add(frame)
        last = frame
      }
    }

    return { sets, wasted, frames: frames.size }
  }
  const idle: BandProps = {
    isStill: false,
    isAppleTerminal: false,
    isGreeting: true,
    columns: 100,
    isWorking: false,
    isHigh: true,
    model: 'Opus 5.5',
    project: 'agent-plugins',
    branch: 'main',
    dirty: 2,
    percent: 86,
    cost: '$0.31',
    limit: { label: '5h', percent: 91, resetsAt: '4:30pm' },
    idleMs: 1000,
    activity: null,
    slip: null,
    lastSlip: null,
    slipAgoMs: null,
    flinchAgoMs: null,
    lastTurn: { seconds: 41, tools: 2, files: 1, ending: 'answer' },
    todos: null,
    cheers: 0,
    oops: 0,
    shownForMs: null,
  }
  const work = (kind: 'edit' | 'run' | 'read', verb: string, target: string): BandProps => ({ ...idle, isGreeting: false, isWorking: true, activity: { kind, verb, target, what: target } })
  const cases: Array<[BandProps, number?]> = [
    [idle],
    [work('edit', 'Editing', 'a.ts')],
    [{ ...work('run', '', 'Run the tests'), isHigh: false }],
    [work('read', 'Reading', 'a.ts')],
    [{ ...idle, isGreeting: false }, 10],
    [{ ...idle, isGreeting: false, idleMs: 170_000 }],
  ]
  for (const [props, clickAt] of cases) {
    // A hundred seconds of each: idle (a wave, blinks, the bead, the countdown), editing, running, reading, a pet, a nap.
    const { sets, wasted, frames } = drive(props, 400, clickAt)
    expect(wasted).toBe(0)
    expect(sets).toBeGreaterThan(1)
    expect(frames).toBeGreaterThan(1)
  }
})

test('the desktop hands the page the same Clawd while the moment is the same, whatever the tools', { timeoutMs: 30_000 }, async ($, on) => {
  let peek: (() => Promise<Read>) | undefined
  const during = new Set<string>()
  const { clock } = world(on, {
    onCall: async () => {
      during.add(svgOf((await peek?.())?.tree)?.source ?? '')
    },
  })
  await start($)

  // At work: reading, editing, running, searching and planning all hand over the very same Svg.
  const busy = await band($, 'desktop', { ...BAND, isWorking: true })
  peek = busy.read
  await prompt($, 'go')
  const working = svgOf((await busy.read()).tree)?.source ?? ''
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(400)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
  await clock.advance(2000)
  await $.tool.call({ tool: 'Grep', pattern: 'band' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Ship it', status: 'pending', activeForm: 'Shipping it' }] })
  await clock.advance(2000)
  expect([...during]).toEqual([working])
  expect(svgOf((await busy.read()).tree)?.source).toBe(working)
  expect(svgOf((await busy.read()).tree)?.alt).toBe('Clawd taps along as Claude works.')
  peek = undefined
  await busy.ui.unmount()

  const { ui, read } = await band($, 'desktop')
  await turn($)
  const landed = svgOf((await read()).tree)?.source
  await clock.advance(1500)
  await $.session.measure(measured(44, 0.33))
  expect(svgOf((await read()).tree)?.source).toBe(landed)

  await clock.advance(10_000)
  await $.session.measure(measured(45, 0.34))
  const idle = svgOf((await read()).tree)?.source
  await clock.advance(30_000)
  await $.session.measure(measured(46, 0.35))
  expect(svgOf((await read()).tree)?.source).toBe(idle)
  await ui.unmount()
})

test('desktop: a reading past warnAt just before the turn lands draws one new frame, the cheer, never a bead first', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  const { ui, read } = await band($, 'desktop', { ...BAND, isWorking: true })
  const source = async () => svgOf((await read()).tree)?.source ?? ''
  await prompt($, 'go')
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  await clock.advance(3_000)
  const working = await source()
  const seen = [working]
  // The context crosses warnAt (42% to 86%) a tenth of a second before the answer lands.
  await $.session.measure(measured(86, 1.94))
  await clock.advance(100)
  seen.push(await source())
  expect((await read()).words[1]).toContain('86%')
  await $.turn.complete({ answer: 'Done.', durationMs: 3_200, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw(BAND)
  for (let i = 0; i < 30; i++) {
    seen.push(await source())
    await clock.advance(50)
  }
  expect(new Set(seen).size).toBe(2)
  expect(seen[1]).toBe(working)
  expect(svgOf((await read()).tree)?.alt).toBe('Clawd cheers for a finished turn.')
  await ui.unmount()

  // A turn that goes on: the bead comes a moment after the reading, in a frame of its own.
  const busy = await band($, 'desktop', { ...BAND, isWorking: true })
  const now = async () => svgOf((await busy.read()).tree)
  await $.session.measure(measured(40, 2.1))
  await prompt($, 'more')
  await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
  await clock.advance(3_000)
  const calm = await now()
  expect(calm?.alt).toBe('Clawd taps along as Claude works.')
  await $.session.measure(measured(87, 2.2))
  await clock.advance(100)
  expect((await now())?.source).toBe(calm?.source)
  await clock.advance(400)
  expect(await now()).toEqual(expect.objectContaining({ alt: 'Clawd taps along, a bead of sweat on his brow.', source: expect.stringContaining('class="hh-sw"') }))
  await busy.ui.unmount()
})

test('/band still keeps Clawd to one pose per moment, and /band lively lets him move again', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await start($)
  const moves = async (isMoving: boolean) => {
    for (const surface of SURFACES) {
      const { ui, read } = await band($, surface, { ...BAND, isWorking: true })
      if (surface === 'terminal') {
        // Thinking, a lively Clawd blinks or glances every few seconds: 25 s shows it.
        const frames = new Set<string>()
        for (let i = 0; i < (isMoving ? 100 : 16); i++) {
          frames.add(JSON.stringify((await read()).tree))
          await ui.advance(250)
        }
        expect(frames.size > 1).toBe(isMoving)
      } else {
        const source = svgOf((await read()).tree)?.source ?? ''
        expect(source.includes('infinite')).toBe(isMoving)
        expect(source.includes('@keyframes hh-ml-')).toBe(isMoving)
      }
      await ui.unmount()
    }
  }

  expect((await run($, 'band', 'still')).text).toMatch(/^Still\. /u)
  await moves(false)

  expect((await run($, 'band', 'hearth')).text).toMatch(/^Hearth\b/u)
  expect((await run($, 'band', 'sparkly')).text).toContain('not "sparkly".')
  expect((await run($, 'band', 'lively')).text).toMatch(/^Lively\. /u)
  await moves(true)
})

test('reduced motion holds Clawd still, and he still cheers, flinches and naps (one pose each)', async ($, on) => {
  world(on, { settings: { prefersReducedMotion: true } })
  await start($)
  const { ui, read } = await band($, 'desktop')

  const idle = svgOf((await read()).tree)?.source ?? ''
  expect(idle).not.toContain('infinite')
  // He still dozes off: one step to closed eyes, three minutes on.
  expect(idle).toMatch(/\.hh-el-c\{opacity:0;animation:hh-qn-el-c 1s step-end 180s 1 forwards\}/)
  await turn($)
  const landed = svgOf((await read()).tree)?.source ?? ''
  expect(landed).toMatch(/@keyframes hh-qc-la-u\{0%\{opacity:1\}100%\{opacity:1\}\}/)
  await ui.unmount()

  // With the context full, his bead of sweat waits for the cheer to end: his claws are up beside it.
  await $.session.measure(measured(86, 1.94))
  await turn($)
  const full = await band($, 'desktop')
  const cheering = svgOf((await full.read()).tree)?.source ?? ''
  expect(cheering).toContain('class="hh-sw"')
  expect(cheering).toMatch(/\.hh-sw\{opacity:0;transform:none;animation:hh-on 1s step-end 3\.2s 1 forwards,hh-off 1s step-end 180s 1 forwards\}/)
  await full.ui.unmount()
})

test('a change to reduced motion takes hold with the next prompt, or with /band, without a restart', { timeoutMs: 30_000 }, async ($, on) => {
  const settings: Record<string, unknown> = {}
  world(on, { settings })
  await start($)
  const isLively = async () => {
    const desk = await band($, 'desktop', { ...BAND, isWorking: true })
    const source = svgOf((await desk.read()).tree)?.source ?? ''
    await desk.ui.unmount()
    const term = await band($, 'terminal', { ...BAND, isWorking: true })
    const frames = new Set<string>()
    for (let i = 0; i < 100; i++) {
      frames.add(JSON.stringify((await term.read()).tree))
      await term.ui.advance(250)
    }
    await term.ui.unmount()
    // Both surfaces agree.
    expect(frames.size > 1).toBe(source.includes('infinite'))

    return frames.size > 1
  }

  expect(await isLively()).toBe(true)
  settings.prefersReducedMotion = true
  await prompt($, 'next')
  expect(await isLively()).toBe(false)

  settings.prefersReducedMotion = false
  expect((await run($, 'band', 'hearth')).text).toBe('Hearth, lively. Try /band tide, /band still or /config.')
  expect(await isLively()).toBe(true)
  settings.prefersReducedMotion = true
  expect((await run($, 'band', 'hearth')).text).toBe('Hearth, still for reduced motion. Try /band tide or /config.')
  expect(await isLively()).toBe(false)
})

test('a page that asks for reduced motion gets the same calm Clawd', async ($, on) => {
  world(on)
  await start($)
  const { ui, read } = await band($, 'desktop')

  const source = svgOf((await read()).tree)?.source ?? ''
  const calm = /@media \(prefers-reduced-motion:reduce\)\{(.*)\}<\/style>/.exec(source)?.[1] ?? ''
  expect(calm).toContain('.hh-el-c{opacity:0;animation:hh-qn-el-c 1s step-end 180s 1 forwards}')
  expect(calm).not.toContain('infinite')
  await ui.unmount()
})

test('in Apple’s Terminal he is Claude Code’s simpler Clawd', async ($, on) => {
  world(on, { env: { TERM_PROGRAM: 'Apple_Terminal' } })
  await start($)
  const { ui, read } = await band($, 'terminal')
  await ui.advance(3000)

  expect((await read()).clawd).toEqual(['▗ ▗   ▖ ▖', '        ', ' ▘▘   ▝▝'])
  await ui.unmount()
})

test('a survey keeps the band', async ($, on) => {
  world(on)
  on('ui.render', () => ({ type: 'Text', children: ['How is Claude doing?'] }))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'session-band', surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
    expect(await ui.find({ text: 'How is Claude doing?' })).toBeDefined()
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the uncommitted count keeps its word or goes whole, a cut ends on a letter, and nothing on line 1 or 3 comes back as the band narrows', { timeoutMs: 60_000 }, async ($, on) => {
  world(on, { branch: 'claude/first-mod' })
  await start($)
  const sweep = async (what: string, isWorking: boolean) => {
    for (const surface of SURFACES) {
      let wider: string[] | null = null
      for (let columns = 160; columns >= 34; columns--) {
        const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns, isWorking })
        const { words } = await read()
        const where = words[0] ?? ''
        // The count says what it counts, or is not there: never "files" (line 3's word), never a bare number.
        expect([surface, columns, where, /· \d+$|· \d+ (?!uncommitted)|\bfiles?\b/u.test(where)]).toEqual([surface, columns, where, false])
        for (const i of [0, 2]) {
          const line = words[i] ?? ''
          // A cut ends on a letter: never "first-…", "register.…" or "the …".
          expect([surface, columns, line, /[\s/._-]…/u.test(line)]).toEqual([surface, columns, line, false])
          for (const part of ['Opus 5.5', 'uncommitted', 'claude/', ' done']) {
            if (line.includes(part)) expect([what, surface, columns, line, wider?.[i]?.includes(part) ?? true]).toEqual([what, surface, columns, line, true])
          }
        }
        wider = words
        await ui.unmount()
      }
    }
  }
  await turn($)
  await sweep('idle', false)
  await prompt($, 'go')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Draw the beach', description: '', activeForm: 'Drawing the beach' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await sweep('thinking', true)
})

test('at 100% the context is "Full", a limit reached comes first, and every meter the page reads out starts with a capital', async ($, on) => {
  world(on)
  await start($, 100, 2.5)
  await $.session.measure({
    context: { tokens: 200_000, window: 200_000, percent: 100 },
    rateLimits: [{ kind: 'spend_limit', percentUsed: 104, resetsAt: new Date(T0 + 130 * 60_000).toISOString() }],
    cost: { usd: 2.5 },
    changed: ['context', 'cost', 'rateLimits'],
  })
  for (const surface of SURFACES) {
    for (const columns of [34, 48, 64, 100]) {
      const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns })
      const seen = await read()
      // Over a spend limit, that comes first; the context's own words wait behind it, never "Getting full".
      expect([surface, columns, seen.words.join(' ').includes('Getting full')]).toEqual([surface, columns, false])
      expect([surface, columns, seen.words[2]]).toEqual([surface, columns, expect.stringMatching(/^Over (the )?spend limit/u)])
      if (surface === 'desktop' && columns === 100) {
        const alts: string[] = []
        walk(seen.tree, node => {
          if (node.type === 'Svg') alts.push(String(node.props?.alt))
        })
        expect(alts).toContain('Context 100% full')
        expect(alts).toContain('Spend limit 104% used')
      }
      await ui.unmount()
    }
  }
  // At the 5h limit (99.6% reads 100% on its meter), the limit still comes first, with the context high.
  await $.session.measure(measured(86, 2.5, 99.6))
  for (const surface of SURFACES) {
    for (const [columns, line] of [[100, 'At the 5h limit'], [34, 'At 5h limit']] as const) {
      const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns })
      expect([surface, columns, (await read()).words[2]]).toEqual([surface, columns, expect.stringMatching(new RegExp(`^${line}`, 'u'))])
      await ui.unmount()
    }
  }
  // With no limit near, line 3 says it plainly, down to the narrowest band.
  await $.session.measure(measured(100, 2.5, 23))
  for (const surface of SURFACES) {
    for (const [columns, line] of [[100, "Full · /compact when you're ready"], [34, 'Full']] as const) {
      const { ui, read } = await band($, surface, { ...BAND, bodyColumns: columns })
      expect([surface, columns, (await read()).words[2]]).toEqual([surface, columns, expect.stringMatching(new RegExp(`^${line.replace(/[/.]/gu, '\\$&')}`, 'u'))])
      await ui.unmount()
    }
  }
})
