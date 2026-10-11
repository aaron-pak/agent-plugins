import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { BandProps, Doing } from '../types'
import { APPLE_EYES, ARMS, EYES, FEET, SPIN, cells, cut } from './clawd'
import type { Arms, Eyes, Feet } from './clawd'
import { ACCENT, DIM, SPACE, WARN, firstFit, happeningForms, span, squeezeRoom, whereForms } from './words'
import type { Form, Line, Measure, Row, Seg } from './words'

// Hearth, on the terminal: Claude Code's own Clawd on the left, three calm lines
// beside him (where you are, how full things are, what is happening). Clawd's
// pose carries the state; the words stay put and only change when the session
// does. One frame clock at 250 ms, and a frame is drawn again only when it looks
// different from the last one drawn, so an idle band is still.
//
// What the band shows of the work under way (line 3, and the pose that goes
// with it) is held at least a second, a pause between tools shorter than three
// quarters of a second is no pause, and it moves on only on a tick of the
// clock: a burst of quick tools reads as one calm stretch of work.

type Frame = { sprite: Row[]; marks: Row[]; lines: Line[]; panel: number }

/** What line 3 and Clawd's working pose are drawn from: held on screen as one piece. */
type Shown = Pick<BandProps, 'isWorking' | 'activity' | 'slip' | 'todos'>

type Live = {
  props: BandProps
  tick: number
  /** The tick the current props arrived on, and what they said: idle and reset times count on from there. */
  propsTick: number
  propsKey: string
  shown: Shown
  shownKey: string
  shownTick: number
  /** What the props say to show, and since when: a pause must last before it shows. */
  wantKey: string
  wantTick: number
  /** His look at the words while Claude reads: the latest one, and the next one due. */
  glanceAt: number
  nextGlance: number
  seenCheers: number
  seenOops: number
  /** A tool failed: its hiccup goes up on a tick, has its second whatever starts next, and he flinches with it. */
  slipDue: Doing | null
  /** The tick the hiccup went up (NEVER while it waits its turn). */
  slipUpAt: number
  cheerUntil: number
  oopsFrom: number
  oopsUntil: number
  petAt: number
  waveUntil: number
}
/** `drawn` is the frame on screen, as JSON: a tick that composes the same frame draws nothing. */
type State = { live: Live; drawn: string }

const TICK_MS = 250
const NEVER = -1_000_000
const NAP_AFTER_MS = 3 * 60_000
const CHEER_TICKS = 16
const OOPS_TICKS = 6
const WAVE_TICKS = 10
/** What he shows of the work stays at least this many ticks (a second)... */
const HOLD_TICKS = 4
/** ...and a pause between tools must last this many (three quarters of a second) to show. */
const GAP_TICKS = 3
/** A look at the words while Claude reads: two seconds, as a read starts and then every 10 to 16 s. */
const GLANCE_TICKS = 8
const GLANCE_EVERY: [number, number] = [40, 64]
/** A read that starts this soon after his last look does not earn another. */
const GLANCE_REST = 32
/** A claw tap and a step come round every four seconds. */
const BEAT = 16
/** A bead of sweat comes every eight seconds at work and every sixteen idle, on ticks 8 to 13 of its cycle. */
const SWEAT_AT_WORK = 32
const SWEAT_IDLE = 64
/** Petted: a full turn through Claude Code's 13 frames, a wink with a heart beside him, then the heart floats up. */
const PET_WINK = 4
const PET_FLOAT = 6
const PET_CALM = 12

// Layout, in cells: a margin, Clawd, his marks (the bead in the first cell, a
// heart, a z, a sparkle), a gap, then the words. Rows end at least two cells
// short of the band.
const MARGIN = 1
const SPRITE = 9
const MARKS = 4
const GAP = 1
const SLACK = 2
const LEFT = MARGIN + SPRITE + MARKS + GAP

