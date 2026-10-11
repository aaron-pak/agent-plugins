import type { Elements, RenderElement } from 'claude-code'

import type { BandProps } from '../types'
import { cells } from './clawd'
import { DIM, firstFit, happeningForms, squeezeRoom, whereForms } from './words'
import type { Line, Measure, Row, Said, Seg } from './words'

// Hearth, on the desktop: a vector Clawd (an Svg drawn from his pixel form,
// animated by CSS alone) beside three tidy lines of Box and Text, with the
// meters as rounded pills. Nothing here ticks: the hooks module redraws when the
// session's state changes, and Clawd's own timing (a blink, a tap, a glance at
// the words, a nap coming on, a cheer settling back down) is written into his
// stylesheet.
//
// A new Svg source reloads his sandboxed frame and starts every animation over,
// so his source is built from slow state alone: whether a turn is under way
// (one `work` mode for reading, editing, running and thinking alike), a cheer,
// a hello, a flinch, a full context, calm. A tool starting or finishing hands
// the page the very same Svg, and his motion carries on undisturbed.

type Desk = Elements['desktop']

type DeskView = BandProps

const NAP_AFTER_MS = 3 * 60_000
/** He dozes off this long after his Svg appears, idle (a CSS delay: nothing ticks here). */
const NAP_AFTER_S = 180
/** How long after a turn lands he is drawn cheering (the hooks module redraws as it ends), and how long a cheer lasts. */
export const CHEER_FOR_MS = 4000
const CHEER_S = 3.2
/** How long after a tool fails he is drawn flinching; the hooks module redraws as it ends. */
export const FLINCH_MS = 2000
/** A pointer must rest on him this long before it counts as petting: one passing on its way to the composer does not. */
const HOVER_S = 0.15

// Colors inside an Svg cannot follow the page's theme, so each one here reads on
// both claude.ai backgrounds (#faf9f5 and #262624).
const CLAY = '#D77757'
const EYE = '#141413'
const PINK = '#E5739A'
const SKY = '#5B9BD5'
const ZED = '#8F8A80'
const LIMIT = '#A39E93'
const TRACK = 'rgba(140,134,122,0.28)'

// Clawd's canvas, in his own units (a pixel is 1 wide and 2 tall; 4 CSS px a
// unit): he stands in x 1..18, y 0..10, with a little room above him and to his
// right for his sparkles, z, sweat and heart, all of which stay inside it.
const VIEW = { x: -1, y: -4, width: 24, height: 16 }
const SCALE = 4

/** Every class and keyframe in his Svg starts with this, in case a host ever draws it inline. */
const P = 'hh-'

export function desk(els: Desk, view: DeskView): RenderElement {
  const { Box, Svg } = els
  const mood = moodOf(view)
  const clawd = (
    <Box flexShrink={0}>
      <Svg source={clawdSvg(mood)} alt={altOf(mood)} width={VIEW.width * SCALE} height={VIEW.height * SCALE} isInteractive />
    </Box>
  )
  const panel = Math.min(view.columns - 14, PANEL_MAX)
  if (panel < PANEL_MIN) {
    // Too narrow for words: Clawd keeps the band alone.
    return <Box flexDirection="row">{clawd}</Box>
  }
  const room = panel * CELL_PX
  const said: Said = {
    isWorking: view.isWorking,
    activity: view.activity,
    slip: view.slip,
    todos: view.todos,
    isHigh: view.isHigh,
    limit: view.limit,
    lastTurn: view.lastTurn,
    resetsIn: null,
    isStatic: true,
    // While he cheers, the words say what finished; a warning waits for the cheer to end.
    isLanding: mood.isCheer,
  }

  // The words: a panel of fixed width, so the figures on the right stay put.
  // Nothing in it clips a figure or a label: each line is composed to fit, and
  // only a branch, a file name or a todo may be cut (with an ellipsis).
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {clawd}
      <Box flexDirection="column" width={panel} flexShrink={1}>
        {line(els, cutToFit(firstFit(whereForms(view), room, PX), room))}
        {fill(els, view, room)}
        {line(els, cutToFit(firstFit(happeningForms(said), room, PX), room))}
      </Box>
    </Box>
  )
}

// ── The words, measured in pixels ──────────────────────────────────────────────
//
// The desktop draws Text in a proportional font, so the terminal's forms
// (words.ts) are measured here in pixels, generously: each glyph at the widest
// of three common UI fonts, and a cell at a little under the 7.8 px measured
// in a desktop preview. A line fits when it fits that budget.

