import type { Elements, RenderElement } from 'claude-code'

import type { BandProps } from './types'
import { CELL_PX, CLAY, DOZE_SLATE, EYE_INK, HEART_PINK, pixelHeart, textPx } from '../clawd'
import { NAP_AFTER_MS, NAP_LATE_MS } from '../facts'
import { DIM, firstFit, happeningForms, panelMost, squeezeCut, squeezeRoom, whereForms } from './words'
import type { Line, Measure, Row, Said, Seg } from './words'

// Hearth, on the desktop: a vector Clawd (an Svg drawn from his pixel form,
// animated by CSS alone) beside three tidy lines of Box and Text, with the
// meters as rounded pills. Nothing here ticks: the hooks module redraws when the
// session's state changes, and Clawd's own timing (a blink, a tap, a glance at
// the words, a nap coming on, a cheer settling back down) is written into his
// stylesheet.
//
// He is a plain image, and a new Svg source restarts every animation in it, so
// his source is built from slow state alone: whether a turn is under way (one
// `work` mode for reading, editing, running and thinking alike), a cheer, a
// hello, a flinch, a full context, calm. A tool starting or finishing hands the
// page the very same Svg, and his motion carries on undisturbed.

type Desk = Elements['desktop']

/**
 * What the desktop draws from: the band's props, and what only the hooks module knows (it remembers
 * the frames it handed out). `isFlinchAgain`: this flinch came while the last still played (see
 * moodOf). `isFlinchKept`: the flinch's frame may stay up past its end while the turn runs, gone on
 * into his taps. `isSweating`: whether his picture wears the bead of sweat (absent: as the context
 * is high); the hooks module holds a change of the bead a moment while Claude works, so a turn whose
 * last reading crosses the line as it lands gives his picture one new source, for the cheer.
 * `dozedS`: asleep, how far the z of the frame before had drifted (see Mood); absent, the turn's
 * ending says.
 */
type DeskView = BandProps & { isFlinchAgain?: boolean; isFlinchKept?: boolean; isSweating?: boolean; dozedS?: number }

/** He dozes off this long after his Svg appears, idle (a CSS delay: nothing ticks here). */
const NAP_AFTER_S = NAP_AFTER_MS / 1000
/** How long after a turn lands he is drawn cheering (the hooks module redraws as it ends), and how long a cheer lasts. */
export const CHEER_FOR_MS = 4000
const CHEER_S = 3.2
/**
 * The calm rest that ends a lively flinch (seconds), after his eyes shut and his glance away.
 */
const FLINCH_REST_S = 1.5
/**
 * How long after a tool fails he is drawn flinching, its rest included; the hooks module redraws
 * as it ends. The flinch's own frame plays the whole rest and then the taps, so the frame after it
 * opens on the very tap it was at, and a turn that ends inside the rest goes from the flinch to the
 * cheer in one reload, with nothing between.
 */
export const FLINCH_MS = (0.5 + 1 + FLINCH_REST_S) * 1000

// Colors inside an Svg cannot follow the page's theme, so each one here reads on
// both claude.ai backgrounds (#faf9f5 and #262624). His eye, his heart and his
// z's are the tide's own, so /band switches the scene and never the Clawd.
const EYE = EYE_INK
const PINK = HEART_PINK
const SKY = '#5B9BD5'
const ZED = DOZE_SLATE
const LIMIT = '#A39E93'
// Dark enough that an empty meter still reads on the light band's gray.
const TRACK = 'rgba(140,134,122,0.42)'

// Clawd's canvas, in his own units (a pixel is 1 wide and 2 tall; 4 CSS px a
// unit): he stands in x 1..18, y 0..10, with a little room above him and to his
// right for his sparkles, z, sweat and heart, all of which stay inside it.
const VIEW = { x: -1, y: -4, width: 24, height: 16 }
const SCALE = 4

/** Every class and keyframe in his Svg starts with this, in case a host ever draws it inline. */
const P = 'hh-'
/**
 * Where the hearth parks the pet's heart, in rows below the band's top: always mounted (so it keeps
 * his clock) yet clipped away, until the band's hover moves it to 0, over him. Parked below, the
 * desktop keeps it in step with him; parked above or to the side, it fell out of step. (The beach,
 * whose heart walks, parks its own across the band's edge: see HEART_PARKED in tide/desk.tsx.)
 */
export const PARKED = 40