// Colors are the person's theme keys; raw hex only for the heart, which no key covers.
const BODY = 'clawd_body'
const DARK = 'clawd_background'
const TRACK = 'subtle'
const SWEAT = 'ide'
const HEART = '#E86A92'

/** Something beside Clawd: `lines` drawn from `row` down, starting `col` cells into the marks column. */
type Mark = { row: number; col: number; lines: string[]; color: string }
/** `turn` is a frame of his spin, drawn in place of the pose; `canSweat` is false in a moment that keeps the bead away. */
type Pose = { eyes: Eyes; arms: Arms; feet: Feet; turn: number | null; mark: Mark | null; canSweat: boolean }

// A pixel heart, seven quadrants across and four down (a terminal cell is
// twice as tall as wide, so it comes out about as wide as it is tall), set in
// four cells with its first half cell empty: it keeps clear of his claw.
//   . . # # . # # .
//   . # # # # # # #
//   . . # # # # # .
//   . . . . # . . .
const HEART_PIXELS = ['▗█▟▙', ' ▀▛▘']

const Band: ClientModule<BandProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    // Drawn for the first time: say hello in a fresh session, and catch a turn
    // that landed (or a tool that failed) just before he appeared.
    const isFresh = props.isGreeting && !props.isWorking && !props.isStill
    const justLanded = props.lastTurn?.ending === 'answer' && !props.isWorking && (props.idleMs ?? Infinity) < 3000
    const justSlipped = props.isWorking && props.activity === null && (props.slipAgoMs ?? Infinity) < 2000
    const slipDue = justSlipped ? (props.lastSlip ?? props.slip) : null
    const shown = slipDue === null ? shownOf(props) : { ...shownOf(props), activity: null, slip: slipDue }
    const key = JSON.stringify(shown)
    const live: Live = {
      props,
      tick: 0,
      propsTick: 0,
      propsKey: JSON.stringify(props),
      shown,
      shownKey: key,
      shownTick: -HOLD_TICKS,
      wantKey: key,
      wantTick: 0,
      glanceAt: NEVER,
      nextGlance: NEVER,
      seenCheers: props.cheers,
      seenOops: props.oops,
      slipDue,
      slipUpAt: slipDue === null ? NEVER : 0,
      cheerUntil: justLanded ? CHEER_TICKS : NEVER,
      oopsFrom: slipDue === null ? NEVER : 0,
      oopsUntil: slipDue === null ? NEVER : OOPS_TICKS,
      petAt: NEVER,
      waveUntil: isFresh ? WAVE_TICKS : NEVER,
    }
    // A read under way as he appears: he looks over at it.
    notice(live, null)
    state = { live, drawn: '' }
    surface.setState(state)
    surface.every(TICK_MS, () => advance(surface))
    surface.onPointer(event => pet(surface, event))
  }
  receive(state.live, props)
  const frame = compose(state.live, widthOf(surface))
  // What this call draws is now on screen: the next tick compares against it,
  // so new props never cost a second, identical frame.
  state.drawn = JSON.stringify(frame)

  const draw = (row: Row) => row.map(({ text, ...style }) => <Text {...style}>{text}</Text>)

  return (
    <Box flexDirection="row" height={3} paddingLeft={MARGIN}>
      <Box flexDirection="column" width={SPRITE} flexShrink={0}>
        {frame.sprite.map(row => (
          <Box height={1} overflow="hidden">
            <Text>{draw(row)}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" width={MARKS} flexShrink={0}>
        {frame.marks.map(row => (
          <Box height={1} overflow="hidden">
            <Text>{row.length === 0 ? ' ' : draw(row)}</Text>
          </Box>
        ))}
      </Box>
      {frame.panel > 0 && (
        <Box flexDirection="column" width={frame.panel} marginLeft={GAP} flexShrink={0}>
          {frame.lines.map(line => (
            <Box height={1} flexDirection="row" overflow="hidden">
              <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
                {line.squeeze === undefined
                  ? [<Text wrap="truncate-end">{line.left.length === 0 ? ' ' : draw(line.left)}</Text>]
                  : [
                      <Box flexShrink={0}>
                        <Text>{draw(line.left)}</Text>
                      </Box>,
                      <Box flexShrink={1} overflow="hidden" width={line.squeezeWidth}>
                        <Text wrap="truncate-end">{draw(line.squeeze)}</Text>
                      </Box>,
                      <Box flexShrink={0}>
                        <Text>{draw(line.tail ?? [])}</Text>
                      </Box>,
                    ]}
              </Box>
              {line.right.length > 0 && (
                <Box flexShrink={0} marginLeft={2}>
                  <Text>{draw(line.right)}</Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default Band

// New props: note when they came, start a cheer for a new turn, queue the
// hiccup of a failed tool, and see whether what is shown may move on (only a
// landing may, between ticks).
function receive(live: Live, props: BandProps): void {
  // Compared by value: the module is called again after every frame with the
  // same props, and only new ones restart the idle and reset clocks.
  const key = JSON.stringify(props)
  if (key !== live.propsKey) {
    live.propsKey = key
    live.propsTick = live.tick
  }
  if (props.cheers > live.seenCheers) {
    live.cheerUntil = live.tick + CHEER_TICKS
    live.waveUntil = NEVER
  }
  const slip = props.lastSlip ?? props.slip
  if (props.oops > live.seenOops && slip !== null) {
    // The hiccup goes up on a tick, as soon as what is shown has had its second; he flinches with it.
    live.slipDue = slip
    live.slipUpAt = NEVER
  }
  live.seenCheers = props.cheers
  live.seenOops = props.oops
  live.props = props
  hold(live, false)
}

function shownOf(props: BandProps): Shown {
  return { isWorking: props.isWorking, activity: props.activity, slip: props.slip, todos: props.todos }
}

/**
 * What the props say to show: a hiccup waiting its turn, else what is happening.
 * A failure owns line 3 for its second whatever starts next, so the hiccup and
 * the flinch always go up together, naming the tool that failed.
 */
function wanted(live: Live): Shown {
  const shown = shownOf(live.props)

  return live.slipDue !== null && live.props.isWorking ? { ...shown, activity: null, slip: live.slipDue } : shown
}

/**
 * Moves what he shows to what the props say: on a tick, once what is up has
 * been up a second, and a pause only once it has lasted three quarters of one.
 * A turn that lands shows at once (the cheer is now).
 */
function hold(live: Live, isTick: boolean): void {
  if (live.slipDue !== null && (!live.props.isWorking || (live.slipUpAt !== NEVER && live.tick - live.slipUpAt >= HOLD_TICKS))) {
    // The hiccup has had its second (or the turn is over): what is happening now comes next.
    live.slipDue = null
    live.slipUpAt = NEVER
  }
  const want = wanted(live)
  const key = JSON.stringify(want)
  if (key === live.shownKey) {
    live.wantKey = key
    return
  }
  if (key !== live.wantKey) {
    live.wantKey = key
    live.wantTick = live.tick
  }
  const hasLanded = live.shown.isWorking && !want.isWorking
  const isHeld = live.tick - live.shownTick < HOLD_TICKS
  const isPause =
    want.isWorking && want.activity === null && want.slip === null && live.shown.activity !== null && live.tick - live.wantTick < GAP_TICKS
  // A hiccup takes over from its own tool at once: the line keeps its subject and says it stumbled.
  const isOwn = want.slip !== null && JSON.stringify(want.slip) === JSON.stringify(live.shown.activity)
  if (hasLanded || (isTick && (isOwn || (!isHeld && !isPause)))) {
    const before = live.shown
    live.shown = want
    live.shownKey = key
    live.shownTick = live.tick
    if (live.slipDue !== null && want.slip === live.slipDue && live.slipUpAt === NEVER) {
      // The hiccup goes up: he squeezes his eyes shut, then glances away.
      live.slipUpAt = live.tick
      live.oopsFrom = live.tick
      live.oopsUntil = live.tick + OOPS_TICKS
    }
    notice(live, before)
  }
}

function isReading(shown: Shown): boolean {
  return shown.isWorking && (shown.activity?.kind === 'read' || shown.activity?.kind === 'web')
}

// Claude starts reading: he looks over at the words, unless he did a moment ago.
function notice(live: Live, before: Shown | null): void {
  if (live.props.isStill || !isReading(live.shown) || (before !== null && isReading(before))) {
    return
  }
  if (live.tick - live.glanceAt >= GLANCE_REST) {
    live.glanceAt = live.tick
    live.nextGlance = later(live.tick)
  } else {
    live.nextGlance = Math.max(live.nextGlance, later(live.glanceAt))
  }
}

// A tiny deterministic dice, so a frame is a function of the tick.
function later(tick: number): number {
  const n = Math.imul((tick * 8 + 3) ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  const [low, high] = GLANCE_EVERY

  return tick + low + (((n ^ (n >>> 13)) >>> 0) % (high - low + 1))
}

function advance(surface: ClientSurface<State>): void {
  const state = surface.state
  if (state === undefined) {
    return
  }
  const live = state.live
  live.tick += 1
  hold(live, true)
  // Reading on: the next look at the words comes round.
  if (!live.props.isStill && isReading(live.shown) && live.tick >= live.nextGlance) {
    live.glanceAt = live.tick
    live.nextGlance = later(live.tick)
  }
  repaint(surface, state)
}

function pet(surface: ClientSurface<State>, event: ClientPointerEvent): void {
  const state = surface.state
  if (state === undefined || event.type !== 'down') {
    return
  }
  const live = state.live
  const isSpinning = live.tick - live.petAt < SPIN.length
  if (!isSpinning && event.y <= 2 && event.x >= MARGIN && event.x < MARGIN + SPRITE + MARKS) {
    live.petAt = live.tick
    repaint(surface, state)
  }
}

// Draw again only when the frame differs from the one on screen.
function repaint(surface: ClientSurface<State>, state: State): void {
  const drawn = JSON.stringify(compose(state.live, widthOf(surface)))
  if (drawn !== state.drawn) {
    surface.setState({ live: state.live, drawn })
  }
}

function widthOf(surface: ClientSurface<State>): number {
  return surface.columns > 0 ? surface.columns : (surface.state?.live.props.columns ?? 100)
}

/**
 * The words sit in a panel of fixed width per band width, so the right-hand
 * figures never wander when a line gets longer or shorter: 68 cells at 100
 * columns, a little more on wider terminals (78 at 140, and never more than
 * 80, so the figures stay near their lines), all the room there is below
 * that. Too narrow for words, Clawd keeps the band alone.
 */
function panelWidth(columns: number): number {
  const room = columns - SLACK - LEFT
  if (room < 16) {
    return 0
  }

  return Math.min(room, 80, 68 + Math.max(0, Math.floor((columns - 100) / 4)))
}

function compose(live: Live, columns: number): Frame {
  const panel = panelWidth(columns)
  const pose = poseAt(live, live.tick)
  // The bead stays clear of a raised claw: it only shows while his arms are down.
  const sweat = pose.arms === 'down' && pose.turn === null && pose.canSweat ? sweatAt(live, live.tick) : null
  const sprite = pose.turn !== null ? turned(pose.turn) : live.props.isAppleTerminal ? appleSprite(pose) : body(pose)

  return { sprite, marks: marks(pose, sweat), lines: words(live, panel), panel }
}

// ── Clawd ──────────────────────────────────────────────────────────────────────

const REST: Pose = { eyes: 'open', arms: 'down', feet: 'both', turn: null, mark: null, canSweat: true }

/** His pose at a tick, from what he knows now (later ticks too: the bead looks ahead for a quiet stretch). */
function poseAt(live: Live, tick: number): Pose {
  const { props } = live
  const still = props.isStill

  const petAge = tick - live.petAt
  if (petAge >= 0 && petAge < petLength(props)) {
    return petted(petAge, props)
  }
  if (tick >= live.oopsFrom && tick < live.oopsUntil) {
    // Squeezes his eyes shut, then glances away. Calm: eyes shut, the whole time.
    const age = tick - live.oopsFrom
    return { ...REST, eyes: still || age < 2 ? 'closed' : 'left' }
  }
  if (tick < live.cheerUntil) {
    return { ...cheer(tick - (live.cheerUntil - CHEER_TICKS), still), canSweat: false }
  }
  if (tick < live.waveUntil) {
    // Hello: one claw up, down, up again, held a moment each time.
    const age = tick - (live.waveUntil - WAVE_TICKS)
    return { ...REST, arms: age < 3 || (age >= 5 && age < 8) ? 'one-up' : 'down' }
  }
  if (live.shown.isWorking) {
    return working(live, tick)
  }
  if (isNapping(live, tick)) {
    // Eyes closed; a soft z drifts up beside him every four seconds. No sweat in his sleep.
    const phase = tick % 16
    const z = still ? { row: 0, col: 2 } : phase < 4 ? { row: 1, col: 1 } : phase < 8 ? { row: 0, col: 2 } : null
    return { ...REST, eyes: 'closed', mark: z === null ? null : { ...z, lines: ['z'], color: DIM }, canSweat: false }
  }
  if (still) {
    return REST
  }
  // Idle: still, but alive. A blink every five or six seconds, and every twenty
  // a glance over at the words (never a blink right beside it).
  const t = tick % 80
  const isGlance = t >= 40 && t < 44
  const isBlink = tick % 22 === 21 && !(t >= 38 && t < 46)

  return { ...REST, eyes: isGlance ? 'right' : isBlink ? 'closed' : 'open' }
}

function petLength(props: BandProps): number {
  return props.isStill ? PET_CALM : (props.isAppleTerminal ? 0 : SPIN.length) + PET_WINK + PET_FLOAT
}

// Petted: he turns all the way round (Claude Code's own turning frames), then
// winks with his arms up and a pixel heart beside him, clear of his claw;
// his arms come down and the heart floats up a row. Calm: the wink and the
// heart, held.
function petted(age: number, props: BandProps): Pose {
  const heart = (row: number): Mark => ({ row, col: 0, lines: HEART_PIXELS, color: HEART })
  if (props.isStill) {
    return { ...REST, eyes: 'wink', arms: 'up', mark: heart(1), canSweat: false }
  }
  const spin = props.isAppleTerminal ? 0 : SPIN.length
  if (age < spin) {
    return { ...REST, turn: age, canSweat: false }
  }
  if (age < spin + PET_WINK) {
    return { ...REST, eyes: 'wink', arms: 'up', mark: heart(1), canSweat: false }
  }

  return { ...REST, mark: heart(0), canSweat: false }
}

// A turn landed: arms up and held, a happy shuffle of the feet, a dip, arms up
// again, while a clay sparkle twinkles beside his raised claw. Four seconds.
function cheer(age: number, still: boolean): Pose {
  const sparkle = (text: string): Mark => ({ row: 0, col: 1, lines: [text], color: ACCENT })
  if (still) {
    return { ...REST, arms: 'up', mark: sparkle('✻') }
  }
  if (age < 4) {
    return { ...REST, arms: 'up', mark: sparkle('✶') }
  }
  if (age < 6) {
    return { ...REST, arms: 'up', feet: 'left', mark: sparkle('✻') }
  }
  if (age < 8) {
    return { ...REST, arms: 'up', feet: 'right', mark: sparkle('✶') }
  }
  if (age < 10) {
    // The dip: arms down, the sparkle small for a moment.
    return { ...REST, mark: sparkle('✢') }
  }

  return { ...REST, arms: 'up', mark: sparkle('✻') }
}

// While Claude works his pose says what kind of work it is, calmly: Claude
// Code's own spinner is already moving right above him. Eyes open is home.
function working(live: Live, tick: number): Pose {
  const activity = live.shown.activity
  if (live.props.isStill) {
    return REST
  }
  if (activity === null) {
    // Thinking: eyes on you; now and then a slow glance away, or a blink.
    const t = tick % 64
    return { ...REST, eyes: t >= 20 && t < 24 ? 'left' : t === 31 || t === 52 ? 'closed' : 'open' }
  }
  switch (activity.kind) {
    case 'read':
    case 'web': {
      // Reading: a look over at the words as the read starts, then eyes on you,
      // a blink now and then, and another look every 10 to 16 s.
      if (isGlancing(live, tick)) {
        return { ...REST, eyes: 'right' }
      }
      const isNear = [-2, -1, 1, 2].some(d => isGlancing(live, tick + d))
      return { ...REST, eyes: tick % 22 === 21 && !isNear ? 'closed' : 'open' }
    }
    case 'edit': {
      // Writing: a claw taps twice, half a second up each time, then rests; a blink in the rest.
      const t = tick % BEAT
      return { ...REST, eyes: tick % 32 === 27 ? 'closed' : 'open', arms: t < 2 || (t >= 4 && t < 6) ? 'one-up' : 'down' }
    }
    case 'run': {
      // A command running: a patient step in place, then a rest.
      const t = tick % BEAT
      return { ...REST, eyes: tick % 32 === 27 ? 'closed' : 'open', feet: t < 2 ? 'left' : t >= 4 && t < 6 ? 'right' : 'both' }
    }
    default:
      return { ...REST, eyes: tick % 22 === 21 ? 'closed' : 'open' }
  }
}

function isGlancing(live: Live, tick: number): boolean {
  const within = (start: number) => tick >= start && tick < start + GLANCE_TICKS

  return within(live.glanceAt) || (tick > live.tick && isReading(live.shown) && within(live.nextGlance))
}

// A bead of sweat forms beside his head and slides down: ticks 8 to 13 of its
// cycle, and only in a quiet stretch, where his pose holds still from two ticks
// before the bead to two after it. So it never meets a raised claw, a glance or
// a blink, and never makes a flurry of changes. Every 8 s at work, every 16 s idle.
function sweatAt(live: Live, tick: number): string | null {
  const { props } = live
  if (!props.isHigh) {
    return null
  }
  if (props.isStill) {
    return '▖'
  }
  const every = live.shown.isWorking ? SWEAT_AT_WORK : SWEAT_IDLE
  const phase = tick % every
  if (phase < 8 || phase >= 14) {
    return null
  }
  const from = tick - phase + 6
  const first = poseAt(live, from)
  if (!first.canSweat) {
    return null
  }
  const key = poseKey(first)
  for (let t = from + 1; t < from + 10; t++) {
    if (poseKey(poseAt(live, t)) !== key) {
      return null
    }
  }

  return phase < 11 ? '▘' : '▖'
}

function poseKey(pose: Pose): string {
  return JSON.stringify(pose)
}

// Idle three minutes: since the last turn, or (before the first prompt) since he appeared.
function isNapping(live: Live, tick: number): boolean {
  const { props } = live
  const idle = props.idleMs === null ? tick * TICK_MS : props.idleMs + (tick - live.propsTick) * TICK_MS

  return !props.isWorking && idle >= NAP_AFTER_MS
}

function body(pose: Pose): Row[] {
  const arms = ARMS[pose.arms]
  const eyes = EYES[pose.eyes].map(
    (span): Seg =>
      span.isLid === true
        ? { text: span.text, color: DARK, backgroundColor: BODY }
        : { text: span.text, color: BODY, backgroundColor: DARK },
  )

  return [
    [{ text: arms.r1L, color: BODY }, ...eyes, { text: arms.r1R, color: BODY }].filter(seg => seg.text !== ''),
    [
      { text: arms.r2L, color: BODY },
      { text: '█████', color: BODY, backgroundColor: DARK },
      { text: arms.r2R, color: BODY },
    ],
    [{ text: FEET[pose.feet], color: BODY }],
  ]
}

// One of Claude Code's turning frames: each row's dark columns on clawd_background.
function turned(frame: number): Row[] {
  const [head = '', headFrom = 0, headTo = 0, middle = '', middleFrom = 0, middleTo = 0, feet = ''] = SPIN[frame] ?? []
  const shade = (row: string, from: number, to: number): Row =>
    [
      { text: row.slice(0, from), color: BODY },
      { text: row.slice(from, to), color: BODY, backgroundColor: DARK },
      { text: row.slice(to).trimEnd(), color: BODY },
    ].filter(seg => seg.text !== '')

  return [shade(head, headFrom, headTo), shade(middle, middleFrom, middleTo), [{ text: feet.trimEnd(), color: BODY }]]
}

// No arms in this one, as in Claude Code's: his eyes, feet and marks carry the moment.
function appleSprite(pose: Pose): Row[] {
  return [
    [
      { text: '▗', color: BODY },
      { text: APPLE_EYES[pose.eyes], color: DARK, backgroundColor: BODY },
      { text: '▖', color: BODY },
    ],
    [{ text: ' ' }, { text: '       ', backgroundColor: BODY }],
    [{ text: pose.feet === 'both' ? ' ▘▘   ▝▝' : pose.feet === 'left' ? ' ▘▘' : '      ▝▝', color: BODY }],
  ]
}

// The marks column, row by row: the bead of sweat in its first cell, beside his
// head and a cell clear of it (his own last cell is where a raised claw goes),
// and a mark (a heart, a z, a sparkle) where it says.
function marks(pose: Pose, sweat: string | null): Row[] {
  const mark = pose.mark
  return [0, 1, 2].map(row => {
    const out: Row = row === 0 && sweat !== null ? [{ text: sweat, color: SWEAT }] : []
    const text = mark === null ? undefined : mark.lines[row - mark.row]
    if (mark !== null && text !== undefined) {
      out.push({ text: ' '.repeat(Math.max(0, mark.col - width(out))) }, { text, color: mark.color })
    }

    return out.filter(seg => seg.text !== '')
  })
}

// ── The words ──────────────────────────────────────────────────────────────────
//
// Each line has its forms, longest first (words.ts), measured here in terminal
// cells; the first that fits the panel is drawn. Parts drop whole, so Ink never
// cuts a figure or a label: only a branch, a file name or a todo may be cut at
// its end, in a box of its own, and never below six cells.

/** Terminal cells: wide CJK characters and emoji count two (see `cells`). */
const CELLS: Measure = { row: width, gap: 2, least: n => n }

function words(live: Live, panel: number): Line[] {
  const { props } = live
  const said = {
    ...live.shown,
    isHigh: props.isHigh,
    limit: props.limit,
    lastTurn: props.lastTurn,
    resetsIn: props.limit?.resetsInMs == null ? null : span(props.limit.resetsInMs - (live.tick - live.propsTick) * TICK_MS),
    isStatic: false,
    // While he cheers, the words say what finished; a warning waits for the cheer to end.
    isLanding: live.tick < live.cheerUntil,
  }

  return [firstFit(whereForms(props), panel, CELLS), fill(props, panel), firstFit(happeningForms(said), panel, CELLS)].map(line => cutAt(line, panel))
}

function width(row: Row): number {
  return row.reduce((sum, seg) => sum + cells(seg.text), 0)
}

/**
 * A squeezed part that must be cut is given a box exactly as wide as what
 * shows of it and Ink's ellipsis. A cut that would end inside a wide character
 * (CJK, an emoji) then lands on a cell boundary, so no stray blank cell opens
 * up before what follows it.
 */
function cutAt(line: Line, panel: number): Line {
  if (line.squeeze === undefined) {
    return line
  }
  const room = squeezeRoom(line, panel, CELLS)
  const text = line.squeeze.map(seg => seg.text).join('')
  if (cells(text) <= room) {
    return line
  }

  return { ...line, squeezeWidth: Math.max(1, cells(cut(text, room - 1)) + 1) }
}

// How full things are: context and the five-hour limit as soft meters, and the cost.
// Forms longest first: the meters shorten (20 and 12 cells on a wide band, 16
// and 10, 12 and 8, 8 and 5), the limit's label shortens to `5h`, the meters
// go and the figures stay, then the cost goes, then the limit.
function fill(props: BandProps, panel: number): Line {
  const limit = props.limit
  const cost: Row = props.cost === null ? [] : [{ text: props.cost }]
  const shapes: Array<{ ctx: number | null; lim: number | null; gap: number; isLong: boolean; hasCost: boolean; hasLimit: boolean }> = [
    ...(panel >= 76 ? [{ ctx: 20, lim: 12, gap: 3, isLong: true, hasCost: true, hasLimit: true }] : []),
    { ctx: 16, lim: 10, gap: 3, isLong: true, hasCost: true, hasLimit: true },
    { ctx: 12, lim: 8, gap: 3, isLong: true, hasCost: true, hasLimit: true },
    { ctx: 8, lim: 5, gap: 2, isLong: true, hasCost: true, hasLimit: true },
    { ctx: 8, lim: 5, gap: 2, isLong: false, hasCost: true, hasLimit: true },
    { ctx: null, lim: null, gap: 3, isLong: false, hasCost: true, hasLimit: true },
    { ctx: null, lim: null, gap: 2, isLong: false, hasCost: false, hasLimit: true },
    { ctx: null, lim: null, gap: 2, isLong: false, hasCost: false, hasLimit: false },
  ]
  const forms = shapes.map(({ ctx, lim, gap, isLong, hasCost, hasLimit }): Form => {
    // Meters keep Clawd's clay (the limit a quiet grey); only the number turns
    // amber past the line, so a full band reads clearly without shouting. Each
    // number hugs its meter and pads after itself, so nothing after it moves.
    const left: Row = [{ text: 'context', color: DIM }, SPACE, ...(ctx === null ? [] : [...meter(props.percent, ctx, ACCENT), SPACE]), ...figure(props.percent, props.isHigh)]
    if (limit !== null && hasLimit) {
      left.push(
        { text: ' '.repeat(gap) },
        { text: isLong && limit.label === '5h' ? '5h limit' : limit.label, color: DIM },
        SPACE,
        ...(lim === null ? [] : [...meter(limit.percent, lim, DIM), SPACE]),
        ...figure(limit.percent, limit.percent >= 80),
      )
    }

    return { line: { left, right: hasCost ? cost : [] }, least: 0 }
  })

  return firstFit(forms, panel, CELLS)
}

// "42%" and its padding to four cells, apart: a warm figure is bold, and its padding is plain.
function figure(percent: number | null, isWarm: boolean): Row {
  const text = percent === null ? '-' : `${Math.round(percent)}%`

  return [isWarm ? { text, color: WARN, bold: true } : { text }, { text: ' '.repeat(Math.max(0, 4 - cells(text))) }].filter((seg: Seg) => seg.text !== '')
}

// A soft meter: one even track, filled from the left.
function meter(percent: number | null, size: number, color: string): Row {
  // Any use at all shows as a sliver; full only when it is.
  const p = percent === null ? 0 : Math.min(100, Math.max(0, percent))
  const filled = p === 0 ? 0 : Math.min(p >= 99.5 ? size : size - 1, Math.max(1, Math.round((p / 100) * size)))

  return [
    { text: '━'.repeat(filled), color },
    { text: '━'.repeat(size - filled), color: TRACK },
  ].filter(seg => seg.text !== '')
}