/** Pixels to a cell in the budget: a little under the desktop's, so a fit is a fit. */
const CELL_PX = 7.6
/** The words' panel, in cells: up to 64 beside Clawd's 96 px and a cell of gap; under 16, Clawd keeps the band alone. */
const PANEL_MAX = 64
const PANEL_MIN = 16
/** Each percentage sits in a box this many cells wide, so a meter group never shifts as a digit comes or goes. */
const FIGURE_CELLS = 5

// Glyph advances at 14 px, in tenths of a pixel, for ASCII 32 to 126: the widest
// of Inter, DejaVu Sans and Liberation Sans (Arial's metrics), regular and semibold.
// prettier-ignore
const REGULAR = [45,57,66,118,90,138,110,42,55,55,71,118,45,65,45,51,90,90,90,90,91,90,90,90,90,90,48,48,118,118,118,78,143,97,96,103,108,94,86,109,106,42,80,95,80,127,106,111,94,111,102,94,91,105,97,139,96,95,96,55,51,55,118,78,70,86,89,80,89,87,52,89,89,39,39,82,39,137,89,86,89,89,58,74,55,89,83,115,83,83,78,90,48,90,118]
// prettier-ignore
const BOLD = [49,64,74,118,98,141,123,46,64,64,76,118,54,66,54,53,98,98,98,98,98,98,98,98,98,98,56,56,118,118,118,86,140,109,107,104,117,96,96,115,118,53,82,109,90,140,118,119,103,119,108,101,96,114,109,155,108,102,102,64,53,64,118,78,70,95,101,83,101,95,61,101,100,48,48,94,48,146,100,97,101,101,69,84,67,100,92,130,91,92,82,100,52,100,118]

/** A text's width in pixels at 14 px, erring wide: CJK and emoji at 18, any other symbol at 14. */
export function textPx(text: string, isBold: boolean): number {
  let px = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const ascii = code >= 32 && code < 127 ? (isBold ? BOLD : REGULAR)[code - 32] : undefined
    px += ascii !== undefined ? ascii / 10 : char === '·' ? 5.4 : cells(char) === 0 ? 0 : cells(char) === 2 ? 18 : 14
  }

  return px
}

export const PX: Measure = {
  row: row => row.reduce((sum, seg) => sum + textPx(seg.text, seg.bold === true), 0),
  gap: 2 * CELL_PX,
  least: n => n * 9,
}

const ELLIPSIS = '…'

/** A squeezed part longer than its room is cut here, with an ellipsis, so the words after it keep their place. */
function cutToFit(line: Line, room: number): Line {
  if (line.squeeze === undefined) {
    return line
  }
  const left = squeezeRoom(line, room, PX)
  if (PX.row(line.squeeze) <= left) {
    return line
  }
  const out: Row = []
  let used = textPx(ELLIPSIS, false)
  for (const seg of line.squeeze) {
    let kept = ''
    for (const char of seg.text) {
      const w = textPx(char, seg.bold === true)
      if (used + w > left) {
        out.push({ ...seg, text: `${kept}${ELLIPSIS}` })
        return { ...line, squeeze: out }
      }
      used += w
      kept += char
    }
    out.push(seg)
  }

  return { ...line, squeeze: out }
}

// One run of words, in the colors of the person's theme: dim words in the desktop's own dim.
function seg(Text: Desk['Text'], part: Seg): RenderElement {
  if (part.color === DIM) {
    return <Text dimColor>{part.text}</Text>
  }
  if (part.color === undefined) {
    return part.bold === true ? <Text bold>{part.text}</Text> : <Text>{part.text}</Text>
  }

  return part.bold === true ? (
    <Text color={part.color} bold>
      {part.text}
    </Text>
  ) : (
    <Text color={part.color}>{part.text}</Text>
  )
}

// A line of words, its figures on the right in a box of their own that never
// shrinks; the words on the left in one Text, so their spaces are the font's own.
function line(els: Desk, words: Line): RenderElement {
  const { Box, Text } = els
  const parts = [...words.left, ...(words.squeeze ?? []), ...(words.tail ?? [])]

  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Box flexDirection="row" flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">{parts.map(part => seg(Text, part))}</Text>
      </Box>
      {words.right.length === 0 ? null : (
        <Box flexShrink={0} marginLeft={2}>
          <Text>{words.right.map(part => seg(Text, part))}</Text>
        </Box>
      )}
    </Box>
  )
}

