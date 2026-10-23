import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { BandProps, Doing } from './types'
import { APPLE_EYES, APPLE_FEET, ARMS, EYES, FEET, SPIN, TERMINAL_HEART, cells, dice } from '../clawd'
import { NAP_AFTER_MS } from '../facts'
import type { Arms, Eyes, Feet } from '../clawd'
import { ACCENT, CELLS, DIM, SPACE, cutAt, firstFit, happeningForms, panelMost, whereForms } from './words'
import { hasRoom, isHeld, isSettled, newPace, spend, tick } from '../pace'
import type { Pace } from '../pace'
import type { Form, Line, Row, Seg } from './words'

// Hearth, on the terminal: Claude Code's own Clawd on the left, three calm lines
// beside him (where you are, how full things are, what is happening). Clawd's
// pose carries the state; the words stay put and only change when the session
// does. One frame clock at 250 ms, and a frame is drawn again only when it looks
// different from the last one drawn, so an idle band is still.
//
// What the band shows of the work under way (line 3, and the pose that goes
// with it) is the line the facts' hold settled on (stepHeld in facts.ts: held at
// least a second, and a pause between tools shorter than three quarters of a
// second is no pause), the very one the desktop shows, taken up at once when the
// frame on screen has been up a tick (else on the next tick of this clock), so the
// line and his pose move together and no beat is cut short: a burst of quick tools
// reads as one calm stretch of work, and the two surfaces name the same tools.

type Frame = { sprite: Row[]; marks: Row[]; lines: Line[]; panel: number; columns: number }

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
  /**
   * What the props have asked to show since `wantTick`; the tick they first moved off what is shown
   * (`offTick`, NEVER while they agree); and how many ticks late what is shown came up here (`lag`:
   * a tick at most, when the beat on screen had its tick first). See hold.
   */
  wantKey: string
  wantTick: number
  offTick: number
  lag: number
  /** When "Thinking" last came up: his slow glance away while Claude thinks counts from there. */
  thinkAt: number
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
/**
 * `frame` is the frame on screen, and `drawn` the same as JSON: a tick that composes the same frame
 * draws nothing. `pace` keeps every second to four changes and every frame up a tick at least (see
 * pace.ts): a change between ticks (a pet, a turn landing, a /band switch) shows at once when the
 * second has room for it, else on the next tick that has; a tick that would change a frame put up
 * just before it holds, clock and all. A look switch to the hearth starts a fresh pace: what he
 * carries on from the beach (a cheer, a hiccup, a glance) holds its first pose half a second at
 * least, so his first tick never changes the frame the switch put up.
 */
type State = { live: Live; drawn: string; frame: Frame; pace: Pace }

const TICK_MS = 250
const NEVER = -1_000_000
const CHEER_TICKS = 16
/** The fewest ticks of a cheer left for a new band to carry it on (1.5 s). */
const RESUME_CHEER = 6
/** The ticks after a cheer with no blink (750 ms): the cheer never ends on closed eyes. */
const AFTER_CHEER = 3
const BLINK_EVERY = 23
const OOPS_TICKS = 6
const WAVE_TICKS = 10
/** The latest tick of the hello a band that comes back carries on from: the second wave's first. */
const WAVE_RESUME = 5
/**
 * A hiccup this band queued itself (a failure, whatever starts next) has its second, and goes up once
 * what is up has had its own here (a second). Every other line is the facts', already held a second.
 */
