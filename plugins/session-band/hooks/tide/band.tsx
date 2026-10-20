import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import { APPLE_EYES, APPLE_FEET, ARMS, EYES, FEET, SPIN, TERMINAL_HEART, dice } from '../clawd'
import type { Arms, Eyes, Feet } from '../clawd'
import { CELLS, fitLine } from './fit'
import { NAP_AFTER_MS, SPLASH_MS } from '../facts'
import { hasRoom, isHeld, newPace, spend, switchedPace, tick } from '../pace'
import type { Pace } from '../pace'
import type { BandProps, Piece, Words } from './types'

// The beach on the terminal: a little beach on the left of the band, three
// lines of words on its right. The context window is the shoreline: as it
// fills, the tide comes in from the right and Clawd's dry sand shrinks.
//
// Everything moves on the surface's own frame clock (a tick every 250 ms), and
// a frame is handed to Ink only when it looks different. Idle, the beach is
// still most of the time: a blink now and then, a wave washing up the sand
// every half minute, a short stroll about once a minute. The band is always
// three rows tall, and no row is ever padded to the band's width.
//
// What the band shows (the words, and the mood Clawd is in) is the tool the
// facts' hold settled on (stepDesk in facts.ts: a second at least, and a pause
// between two tools shorter than three quarters of a second is no pause at all),
// the very one the desktop shows, taken up as soon as the second has room for
// it. So a burst of quick reads is one calm stretch of reading, not a flicker of
// file names, and the two surfaces name the same files at the same moments.

/** A cell of the scene; `kind` marks the shell and the wave, which a mark keeps a cell of sky from. */
type Cell = { ch: string; color?: string; bg?: string; dim?: boolean; kind?: 'wave' | 'shell' }
export type Row = Cell[]
type Run = { text: string; color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean }

type Live = {
  /** The props the band shows: the latest ones, taken up as soon as the second has room for them. */
  props: BandProps
  /** The latest props, and what they would show. */
  want: BandProps
  wantKey: string
  /** What the shown props look like. */
  shownKey: string
  tick: number
  /** When the shown props were taken up: their idle time counts on from there. */
  propsTick: number
  /** The beach's width last drawn: where home is, and whether there is a shell. */
  beach: number
  /**
   * Where the calm water starts, as drawn, and the beach it was drawn on. The context can jump (a
   * long read, a /compact): the water then rolls in or out a cell a tick, never all at once.
   */
  shore: number
  shoreBeach: number
  x: number
  goal: number
  /** He stepped a cell out from home to cheer (see stepOut): once settled, he pads back. */
  isOut: boolean
  stepAt: number
  steps: number
  blinkAt: number
  lapAt: number
  glanceAt: number
  napAt: number
  nextBlink: number
  nextLap: number
  nextGlance: number
  nextStroll: number
  cheerAt: number
  /** A new prompt came while he spun: the spin plays out, and the cheer ends with it. */
  isCheerCut: boolean
  /**
   * This cheer opens with Claude Code's spin: it began lively, on this look, as Claude Code's own
   * Clawd (Apple's has no spin), and has not been still since. Any other cheer is its arms-up finale
   * from first to last, whatever the motion does after: /band lively never starts a spin in the middle
   * of one whose arms are already up, which would play the finale twice.
   */
  isCheerSpun: boolean
  splashAt: number
  /** Where he stood when the wave splashed him: the water runs up to there and back. */
  splashFrom: number
  petAt: number
  /** How long this pet lasts: longer when the wave stood back for the heart and rolls back in. */
  petTicks: number
  /** When he woke from a nap: he stands a moment with his eyes still shut. */
  wakeAt: number
  /** When he waves hello: a fresh session's band, a moment after it first appears. */
  helloAt: number
  seenCheers: number
  seenOops: number
  /** The facts' waves this band has splashed for: a failure that rides along with a wave starts none. */
  seenWaves: number
  /**
   * The facts' wave was this look's to show: it began while this look was on screen (or the band came
   * up with it already this look's: a /config reload, a dialog closing). A look switched to after the
   * wave began starts at rest, its words with it, as the desktop's new frame does (see wordsNow).
   */
  isWaveSeen: boolean
  /**
   * The tick that put up the quiet line a splash ends on (what failed, in the dim), or NEVER: a step
   * that starts before the next tick waits for it, so that line is up a tick, never a flash.
   */
  quietAt: number
  /** The mood last drawn, so a new one can start with a glance (a fresh read, say). */
  mood: Mood | null
  /** The last tick a moment (a cheer, a splash, a pet, waking) held him: he settles a while after. */
  busyAt: number
  /** Where this cheer's sparkles went (which of its places), for the cheer, beach and spot it was chosen for. */
  cheerMarks: { key: string; index: number; isOut: boolean } | null
}
/**
 * `drawn` is the frame on screen, and `frame` the same as JSON. `pace` keeps every second to four
 * changes and every frame up a tick at least (see pace.ts): a change between ticks (a pet, a turn
 * landing, a /band switch) shows at once when the second has room for it, else on the next tick that
 * has; a tick that would change a frame put up just before it holds, clock and all.
 */
type State = { live: Live; frame: string; drawn: Drawn; pace: Pace }
type Drawn = ReturnType<typeof compose>

const TICK_MS = 250
const NEVER = -1_000_000

// Clawd's colors are the theme's own. The beach's are accents no theme key covers, picked to read
// on dark and light terminals alike and kept soft and warm beside Claude's clay: kraft sand, a
// dusk-blue sea, a coral shell. Each sits on or just beside an entry of xterm's 256-color cube
// (the number after it), so a terminal that shows only 256 colors draws nearly the same beach.
// Where a channel stops short of its entry, it is because chalk (which Claude Code rounds with)
// shows the cube's 95 level only for a channel of 76 or less, and its 135 level only for 127 or less.
export const BODY = 'clawd_body'
export const EYE = 'clawd_background'
export const SAND = '#DAB27F' // 180
// Damp sand, and the specks in the dry sand, share one darker tan.
export const WET = '#B27F4C' // 137
const SPECK = WET
const SEA = '#4C7FAF' // 67
// The ripples at the bottom of the sea, darker than the sea so they read as depth.
const SEA_DEEP = '#004C7F' // 24
// A touch deeper than white foam, so the wave's lip (which draws the wave) still shows on a light
// terminal (about 2.3:1 on white, where a paler foam all but vanished), without going cold on a dark one.
const FOAM = '#7FAFD7' // 110
const SHELL = '#E4A5A6' // 181
const SHELL_RIDGE = '#D97F7F' // 174
const HEART = TERMINAL_HEART

// The beach, left to right: a scallop shell (columns 0 to 3) and a cell of sand, Clawd's home
// spot, a cell of sky, then the shore the tide runs up, then a strip of open sea. At 100% the
// water comes up to his side at home, and the wave's lip still keeps a cell of sky from his arm.
// A narrow beach (below 56 columns) has no shell, so the tide keeps room to move.
const SHELL_WIDTH = 4
const SPRITE = 9

// ── Clawd, exactly as Claude Code draws him ────────────────────────────────────

// His eyes, arms, feet and turning frames are clawd.ts's, the hearth's very own: one Clawd in both looks.
export type Pose = { eyes: Eyes; arms: Arms; feet: Feet }

function blank(): Row {
  return Array.from({ length: SPRITE }, () => ({ ch: ' ' }))
}

/** A run of his glyphs as cells, those in columns [from, to) on his dark background. */
function spriteRow(text: string, from: number, to: number): Row {
  return [...text].map((ch, i) => (ch === ' ' ? { ch } : i >= from && i < to ? { ch, color: BODY, bg: EYE } : { ch, color: BODY }))
}

export function pose({ eyes, arms, feet }: Pose): [Row, Row, Row] {
  const a = ARMS[arms]
  const head: Row = [...spriteRow(a.r1L, 0, 0)]
  for (const span of EYES[eyes]) {
    for (const ch of span.text) {
      head.push(span.isLid === true ? { ch, color: EYE, bg: BODY } : { ch, color: BODY, bg: EYE })
    }
  }
  head.push(...spriteRow(a.r1R, 0, 0))
  const body = [...spriteRow(a.r2L, 0, 0), ...spriteRow('█████', 0, 5).map(cell => ({ ...cell, bg: EYE })), ...spriteRow(a.r2R, 0, 0)]

  return [pad(head), pad(body), pad(spriteRow(FEET[feet], 0, 0))]
}

export function spin(frame: number): [Row, Row, Row] {
  const [r0, a0, b0, r1, a1, b1, r2] = SPIN[frame] ?? SPIN[0] ?? []
  if (r0 === undefined || r1 === undefined || r2 === undefined) {
    return pose({ eyes: 'open', arms: 'down', feet: 'both' })
  }

  return [spriteRow(r0, a0 ?? 0, b0 ?? 0), spriteRow(r1, a1 ?? 0, b1 ?? 0), spriteRow(r2, 0, 0)]
}

// Napping: his own head and body, settled down a row so he is nestled in the sand.
export function curled(): [Row, Row, Row] {
  const [head, body] = pose({ eyes: 'closed', arms: 'down', feet: 'both' })

  return [blank(), head, body]
}

// Apple's Terminal draws block glyphs on colored backgrounds badly, so Claude Code gives it a
// simpler Clawd: his eyes drawn dark into a solid head, a body of plain color, no arms, and no
// spin. The beach draws him the same way there.
function applePose({ eyes, feet }: Pose): [Row, Row, Row] {
  const head: Row = [
    { ch: '▗', color: BODY },
    ...[...APPLE_EYES[eyes]].map((ch): Cell => ({ ch, color: EYE, bg: BODY })),
    { ch: '▖', color: BODY },
  ]
  const body: Row = [{ ch: ' ' }, ...Array.from({ length: 7 }, (): Cell => ({ ch: ' ', bg: BODY })), { ch: ' ' }]

  return [pad(head), pad(body), pad(spriteRow(APPLE_FEET[feet], 0, 0))]
}