/** One form of line 2: pill widths in px (null: no pills), the limit's long label, and which figures stay. */
type Fill = { ctx: number | null; lim: number | null; isLong: boolean; hasCost: boolean; hasLimit: boolean }

// Longest first: the pills shrink, `5h limit` becomes `5h`, the pills go and
// the figures stay, then the cost goes, then the 5h figure. The context figure
// always stays.
const FILLS: Fill[] = [
  { ctx: 72, lim: 48, isLong: true, hasCost: true, hasLimit: true },
  { ctx: 56, lim: 36, isLong: true, hasCost: true, hasLimit: true },
  { ctx: 40, lim: 24, isLong: true, hasCost: true, hasLimit: true },
  { ctx: 40, lim: 24, isLong: false, hasCost: true, hasLimit: true },
  { ctx: null, lim: null, isLong: false, hasCost: true, hasLimit: true },
  { ctx: null, lim: null, isLong: false, hasCost: false, hasLimit: true },
  { ctx: null, lim: null, isLong: false, hasCost: false, hasLimit: false },
]

/** How wide a form of line 2 is drawn, in pixels: every label, pill, margin and figure box. */
export function fillPx(view: Pick<DeskView, 'percent' | 'isHigh' | 'limit' | 'cost'>, shape: Fill): number {
  const figure = (text: string, isWarm: boolean) => Math.max(FIGURE_CELLS * CELL_PX, textPx(text, isWarm))
  // A pill has a cell either side; without one, a cell sits between the label and its figure.
  const pill = (px: number | null) => (px === null ? CELL_PX : CELL_PX + px + CELL_PX)
  const limit = view.limit
  let px = textPx('context', false) + pill(shape.ctx) + figure(percentText(view.percent), view.isHigh)
  if (limit !== null && shape.hasLimit) {
    px += CELL_PX + textPx(labelOf(limit.label, shape.isLong), false) + pill(shape.lim) + figure(percentText(limit.percent), limit.percent >= 80)
  }
  if (view.cost !== null && shape.hasCost) {
    px += 2 * CELL_PX + textPx(view.cost, false)
  }

  return px
}

function labelOf(label: string, isLong: boolean): string {
  return isLong && label === '5h' ? '5h limit' : label
}

// How full things are: the context and the 5h limit as rounded pills with
// their figures, and the cost. Nothing on this line sits in a box that clips:
// the form is chosen to fit.
function fill(els: Desk, view: DeskView, room: number): RenderElement {
  const { Box, Text, Svg } = els
  const shape = FILLS.find(form => fillPx(view, form) <= room) ?? FILLS[FILLS.length - 1] ?? { ctx: null, lim: null, isLong: false, hasCost: false, hasLimit: false }
  const limit = view.limit
  const isNear = limit !== null && limit.percent >= 80
  const meter = (px: number | null, percent: number | null, color: string, alt: string) =>
    px === null ? null : (
      <Box marginLeft={1} marginRight={1} flexShrink={0}>
        <Svg source={pill(percent, px, color)} alt={alt} width={px} height={8} />
      </Box>
    )
  // Each number sits in a box of its own width, wide enough for "100%" in a
  // proportional font, so a meter group never shifts when a percentage gains a digit.
  const figure = (percent: number | null, isWarm: boolean, hasPill: boolean) => (
    <Box minWidth={FIGURE_CELLS} flexShrink={0} marginLeft={hasPill ? 0 : 1}>
      <Text color={isWarm ? 'warning' : undefined} bold={isWarm}>
        {percentText(percent)}
      </Text>
    </Box>
  )

  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Box flexDirection="row" alignItems="center" flexShrink={0}>
        <Text dimColor>context</Text>
        {meter(shape.ctx, view.percent, CLAY, `Context ${view.percent ?? 0}% full`)}
        {figure(view.percent, view.isHigh, shape.ctx !== null)}
        {limit === null || !shape.hasLimit ? null : (
          <Box flexDirection="row" alignItems="center" marginLeft={1} flexShrink={0}>
            <Text dimColor>{labelOf(limit.label, shape.isLong)}</Text>
            {meter(shape.lim, limit.percent, LIMIT, `${limit.label} limit ${limit.percent}% used`)}
            {figure(limit.percent, isNear, shape.lim !== null)}
          </Box>
        )}
      </Box>
      {view.cost === null || !shape.hasCost ? null : (
        <Box flexShrink={0} marginLeft={2}>
          <Text>{view.cost}</Text>
        </Box>
      )}
    </Box>
  )
}