export function desk(els: Desk, view: DeskView): RenderElement {
  const { Box, Svg } = els
  const mood = moodOf(view)
  // The heart is always mounted, parked below the band where nothing of it shows, and the band's own
  // hover moves it onto him. Revealing it instead (display none to flex) would have the desktop draw it
  // as a floating card above the band, and a revealed picture starts its clock over.
  const clawd = (
    <Box key="clawd" position="relative" flexShrink={0}>
      <Svg source={clawdSvg(mood)} alt={altOf(mood)} width={VIEW.width * SCALE} height={VIEW.height * SCALE} />
      <Box position="absolute" top={PARKED} left={0} hover={{ top: 0 }}>
        <Svg source={petHeart(mood)} alt="" width={VIEW.width * SCALE} height={VIEW.height * SCALE} />
      </Box>
    </Box>
  )
  // No width from the host (0, or nothing usable): the words keep a 100-column band's panel.
  const isSized = Number.isFinite(view.columns) && view.columns > 0
  const panel = isSized ? Math.min(view.columns - 14, panelMost(view.columns)) : panelMost(100)
  if (panel < PANEL_MIN) {
    // Too narrow for words: Clawd keeps the band alone.
    return <Box flexDirection="row">{clawd}</Box>
  }
  // The room is the panel as a page with narrow cells (7.2 px) lays it out: beside Clawd's fixed
  // 96 px the panel then shrinks, so the words keep one to four cells to spare (fewest on the
  // narrowest bands) and no line ever runs past the band's edge.
  const room = isSized ? Math.min(panel * NARROW_CELL_PX, (view.columns - 1) * NARROW_CELL_PX - VIEW.width * SCALE) : panel * NARROW_CELL_PX
  const said: Said = {
    isWorking: view.isWorking,
    activity: view.activity,
    slip: view.slip,
    todos: view.todos,
    isHigh: view.isHigh,
    percent: view.percent,
    limit: view.limit,
    lastTurn: view.lastTurn,
    resetsAt: view.limit?.resetsAt ?? null,
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
// in a desktop preview; the room they must fit is the panel as a page with
// narrower cells still would lay it out. A line fits when it fits that budget.

/** Under this many cells for the words' panel (as wide as the terminal's, see panelMost), Clawd keeps the band alone. */
const PANEL_MIN = 16
/** The narrowest cell a page is expected to draw (the desktop's measures 7.8 px): the room is counted at this. */
const NARROW_CELL_PX = 7.2
/** Each percentage sits in a box this many cells wide, so a meter group never shifts as a digit comes or goes. */
const FIGURE_CELLS = 5

const PX: Measure = {
  row: row => row.reduce((sum, seg) => sum + textPx(seg.text, seg.bold === true), 0),
  gap: 2 * CELL_PX,
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
        // Never an ellipsis straight after a hyphen, a slash, a dot or a space; words a person wrote
        // end on their last whole word ("Run the…").
        const neat = squeezeCut(line, seg.text, kept)
        out.push({ ...seg, text: `${neat === '' ? kept : neat}${ELLIPSIS}` })
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
function fillPx(view: Pick<DeskView, 'percent' | 'isHigh' | 'limit' | 'cost'>, shape: Fill): number {
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
  return isLong ? `${label} limit` : label
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
      <Text color={isWarm ? 'claude' : undefined} bold={isWarm}>
        {percentText(percent)}
      </Text>
    </Box>
  )

  // With the pills, the cost keeps to the right edge, under the model; without them (a narrow
  // band, where the model has gone too) it follows the figures, so no hole opens in the line.
  return (
    <Box flexDirection="row" justifyContent={shape.ctx === null ? 'flex-start' : 'space-between'} alignItems="center">
      <Box flexDirection="row" alignItems="center" flexShrink={0}>
        <Text dimColor>context</Text>
        {meter(shape.ctx, view.percent, CLAY, view.percent === null ? 'No context reading yet' : `Context ${Math.round(view.percent)}% full`)}
        {figure(view.percent, view.isHigh, shape.ctx !== null)}
        {limit === null || !shape.hasLimit ? null : (
          <Box flexDirection="row" alignItems="center" marginLeft={1} flexShrink={0}>
            <Text dimColor>{labelOf(limit.label, shape.isLong)}</Text>
            {meter(shape.lim, limit.percent, isNear ? CLAY : LIMIT, `${capitalized(limit.label)} limit ${limit.percent}% used`)}
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

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function percentText(percent: number | null): string {
  // No reading yet (a new session, a /clear): an en dash, never a "0%" that was never measured.
  return percent === null ? '–' : `${Math.round(percent)}%`
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

type Eyes = 'open' | 'left' | 'right' | 'closed'
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
  /** A flinch that comes while the last still plays is drawn under a second name: a new source, so the page starts it over. */
  isFlinchAgain: boolean
  isHigh: boolean
  /** `/band still` or Claude Code's reduced motion: one pose per moment, nothing moves. */
  isStill: boolean
  /** Idle and awake: he dozes off by himself, NAP_AFTER_S after his Svg appears. */
  isDozy: boolean
  /**
   * Asleep: how far (seconds) the z of the frame before had drifted when this frame came, so his z
   * carries on rather than shrinking to nothing and growing again. The nap's own redraw follows the
   * frame he dozed off in: one that appeared as a stopped turn landed dozed off as the nap fell due,
   * a second before (NAP_LATE_MS); one that came after a cheer (or the hello) has not dozed off yet,
   * so its z starts here. Any other nap frame (still to lively, the beach to the hearth, a reload)
   * follows one that already showed a z: a second in, where the z is whole.
   */
  dozedS: number
}

const REST: Pose = { eyes: 'open', arms: 'down', feet: 'both' }

// The moment, and nothing finer: every redraw within the same moment gives the same mood.
function moodOf(view: DeskView): Mood {
  const isIdle = !view.isWorking
  // Waiting on you (a question, a plan to look over): he rests, as between turns, but never dozes.
  const isWaiting = view.isWorking && view.activity?.kind === 'ask'
  const idle = view.idleMs ?? 0
  const isNap = isIdle && view.idleMs !== null && idle >= NAP_AFTER_MS
  const mode: Mode = isNap ? 'nap' : isIdle || isWaiting ? 'idle' : 'work'

  // A moment that began before this look came on screen (a /band or /config switch) is over for
  // it: the new frame starts at rest, rather than playing the moment from its first beat only for
  // the moment's end to cut it short.
  const isSeen = (ago: number | null) => view.shownForMs === null || (ago !== null && ago <= view.shownForMs)
  // Over, the flinch's frame may stay up through the turn (`isFlinchKept`): it has gone on into his taps.
  const isFlinch = !isIdle && view.flinchAgoMs !== null && (view.flinchAgoMs < FLINCH_MS || view.isFlinchKept === true) && isSeen(view.flinchAgoMs)

  return {
    mode,
    isCheer: isIdle && !isNap && view.lastTurn?.ending === 'answer' && idle < CHEER_FOR_MS && isSeen(view.idleMs),
    // Still, no wave is drawn, so none is said (the beach is the same: its hello never shows still).
    isWave: isIdle && view.isGreeting && !isNap && !view.isStill,
    isFlinch,
    isFlinchAgain: isFlinch && view.isFlinchAgain === true,
    isHigh: view.isSweating ?? view.isHigh,
    isStill: view.isStill,
    isDozy: isIdle && !isNap,
    dozedS: !isNap ? 0 : (view.dozedS ?? (view.lastTurn !== null && view.lastTurn.ending !== 'answer' ? NAP_LATE_MS / 1000 : 0)),
  }
}

// What the picture shows, his moment or else what he is up to, in short sentences in the tide's
// voice, so a screen reader hears one writer whichever look is on.
function altOf(mood: Mood): string {
  if (mood.mode === 'nap') return 'Clawd naps.'
  if (mood.isFlinch) return mood.isStill ? 'Clawd flinches at a failed step.' : 'Clawd flinches at a failed step, then taps along again.'
  if (mood.mode === 'work') {
    // Still, he does not tap: he sits as Claude works.
    const doing = mood.isStill ? 'Clawd sits quietly while Claude works' : 'Clawd taps along'
    return mood.isHigh ? `${doing}, a bead of sweat on his brow.` : mood.isStill ? `${doing}.` : 'Clawd taps along as Claude works.'
  }
  if (mood.isCheer) return 'Clawd cheers for a finished turn.'
  if (mood.isWave) return 'Clawd waves hello.'

  return mood.isHigh ? 'Clawd rests, a bead of sweat on his brow.' : 'Clawd rests.'
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
    // Arms up for the whole cheer, lively or calm: his two hops carry its beat, as on the terminal.
    tracks.push({ name: 'c', steps: [[CHEER_S, up]], delay: 0, isLoop: false })
  }
  if (mood.isFlinch) {
    // Eyes shut, a look at what failed, then a calm moment at rest before the taps come back, all
    // of it inside FLINCH_MS: the taps start in this frame, so the one that takes over at its end
    // opens on the same tap. Calm, his eyes stay shut a moment and then he rests.
    const steps: Array<[number, Pose]> = isCalm ? [[1.5, shut]] : [[0.5, shut], [1.0, { ...REST, eyes: 'left' }], [FLINCH_REST_S, REST]]
    tracks.push({ name: mood.isFlinchAgain ? 'f2' : 'f', steps, delay: 0, isLoop: false })
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
  { name: 'el-o', fill: EYE, rects: [[5, 2, 1, 2]], shows: p => p.eyes === 'open' },
  { name: 'el-l', fill: EYE, rects: [[4, 2, 1, 2]], shows: p => p.eyes === 'left' },
  { name: 'el-r', fill: EYE, rects: [[6, 2, 1, 2]], shows: p => p.eyes === 'right' },
  { name: 'el-c', fill: EYE, rects: [[4, 3.2, 2, 0.8]], shows: p => p.eyes === 'closed' },
  { name: 'er-o', fill: EYE, rects: [[13, 2, 1, 2]], shows: p => p.eyes === 'open' },
  { name: 'er-l', fill: EYE, rects: [[12, 2, 1, 2]], shows: p => p.eyes === 'left' },
  { name: 'er-r', fill: EYE, rects: [[14, 2, 1, 2]], shows: p => p.eyes === 'right' },
  { name: 'er-c', fill: EYE, rects: [[12, 3.2, 2, 0.8]], shows: p => p.eyes === 'closed' },
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
  // Little things around him: sparkles for a cheer, a z for a nap, a bead of
  // sweat when the context runs high. He is pixels; the sparkles, z and bead
  // are soft, smooth shapes, so they read as his feelings.
  const extras: string[] = []
  if (mood.isCheer) {
    extras.push(
      `<g class="${P}sp" fill="${CLAY}" shape-rendering="geometricPrecision">${sparkle(20.3, -1.6, 1.4)}</g>`,
      `<g class="${P}sp ${P}sp2" fill="${CLAY}" shape-rendering="geometricPrecision">${sparkle(0.4, -2.1, 1.1)}</g>`,
    )
  }
  if (mood.mode === 'nap' || mood.isDozy) {
    extras.push(
      `<g class="${P}z" fill="none" stroke="${ZED}" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision">${zed(19, 1.25, 2)}</g>`,
    )
  }
  if (mood.isHigh && mood.mode !== 'nap') {
    extras.push(`<g class="${P}sw" fill="${SKY}" shape-rendering="geometricPrecision">${drop(17, -1.2)}</g>`)
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}" ` +
    `width="${VIEW.width * SCALE}" height="${VIEW.height * SCALE}" shape-rendering="crispEdges">` +
    `<style>${css.join('')}</style>` +
    `<g class="${P}hop"><g fill="${CLAY}">${rects(BODY)}</g>${parts.join('')}</g>${extras.join('')}` +
    `</svg>`
  )
}

/**
 * Petting him on the desktop: a heart beside him, or over his head as he sleeps, drawn over him
 * while a pointer rests on him. He is an image (an interactive frame blanks for a frame or two each
 * time its source changes), and an image takes no hover, so the heart is a picture of its own, his
 * size, parked below the band until its hover lays it over him. It shows at once, with no pop, and
 * beats softly; held still under reduced motion and /band still.
 */
function petHeart(mood: Mood): string {
  const [hx, hy] = mood.mode === 'nap' ? NAP_HEART : PET_HEART
  const beat =
    `.${P}ht{transform-box:fill-box;transform-origin:center}` +
    `@keyframes ${P}beat{0%,50%,100%{transform:scale(1)}20%{transform:scale(1.14)}}`
  const css = mood.isStill ? '' : `@media (prefers-reduced-motion:no-preference){.${P}ht{animation:${P}beat 1.6s ease-in-out infinite}}`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}" ` +
    `width="${VIEW.width * SCALE}" height="${VIEW.height * SCALE}">` +
    `<style>${beat}${css}</style>` +
    `<g class="${P}ht" fill="${PINK}" shape-rendering="geometricPrecision">${heart(hx, hy)}</g>` +
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

  // Where his loop begins (its bead of sweat keeps its place in it), or else where his moments end.
  const lead = tracks.find(track => track.isLoop)?.delay ?? leadOf(tracks.filter(track => !track.isLoop && !track.isHeld))
  const napAt = Math.max(lead, NAP_AFTER_S)
  if (isCalm) {
    // One pose per moment: a sparkle shown for the cheer, a z once he sleeps, a bead of sweat held.
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
      `.${P}hop{animation:none}`,
    )

    return { keyframes, rules }
  }

  const period = sweatPeriod(mood)
  const pct = (seconds: number) => round((seconds / period) * 100)
  keyframes.push(
    // A sparkle twinkles up from a point, holds, and shrinks back to one; twice. Never faded: a
    // half-faded clay star on the dark page is a muddy brown smudge (the tide's stars do the same).
    `@keyframes ${P}tw{0%{opacity:1;transform:scale(0) rotate(-20deg)}25%{opacity:1;transform:scale(1) rotate(0deg)}65%{opacity:1;transform:scale(.9) rotate(0deg);animation-timing-function:ease-in}100%{opacity:1;transform:scale(0) rotate(0deg)}}`,
    // Two little hops as his arms go up.
    `@keyframes ${P}hop{0%,16%,50%,64%,100%{transform:translate(0,0)}7%,56%{transform:translate(0,-1px)}}`,
    // One z at a time pops up beside him and drifts up and away, shrinking as it goes: at full
    // color throughout, as the tide's z's, since a half-faded slate is a muddy gray on the dark page.
    `@keyframes ${P}zz{0%{opacity:1;transform:translate(0,0) scale(0)}12%{opacity:1;transform:translate(.1px,-.3px) scale(1.1)}22%{opacity:1;transform:translate(.25px,-.7px) scale(1)}70%{opacity:1;transform:translate(1.1px,-3.3px) scale(1);animation-timing-function:ease-in}100%{opacity:1;transform:translate(1.5px,-4.5px) scale(0)}}`,
    // A bead of sweat forms, slides a little, and goes: from 2 s to 4.5 s of
    // his loop, which at work is the rest after the tap (the claw is down by
    // 1.5 s) and before the glance (4.8 s), and idle the rest before his first
    // blink (5.4 s); it stops above his claw.
    `@keyframes ${P}sw{0%,${pct(2)}%{opacity:0;transform:translate(0,0)}${pct(2.5)}%{opacity:1;transform:translate(0,0)}` +
      `${pct(4)}%{opacity:1;transform:translate(0,1px)}${pct(4.5)}%,100%{opacity:0;transform:translate(0,1px)}}`,
  )
  rules.push(
    `.${P}sp{opacity:0;transform-box:fill-box;transform-origin:center;animation:${P}tw 1.5s ease-out 0.1s 2 both}`,
    `.${P}sp2{animation-delay:.7s}`,
    // Asleep, the z carries on from the frame he dozed off in (see dozedS): never popping up afresh.
    `.${P}z{opacity:0;transform-box:fill-box;transform-origin:center;animation:${P}zz 3s ease-out ${mood.mode === 'nap' ? -mood.dozedS : napAt}s infinite}`,
    `.${P}sw{opacity:0;transform:none;animation:${P}sw ${period}s ease-in ${round(lead)}s infinite${mood.isDozy ? `,${P}off 1s step-end ${napAt}s 1 forwards` : ''}}`,
    mood.isCheer ? `.${P}hop{animation:${P}hop ${CHEER_S}s ease-out 0s 1 none}` : `.${P}hop{animation:none}`,
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

// A four-point twinkle with tapered rays, centered on (x, y).
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

// The terminal's block heart, as the tide draws it on the beach, its corner at (x, y): pixels half
// a unit wide and three quarters tall (2 by 3 screen pixels at SCALE), so every edge falls on a
// whole pixel and the held heart is crisp at 1x and 2x.
function heart(x: number, y: number): string {
  return pixelHeart(x, y, 0.5, 0.75)
}

/** Where the petted heart stands: up beside his right claw, and over his head (right of center, beside the z) as he naps. */
const PET_HEART: [number, number] = [18.75, 0.75]
const NAP_HEART: [number, number] = [12.5, -3.5]

// A soft z, s units square, its corner at (x, y): drawn with a round pen.
function zed(x: number, y: number, s: number): string {
  return `<path d="M${x} ${y}L${round(x + s)} ${y}L${x} ${round(y + s)}L${round(x + s)} ${round(y + s)}"/>`
}