function appleCurled(): [Row, Row, Row] {
  const [head, body] = applePose({ eyes: 'closed', arms: 'down', feet: 'both' })

  return [blank(), head, body]
}

function pad(row: Row): Row {
  return [...row, ...blank()].slice(0, SPRITE)
}

// ── The module ─────────────────────────────────────────────────────────────────

const Band: ClientModule<BandProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    const live = start(props, widthOf(surface, props))
    const drawn = compose(live, widthOf(surface, props))
    // Swapped in for the hearth's band on screen by a look switch, it follows that band's last frame
    // by less than a tick, and that band may have changed on each of its last ticks, so its first
    // tick holds if it would change (see pace.ts). Mounted afresh, nothing came before it.
    state = { live, frame: JSON.stringify(drawn), drawn, pace: props.isSwapped === true ? switchedPace() : newPace() }
    surface.setState(state)
    surface.every(TICK_MS, () => advance(surface))
    surface.onPointer(event => pet(surface, event))
  }
  const columns = widthOf(surface, props)
  // A new width shows at once (the frame on screen no longer fits); anything else between ticks shows
  // at once only when the second has room for it. Otherwise a turn's moment, a splash or a /band
  // switch starts on the next tick that has (so its first frame is never skipped), and any other
  // change waits for it on screen.
  const isResize = columns !== state.drawn.columns
  // (A todo ticked off comes with the step after it: the facts hold it for that, see tallied.)
  const isNow = isResize || (hasRoom(state.pace) && state.live.quietAt !== state.live.tick)
  receive(state.live, props, isNow)
  // A new width or a still beach is taken up before this frame is drawn, never a tick later.
  place(state.live, columns)
  const drawn = compose(state.live, columns)
  const frame = JSON.stringify(drawn)
  // A splash that ends with no step to hand on falls to its quiet line on a tick, never between two
  // (the facts say it is over between them): so a step that starts in that tick takes the line
  // straight from the splash, rather than waiting behind a quiet line that had only just gone up and
  // must stay a tick (a read 40 ms after a lone splash would come up 390 ms late, and so have only
  // 810 ms of its second).
  const isQuietEnd = !isResize && isQuietEnding(state.drawn, drawn, state.live.props)
  if (frame !== state.frame && isNow && !isQuietEnd) {
    spend(state.pace, false)
    state.frame = frame
    state.drawn = drawn
  }
  const { scene: rows, words, beach, gutter } = state.drawn

  return (
    <Box flexDirection="row" width={Math.max(1, columns - 2)} height={3}>
      <Box flexDirection="column" width={beach} flexShrink={0}>
        {rows.map(row => (
          <Text wrap="truncate-end">
            {row.map(({ text, ...style }) => (
              <Text {...style}>{text}</Text>
            ))}
          </Text>
        ))}
      </Box>
      {words.length === 0 ? null : (
        <Box flexDirection="column" marginLeft={gutter} flexGrow={1} flexShrink={1} minWidth={0}>
          {words.map(row => (
            <Text wrap="truncate-end">
              {row.map(({ text, ...style }) => (
                <Text {...style}>{text}</Text>
              ))}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default Band

/**
 * Where a splash under way as the band appears picks up, as the tick it began on (counted back from
 * the band's first, 0), or NEVER with too little of it left. Carried on, it is as far in as the next
 * whole tick (1.1 s in is its fifth tick, never its fourth again), so it ends with the facts' wave, or
 * a tick before it (whose words wait for the facts; see wordsNow), never a tick after them.
 */
export function resumeSplash(ms: number | null): number {
  return ms !== null && ms >= 0 && Math.floor(ms / TICK_MS) <= SPLASH_TICKS - RESUME_SPLASH ? -Math.ceil(ms / TICK_MS) : NEVER
}

function start(props: BandProps, columns: number): Live {
  // A moment under way as the band appears (a look switch, a dialog closing) carries on from where
  // it is, but only with a good part of it left: never its last beat on its own, a pose that
  // flashes up and snaps back. Otherwise he is at rest, and the words have moved on with him.
  const resume = (ms: number | null, ticks: number, least: number) =>
    ms !== null && ms >= 0 && Math.floor(ms / TICK_MS) <= ticks - least ? -Math.floor(ms / TICK_MS) : NEVER
  const key = keyOf(props)
  // Whether this look was on screen as the facts' wave began (or the band came up as the look it was
  // all along: a /config reload, a dialog closing). Only such a band carries the wave on; a look
  // switched to after it began starts at rest, as its desktop's new frame does, words and all.
  const isSeen = (ms: number | null) => props.shownForMs === null || (ms !== null && ms <= props.shownForMs)
  const isWaveSeen = isSeen(props.sinceSplashMs)
  const live: Live = {
    props,
    want: props,
    wantKey: key,
    shownKey: key,
    tick: 0,
    propsTick: 0,
    beach: beachWidth(columns),
    shore: tideline(props, beachWidth(columns)),
    shoreBeach: beachWidth(columns),
    x: homeOf(beachWidth(columns)),
    goal: homeOf(beachWidth(columns)),
    isOut: false,
    stepAt: NEVER,
    steps: 0,
    blinkAt: NEVER,
    lapAt: NEVER,
    glanceAt: NEVER,
    napAt: NEVER,
    // The first little things happen a while after the band appears, never at once.
    nextBlink: 20 + dice(1, 24),
    nextLap: 40 + dice(2, 32),
    nextGlance: 90 + dice(3, 60),
    nextStroll: 72 + dice(4, 80),
    cheerAt: resume(props.sinceCheerMs, CHEER_TICKS, RESUME_CHEER),
    isCheerCut: false,
    // A cheer the other look was showing (with its arms already up, as the hearth's are from the
    // first) carries on here with them up too, never spinning first and raising them a second time.
    isCheerSpun: isSeen(props.sinceCheerMs) && !props.isStill && !props.isAppleTerminal,
    splashAt: isWaveSeen ? resumeSplash(props.sinceSplashMs) : NEVER,
    splashFrom: homeOf(beachWidth(columns)),
    petAt: NEVER,
    petTicks: PET_TICKS,
    wakeAt: NEVER,
    // A fresh session: half a second in, he waves hello (never on a switch, still, or as Apple's Clawd,
    // who has no arms to wave with). A band that comes back mid-wave carries it on (see helloFrom).
    helloAt: props.isGreeting && !props.isAppleTerminal ? helloFrom(props.greetedMs) : NEVER,
    seenCheers: props.cheers,
    seenOops: props.oops,
    seenWaves: props.waves,
    isWaveSeen,
    quietAt: NEVER,
    mood: null,
    busyAt: NEVER,
    cheerMarks: null,
  }
  const [home, high] = range(live, live.beach)
  if (isNapping(live)) {
    live.x = home
    live.napAt = 0
  } else if (moodOf(live) === 'high') {
    // At high tide, with nothing to do, he stands at the water's edge watching it, as a band that
    // has been up all along has him (see plan): a band that appears then (a look switch) finds him there.
    live.x = high
  }
  live.x = Math.min(high, Math.max(home, live.x))
  live.goal = live.x
  // A band that comes up during a cheer (a /band switch, a dialog closing) finds him a cell out, as
  // one that saw the cheer start does: every road to the cheer looks the same.
  if (isCheering(live)) {
    stepOut(live)
  }
  live.splashFrom = live.x
  notice(live)

  return live
}

/**
 * A cheer by his home spot steps him a cell out into the open, so a sparkle fits on each side of him
 * with sky all round it. By the band's edge (a beach with no shell, home a cell in) the ✶ by his left
 * claw would otherwise have no cell but the edge, and the cheer would squeeze its one ✻ flush against
 * his right (`▗▟▛███▛█▄✻`): so there every cheer steps in, still and in Apple's Terminal too, the
 * step riding on the pose change as his arms go up, and the crest stands back for the ✻ (see
 * cheerRoom), with the tide in as well. Lively, he pads back home once he has settled after the cheer
 * (see plan); still, he is back as his arms come down, or as a pet takes over (see place). By the shell the lively spin
 * carries him out only where the step leaves his right-hand sparkle its cell of air off his claw
 * (with the tide up the sand, he stays by the shell's corner rather than crowd the wave); still, or
 * in Apple's Terminal, he cheers there where he stands.
 */
function stepOut(live: Live): void {
  const home = homeOf(live.beach)
  if (live.x !== home || live.goal !== home) {
    return
  }
  const isRoom = hasShell(live.beach) ? isSpinning(live) && range(live, live.beach)[1] >= home + 3 : home + 1 + SPRITE + 3 + 2 <= live.beach
  if (isRoom) {
    live.x = home + 1
    live.goal = home + 1
    live.isOut = true
  }
}

/** The furthest right he may stand: the room the tide leaves him, or the cell he stepped out to cheer from. */
function reach(live: Live, beach: number): number {
  const [home, high] = range(live, beach)

  return live.isOut ? Math.max(high, home + 1) : high
}

// What the props would show, leaving out the times that tick on with every redraw, what only the
// desktop reads (the turn's own time and tides, whether it has changed anything yet, a wake, the time
// this look has been on) and how the band came up (a swap). A redraw for some other surface's sake is
// no change here, and never takes a frame's room in the second.
function keyOf(props: BandProps): string {
  return JSON.stringify({
    ...props,
    idleMs: null,
    sinceCheerMs: null,
    sinceOopsMs: null,
    sinceSplashMs: null,
    sinceTurnMs: null,
    isGreeting: null,
    greetedMs: null,
    shownForMs: null,
    isSwapped: null,
    turnPercent: null,
    turnWorked: null,
    woke: null,
    cheerPercent: null,
    oopsPercent: null,
  })
}

// When the hello starts, in ticks from the band's first: half a second into the session. A band that
// appears (or comes back) later picks the wave up where it is, as long as its second wave is still to
// come; later than that, only a claw's last moment would be left, which reads as a twitch: no hello.
function helloFrom(greetedMs: number | null | undefined): number {
  const gone = Math.max(0, Math.floor((greetedMs ?? 0) / TICK_MS))

  return gone - HELLO_FROM <= HELLO_RESUME ? HELLO_FROM - gone : NEVER
}

// New props: the band takes them up at once when they look the same, or when the second has room to
// show them (`isNow`); otherwise on the next tick that has (see advance). What Claude is doing is the
// facts' step (stepDesk), already held its second there, so the words move on with the desktop's, and a
// step this band took up late (the second had no room) never makes the next one late too.
function receive(live: Live, props: BandProps, isNow: boolean): void {
  if (props === live.want) {
    return
  }
  const key = keyOf(props)
  live.want = props
  live.wantKey = key
  if (key === live.shownKey || isNow) {
    adopt(live, props, key)
  }
}

// Shows these props: starts a cheer for a finished turn or a splash for a failed tool, lets a
// spin play out when a new prompt comes during it, and wakes him gently from a nap.
function adopt(live: Live, props: BandProps, key: string): void {
  const isTurnStart = props.isWorking && !live.props.isWorking
  const wasCurled = isNapping(live) && live.x === homeOf(live.beach) && live.napAt !== NEVER
  if (isTurnStart && isCheering(live)) {
    // A new prompt while he cheers the last turn: the words move on at once, and a spin
    // already under way plays out (never cut mid-turn), without the arms-up after it.
    if (props.isStill || !isSpinning(live) || since(live, live.cheerAt) >= SPIN.length) {
      live.cheerAt = NEVER
    } else {
      live.isCheerCut = true
    }
  }
  const isCheerStart = props.cheers > live.seenCheers
  if (isCheerStart) {
    live.cheerAt = live.tick
    live.isCheerCut = false
    live.isCheerSpun = true
  }
  // A moment the facts take back (a /clear ends the conversation a cheer or a splash belonged to, and
  // a failure Esc caused is no failure: its count goes back down) ends with this frame, never playing
  // on beside words that have moved on, and he is home at rest.
  if (isCheering(live) && props.sinceCheerMs === null) {
    live.cheerAt = NEVER
    live.isCheerCut = false
    if (live.isOut) {
      live.x = homeOf(live.beach)
      live.goal = live.x
      live.isOut = false
    }
  }
  if (isSplashed(live) && (props.sinceSplashMs === null || props.oops < live.seenOops)) {
    live.splashAt = NEVER
  }
  // Lively from still mid-splash (a /band lively, reduced motion turned off): as after a look switch,
  // he is at rest on the dim line, as the desktop's new lively frame opens, never carrying on a wave
  // this motion never drew (see isWaveSeen). Still, the wave was one held frame.
  if (live.props.isStill && !props.isStill && isSplashed(live)) {
    live.splashAt = NEVER
    live.isWaveSeen = false
  }
  // A new wave splashes him. A second failure while the wave is still rushing in rides along with it
  // (the facts say which: see SPLASH_RUSH_MS), and ends with it, as on the desktop.
  if (props.waves > live.seenWaves) {
    live.splashAt = live.tick
    live.splashFrom = live.x
    live.isWaveSeen = true
  }
  live.seenCheers = props.cheers
  live.seenOops = props.oops
  live.seenWaves = props.waves
  live.props = props
  if (props.isStill || props.isAppleTerminal) {
    // Still, a cheer is its finale alone: one that goes on lively after this carries its arms on up.
    live.isCheerSpun = false
  }
  live.propsTick = live.tick
  if (isCheerStart) {
    stepOut(live)
  }
  live.shownKey = key
  if (wasCurled && !isNapping(live)) {
    live.wakeAt = live.tick
  }
  notice(live)
}

// A change of mood takes up the new mood's own timing (see reschedule), and can start with a
// glance: when Claude starts reading, he looks over at the words.
function notice(live: Live): void {
  const mood = moodOf(live)
  if (mood === live.mood) {
    return
  }
  if (live.mood !== null) {
    // (The band's first mood keeps the first timers, which give it a while before anything happens.)
    reschedule(live, mood, 0)
  }
  if (mood === 'look' && !live.props.isStill && live.tick + 2 - live.glanceAt >= GLANCE_REST) {
    // A beat after Claude starts reading, he glances over at the words for 2 s; in a busy turn of
    // reads, one glance in twelve seconds is enough.
    live.glanceAt = live.tick + 2
    live.nextGlance = later(live.tick, 3, GAPS.look.glance ?? [40, 64])
  }
  live.mood = mood
}

/**
 * Whether this frame ends a splash on its quiet line: the failure stands, its wave is over, and no
 * step is there to hand the line on to. (One Esc or /clear took back ends the splash at once, on
 * whatever the line says next: nothing failed.)
 */
function isQuietEnding(was: { isSplash: boolean }, now: { isSplash: boolean }, props: BandProps): boolean {
  return was.isSplash && !now.isSplash && props.doing === null && props.sinceOopsMs !== null
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
  // What waited for room (see Band) shows now: a turn's moment, the words' next step. (The second a
  // step stays up, and the pause between tools, are the facts' to keep: see stepDesk.)
  const columns = widthOf(surface, live.props)
  if (live.wantKey !== live.shownKey) {
    adopt(live, live.want, live.wantKey)
  }
  notice(live)
  plan(live, columns)
  const drawn = compose(live, columns)
  const frame = JSON.stringify(drawn)
  if (frame === state.frame) {
    return
  }
  // A frame put up since the last tick keeps this one, and no second has more than four changes:
  // the tick holds, clock and all, and the next one moves on from where this one began.
  if (isHeld(pace)) {
    Object.assign(live, was)
    return
  }
  spend(pace, true)
  live.quietAt = isQuietEnding(state.drawn, drawn, live.props) ? live.tick : NEVER
  surface.setState({ ...state, frame, drawn })
}

function pet(surface: ClientSurface<State>, event: ClientPointerEvent): void {
  const state = surface.state
  if (state === undefined || event.type !== 'down') {
    return
  }
  const live = state.live
  const beach = beachWidth(widthOf(surface, live.props))
  if (event.x < beach) {
    // At once, or with the next tick when the second has no room for it (he is spinning, say).
    const isNow = hasRoom(state.pace)
    live.petAt = isNow ? live.tick : live.tick + 1
    live.petTicks = petTicks(live, beach)
    if (isNow) {
      repaint(surface, state)
    }
  }
}

// A change between ticks, drawn at once (the caller has found it room), with him where it puts him.
function repaint(surface: ClientSurface<State>, state: State): void {
  const columns = widthOf(surface, state.live.props)
  place(state.live, columns)
  const drawn = compose(state.live, columns)
  const frame = JSON.stringify(drawn)
  if (frame !== state.frame) {
    spend(state.pace, false)
    surface.setState({ ...state, frame, drawn })
  }
}

function widthOf(surface: ClientSurface<State>, props: BandProps): number {
  return surface.columns > 0 ? surface.columns : props.columns
}

// ── Moods ──────────────────────────────────────────────────────────────────────

const CHEER_TICKS = SPIN.length + 7
/**
 * The fewest ticks his arms stay up for the cheer's finale (a second). A pet late in the cheer, which
 * has its own wink and arms up, leaves the finale what is left of the cheer: less than this, and he
 * ends the cheer facing you at rest rather than flashing his arms and sparkles up for a tick or two.
 */
const FINALE_LEAST = 4
const SPLASH_TICKS = 12
/** The fewest ticks of a cheer (a second and a half) and of a splash (a second) worth carrying on with when the band appears. */
const RESUME_CHEER = 6
const RESUME_SPLASH = 4
// How long the sand a splash ran over stays damp.
const DAMP_TICKS = 28
const PET_TICKS = 10
// The heart shows for the first 2 s of a pet.
const HEART_TICKS = 8
// Waking from a nap: standing, eyes still shut, for three quarters of a second, the first half of it
// a big stretch with his arms up.
const WAKE_TICKS = 3
const STRETCH_TICKS = 2
/** Hello: half a second after the band appears, one claw up twice, as Claude Code waves (2.5 s). */
const HELLO_FROM = 2
const HELLO_TICKS = 10
/** The latest tick of the hello a band that comes back carries on from: the second wave's first. */
const HELLO_RESUME = 5
// A step every three ticks: lift a pair of legs and move, set them down, rest.
const STEP_TICKS = 3
// The z beside a napping Clawd: low by his head for 8 s, higher for 8 s, then gone for 10 s.
const Z_LOW = 32
const Z_HIGH = 64
const Z_CYCLE = 104

function since(live: Live, at: number): number {
  return live.tick - at
}

function isCheering(live: Live): boolean {
  const t = since(live, live.cheerAt)

  return t >= 0 && t < (live.isCheerCut ? SPIN.length : CHEER_TICKS)
}

/** Whether his cheer opens with the spin (see isCheerSpun): lively, and Claude Code's own Clawd. */
function isSpinning(live: Live): boolean {
  return live.isCheerSpun && !live.props.isStill && !live.props.isAppleTerminal
}

/**
 * The tick the cheer's finale (arms up, the sparkles held) begins: as the spin ends (at once, still or
 * in Apple's Terminal, which have no spin), or as a pet that ran on into the cheer's last part ends.
 * Null when the cheer has no finale: a new prompt cut it, or a pet left it under FINALE_LEAST ticks
 * (arms and sparkles up for a single 250 ms tick would be a flash).
 */
function finaleAt(live: Live): number | null {
  if (live.isCheerCut) {
    return null
  }
  const spun = live.cheerAt + (isSpinning(live) ? SPIN.length : 0)
  const end = live.cheerAt + CHEER_TICKS
  const petEnd = live.petAt + live.petTicks
  const from = live.petAt < end && petEnd > live.cheerAt ? Math.max(spun, petEnd) : spun

  return end - from >= FINALE_LEAST ? from : null
}

/** Whether his arms are up for the cheer's finale on this tick, sparkles and all. */
function isFinale(live: Live): boolean {
  const from = finaleAt(live)

  return isCheering(live) && !isPetted(live) && from !== null && live.tick >= from
}

/** A pet that runs on past the spin, straight into the cheer's finale: as it ends, his arms go up. */
function isPetIntoFinale(live: Live): boolean {
  return isCheering(live) && finaleAt(live) === live.petAt + live.petTicks
}

function isSplashed(live: Live): boolean {
  return since(live, live.splashAt) >= 0 && since(live, live.splashAt) < SPLASH_TICKS
}

/**
 * Whether the splash shows: the wave under way, and no turn landed since it began. A turn that lands
 * mid-splash has its cheer at once, his pose and the words, as the desktop's cheer frame replaces the
 * splash's and the hearth's cheer its flinch; the sea ebbs on from where the wave had it.
 */
function isSplashShown(live: Live): boolean {
  return isSplashed(live) && !(isCheering(live) && live.cheerAt >= live.splashAt)
}

// How far into the splash we are; a still beach holds its middle moment.
function splashTick(live: Live): number {
  return live.props.isStill ? 3 : since(live, live.splashAt)
}

function isPetted(live: Live): boolean {
  return since(live, live.petAt) >= 0 && since(live, live.petAt) < live.petTicks
}

function isHello(live: Live): boolean {
  const t = since(live, live.helloAt)

  return t >= 0 && t < HELLO_TICKS && !live.props.isWorking && !live.props.isStill
}

function isWaking(live: Live): boolean {
  return !live.props.isStill && since(live, live.wakeAt) >= 0 && since(live, live.wakeAt) < WAKE_TICKS
}

// Petting a sleeper does not wake him: he gets the heart and sleeps on.
function isNapping(live: Live): boolean {
  const { props } = live
  if (props.isWorking || props.idleMs === null || isCheering(live)) {
    return false
  }

  return props.idleMs + (live.tick - live.propsTick) * TICK_MS >= NAP_AFTER_MS
}

function isMoment(live: Live): boolean {
  return isCheering(live) || isSplashed(live) || isPetted(live) || isWaking(live) || isHello(live)
}

type Mood = 'idle' | 'high' | 'work' | 'look' | 'think' | 'nap'

// Claude at work: not between turns, and not waiting on you (a question, a plan to look over), when
// he sits at rest as he does between turns.
function isBusy(props: BandProps): boolean {
  return props.isWorking && props.doing !== 'wait'
}

function moodOf(live: Live): Mood {
  const { props } = live
  if (isNapping(live)) return 'nap'
  if (isBusy(props)) return props.doing === 'look' ? 'look' : props.doing === 'work' ? 'work' : 'think'

  return props.isHigh ? 'high' : 'idle'
}

type Span = [number, number]

// How long until the next little thing, in ticks (four a second), for each mood. He rests with
// his eyes open: Claude Code's glancing eyes sit on the head's top edge, where a dark terminal
// swallows the pupils, so a glance is always short (2 or 3 s) and the open gaze is home.
const GAPS: Record<Mood, { blink: Span; lap: Span; glance: Span | null; stroll: Span | null }> = {
  idle: { blink: [76, 124], lap: [100, 144], glance: [180, 300], stroll: [240, 400] },
  // At high tide he looks at each wave that reaches him (see plan), rather than on a timer.
  high: { blink: [76, 124], lap: [64, 96], glance: null, stroll: null },
  work: { blink: [60, 100], lap: [100, 144], glance: [60, 120], stroll: [40, 72] },
  look: { blink: [48, 80], lap: [100, 144], glance: [40, 64], stroll: null },
  think: { blink: [60, 100], lap: [100, 144], glance: [32, 56], stroll: null },
  nap: { blink: [76, 124], lap: [360, 480], glance: null, stroll: null },
}
// How long a glance lasts, in ticks.
const GLANCE: Record<Mood, number> = { idle: 12, high: 5, work: 10, look: 8, think: 8, nap: 0 }
// A read that starts within 12 s of his last glance does not earn another: in a long burst of reads
// he notices now and then, rather than glancing as a habit.
const GLANCE_REST = 48

// After a moment (a cheer, a splash, a pet, waking up) he settles for 3 s, eyes open, before
// anything else: no glance, no blink, no stroll. A finished turn and coming back to the session
// are when a person looks at the band, and that is when he should be looking back.
const SETTLE = 12
// A timer for something this mood never does (a nap has no glances): the next mood sets its own.
const FOREVER = 1_000_000_000

function isGlancing(live: Live, mood: Mood): boolean {
  const t = since(live, live.glanceAt)

  return t >= 0 && t < GLANCE[mood] && live.glanceAt >= live.busyAt + SETTLE
}

function later(tick: number, salt: number, [low, high]: Span): number {
  return tick + low + dice(tick * 8 + salt, high - low + 1)
}

// Takes up a mood's own timing for the little things (a blink, a glance, a stroll). A timer the
// last mood or moment left behind comes again between half this mood's shortest gap and its
// shortest gap when it is overdue (a nap has no glances, a cheer held it back), sooner than half
// that gap (a busier mood set it), or further off than this mood would ever wait. One already on
// its way is kept. None comes sooner than `settle`. Without this, a timer left over from before a
// nap fired the moment he woke, and he looked away before he had ever opened his eyes; and a
// glance set while Claude worked came a moment after the cheer.
function reschedule(live: Live, mood: Mood, settle: number): void {
  const { tick } = live
  const gaps = GAPS[mood]
  const fit = (next: number, span: Span | null, salt: number): number => {
    if (span === null) {
      return FOREVER
    }
    const soonest = Math.max(settle, span[0] >> 1)
    if (next < tick + soonest || next > tick + span[1]) {
      return later(tick, salt, [soonest, Math.max(soonest, span[0])])
    }

    return next
  }
  live.nextBlink = fit(live.nextBlink, gaps.blink, 2)
  live.nextGlance = fit(live.nextGlance, gaps.glance, 3)
  live.nextStroll = fit(live.nextStroll, gaps.stroll, 6)
}

// The first tick after a moment: everything waits a while, and a glance that was coming (the
// look at the words when Claude starts reading) comes once he has settled.
function settle(live: Live, mood: Mood): void {
  reschedule(live, mood, SETTLE)
  const { tick } = live
  if (live.glanceAt + GLANCE[mood] > tick && live.glanceAt < tick + SETTLE) {
    live.glanceAt = tick + SETTLE
  }
}

// Where he is on a new beach, and on a still one. Both are taken up at once, on the frame that
// first shows them (see place), never walked to:
//
// - The band was resized: the beach is a new width, and home may have moved (the shell comes and
//   goes at 56 columns). He keeps his place relative to home, inside the room the tide leaves him,
//   and a sleeper stays curled up by the shell; he never walks over the shell to get there, and a
//   resize never wakes him.
// - Still (`/band still`, or reduced motion): nothing moves on its own, so a nap finds him curled
//   up by the shell at once, wherever he stood (a jump, never a walk he would not take); and a cell
//   out from his spot by the band's edge, he stands only while his arms are up for the cheer (see
//   stepOut), stepping there and back on the frames that change his pose.
function place(live: Live, columns: number): void {
  const beach = beachWidth(columns)
  if (beach !== live.beach) {
    const was = homeOf(live.beach)
    live.beach = beach
    live.shore = tideline(live.props, beach)
    live.shoreBeach = beach
    const [low, high] = range(live, beach)
    const at = (x: number) => Math.min(high, Math.max(low, low + x - was))
    live.x = isNapping(live) ? low : at(live.x)
    live.goal = isNapping(live) ? low : at(live.goal)
    live.splashFrom = at(live.splashFrom)
    // Home is somewhere else now: he stays where he is on it (still out a cell from it, if he stepped
    // out for a cheer and the tide leaves him there). In a cheer at the new home, he steps out from
    // it, as a band that comes up mid-cheer has him (see start).
    live.isOut = live.isOut && live.x === low + 1
    if (isCheering(live)) stepOut(live)
  }
  if (live.props.isStill) {
    live.shore = tideline(live.props, beach)
    live.shoreBeach = beach
    const low = homeOf(beach)
    const isArmsUp = isFinale(live)
    if (live.isOut && !isArmsUp) {
      // Stepped out for a cheer: still, he is back on his spot as his arms come down, or as a pet
      // takes the cheer over (its wink, its raised claw and its heart are a new pose, and the heart
      // goes up beside him where he is to stay), in that same frame: nothing walks him there, so he
      // never moves on a tick where nothing else about him does, and his still home never moves.
      live.x = low
      live.isOut = false
    } else if (!live.isOut && isArmsUp) {
      // A pet over, the cheer's finale comes back: he steps out again as his arms go up.
      stepOut(live)
    }
    if (isNapping(live)) {
      live.x = low
      if (live.napAt === NEVER) live.napAt = live.tick
    } else {
      live.napAt = NEVER
      live.x = Math.min(reach(live, beach), Math.max(low, live.x))
    }
    live.goal = live.x
  }
}

// One tick of the beach's life: when the sea washes up, what Clawd decides, where he steps.
function plan(live: Live, columns: number): void {
  place(live, columns)
  const beach = live.beach
  // The water rolls toward where the context puts it, a cell a tick (a still beach has it there already).
  const tide = tideline(live.props, beach)
  live.shore += Math.sign(tide - live.shore)
  const [low, high] = range(live, beach)
  const mood = moodOf(live)
  const { tick } = live
  if (live.props.isStill) {
    return
  }
  const gaps = GAPS[mood]
  const isResting = live.x === live.goal
  if (tick >= live.nextLap) {
    live.lapAt = tick
    live.nextLap = later(tick, 1, gaps.lap)
    if (mood === 'high' && isResting && !isMoment(live)) {
      // The wave is coming up to his feet: he looks down at it as it arrives, then back.
      live.glanceAt = tick + 2
    }
  }
  if (isMoment(live)) {
    live.busyAt = tick
    return
  }
  if (live.busyAt === tick - 1) {
    settle(live, mood)
  }
  // Out a cell for his cheer, he leaves it on a tick no wave washes up to his feet (nor will on the
  // next): with a foot lifted beside the water he would read as stepping out of the sea, so he waits
  // for it to draw back.
  const isLapped = live.isOut && isLapAtFeet(live, beach)

  if (mood === 'nap') {
    live.goal = low
    live.isOut = false
    if (live.x === low && live.napAt === NEVER) {
      live.napAt = tick
    }
  } else if (live.isOut && isResting && tick >= live.busyAt + SETTLE && (mood === 'idle' || live.x > high) && !isLapped) {
    // Out a cell for his cheer: settled, he pads back home with a step, looking the way he goes (in
    // any mood when the tide has come up to the cell he stepped out to).
    live.goal = low
    live.isOut = false
  } else {
    live.napAt = NEVER
    if (mood === 'look' || mood === 'think') {
      // Reading or thinking: he stays put and watches.
      live.goal = live.x
    }
    if (mood === 'high' && tick >= live.busyAt + SETTLE && !isLapped) {
      // The tide is high and nothing is going on: settled, he goes down to the water's edge to watch
      // it come in (a cell or two), where a band that appears now finds him too.
      live.goal = high
      live.isOut = false
    }
    if (isResting && tick >= live.nextBlink) {
      live.blinkAt = tick
      live.nextBlink = later(tick, 2, gaps.blink)
    }
    if (isResting && gaps.glance !== null && tick >= live.nextGlance) {
      live.glanceAt = tick
      live.nextGlance = later(tick, 3, gaps.glance)
    }
    if (isResting && gaps.stroll !== null && tick >= live.nextStroll && !isGlancing(live, mood)) {
      // A scuttle of two to four cells, either way, to a spot with room for a heart beside him
      // (on the narrowest beach a couple of spots have none).
      const goals = [2, 3, 4]
        .flatMap(step => [live.x + step, live.x - step])
        .filter(goal => goal >= low && goal <= high && heartAt(live, beach, goal) !== null)
      const goal = goals[dice(tick * 8 + 4, goals.length)]
      if (goal !== undefined) {
        live.goal = goal
        live.isOut = false
      }
      live.nextStroll = later(tick, 6, gaps.stroll)
    }
  }
  // The tide came in past him: he scuttles back up the sand (from the cell he stepped out to for a
  // cheer, once he has settled: see above).
  live.goal = Math.min(reach(live, beach), Math.max(low, live.goal))
  if (live.x !== live.goal && since(live, live.stepAt) >= STEP_TICKS) {
    live.x += Math.sign(live.goal - live.x)
    live.stepAt = tick
    live.steps += 1
  }
}

// A mark beside Clawd (a sparkle, the heart, a z, spray): the places it may go, best first. It is
// drawn in the first place that is all clear sky, so it never covers the shell, the wave or him,
// and is left out when no place is clear. A mark also keeps a cell of sky from the shell and the
// wave on its row, so it never reads as part of them; only spray (`isLoose`) may fly off the wave.
// A mark that stands off from him in the sky (`isAiry`: a sparkle a cell out from his claws) keeps
// clear of what lies below it too: no wave under it or a corner away, as far as the wave will lap
// while the moment lasts, and no shell under it. Otherwise it would read as the wave's, or the
// shell's, rather than his.
type Mark = { row: number; col: number; cell: Cell; isLoose?: boolean; isAiry?: boolean }
type Places = Mark[][]

/**
 * Clawd's three rows for this tick and the marks around him. `cheer`: the places his cheer's
 * sparkles may go while his arms are up (chosen once per cheer, see scene); `ahead`: the same places
 * on the spin's last frame, drawn nowhere, so the crest can start standing back for them a beat
 * before his arms go up (see cheerRoom).
 */
function clawd(live: Live, beach: number): { rows: [Row, Row, Row]; marks: Places[]; cheer: Places | null; ahead?: Places } {
  const { props, x } = live
  const marks: Places[] = []
  const still = props.isStill
  const isApple = props.isAppleTerminal
  // His sprite: Claude Code's own Clawd, or in Apple's Terminal its simpler one.
  const posed = isApple ? applePose : pose
  const lying = isApple ? appleCurled : curled

  // Curled up once he is home for his nap: lively, on the tick after the step that brought him
  // there; still, at once (place() sends him home and marks the nap begun on the frame that shows it).
  const isCurled = isNapping(live) && x === homeOf(beach) && live.napAt !== NEVER
  // Still, a petted sleeper's z comes back as the heart goes (lively, he sleeps a moment without it,
  // while the wave rolls back in).
  const isHeartGone = still && isCurled && since(live, live.petAt) >= HEART_TICKS
  if (isPetted(live) && !isHeartGone) {
    const t = since(live, live.petAt)
    const at = heartAt(live, beach)
    if (t < HEART_TICKS && at !== null) {
      // Beside him, a cell of sky away: on the right (the wave stands back to make room for it, see
      // scene), or on the left when he has strolled away from the shell.
      marks.push([heart(at.col)])
    }
    if (isCurled) {
      // Asleep, he just gets the heart, and sleeps on (the z's wait until it has gone).
      return { rows: lying(), marks, cheer: null }
    }

    // A pet that runs into the cheer's finale chooses its sparkles' places ahead (drawn nowhere yet), so
    // the crest the heart stood back rolls in no further than they need (see cheerRoom).
    const ahead = isPetIntoFinale(live) ? { ahead: cheerPlaces(live, x) } : {}
    // A heart held up in his claw (flush against him, where no cell of sky beside him is left) stays up
    // in it for as long as it shows, and goes as he lowers his claw: lowered while the heart still
    // showed, his arm's `▀` would meet its point's `▝`, and heart and body read as one blob.
    const isHeld = at !== null && at.col === x + SPRITE && t < HEART_TICKS

    return { rows: posed({ eyes: t < 6 ? 'wink' : 'open', arms: t < 6 || isHeld ? 'up' : 'down', feet: 'both' }), marks, cheer: null, ...ahead }
  }
  if (isSplashShown(live)) {
    // Eyes squeezed shut as it hits; then, cold feet, he hops from one pair to the other to shake
    // them dry, looking round at the water as it goes back out; then settled. (Still: the hit, held.)
    const t = splashTick(live)
    marks.push(...spray(x, t))
    const feet: Feet = t >= 4 && t < 8 ? (t % 2 === 0 ? 'left' : 'right') : 'both'

    return { rows: posed({ eyes: t < 6 ? 'closed' : t < 10 ? 'right' : 'open', arms: t < 4 ? 'up' : 'down', feet }), marks, cheer: null }
  }
  if (isCheering(live)) {
    const t = since(live, live.cheerAt)
    const isFinale = finaleAt(live) !== null
    if (t < SPIN.length && isSpinning(live)) {
      const ahead = t === SPIN.length - 1 && isFinale ? { ahead: cheerPlaces(live, x) } : {}
      // A pet during the spin turned him round to face you: he stays facing you for what is left of
      // it, never turning back to a three-quarter frame, and his arms go up on the cheer's own beat
      // (so the wave still draws back its first cell a beat ahead, see cheerRoom).
      if (live.petAt + live.petTicks > live.cheerAt) {
        return { rows: posed({ eyes: 'open', arms: 'down', feet: 'both' }), marks, cheer: null, ...ahead }
      }

      return { rows: spin(t), marks, cheer: null, ...ahead }
    }
    if (!isFinale) {
      // A pet late in the cheer left it too little for its finale: he ends it facing you, at rest.
      return { rows: posed({ eyes: 'open', arms: 'down', feet: 'both' }), marks, cheer: null }
    }

    return { rows: posed({ eyes: 'open', arms: 'up', feet: danceFeet(live) }), marks, cheer: cheerPlaces(live, x) }
  }
  // Home for his nap: the step that brings him there lands standing, and he curls up on the next tick.
  if (isCurled || (isNapping(live) && x === homeOf(beach) && (still || since(live, live.stepAt) > 0))) {
    const phase = still || live.napAt === NEVER ? 0 : since(live, live.napAt) % Z_CYCLE
    const z = (row: number, col: number): Mark[] => [{ row, col, cell: { ch: 'z', dim: true } }]
    // A cell of sky between his head and the z (Apple's Clawd fills his whole row, so one further out).
    const by = x + SPRITE + (isApple ? 1 : 0)
    if (phase < Z_LOW) {
      marks.push([z(1, by), z(0, by)])
    } else if (phase < Z_HIGH) {
      marks.push([z(0, by + 1), z(0, by + 2)])
    }

    return { rows: lying(), marks, cheer: null }
  }
  if (isWaking(live)) {
    // Up from the sand with a big stretch, arms up and eyes still shut; arms down; then he opens them.
    return { rows: posed({ eyes: 'closed', arms: since(live, live.wakeAt) < STRETCH_TICKS ? 'up' : 'down', feet: 'both' }), marks, cheer: null }
  }
  if (isHello(live)) {
    // Hello: one claw up for three quarters of a second, down, and up again.
    const t = since(live, live.helloAt)

    return { rows: posed({ eyes: 'open', arms: t < 3 || (t >= 5 && t < 8) ? 'one-up' : 'down', feet: 'both' }), marks, cheer: null }
  }

  // A step lifts one pair of legs for a tick; between steps all four stand.
  const feet: Feet = !still && since(live, live.stepAt) === 0 ? (live.steps % 2 === 0 ? 'left' : 'right') : 'both'
  // Eyes open is home. He looks where he is going, blinks, and glances right for a moment: over
  // at the words when Claude starts reading, out to sea while thinking, at a wave reaching him.
  let eyes: Eyes = 'open'
  if (!still && since(live, live.stepAt) === 0 && moodOf(live) === 'nap') {
    // The last step home for a nap: still looking the way he went.
    eyes = 'left'
  } else if (!still && live.x !== live.goal) {
    eyes = live.goal < live.x ? 'left' : 'right'
  } else if (!still && since(live, live.blinkAt) === 0) {
    eyes = 'closed'
  } else if (!still && isGlancing(live, moodOf(live))) {
    eyes = 'right'
  }

  return { rows: posed({ eyes, arms: 'down', feet }), marks, cheer: null }
}

// The heart, in quadrant pixels, four cells by two rows: Claude Code's block heart. There is only
// the one size: a heart three cells by two reads in a terminal's tall cells as a pink "Y" or a
// tulip, whatever its pixels (`█▄█` over `▝█▘`, `▜▄▛`, `▟▄▙`, `▗▄▖`).
const HEART_ROWS = ['▟▙▟▙', '▝▜▛▘'] as const
const HEART_WIDTH = 4

function heart(col: number): Mark[] {
  return HEART_ROWS.flatMap((row, r) => [...row].map((ch, i): Mark => ({ row: r, col: col + i, cell: { ch, color: HEART } })))
}

type HeartAt = { col: number; width: typeof HEART_WIDTH; standsBack: boolean }

// Where the heart goes when he stands at `x`, a cell of sky from him, best first: on his right
// when the wave leaves room for it there (a cell of sky, the heart, a cell of sky, then the lip);
// on his left when he has strolled far enough from the shell; on his right with the wave standing
// back past it, as long as the wave keeps its lip and shoulder on the beach; on a narrow beach
// with no shell, on his left by his raised hand (a quadrant of his first cell, so half a cell of
// sky is left). On the narrowest beach, with the tide well in, he holds it up in his raised claw,
// the wave standing back past it. Null when there is no room even so (the wave never loses its
// head for a heart): the wink and the raised claw say it alone.
function heartAt(live: Live, beach: number, x = live.x): HeartAt | null {
  const right = x + SPRITE + 1
  const calm = Math.max(shoreline(live, beach), right)
  const left = hasShell(beach) ? SHELL_WIDTH + 1 : 0
  const width = HEART_WIDTH
  if (right + width + 1 <= calm) return { col: right, width, standsBack: false }
  if (x - width - 1 >= left) return { col: x - width - 1, width, standsBack: false }
  if (right + width + 1 + 2 <= beach) return { col: right, width, standsBack: true }
  if (!hasShell(beach) && x - width >= 0) return { col: x - width, width, standsBack: false }
  if (right - 1 + width + 1 + 2 <= beach) return { col: right - 1, width, standsBack: true }

  return null
}

// While the heart is beside him on the right, the wave's crest stands back past it, out on the
// open water (the water's edge on the sand stays where the tide has it). When the heart has gone it
// rolls back in, a cell a tick. Where the calm sea already leaves the heart room, the crest only
// keeps that cell of sky: a wave lapping up the sand meanwhile runs in under it, so the heart
// never blinks out mid-pet. Returns the column the crest stands at or beyond, or 0.
function heartRoom(live: Live, beach: number): number {
  const t = since(live, live.petAt)
  const at = isPetted(live) ? heartAt(live, beach) : null
  if (at === null || at.col < live.x) {
    return 0
  }
  const room = at.col + at.width + 1
  if (live.props.isStill) {
    // Nothing rolls: the crest is simply back once the heart has gone.
    return t < HEART_TICKS ? room : 0
  }

  return t < HEART_TICKS ? room : room - (t - HEART_TICKS + 1)
}

/**
 * Where his cheer's sparkles may go, best first. Arms up, he holds up two of Claude Code's own
 * sparkles, in the sky where nothing else is: never squeezed in between him and the shell, never
 * flush against the band's left edge, and never flush against his claw. A breath of air parts each
 * from his claws, the same on both sides: his raised left hand is a quadrant at the right of its
 * cell, so the cell beside it already leaves half a cell of sky, and his right hand fills its cell,
 * so its sparkle stands a cell out. A sparkle that stands out like that (`isAiry`) keeps clear of the
 * wave below it, as far as the wave laps while he cheers, and of the shell, under it or a corner
 * away, so it reads as his; with the tide in, the crest stands back for it (see cheerRoom). By the
 * band's edge he steps a cell in first (see stepOut), so the pair fits there too. Where the ✶ by his
 * left has no room, both go on his right, a cell of sky from him and from each other, so they read
 * as two sparkles rather than a clump; failing that, the ✻ alone, a cell out. Apple's Clawd ends in a
 * quadrant on both sides, so his sparkles stand a cell out on both sides, and where that has no room
 * (by the shell, or a cell in from the edge), at his claws, each with half a cell of sky.
 */
function cheerPlaces(live: Live, x: number): Places {
  const isApple = live.props.isAppleTerminal
  const [left, right] = [x - 1, x + SPRITE]
  const pair = (stars: Array<[number, string]>): Mark[] =>
    stars.map(([col, ch]) => ({ row: 0, col, cell: { ch, color: 'claude' }, isAiry: col !== left && col !== right }))
  // His right claw (`▄`) fills its cell to the edge, so a sparkle in the cell beside it sits flush and
  // reads as part of his arm (`▄✻`): his ✻ always stands a cell out. Apple's Clawd ends in a quadrant
  // (`▖`), which leaves half a cell of sky beside it, as his left claw does on both Clawds.
  const pairs: Array<Array<[number, string]>> = isApple
    ? [
        [[right + 1, '✻'], [left - 1, '✶']],
        [[right, '✻'], [left, '✶']],
        [[right + 1, '✻'], [right + 3, '✶']],
        [[right, '✻'], [right + 2, '✶']],
        [[right, '✻']],
        [[left, '✻']],
      ]
    : [[[right + 1, '✻'], [left, '✶']], [[right + 1, '✻'], [right + 3, '✶']], [[right + 1, '✻']], [[left, '✻']]]

  return pairs.filter(stars => stars.every(([col]) => col >= 1)).map(pair)
}

// While his arms are up for a cheer, the crest stands back from him, so his ✻ keeps a cell of sky
// from the wave's lip, as it has at low tide (and so long as the wave keeps its lip and shoulder on
// the beach): two cells further off than it does for him when the ✻ stands a cell out from his
// claw (`✶▗▟▛███▛█▄ ✻`, as everywhere else, the tide in too), one when it
// is at his claw. The cheer over, it rolls back in a cell a tick, as it does after the heart (still,
// it is simply back). Returns the column, or 0.
function cheerRoom(live: Live, beach: number): number {
  const t = since(live, live.cheerAt)
  const { isStill } = live.props
  const isSpin = t < SPIN.length && isSpinning(live)
  const kept = live.cheerMarks?.key === cheerKey(live, beach) ? live.cheerMarks : null
  const room = live.x + SPRITE + (kept?.isOut === true ? 3 : 2)
  if (room + 2 > beach || isSplashShown(live) || t < 0 || finaleAt(live) === null) {
    return 0
  }
  if (isPetted(live)) {
    // A pet that runs into the finale: the crest its heart stood back rolls in no further than the
    // finale's room, so it never jumps back out as his arms go up. (A heart on his left moves no
    // crest: the finale draws it back as his arms go up, as after a spin.)
    return isPetIntoFinale(live) && heartRoom(live, beach) > 0 ? room : 0
  }
  if (isSpin) {
    // The spin's last frame (its sparkles chosen ahead, see clawd): the wave draws back its first
    // cell, so it goes back over two beats, the way it comes in, never two cells as his arms go up.
    return t === SPIN.length - 1 && kept !== null ? room - 1 : 0
  }
  if (isCheering(live)) {
    return room
  }

  return isStill || live.isCheerCut ? 0 : room - (t - CHEER_TICKS + 1)
}

/**
 * Which half second of the cheer's finale this tick is in, from 0 as his arms go up; null while it is
 * no lively finale (still, it is one held frame). The sparkles twinkle and his feet dance to it.
 */
function finaleBeat(live: Live): number | null {
  const from = finaleAt(live)

  return from === null || live.props.isStill || live.tick < from ? null : Math.floor((live.tick - from) / BEAT_TICKS)
}

/**
 * The cheer's sparkles, twinkling as Claude Code's spinner does: every other half second of the
 * finale they swap to their other form, the ✻ swelling to a heavy ✽ as the ✶ draws in to a ✢. Each
 * keeps its cell. Still, they hold their first form, one frame for the whole cheer.
 */
function twinkled(live: Live, place: Mark[] | undefined): Mark[] | undefined {
  const beat = finaleBeat(live)
  if (place === undefined || beat === null || beat % 2 === 0) {
    return place
  }

  return place.map(mark => ({ ...mark, cell: { ...mark.cell, ch: TWINKLE[mark.cell.ch] ?? mark.cell.ch } }))
}

/**
 * His feet in the finale, arms up: a happy shuffle to the sparkles' beat (as the hearth's Clawd
 * shuffles in his cheer), one pair lifted and then the other, and both down again to end on.
 */
function danceFeet(live: Live): Feet {
  const beat = finaleBeat(live)

  return beat === 1 ? 'left' : beat === 2 ? 'right' : 'both'
}

/** Each sparkle's other form, and how long a beat of the finale lasts (half a second). */
const TWINKLE: Record<string, string> = { '✻': '✽', '✶': '✢' }
const BEAT_TICKS = 2

/** Which cheer, beach and spot a choice of sparkles was made for. */
function cheerKey(live: Live, beach: number): string {
  return `${live.cheerAt}:${beach}:${live.x}`
}

// How long a pet lasts: the heart's 2 s, then as long as the wave takes to roll back in.
function petTicks(live: Live, beach: number): number {
  const at = heartAt(live, beach)
  const calm = Math.max(shoreline(live, beach), live.x + SPRITE + 1)

  return at?.standsBack === true && !live.props.isStill ? Math.max(PET_TICKS, HEART_TICKS + at.col + at.width + 1 - calm) : PET_TICKS
}

// Sea spray as the wave reaches his feet: drops leap up off the crest, hang, and the last one falls
// (t in ticks). The crest stands a cell of sky right of him while the water runs under his feet,
// so each drop is placed in the sky a pixel clear of the wave, never touching it or him.
function spray(x: number, t: number): Places[] {
  const at = (col: number, ch: string): Places => [[{ row: 0, col, cell: { ch, color: SEA }, isLoose: true }]]
  const lip = x + SPRITE + 1
  if (t < 2) {
    return []
  }
  if (t < 4) {
    return [at(lip + 1, '▝'), at(lip + 3, '▖')]
  }
  if (t < 6) {
    return [at(lip - 1, '▘'), at(lip + 2, '▝'), at(lip + 4, '▘')]
  }
  if (t < 8) {
    return [at(lip + 3, '▖')]
  }

  return []
}

// ── The beach ──────────────────────────────────────────────────────────────────

// The beach and the gutter after it, at each width of terminal. The beach is about a third of the
// band at most, so the words keep room to breathe: 25 cells from 56 columns (34 for the words at
// 64, 50 at 80), 32 from 96, 40 from 130; below 52 columns a small one (18 to 22 cells, no shell),
// so the words keep at least 12 columns from 34 up. Between those sizes it grows a cell a column
// (and the gutter, two cells beside a small beach, three beside one with a shell, grows by one at
// 55), so the words' room never shrinks as the band widens: a line never says less at 56 columns
// than at 55. It never outgrows the band.
export function layoutOf(columns: number): { beach: number; gutter: number } {
  if (columns >= 130) return { beach: 40, gutter: 3 }
  if (columns >= 122) return { beach: columns - 90, gutter: 3 }
  if (columns >= 96) return { beach: 32, gutter: 3 }
  if (columns >= 89) return { beach: columns - 64, gutter: 3 }
  if (columns >= 56) return { beach: 25, gutter: 3 }
  if (columns >= 52) return { beach: Math.min(24, columns - 30), gutter: columns >= 55 ? 3 : 2 }

  return { beach: Math.max(0, Math.min(columns - 2, Math.max(18, Math.min(22, columns - 23)))), gutter: 2 }
}

function beachWidth(columns: number): number {
  return layoutOf(columns).beach
}

/** Whether this beach has room for the shell: from 25 cells (56 columns) up. */
function hasShell(beach: number): boolean {
  return beach >= 25
}

/** Clawd's home spot: a cell of sand right of the shell, or one cell in when there is none. */
function homeOf(beach: number): number {
  return hasShell(beach) ? SHELL_WIDTH + 1 : 1
}

// The open sea: water the tide never needs, so even at 0% a whole wave rolls in on flat water
// (the wave takes five or six cells, then at least one cell of calm sea beyond it): 6 cells at 25,
// 8 at 32, 9 at 40, a cell more at a time between. A narrow beach keeps a smaller wave and 4 to 6.
function openSea(beach: number): number {
  if (beach >= 36) return 9
  if (beach >= 30) return 8
  if (beach >= 27) return 7
  if (beach >= 22) return 6

  return beach >= 20 ? 5 : 4
}

/** The cells of shore the tide runs up: 4 at 25 cells, 9 at 32, 16 at 40, 3 to 5 on a narrow beach. */
function shoreOf(beach: number): number {
  return Math.max(0, beach - homeOf(beach) - SPRITE - 1 - openSea(beach))
}

// Where the water starts when the sea is calm. Past the open sea, the tide covers the shore in
// proportion to the context used: at 100% it comes up to a cell of sky from his side at home.
function tideline(props: BandProps, beach: number): number {
  const percent = props.percent ?? 0

  return beach - openSea(beach) - Math.round((Math.min(100, Math.max(0, percent)) / 100) * shoreOf(beach))
}

// Where the calm water starts as drawn: on its way to the tideline a cell a tick (see plan).
function shoreline(live: Live, beach: number): number {
  return live.shoreBeach === beach ? live.shore : tideline(live.props, beach)
}

// Where he may stand: from home to the water's edge, always with a cell of sky between his arm
// and the wave's lip.
function range(live: Live, beach: number): [number, number] {
  const home = homeOf(beach)

  return [home, Math.max(home, shoreline(live, beach) - SPRITE - 1)]
}

// How far a wave has washed up past the shoreline at this tick. Most of the time: not at all.
function lap(live: Live): number {
  return lapAt(live, since(live, live.lapAt))
}

// How far the wave has washed up `t` ticks into a lap.
function lapAt(live: Live, t: number): number {
  if (live.props.isStill || t < 0) {
    return 0
  }
  if (live.props.isHigh && !isBusy(live.props) && !isNapping(live)) {
    // High tide: the wave runs right up to his feet, then slides back (a sleeper gets the small lap).
    return t < 2 ? 1 : t < 9 ? 3 : t < 12 ? 1 : 0
  }

  return t < 6 ? 1 : 0
}

// The furthest the wave will wash up from now until `until` (a tick): the lap under way, and the
// next one if it comes by then (laps are planned ahead, see plan).
function lapsUntil(live: Live, until: number): number {
  let most = 0
  for (let tick = live.tick; tick <= until; tick++) {
    most = Math.max(most, lapAt(live, tick - (tick >= live.nextLap ? live.nextLap : live.lapAt)))
  }

  return most
}

// Whether a wave washes up to the cell beside his right foot this tick or the next (the calm water
// alone never counts: a tide come up to him waits on nothing).
function isLapAtFeet(live: Live, beach: number): boolean {
  const lapped = lapsUntil(live, live.tick + 1)

  return lapped > 0 && shoreline(live, beach) - lapped <= live.x + SPRITE - 1
}

// Where the water's edge is this tick: the calm shoreline, a wave washing up, or a splash.
function edgeOf(live: Live, shore: number): number {
  return Math.max(0, Math.min(shore - lap(live), splashEdge(live, shore)))
}

// A splash: the water rushes up the sand to his feet over three ticks, holds there while the
// spray falls, then slides back out a cell or two a tick, never all at once. At a wide beach it
// may still be ebbing for a moment after the words have moved on, as the sea would.
function splashEdge(live: Live, shore: number): number {
  const t = since(live, live.splashAt)
  const peak = live.splashFrom + 4
  if (t < 0 || peak >= shore) {
    return shore
  }
  if (live.props.isStill) {
    // A still beach holds the splash at its peak, the water right up to his feet, for as long as
    // the splash lasts: the frame the lively splash shows as its spray flies (and the desktop's).
    return isSplashShown(live) ? peak : shore
  }
  const reach = shore - peak
  if (t < 2) {
    return shore - Math.round(reach * (t === 0 ? 0.4 : 0.75))
  }
  if (t < 5) {
    return peak
  }
  const out = t - 4

  return Math.min(shore, peak + (out <= 2 ? out : 2 * out - 2))
}

// The ground row is a full cell of sand, so Clawd's legs stand in front of it and nothing
// above the sand line carries its color: dry sand with a few darker grains (none under him or
// right beside him, where a grain would read as a third foot), damp sand near the water, foam sliding up the
// sand, then the sea (lighter on top, deeper below). A grain stays put: it is hidden only while he
// stands on it or a cell from it, so as he walks home for his nap, the grain he walks off is back
// before the one he walks onto goes (a margin three cells wide would make one grain vanish well
// ahead of him and another appear behind him a second later, which reads as a grain jumping).
// The sand beneath him stays dry (`isBeneath`): his clay feet on the damp tan all but vanish, so the
// damp strip, and the damp ground under the foam at the water's edge, stop where he stands. The water
// itself still runs under his feet.
function groundAt(col: number, edge: number, damp: number, isUnder: boolean, isBeneath: boolean): Cell {
  if (col < edge) {
    if (col >= damp && !isBeneath) {
      return { ch: ' ', bg: WET }
    }

    return col % 6 === 5 && !isUnder ? { ch: '▖', color: SPECK, bg: SAND } : { ch: ' ', bg: SAND }
  }
  if (col === edge) {
    return { ch: '▟', color: FOAM, bg: isBeneath ? SAND : WET }
  }
  // Now and then the deep water swells up into the light: ripples riding in behind the crest.
  const ripple = (col - edge) % 8

  return { ch: ripple === 6 ? '▟' : ripple === 7 ? '▙' : '▄', color: SEA_DEEP, bg: SEA }
}

// The wave at the shore, curling toward the sand: a foam lip pitching forward over its foot (the
// sky shows under it, open toward the beach, so nothing is enclosed), the foam running back over
// its shoulder, then a body of sea that slopes gently down behind. Six cells when there is room,
// always with at least a cell of flat water beyond it; smaller near the end of a narrow beach (just
// its lip and shoulder when it stands back for the heart there), and none when under two cells are left.
function crestOf(room: number): Cell[] {
  const wave = (cell: Cell): Cell => ({ ...cell, kind: 'wave' })
  const lip = wave({ ch: '▀', color: FOAM })
  const shoulder = wave({ ch: '▛', color: FOAM, bg: SEA })
  const body = wave({ ch: '█', color: SEA })
  const back = wave({ ch: '▄', color: SEA })
  const end = wave({ ch: '▖', color: SEA })
  const size = Math.min(6, room - 1)
  if (size >= 6) return [lip, shoulder, body, back, back, end]
  if (size === 5) return [lip, shoulder, body, back, end]
  // (Four cells would squeeze its back into a step, `▀▛▙▖`, which read as a broken wave: the small one, then flat water.)
  if (size >= 3) return [lip, shoulder, end]

  return room >= 2 ? [lip, shoulder] : []
}

// A little scallop by his home spot, half buried in the sand: a coral dome with two deeper ribs
// running down it, rounded at its top corners, its lower half sunk into the ground row and
// narrowing there toward the hinge. (A fan standing on the sand read as a striped block, and a
// dome over a darker hinge bar as a cupcake.)
const SHELL_CELLS: Array<[number, number, Cell]> = [
  [1, 0, { ch: '▟', color: SHELL, kind: 'shell' }],
  [1, 1, { ch: '▌', color: SHELL_RIDGE, bg: SHELL, kind: 'shell' }],
  [1, 2, { ch: '▐', color: SHELL_RIDGE, bg: SHELL, kind: 'shell' }],
  [1, 3, { ch: '▙', color: SHELL, kind: 'shell' }],
  [2, 0, { ch: '▝', color: SHELL, kind: 'shell' }],
  [2, 1, { ch: '▀', color: SHELL, kind: 'shell' }],
  [2, 2, { ch: '▀', color: SHELL, kind: 'shell' }],
  [2, 3, { ch: '▘', color: SHELL, kind: 'shell' }],
]

function scene(live: Live, beach: number): Row[] {
  const sky = (): Row => Array.from({ length: beach }, () => ({ ch: ' ' }))
  const swell = sky()
  const ground: Row = []
  const rows: Row[] = [sky(), swell, ground]
  const shore = shoreline(live, beach)
  const edge = edgeOf(live, shore)
  // Damp sand just above the water, and, for a few seconds after a splash, all the way up to
  // where the wave reached: the sea leaves the sand it ran over wet as it slides back.
  // A still beach holds the splash's peak (see splashEdge), with the sand it ran over damp, and
  // goes back to calm as the splash ends: one frame for the moment, then the beach as it was.
  const splashed = since(live, live.splashAt)
  const isDamp = live.props.isStill ? isSplashShown(live) : splashed >= 2 && splashed < DAMP_TICKS
  const trail = isDamp ? live.splashFrom + 4 : beach
  const damp = Math.min(Math.min(edge, shore) - 2, trail)
  for (let col = 0; col < beach; col++) {
    ground.push(groundAt(col, edge, damp, col >= live.x - 1 && col <= live.x + SPRITE, col >= live.x && col < live.x + SPRITE))
  }
  if (hasShell(beach) && edge > SHELL_WIDTH) {
    for (const [r, c, cell] of SHELL_CELLS) {
      const target = rows[r]
      // In the ground row it sits in the sand, which shows round it.
      if (target !== undefined && c < beach) target[c] = r === 2 ? { ...cell, bg: target[c]?.bg ?? SAND } : cell
    }
  }
  const isSky = (row: number, col: number) => {
    const under = rows[row]?.[col]
    return col >= 0 && col < beach && under !== undefined && under.ch === ' ' && under.bg === undefined
  }
  const isScenery = (row: number, col: number) => {
    const kind = rows[row]?.[col]?.kind
    return kind === 'wave' || kind === 'shell'
  }
  const isClear = ({ row, col, isLoose }: Mark) =>
    isSky(row, col) && (isLoose === true || (!isScenery(row, col - 1) && !isScenery(row, col + 1)))
  const { rows: sprite, marks, cheer, ahead } = clawd(live, beach)
  // The cheer's sparkles are chosen before the crest is drawn, since it stands back for them.
  const choose = (pairs: Places): number => {
    // As far up the sand as the wave's lip will come while he cheers: the furthest lap, until the
    // cheer ends, of the shore it is at or heading for, and never nearer him than a cell of sky; or,
    // where the beach has room for it, two cells, so even with the tide in his ✻ has a cell of sky
    // from his claw and another from the lip (see cheerRoom).
    const lip = Math.min(shore, tideline(live.props, beach)) - lapsUntil(live, live.cheerAt + CHEER_TICKS)
    const out = live.x + SPRITE + 3
    const reach = Math.max(lip, live.x + SPRITE + 1, out + 2 <= beach ? out : 0)
    const isShell = (row: number, col: number) => rows[row]?.[col]?.kind === 'shell'
    const isAiryClear = ({ row, col, isAiry }: Mark) =>
      isAiry !== true || (col + 1 < reach && !isShell(row + 1, col - 1) && !isShell(row + 1, col) && !isShell(row + 1, col + 1))

    return pairs.findIndex(place => place.every(isClear) && place.every(isAiryClear))
  }
  const key = cheerKey(live, beach)
  const planned = cheer ?? ahead ?? null
  if (planned !== null && live.cheerMarks?.key !== key) {
    const index = choose(planned)
    live.cheerMarks = { key, index, isOut: planned[index]?.some(mark => mark.col === live.x + SPRITE + 1) === true }
  }
  // The crest stands at the water's edge, but never behind him or against his arm: when the water
  // runs up to his feet (a wave at high tide, a splash, the tide coming in past him) only the water
  // on the sand moves, and the crest keeps a cell of sky from him. It stands back for the heart, and
  // for the cheer's ✻.
  const crestAt = Math.max(edge, live.x + SPRITE + 1, heartRoom(live, beach), cheerRoom(live, beach))
  crestOf(beach - crestAt).forEach((cell, i) => {
    if (crestAt + i < beach) swell[crestAt + i] = cell
  })

  sprite.forEach((line, r) => {
    const target = rows[r]
    line.forEach((cell, c) => {
      const col = live.x + c
      const under = target?.[col]
      if (target === undefined || under === undefined || (cell.ch === ' ' && cell.bg === undefined)) {
        return
      }
      // In the ground row his legs stand in front of the sand (or the water), which shows round them.
      target[col] = r === 2 && cell.bg === undefined ? { ...cell, bg: under.bg ?? SAND } : cell
    })
  })
  const draw = (place: Mark[] | undefined) => {
    for (const { row, col, cell } of place ?? []) {
      const target = rows[row]
      if (target !== undefined) target[col] = cell
    }
  }
  for (const places of marks) {
    draw(places.find(marks => marks.every(isClear)))
  }
  if (cheer !== null) {
    // The cheer's sparkles are placed once, as his arms go up, and held for the whole cheer: a wave
    // lapping in, or the tide rising on a late reading, never sends them hopping about.
    const held = live.cheerMarks?.key === key ? cheer[live.cheerMarks.index] : undefined
    draw(twinkled(live, held !== undefined && held.every(isClear) ? held : cheer[choose(cheer)]))
  }

  return rows
}

// ── Words ──────────────────────────────────────────────────────────────────────

// The three lines, each as its forms, longest first (see fitLine).
function wordsNow(live: Live): Words[][] {
  const { words } = live.props
  // A spin playing out after a new prompt is no longer "Done": the words have moved on.
  const isCheer = isCheering(live) && !live.props.isWorking
  // The splash's words are the wave's, and the facts say when it is over, for both surfaces: this
  // clock's splash, begun on the tick before the failure landed, may end up to a tick before the
  // desktop's (its words wait the tick out: the line it hands on to is the facts' to say, see
  // stepDesk), and a tick held for the second's room (see pace.ts) runs its frames late, whose words
  // still go with the facts' redraw as the wave ends. A band that appears with too little of the
  // splash left to carry it on (see start) has him at rest, but on the look that was on screen as the
  // wave began (a /config reload, a dialog closing) the words are still the wave's until the facts
  // say it is over, as the desktop's are: a reload late in a splash once put the next line up as much
  // as 700 ms before the desktop's. A look switched to after the wave began never says it: the
  // desktop's new frame opens at rest, its words with it (a bold "Splash!" over a calm beach, dropped
  // half a second later, would say a wave that never came).
  const mood = isSplashWords(live) ? words.splash : isCheer ? words.cheer : isNapping(live) ? words.nap : words.now

  return [mood, words.tide, words.place]
}

// Whether line 1 is the splash's (see wordsNow).
function isSplashWords(live: Live): boolean {
  const isWave = isSplashed(live) || since(live, live.splashAt) === SPLASH_TICKS || (live.splashAt === NEVER && live.isWaveSeen)
  const isLanded = isCheering(live) && live.cheerAt >= live.splashAt

  return isWave && !isLanded && (live.props.sinceSplashMs ?? Infinity) < SPLASH_MS
}

function runOf(piece: Piece): Run {
  const run: Run = { text: piece.text }
  switch (piece.tone) {
    case 'dim':
      run.dimColor = true
      break
    case 'good':
      run.color = 'success'
      break
    case 'warn':
      run.color = 'warning'
      break
    case 'bad':
      run.color = 'error'
      break
    case 'clay':
      run.color = 'claude'
      break
    default:
      break
  }
  if (piece.bold === true) {
    run.bold = true
  }

  return run
}

function compose(live: Live, columns: number): { scene: Run[][]; words: Run[][]; beach: number; gutter: number; columns: number; isSplash: boolean } {
  const { beach, gutter } = layoutOf(columns)
  const rows = scene(live, beach).map(row => merge(trimEnd(row)))
  const room = columns - 2 - beach - gutter
  // The words stay at every width a person would use (even a narrow split pane keeps the tide line).
  const words = room >= 5 ? wordsNow(live).map(forms => fitLine(forms, room, CELLS).map(runOf)) : []

  return { scene: rows, words, beach, gutter, columns, isSplash: words.length > 0 && isSplashWords(live) }
}

function trimEnd(row: Row): Row {
  let end = row.length
  while (end > 0 && row[end - 1]?.ch === ' ' && row[end - 1]?.bg === undefined) {
    end -= 1
  }

  return row.slice(0, Math.max(1, end))
}

// Joins neighbors drawn alike, so a row is a handful of Text runs, not one per cell.
function merge(row: Row): Run[] {
  const out: Run[] = []
  for (const cell of row) {
    const run: Run = { text: cell.ch }
    if (cell.ch !== ' ' && cell.color !== undefined) run.color = cell.color
    if (cell.bg !== undefined) run.backgroundColor = cell.bg
    if (cell.ch !== ' ' && cell.dim === true) run.dimColor = true
    const last = out[out.length - 1]
    if (
      last !== undefined &&
      last.color === run.color &&
      last.backgroundColor === run.backgroundColor &&
      last.dimColor === run.dimColor
    ) {
      last.text += run.text
    } else {
      out.push(run)
    }
  }

  return out
}