function percentText(percent: number | null): string {
  return percent === null ? '-' : `${Math.round(percent)}%`
}

// ── The pill meter ─────────────────────────────────────────────────────────────

function pill(percent: number | null, width: number, color: string): string {
  const p = percent === null ? 0 : Math.min(100, Math.max(0, percent))
  const filled = p === 0 ? 0 : Math.max(8, Math.round((p / 100) * width))

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 8" width="${width}" height="8">` +
    `<rect x="0" y="1" width="${width}" height="6" rx="3" fill="${TRACK}"/>` +
    (filled === 0 ? '' : `<rect x="0" y="1" width="${filled}" height="6" rx="3" fill="${color}"/>`) +
    `</svg>`
  )
}

// ── Clawd, in pixels ───────────────────────────────────────────────────────────

type Eyes = 'open' | 'left' | 'right' | 'closed' | 'wink'
type Arms = 'down' | 'up' | 'one-up'
type Feet = 'both' | 'left' | 'right'
type Pose = { eyes: Eyes; arms: Arms; feet: Feet }
type Track = { name: string; steps: Array<[number, Pose]>; delay: number; isLoop: boolean; isHeld?: boolean }

type Mode = 'idle' | 'work' | 'nap'
type Mood = {
  mode: Mode
  isCheer: boolean
  isWave: boolean
  isFlinch: boolean
  isHigh: boolean
  /** `/band still` or Claude Code's reduced motion: one pose per moment, nothing moves. */
  isStill: boolean
  /** Idle and awake: he dozes off by himself, NAP_AFTER_S after his Svg appears. */
  isDozy: boolean
}

const REST: Pose = { eyes: 'open', arms: 'down', feet: 'both' }
const PET: Pose = { eyes: 'wink', arms: 'up', feet: 'both' }

// The moment, and nothing finer: every redraw within the same moment gives the same mood.
function moodOf(view: DeskView): Mood {
  const isIdle = !view.isWorking
  const idle = view.idleMs ?? 0
  const isNap = isIdle && view.idleMs !== null && idle >= NAP_AFTER_MS
  const mode: Mode = isNap ? 'nap' : isIdle ? 'idle' : 'work'

  return {
    mode,
    isCheer: isIdle && !isNap && view.lastTurn?.ending === 'answer' && idle < CHEER_FOR_MS,
    isWave: isIdle && view.isGreeting && !isNap,
    isFlinch: !isIdle && view.flinchAgoMs !== null && view.flinchAgoMs < FLINCH_MS,
    isHigh: view.isHigh,
    isStill: view.isStill,
    isDozy: isIdle && !isNap,
  }
}

function altOf(mood: Mood): string {
  switch (mood.mode) {
    case 'nap':
      return 'Clawd, napping'
    case 'work':
      return 'Clawd, at work'
    default:
      return mood.isCheer ? 'Clawd, cheering' : 'Clawd'
  }
}

// The pose he holds when nothing moves.
function restOf(mood: Mood): Pose {
  return mood.mode === 'nap' ? { ...REST, eyes: 'closed' } : REST
}

// The loop for each mode, as [seconds, pose] steps. Calm: Claude Code's own
// spinner is already moving above him, so most of the time he simply rests,
// eyes open.
function loopOf(mood: Mood): Array<[number, Pose]> {
  const eyes = (e: Eyes): Pose => ({ ...REST, eyes: e })
  switch (mood.mode) {
    case 'idle':
      // A blink every five or six seconds, and now and then a glance at the words.
      return [
        [5.4, REST],
        [0.16, eyes('closed')],
        [5.6, REST],
        [0.16, eyes('closed')],
        [3.2, REST],
        [1.2, eyes('right')],
        [3.4, REST],
        [0.16, eyes('closed')],
      ]
    case 'work':
      // At work, whatever the tool: a claw taps twice, he rests, glances at the
      // words beside him (his pupils move a pixel along the eye row), rests and
      // blinks. Eight seconds; a bead of sweat comes in the rest after the tap.
      return [
        [0.5, { ...REST, arms: 'one-up' }],
        [0.5, REST],
        [0.5, { ...REST, arms: 'one-up' }],
        [3.3, REST],
        [1.2, eyes('right')],
        [1.84, REST],
        [0.16, eyes('closed')],
      ]
    default:
      return [[1, restOf(mood)]]
  }
}