const HOLD_TICKS = 4
/** A look at the words while Claude reads: two seconds, as a read starts and then every 10 to 16 s. */
const GLANCE_TICKS = 8
const GLANCE_EVERY: [number, number] = [40, 64]
/** A read that starts this soon after his last look (12 s) does not earn another: he notices, now and then. */
const GLANCE_REST = 48
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
const HEART = TERMINAL_HEART

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
    // A cheer under way (the other look was on screen as the turn landed) carries on from where it
    // is, and only with a second and a half of it to go: never its last beat on its own.
    const cheerLeft = props.lastTurn?.ending === 'answer' && !props.isWorking ? CHEER_TICKS - Math.floor((props.idleMs ?? Infinity) / TICK_MS) : 0
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
      offTick: NEVER,
      lag: 0,
      thinkAt: 0,
      glanceAt: NEVER,
      nextGlance: NEVER,
      seenCheers: props.cheers,
      seenOops: props.oops,
      slipDue,
      slipUpAt: slipDue === null ? NEVER : 0,
      cheerUntil: cheerLeft >= RESUME_CHEER ? cheerLeft : NEVER,
      oopsFrom: slipDue === null ? NEVER : 0,
      oopsUntil: slipDue === null ? NEVER : OOPS_TICKS,
      petAt: NEVER,
      waveUntil: isFresh ? waveUntil(props.greetedMs) : NEVER,
    }
    // A read under way as he appears: he looks over at it.
    notice(live, null)
    const frame = compose(live, widthOf(surface, props))
    state = { live, drawn: JSON.stringify(frame), frame, pace: newPace() }
    surface.setState(state)
    surface.every(TICK_MS, () => advance(surface))
    surface.onPointer(event => pet(surface, event))
  }
  const columns = widthOf(surface, props)
  // A new width shows at once (the frame on screen no longer fits); anything else between ticks shows
  // at once only when the second has room for it. Otherwise a landing waits for the next tick that
  // has (his cheer starts there, whole), and any other change waits for it on screen.
  const isNow = columns !== state.frame.columns || hasRoom(state.pace)
  // A look at the words or a flinch he began less than a tick ago (as the last read showed) has its
  // tick: a turn that lands now goes up with its cheer on the next tick, never cutting it to a flash.
  const isBeatNew = !isSettled(state.pace) && (isLookingNow(state.live) || state.live.tick === state.live.oopsFrom)
  receive(state.live, props, { isNow, isFree: isNow && isSettled(state.pace), canLand: isNow && !isBeatNew })
  const frame = compose(state.live, columns)
  const drawn = JSON.stringify(frame)
  if (drawn !== state.drawn && isNow) {
    spend(state.pace, false)
    state.drawn = drawn
    state.frame = frame
  }
  const shown = state.frame

  const draw = (row: Row) => row.map(({ text, ...style }) => <Text {...style}>{text}</Text>)

  return (
    <Box flexDirection="row" height={3} paddingLeft={MARGIN}>
      <Box flexDirection="column" width={SPRITE} flexShrink={0}>
        {shown.sprite.map(row => (
          <Box height={1} overflow="hidden">
            <Text>{draw(row)}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" width={MARKS} flexShrink={0}>
        {shown.marks.map(row => (
          <Box height={1} overflow="hidden">
            <Text>{row.length === 0 ? ' ' : draw(row)}</Text>
          </Box>
        ))}
      </Box>
      {shown.panel > 0 && (
        <Box flexDirection="column" width={shown.panel} marginLeft={GAP} flexShrink={0}>
          {shown.lines.map(line => (
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

// The tick the hello ends on: he waves as the session starts, and a band that comes back mid-wave (a
// dialog that briefly took the prompt's place) picks the wave up where it is, as long as its second
// wave is still to come; later, only a claw's last moment would be left: no hello.
function waveUntil(greetedMs: number | null | undefined): number {
  const gone = Math.max(0, Math.floor((greetedMs ?? 0) / TICK_MS))

  return gone <= WAVE_RESUME ? WAVE_TICKS - gone : NEVER
}

/**
 * When new props may show between two ticks. `isNow`: the second has room for a change. `isFree`: and
 * the frame on screen has been up a whole tick, so a line that could as well wait cuts no beat short.
 * `canLand`: and no glance or flinch he began less than a tick ago is up, so a turn that lands may show at once.
 */
type Between = { isNow: boolean; isFree: boolean; canLand: boolean }

// New props: note when they came, start a cheer for a new turn, queue the
// hiccup of a failed tool, and see whether what is shown may move on between
// ticks (see Between and hold).
function receive(live: Live, props: BandProps, between: Between): void {
  // Compared by value: the module is called again after every frame with the
  // same props, and only new ones restart the idle and reset clocks.
  const key = JSON.stringify(props)
  if (key !== live.propsKey) {
    live.propsKey = key
    live.propsTick = live.tick
  }
  if (props.cheers > live.seenCheers) {
    // With no room now, or a glance or flinch just begun (as the last read showed), his cheer starts
    // on the next tick, whole, and that beat has its tick. A flinch still up ends as the cheer starts,
    // as the beach's splash does: his arms go up on the frame "Done" comes in on.
    const from = live.tick + (between.canLand ? 0 : 1)
    live.cheerUntil = from + CHEER_TICKS
    live.waveUntil = NEVER
    live.oopsUntil = Math.min(live.oopsUntil, from)
  }
  const slip = props.lastSlip ?? props.slip
  if (props.oops > live.seenOops && slip !== null) {
    // The hiccup goes up as soon as what is shown has had its second (at once over its own tool or
    // "Thinking it over"); he flinches with it.
    live.slipDue = slip
    live.slipUpAt = NEVER
  }
  // A moment the facts take back ends at once, never playing on beside words that have moved on: a
  // /clear's fresh conversation has no turn to cheer and no step that stumbled; a failure Esc caused
  // (the count goes back down) is no hiccup.
  const isFresh = !props.isWorking && props.lastTurn === null
  if (isFresh && live.tick < live.cheerUntil) {
    live.cheerUntil = NEVER
  }
  if ((isFresh || props.oops < live.seenOops) && (live.slipDue !== null || live.tick < live.oopsUntil)) {
    live.slipDue = null
    live.slipUpAt = NEVER
    live.oopsFrom = NEVER
    live.oopsUntil = NEVER
  }
  live.seenCheers = props.cheers
  live.seenOops = props.oops
  live.props = props
  if (between.isNow) {
    hold(live, between)
  } else {
    note(live, JSON.stringify(wanted(live)))
  }
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
 * Moves what he shows to what the props say: the facts' held line (stepHeld, which has already held
 * each line its second), or a hiccup waiting its turn. On a tick, or between ticks once the frame on
 * screen has been up a whole tick (`isFree`), so his pose and the line move together and a beat he
 * has started (a glance, a blink, a claw tap) is up a tick at least. Between ticks (only when the second has room:
 * `receive` calls on this then) what must not wait shows at once: a turn that starts ("Thinking it
 * over" is now), a hiccup over its own tool or "Thinking it over", and a turn that lands, with its
 * cheer, as the beach's does (unless a glance or flinch he has just begun is up: `canLand`; then both
 * wait for the next tick).
 */
function hold(live: Live, between: Omit<Between, 'isNow'>): void {
  if (live.slipDue !== null && (!live.props.isWorking || (live.slipUpAt !== NEVER && live.tick - live.slipUpAt >= HOLD_TICKS))) {
    // The hiccup has had its second (or the turn is over): what is happening now comes next.
    live.slipDue = null
    live.slipUpAt = NEVER
  }
  const want = wanted(live)
  const key = JSON.stringify(want)
  note(live, key)
  if (key === live.shownKey) {
    return
  }
  // The turn begins (and a napping Clawd's eyes open with the frame its words come in on), or lands.
  const isStart = want.isWorking && !live.shown.isWorking
  const hasLanded = live.shown.isWorking && !want.isWorking
  // A hiccup takes over at once from its own tool (the line keeps its subject and says it stumbled)
  // and from "Thinking it over", as the facts' line does (stepHeld): a failure is never held back.
  const isOwn = want.slip !== null && (JSON.stringify(want.slip) === JSON.stringify(live.shown.activity) || isThinking(live.shown))
  // A line that came up here a tick late (its beat had the tick first) stays that tick longer once
  // the facts move on, so it has its second here too; once it has had it, it goes with the facts,
  // and the terminal is back in step. A hiccup this band queued itself has its second here.
  const isQueued = live.slipDue !== null && want.slip === live.slipDue
  const isHeld = isQueued ? live.tick - live.shownTick < HOLD_TICKS : live.tick < Math.min(live.offTick + live.lag, live.shownTick + HOLD_TICKS)
  if ((hasLanded && between.canLand) || isStart || isOwn || (between.isFree && !isHeld)) {
    show(live, want, key)
  }
}

/**
 * Notes what the props ask to show, as they arrive (with room for a change or not): since when they
 * have asked for it, and since when they have asked for something other than what is shown.
 */
function note(live: Live, key: string): void {
  if (key !== live.wantKey) {
    live.wantKey = key
    live.wantTick = live.tick
  }
  if (key === live.shownKey) {
    live.offTick = NEVER
  } else if (live.offTick === NEVER) {
    live.offTick = live.tick
  }
}

function show(live: Live, want: Shown, key: string): void {
  const before = live.shown
  if (isThinking(want) && !isThinking(before)) {
    live.thinkAt = live.tick
  }
  live.shown = want
  live.shownKey = key
  live.shownTick = live.tick
  // (A tick at most, and never more in practice: a tick always has room to show what waits once
  // its hold is over, which is a tick at most past when the props moved off what is shown, no later
  // than they asked for this; and a tick the second has no room for rolls its clock back. The cap
  // only says so, and drawing would be the same without it.)
  live.lag = Math.min(1, live.tick - live.wantTick)
  live.offTick = NEVER
  if (live.slipDue !== null && want.slip === live.slipDue && live.slipUpAt === NEVER) {
    // The hiccup goes up: he squeezes his eyes shut, then glances away.
    live.slipUpAt = live.tick
    live.oopsFrom = live.tick
    live.oopsUntil = live.tick + OOPS_TICKS
  }
  notice(live, before)
}

// Claude at work: not between turns, and not waiting on you (a question, a plan to look over), when
// he rests as he does between turns.
function isBusy(shown: Shown): boolean {
  return shown.isWorking && shown.activity?.kind !== 'ask'
}

function isThinking(shown: Shown): boolean {
  return shown.isWorking && shown.activity === null && shown.slip === null
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

function later(tick: number): number {
  const [low, high] = GLANCE_EVERY

  return tick + low + dice(tick * 8 + 3, high - low + 1)
}

// One blink in each stretch of BLINK_EVERY ticks, at a place the dice picks,
// so the gaps run 4.5 to 7 seconds and he reads as alive rather than clockwork.
function isBlinkTick(tick: number): boolean {
  return tick % BLINK_EVERY === 8 + dice(Math.floor(tick / BLINK_EVERY) * 8 + 5, 6)
}

function advance(surface: ClientSurface<State>): void {
  const state = surface.state
  if (state === undefined) {
    return
  }
  const { live, pace } = state
  tick(pace)
  const was = { ...live }
  live.tick += 1
  hold(live, { isFree: true, canLand: true })
  // Reading on: the next look at the words comes round.
  if (!live.props.isStill && isReading(live.shown) && live.tick >= live.nextGlance) {
    live.glanceAt = live.tick
    live.nextGlance = later(live.tick)
  }
  const frame = compose(live, widthOf(surface))
  const drawn = JSON.stringify(frame)
  if (drawn === state.drawn) {
    return
  }
  // A frame put up since the last tick keeps this one, and no second has more than four changes:
  // the tick holds, clock and all, and the next one moves on from where this one began.
  if (isHeld(pace)) {
    Object.assign(live, was)
    return
  }
  spend(pace, true)
  surface.setState({ ...state, drawn, frame })
}

function pet(surface: ClientSurface<State>, event: ClientPointerEvent): void {
  const state = surface.state
  if (state === undefined || event.type !== 'down') {
    return
  }
  const live = state.live
  const isSpinning = live.tick - live.petAt < SPIN.length
  if (!isSpinning && event.y <= 2 && event.x >= MARGIN && event.x < MARGIN + SPRITE + MARKS) {
    // At once, or with the next tick when the second has no room for it (he is cheering, say).
    const isNow = hasRoom(state.pace)
    live.petAt = isNow ? live.tick : live.tick + 1
    if (isNow) {
      const frame = compose(live, widthOf(surface))
      const drawn = JSON.stringify(frame)
      if (drawn !== state.drawn) {
        spend(state.pace, false)
        surface.setState({ ...state, drawn, frame })
      }
    }
  }
}

/** The band's width in columns: the surface's, else the props' (a mount before the first layout), else 100. */
function widthOf(surface: ClientSurface<State>, props?: BandProps): number {
  return surface.columns > 0 ? surface.columns : ((props ?? surface.state?.live.props)?.columns ?? 100)
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

  return Math.min(room, panelMost(columns))
}

function compose(live: Live, columns: number): Frame {
  const panel = panelWidth(columns)
  const pose = poseAt(live, live.tick)
  // The bead stays clear of a raised claw: it only shows while his arms are down.
  const sweat = pose.arms === 'down' && pose.turn === null && pose.canSweat ? sweatAt(live, live.tick) : null
  const sprite = pose.turn !== null ? turned(pose.turn) : live.props.isAppleTerminal ? appleSprite(pose) : body(pose)

  return { sprite, marks: marks(pose, sweat), lines: words(live, panel), panel, columns }
}

// ── Clawd ──────────────────────────────────────────────────────────────────────

const REST: Pose = { eyes: 'open', arms: 'down', feet: 'both', turn: null, mark: null, canSweat: true }

/** Whether he looks at the words on the frame on screen (a glance he began, finishing whatever the line says). */
function isLookingNow(live: Live): boolean {
  return live.shown.isWorking && !live.props.isStill && live.tick >= live.glanceAt && live.tick < live.glanceAt + GLANCE_TICKS
}

/** Whether he cheers on this tick: from the tick his cheer starts on (this one, or the next: see receive) to its end. */
function isCheering(live: Live, tick: number): boolean {
  return tick >= live.cheerUntil - CHEER_TICKS && tick < live.cheerUntil
}

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
  if (isCheering(live, tick)) {
    return { ...cheer(tick - (live.cheerUntil - CHEER_TICKS), still), canSweat: false }
  }
  if (tick < live.waveUntil) {
    // Hello: one claw up, down, up again, held a moment each time.
    const age = tick - (live.waveUntil - WAVE_TICKS)
    return { ...REST, arms: age < 3 || (age >= 5 && age < 8) ? 'one-up' : 'down' }
  }
  if (isBusy(live.shown)) {
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
  // Idle: still, but alive. A blink every five or six seconds, never quite on
  // the beat, and every twenty a glance over at the words (never a blink right
  // beside it, and never in the three ticks after a cheer, so his arms come
  // down with his eyes open).
  const t = tick % 80
  const isGlance = t >= 40 && t < 44
  const isBlink = isBlinkTick(tick) && !(t >= 38 && t < 46) && !(tick >= live.cheerUntil && tick - live.cheerUntil < AFTER_CHEER)

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

// A turn landed: arms up and held through a happy shuffle of the feet, while a
// clay sparkle twinkles beside his raised claw, as Claude Code's own spinner
// glyphs do: big, bigger, big, small, bigger. Four seconds. (His arms stay up
// all the while: a beat with them down read as the cheer dropping out.)
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
    // Both feet down again, and the sparkle small for a moment before it flares.
    return { ...REST, arms: 'up', mark: sparkle('✢') }
  }

  return { ...REST, arms: 'up', mark: sparkle('✻') }
}

// While Claude works his pose says what kind of work it is, calmly: Claude
// Code's own spinner is already moving right above him. Eyes open is home.
function working(live: Live, tick: number): Pose {
  const pose = workPose(live, tick)
  // A look at the words he has started finishes, whatever the line moves on to (his eyes never flick
  // over and straight back): its two seconds, with whatever his claws and feet do for the new work.
  const isLooking = !live.props.isStill && tick >= live.glanceAt && tick < live.glanceAt + GLANCE_TICKS

  return isLooking ? { ...pose, eyes: 'right' } : pose
}

function workPose(live: Live, tick: number): Pose {
  const activity = live.shown.activity
  if (live.props.isStill) {
    return REST
  }
  if (activity === null) {
    // Thinking: eyes on you; now and then a slow glance away, or a blink. Counted from when "Thinking"
    // came up, so a turn never opens on a sideways look: the first comes five seconds in.
    const t = (((tick - live.thinkAt) % 64) + 64) % 64
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
      return { ...REST, eyes: isBlinkTick(tick) && !isNear ? 'closed' : 'open' }
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
      return { ...REST, eyes: isBlinkTick(tick) ? 'closed' : 'open' }
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
  const every = isBusy(live.shown) ? SWEAT_AT_WORK : SWEAT_IDLE
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
    [{ text: APPLE_FEET[pose.feet], color: BODY }],
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
// cuts a figure or a label: only a branch, a file name, a command or a todo may
// be cut at its end, in a box of its own, and never below the LEAST cells words.ts
// keeps (seven characters and the ellipsis).

function words(live: Live, panel: number): Line[] {
  const { props } = live
  const said = {
    ...live.shown,
    isHigh: props.isHigh,
    percent: props.percent,
    limit: props.limit,
    lastTurn: props.lastTurn,
    resetsAt: props.limit?.resetsAt ?? null,
    // While he cheers, the words say what finished; a warning waits for the cheer to end.
    isLanding: isCheering(live, live.tick),
  }

  return [firstFit(whereForms(props), panel, CELLS), fill(props, panel), firstFit(happeningForms(said), panel, CELLS)].map(line => cutAt(line, panel))
}

function width(row: Row): number {
  return CELLS.row(row)
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
    // Meters keep Clawd's clay (the limit a quiet gray); past the line the number
    // turns clay and bold, in the one warm voice line 3's "Getting full" speaks
    // in (amber beside clay read as two alarms), so a full band reads clearly
    // without shouting. Each number hugs its meter and pads after itself, so
    // nothing after it moves.
    const left: Row = [{ text: 'context', color: DIM }, SPACE, ...(ctx === null ? [] : [...meter(props.percent, ctx, ACCENT), SPACE]), ...figure(props.percent, props.isHigh)]
    if (limit !== null && hasLimit) {
      left.push(
        { text: ' '.repeat(gap) },
        { text: isLong ? `${limit.label} limit` : limit.label, color: DIM },
        SPACE,
        // Its fill turns clay with its figure once the limit is near, so the warning reads as one thing.
        ...(lim === null ? [] : [...meter(limit.percent, lim, limit.percent >= 80 ? ACCENT : DIM), SPACE]),
        ...figure(limit.percent, limit.percent >= 80),
      )
    }
    // With the meters, the cost keeps to the panel's right edge, under the model; without them (a
    // narrow band, where the model has gone too) it follows the figures, so no hole opens in the line.
    if (ctx === null && hasCost && cost.length > 0) {
      return { line: { left: [...left, { text: ' '.repeat(gap) }, ...cost], right: [] }, least: 0 }
    }

    return { line: { left, right: hasCost ? cost : [] }, least: 0 }
  })

  return firstFit(forms, panel, CELLS)
}

// "42%" and its padding to four cells, apart: a warm figure is clay and bold, and its padding is plain.
function figure(percent: number | null, isWarm: boolean): Row {
  // No reading yet (a new session, a /clear): an en dash, never a "0%" that was never measured.
  const text = percent === null ? '–' : `${Math.round(percent)}%`

  return [isWarm ? { text, color: ACCENT, bold: true } : { text }, { text: ' '.repeat(Math.max(0, 4 - cells(text))) }].filter((seg: Seg) => seg.text !== '')
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