/**
 * The sweat cycle, in seconds: his own loop's, so the bead keeps its place in
 * it (from 2 s to 4.5 s, in the rest before any glance): every 8 s at work,
 * about every 19 s idle.
 */
function sweatPeriod(mood: Mood): number {
  return round(total(loopOf(mood)))
}

// One moment's pose changes, in order. Calm keeps one pose per moment: arms up
// for the whole cheer, eyes shut for the whole flinch, and still the nap.
function tracksOf(mood: Mood, isCalm: boolean): Track[] {
  const up: Pose = { ...REST, arms: 'up' }
  const shut: Pose = { ...REST, eyes: 'closed' }
  const tracks: Track[] = []
  if (mood.isWave && !isCalm) {
    const wave: Pose = { ...REST, arms: 'one-up' }
    tracks.push({ name: 'w', steps: [[0.5, wave], [0.3, REST], [0.5, wave], [0.3, REST]], delay: 0.3, isLoop: false })
  }
  if (mood.isCheer) {
    tracks.push({ name: 'c', steps: isCalm ? [[CHEER_S, up]] : [[1.2, up], [0.4, REST], [1.6, up]], delay: 0, isLoop: false })
  }
  if (mood.isFlinch) {
    tracks.push({ name: 'f', steps: isCalm ? [[1.5, shut]] : [[0.5, shut], [1.0, { ...REST, eyes: 'left' }]], delay: 0, isLoop: false })
  }
  const lead = leadOf(tracks)
  if (!isCalm) {
    tracks.push({ name: 'l', steps: loopOf(mood), delay: lead, isLoop: true })
  }
  if (mood.isDozy) {
    tracks.push({ name: 'n', steps: [[1, shut]], delay: Math.max(lead, NAP_AFTER_S), isLoop: false, isHeld: true })
  }

  return tracks
}

function leadOf(tracks: Track[]): number {
  return tracks.reduce((sum, track) => sum + track.delay + total(track.steps), 0)
}

// Every part of him that comes and goes, with the poses it belongs to. A glance
// moves both pupils a pixel sideways along the eye row (in the terminal's glyphs
// they rise to the top row, which at this size reads as a notch in his head).
type Rect = [number, number, number, number]
type Part = { name: string; fill: string; rects: Rect[]; shows: (pose: Pose) => boolean }

const PARTS: Part[] = [
  { name: 'la-d', fill: CLAY, rects: [[1, 4, 2, 2]], shows: p => p.arms !== 'up' },
  { name: 'la-u', fill: CLAY, rects: [[1, 2, 2, 2], [2, 4, 1, 2]], shows: p => p.arms === 'up' },
  { name: 'ra-d', fill: CLAY, rects: [[16, 4, 2, 2]], shows: p => p.arms === 'down' },
  { name: 'ra-u', fill: CLAY, rects: [[16, 2, 2, 2], [16, 4, 1, 2]], shows: p => p.arms !== 'down' },
  { name: 'ft-l', fill: CLAY, rects: [[3, 8, 1, 2], [5, 8, 1, 2]], shows: p => p.feet !== 'right' },
  { name: 'ft-r', fill: CLAY, rects: [[13, 8, 1, 2], [15, 8, 1, 2]], shows: p => p.feet !== 'left' },
  { name: 'el-o', fill: EYE, rects: [[5, 2, 1, 2]], shows: p => p.eyes === 'open' || p.eyes === 'wink' },
  { name: 'el-l', fill: EYE, rects: [[4, 2, 1, 2]], shows: p => p.eyes === 'left' },
  { name: 'el-r', fill: EYE, rects: [[6, 2, 1, 2]], shows: p => p.eyes === 'right' },
  { name: 'el-c', fill: EYE, rects: [[4, 3.2, 2, 0.8]], shows: p => p.eyes === 'closed' },
  { name: 'er-o', fill: EYE, rects: [[13, 2, 1, 2]], shows: p => p.eyes === 'open' },
  { name: 'er-l', fill: EYE, rects: [[12, 2, 1, 2]], shows: p => p.eyes === 'left' },
  { name: 'er-r', fill: EYE, rects: [[14, 2, 1, 2]], shows: p => p.eyes === 'right' },
  { name: 'er-c', fill: EYE, rects: [[12, 3.2, 2, 0.8]], shows: p => p.eyes === 'closed' || p.eyes === 'wink' },
]

// The body that never changes: head, eye row, body, in viewBox units (a pixel is 1 x 2).
const BODY: Rect[] = [
  [3, 0, 13, 2],
  [3, 2, 13, 2],
  [3, 4, 13, 2],
  [3, 6, 13, 2],
]

function rects(list: Rect[]): string {
  return list.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('')
}

// Clawd as one pose, drawn whole: the petted Clawd that a hover brings up.
function still(pose: Pose): string {
  const byFill = new Map<string, Rect[]>([[CLAY, [...BODY]]])
  for (const part of PARTS) {
    if (part.shows(pose)) {
      byFill.set(part.fill, [...(byFill.get(part.fill) ?? []), ...part.rects])
    }
  }

  return [...byFill].map(([fill, list]) => `<g fill="${fill}">${rects(list)}</g>`).join('')
}

function clawdSvg(mood: Mood): string {
  const rest = restOf(mood)
  const css: string[] = []
  const parts = PARTS.map(part => `<g class="${P}${part.name}" fill="${part.fill}">${rects(part.rects)}</g>`)

  // Two sets of timing: lively, and calm (one pose per moment). /band still and
  // Claude Code's reduced-motion setting get the calm set alone; otherwise the
  // calm set takes over when the page asks for reduced motion.
  const calm = styleOf(mood, rest, true)
  if (mood.isStill) {
    css.push(...calm.keyframes, ...calm.rules)
  } else {
    const lively = styleOf(mood, rest, false)
    css.push(...lively.keyframes, ...calm.keyframes, ...lively.rules, `@media (prefers-reduced-motion:reduce){${calm.rules.join('')}}`)
  }
  // Petting him (a hover that rests on him a moment): his moment gives way to a
  // winking, arms-up Clawd and a heart. The delay is the hover's intent; leaving
  // takes him back at once.
  css.push(
    `.${P}pet{opacity:0;transition:opacity 0s}.${P}mood{transition:opacity 0s}`,
    `svg:hover .${P}pet{opacity:1;transition:opacity 0s ${HOVER_S}s}svg:hover .${P}mood{opacity:0;transition:opacity 0s ${HOVER_S}s}`,
  )

  // Little things around him: sparkles for a cheer, a z for a nap, a bead of
  // sweat when the context runs high, and a heart while he is petted. He is
  // pixels; these are soft, smooth shapes, so they read as his feelings.
  const extras: string[] = []
  if (mood.isCheer) {
    extras.push(
      `<g class="${P}sp" fill="${CLAY}" shape-rendering="geometricPrecision">${sparkle(20.3, -1.6, 1.4)}</g>`,
      `<g class="${P}sp ${P}sp2" fill="${CLAY}" shape-rendering="geometricPrecision">${sparkle(0.4, -2.1, 1.1)}</g>`,
    )
  }
  if (mood.mode === 'nap' || mood.isDozy) {
    extras.push(
      `<g class="${P}z" fill="none" stroke="${ZED}" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision">${zed(19, 1.2, 2)}</g>`,
    )
  }
  if (mood.isHigh && mood.mode !== 'nap') {
    extras.push(`<g class="${P}sw" fill="${SKY}" shape-rendering="geometricPrecision">${drop(17, -1.2)}</g>`)
  }
  const petted =
    `<g class="${P}pet"><g class="${P}pop">${still(PET)}</g>` +
    `<g class="${P}ht" fill="${PINK}" shape-rendering="geometricPrecision">${heart(19, 0.6, 3.4, 3)}</g></g>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}" ` +
    `width="${VIEW.width * SCALE}" height="${VIEW.height * SCALE}" shape-rendering="crispEdges">` +
    `<style>${css.join('')}</style>` +
    `<g class="${P}mood"><g class="${P}hop"><g fill="${CLAY}">${rects(BODY)}</g>${parts.join('')}</g>${extras.join('')}</g>` +
    petted +
    `</svg>`
  )
}

// One set of timing: keyframes, and rules that say everything about each part
// and extra (so the calm rules can take over from the lively ones whole).
function styleOf(mood: Mood, rest: Pose, isCalm: boolean): { keyframes: string[]; rules: string[] } {
  const tag = isCalm ? 'q' : 'm'
  const tracks = tracksOf(mood, isCalm)
  const keyframes: string[] = []
  const rules: string[] = []
  for (const part of PARTS) {
    const anims = tracks.map(track => animation(`${P}${tag}${track.name}`, track, part))
    keyframes.push(...anims.map(a => a.keyframes))
    rules.push(`.${P}${part.name}{opacity:${part.shows(rest) ? 1 : 0};animation:${anims.length === 0 ? 'none' : anims.map(a => a.use).join(',')}}`)
  }

  const lead = leadOf(tracks.filter(track => !track.isLoop && !track.isHeld))
  const napAt = Math.max(lead, NAP_AFTER_S)
  if (isCalm) {
    // One pose per moment: a sparkle shown for the cheer, a z once he sleeps, a bead of sweat held, a still heart.
    // (The calm keyframes are always in the stylesheet, so the lively rules use `off` too.)
    keyframes.push(`@keyframes ${P}on{0%,100%{opacity:1}}`, `@keyframes ${P}off{0%,100%{opacity:0}}`)
    rules.push(
      `.${P}sp{opacity:0;transform:none;animation:${P}on ${CHEER_S}s step-end 0s 1 none}`,
      `.${P}sp2{animation-delay:0s}`,
      mood.mode === 'nap'
        ? `.${P}z{opacity:1;transform:none;animation:none}`
        : `.${P}z{opacity:0;transform:none;animation:${P}on 1s step-end ${napAt}s 1 forwards}`,
      // The bead waits for a cheer to end (his claws are up beside it), and asleep he stops sweating (as on the terminal).
      `.${P}sw{opacity:${mood.isCheer ? 0 : 1};transform:none;animation:${calmSweat(mood, napAt)}}`,
      `.${P}ht{opacity:1;transform:none;animation:none}`,
      `.${P}hop{animation:none}`,
      `svg:hover .${P}pop,svg:hover .${P}ht{animation:none}`,
    )

    return { keyframes, rules }
  }

  const period = sweatPeriod(mood)
  const pct = (seconds: number) => round((seconds / period) * 100)
  keyframes.push(
    // A sparkle twinkles in, holds, and fades; twice.
    `@keyframes ${P}tw{0%{opacity:0;transform:scale(.3) rotate(-20deg)}25%{opacity:1;transform:scale(1) rotate(0deg)}65%{opacity:1;transform:scale(.9)}100%{opacity:0;transform:scale(.5)}}`,
    // Two little hops as his arms go up.
    `@keyframes ${P}hop{0%,16%,50%,64%,100%{transform:translate(0,0)}7%,56%{transform:translate(0,-1px)}}`,
    // One z at a time drifts up and away from him, growing a little as it goes.
    `@keyframes ${P}zz{0%{opacity:0;transform:translate(0,0) scale(.6)}20%{opacity:1}75%{opacity:.85}100%{opacity:0;transform:translate(1.5px,-4.5px) scale(1)}}`,
    // A bead of sweat forms, slides a little, and goes: from 2 s to 4.5 s of
    // his loop, which at work is the rest after the tap (the claw is down by
    // 1.5 s) and before the glance (4.8 s), and idle the rest before his first
    // blink (5.4 s); it stops above his claw.
    `@keyframes ${P}sw{0%,${pct(2)}%{opacity:0;transform:translate(0,0)}${pct(2.5)}%{opacity:1;transform:translate(0,0)}` +
      `${pct(4)}%{opacity:1;transform:translate(0,1px)}${pct(4.5)}%,100%{opacity:0;transform:translate(0,1px)}}`,
    // The heart rises from beside his raised claw and fades near the top.
    `@keyframes ${P}ht{0%{opacity:0;transform:translate(0,1px) scale(.6)}20%{opacity:1;transform:translate(0,0) scale(1)}70%{opacity:1}100%{opacity:0;transform:translate(0,-3.4px) scale(1)}}`,
    `@keyframes ${P}pop{0%,40%,100%{transform:translate(0,0)}15%{transform:translate(0,-1px)}}`,
  )
  rules.push(
    `.${P}sp{opacity:0;transform-box:fill-box;transform-origin:center;animation:${P}tw 1.5s ease-out 0.1s 2 both}`,
    `.${P}sp2{animation-delay:.7s}`,
    `.${P}z{opacity:0;transform-box:fill-box;transform-origin:center;animation:${P}zz 3s ease-out ${mood.mode === 'nap' ? 0 : napAt}s infinite}`,
    `.${P}sw{opacity:0;transform:none;animation:${P}sw ${period}s ease-in ${round(lead)}s infinite${mood.isDozy ? `,${P}off 1s step-end ${napAt}s 1 forwards` : ''}}`,
    `.${P}ht{opacity:1;transform-box:fill-box;transform-origin:center}`,
    // Twice, like his hop: a pointer left resting on him does not keep releasing hearts.
    `svg:hover .${P}ht{animation:${P}ht 2s ease-out ${HOVER_S}s 2 both}`,
    mood.isCheer ? `.${P}hop{animation:${P}hop ${CHEER_S}s ease-out 0s 1 none}` : `.${P}hop{animation:none}`,
    `.${P}pop{transform-box:fill-box;transform-origin:50% 100%}svg:hover .${P}pop{animation:${P}pop .9s ease-out ${HOVER_S}s 2}`,
  )

  return { keyframes, rules }
}

// The calm bead of sweat: held still, shown once a cheer is over, gone once he sleeps.
function calmSweat(mood: Mood, napAt: number): string {
  const steps = [
    ...(mood.isCheer ? [`${P}on 1s step-end ${CHEER_S}s 1 forwards`] : []),
    ...(mood.isDozy ? [`${P}off 1s step-end ${napAt}s 1 forwards`] : []),
  ]

  return steps.length === 0 ? 'none' : steps.join(',')
}

function total(steps: Array<[number, Pose]>): number {
  return steps.reduce((sum, [seconds]) => sum + seconds, 0)
}

// One track's keyframes for one part: shown (1) or hidden (0) in each step, held to the next.
function animation(name: string, track: Track, part: Part): { keyframes: string; use: string } {
  const length = total(track.steps)
  let at = 0
  const frames: string[] = []
  for (const [seconds, pose] of track.steps) {
    frames.push(`${round((at / length) * 100)}%{opacity:${part.shows(pose) ? 1 : 0}}`)
    at += seconds
  }
  const last = track.steps[track.steps.length - 1]
  frames.push(`100%{opacity:${last !== undefined && part.shows(last[1]) ? 1 : 0}}`)
  const id = `${name}-${part.name}`

  return {
    keyframes: `@keyframes ${id}{${frames.join('')}}`,
    use: `${id} ${round(length)}s step-end ${round(track.delay)}s ${track.isLoop ? 'infinite' : 1} ${track.isHeld === true ? 'forwards' : 'none'}`,
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

// A four-point twinkle with tapered rays, centred on (x, y).
function sparkle(x: number, y: number, r: number): string {
  const k = r * 0.16
  const p = (n: number) => round(n)

  return (
    `<path d="M${p(x)} ${p(y - r)}Q${p(x + k)} ${p(y - k)} ${p(x + r)} ${p(y)}Q${p(x + k)} ${p(y + k)} ${p(x)} ${p(y + r)}` +
    `Q${p(x - k)} ${p(y + k)} ${p(x - r)} ${p(y)}Q${p(x - k)} ${p(y - k)} ${p(x)} ${p(y - r)}Z"/>`
  )
}

// A bead of sweat, its point at (x, y).
function drop(x: number, y: number): string {
  return `<path d="M${x} ${y}C${x + 0.85} ${round(y + 1)} ${x + 0.75} ${round(y + 2)} ${x} ${round(y + 2.1)}C${x - 0.75} ${round(y + 2)} ${x - 0.85} ${round(y + 1)} ${x} ${y}Z"/>`
}

// A soft heart in the box (x, y, w, h): two round lobes and a point, every
// control point inside the box.
function heart(x: number, y: number, w: number, h: number): string {
  const at = (u: number, v: number) => `${round(x + u * w)} ${round(y + v * h)}`
  const curves: Array<[number, number, number, number, number, number]> = [
    [0.18, 0.72, 0, 0.52, 0, 0.3],
    [0, 0.12, 0.12, 0, 0.27, 0],
    [0.39, 0, 0.47, 0.07, 0.5, 0.18],
    [0.53, 0.07, 0.61, 0, 0.73, 0],
    [0.88, 0, 1, 0.12, 1, 0.3],
    [1, 0.52, 0.82, 0.72, 0.5, 0.96],
  ]

  return `<path d="M${at(0.5, 0.96)}${curves.map(([a, b, c, d, e, f]) => `C${at(a, b)} ${at(c, d)} ${at(e, f)}`).join('')}Z"/>`
}

// A soft z, s units square, its corner at (x, y): drawn with a round pen.
function zed(x: number, y: number, s: number): string {
  return `<path d="M${x} ${y}L${round(x + s)} ${y}L${x} ${round(y + s)}L${round(x + s)} ${round(y + s)}"/>`
}
