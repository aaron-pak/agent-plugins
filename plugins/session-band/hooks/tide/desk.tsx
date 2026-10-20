import type { Elements, RenderElement } from 'claude-code'

import type { BandProps, Piece, Words } from './types'
import { CELL_PX, CLAY, DOZE_SLATE, EYE_INK, HEART_ALT, HEART_PINK, SPIN, pixelHeart, textPx } from '../clawd'
import { BODY, EYE, curled, pose, spin } from './band'
import type { Pose, Row } from './band'
import { PIXELS, fitLine } from './fit'
import { NAP_AFTER_MS, SPLASH_MS, skySteps } from '../facts'

// The beach on the desktop: a tiny SVG diorama (sand, a shell, slow waves and
// Clawd built from the very cells the terminal draws him with) beside the
// band's three lines, laid out with Box and Text.
//
// The desktop has no frame clock: everything that moves is CSS inside the
// diorama's image, and a new `source` restarts every animation in it. So the
// source is built only from slow, visible state (the loop he is in, where the
// tide stands in 5% steps, still or not, and a moment while it plays), and
// stays byte-identical across the redraws a turn makes as tools start and
// finish. Nothing in it counts time.

type Desktop = Elements['desktop']

/** How long a cheer plays (a splash plays SPLASH_MS); the hooks module redraws once each ends. */
export const CHEER_MS = 4_500

// The diorama in units of one Clawd pixel's width (3 CSS px): 64 wide on a band of 48 columns, down
// to 40 on the narrowest (see dioramaWidth), and on a wider band as wide as the words leave room for,
// up to WIDEST (see beachWidth). The frame is 64 px tall, as tall as the hearth's Clawd, so a look
// switch never moves the prompt: the 54 px picture sits in its middle.
const U = 3
const WIDE = 64
const NARROW = 40
/** The widest the beach grows, in units (672 px): a wide window's panorama. */
const WIDEST = 224
/**
 * The least room the words keep beside a widened beach, in pixels: a turn's tally whole ("✻ Done in
 * 41s · 7 tools · 2 files changed"), and the context line with every number at its widest.
 */
const WORDS_LEAST_PX = 290
const H = 18
const FRAME_PX = 64
const PAD_PX = (FRAME_PX - H * U) / 2
/**
 * Where the beach parks its heart, in rows, and where the hover moves it. The hearth's heart parks
 * wholly below the band (PARKED), but a Box parked there is squeezed to a pixel, and the beach's
 * heart, which walks his walk, then landed its first frame up to 15 px off one reveal in three. So
 * this one parks 3 rows down, still across the band's bottom edge, which only clips it and keeps
 * its clock true, and the hover lifts it a row above the band's top. Its picture carries a row of
 * empty sky (ROW_PX) above the heart, which keeps the parked heart under the edge and, shown,
 * cancels the row it was lifted, so it lands on him exactly.
 */
export const HEART_PARKED = 3
export const HEART_SHOWN = -1
/** One row of the desktop's text, in CSS px, as Claude's desktop app draws it. */
export const ROW_PX = 19
const GROUND = 14
const TOP = GROUND - 10
const HOME = 7
const SPRITE_W = 18
const SHORE_START = HOME + SPRITE_W
// Sea the tide never needs, so even at 0% the shoulder and a stretch of open water show.
const OPEN_SEA = 9
const TIDE_STEP = 5
const TIDE_HOLD = 15

// Colors that read on claude.ai's light (#faf9f5) and dark (#262624) pages, soft and warm
// enough to sit beside Claude's clay: kraft sand, a dusk-blue sea, a coral shell.
const PAINT: Record<string, string> = { [BODY]: CLAY, [EYE]: EYE_INK }
const SAND = '#E2C394'
const SAND_EDGE = '#CFA86F'
const WET = '#CDAE7E'
const SEA = '#6C9DC2'
const SEA_DEEP = '#5888AE'
const FOAM = '#C6DCEC'
const SHELL = '#E9A3A4'
const SHELL_RIDGE = '#C9818A'
const HEART = HEART_PINK
const DOZE = DOZE_SLATE
// His shadow: the sand, a shade darker (it only ever lies on the sand).
const SHADOW = 'rgba(122,88,44,.26)'
// A paler sea for the splash's drops, so they stay airy on the dark page too.
const DROP = '#8FB6D6'

type Mood = 'idle' | 'high' | 'read' | 'work' | 'nap'
type Moment = 'cheer' | 'splash' | 'wake' | 'hello' | null

/**
 * A frame of the beach: the slow state the diorama is drawn from, and nothing else reaches the Svg
 * source. `from`: where he stands as this frame opens, in pixels out on the sand from his home by
 * the shell, where the last frame had him (see positionAt and leadOf). A moment (a cheer, a splash)
 * plays there, and then he walks to where his new loop starts; a nap walks him home to sleep. So a
 * new frame never jumps him back to a starting spot. Null when there is no last frame to go on: the
 * loop's own start (for a nap, home by the shell). `wave`: which failure a splash is for (the
 * session's count), so a new failure while one splash plays (once its first rush is over) is a new
 * source and splashes him again. `phase`: when this frame carries on the very walk the last one had
 * him on (the same loop, the same sand to roam: a stride of the tide far out to sea, a reading while
 * he potters), how many seconds into that loop it opens, so he goes on with his step the way he was
 * heading, with no walk back to the loop's start (see carriedPhase). `curled`: a nap that takes over
 * from one already curled up on screen (still, or at another width), so he sleeps on from its first
 * frame, never standing up to lie down again (see isCurledAt). `doze`: with it, how many seconds
 * into their loop the z's were in that frame (see dozeAt), so they drift on where they were: never a
 * "zzZ" dropped back to one small z.
 */
export type Scene = {
  mood: Mood
  tide: number
  still: boolean
  moment: Moment
  from: number | null
  width: number
  wave: number
  /** Night by the person's own clock: a moon and stars over the sea. */
  night: boolean
  /** How far the sun has crossed the sky by day, or the moon by night, in steps (see skyStepAt and skyAt). */
  sky: number
  /** Where a compaction left a starfish: the tide it stood at before, in 5% steps (null: none). */
  treasure: number | null
  /** How built his sandcastle is, 0 (none) to 6 (flag and all): see castleStage. */
  castle: number
  /** This frame's cheer is for the turn that built the castle's newest piece: it pops up as his arms go up. */
  built: boolean
  sea: Sea | null
  phase?: number
  curled?: boolean
  doze?: number
}

/**
 * Where the sea is as a frame opens, carried from the last frame the way `from` carries Clawd (see
 * seaAfter), so a new source never snaps the water back to its start. `clock`: the crests' time, in
 * seconds; both crests roll on from it. `lap`: the wash up the sand. A lap the last frame had out on
 * the sand when this one's is a different lap (a nap's slower one, high tide's longer reach) runs
 * out first (`finish`); this frame's own laps begin `start` seconds in (negative: already that far
 * into one, when it is the same lap going on). `glide`: how far the water's front stands from its
 * calm line as the frame opens, in units (a surge still running out, a tide that has moved): it eases
 * there. Null: a frame with nothing before it, the sea at its own start.
 */
export type Sea = { clock: number; lap: LapPlan; glide: number }
type Lap = { period: number; reach: number }
type LapPlan = { finish: (Lap & { offset: number }) | null; start: number }
const CALM_SEA: Sea = { clock: 0, lap: { finish: null, start: 0 }, glide: 0 }
/** The crests' periods (seconds), and a time both come round in, which the sea's clock wraps at (the glints' and the stars' periods divide it too). */
const ROLL_S = 9
const ROLL2_S = 14
const CLOCK_WRAP = 126
/** A splash's surge: in, a moment at his feet, then back out (seconds). */
const SURGE_S = 2.4
/** When the splash's last drop has fallen back into the sea, in seconds from the splash's start. */
const DROPS_END_S = 2.2
/** How far through its flight a drop of spray reaches the top of its arc. */
const PEAK_AT = 0.42

/**
 * How wide the diorama is beside a narrow band of `columns`, in units: 64 from 48 columns, 40 on the
 * narrowest, two units (6 px) narrower a column between, so the words' room (7.6 px a column)
 * never shrinks as the band widens. No width from the host: the wide one. (A wider band's beach is
 * beachWidth's.)
 */
function dioramaWidth(columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) {
    return WIDE
  }

  return Math.max(NARROW, Math.min(WIDE, NARROW + 2 * (Math.floor(columns) - 36)))
}

/**
 * How wide the beach is beside a band of `columns` whose where-line is `place` (its widest form), in
 * units. Up to 48 columns it is dioramaWidth's, and 64 from there until the words have their room
 * beside it: WORDS_LEAST_PX at least, and their where-line whole, each of its numbers counted as two
 * zeros or more, so a count going from 9 to 10 (or 13 to 14) never moves the beach. From that band
 * on it widens two units (6 px) a column, up to WIDEST, so the words' room (7.6 px a column) never
 * shrinks as the band widens and a narrower band never says more than a wider one. Only that line's
 * parts move it (a new branch, another model), and a move is a new frame as a resize is.
 */
export function beachWidth(columns: number, place: Words): number {
  const narrow = dioramaWidth(columns)
  if (!Number.isFinite(columns) || columns <= 0) {
    return narrow
  }
  const where = place.reduce((sum, piece) => sum + textPx(piece.text.replace(/\d+/gu, digits => '0'.repeat(Math.max(2, digits.length))), piece.bold === true || piece.fitsAsBold === true), 0)
  // The first band whose words have their room beside the 64-unit beach (see deskRoom).
  const from = Math.ceil((Math.max(WORDS_LEAST_PX, where) + 3 * CELL_PX + 1 + WIDE * U) / CELL_PX)

  return Math.max(narrow, Math.min(WIDEST, WIDE + 2 * (Math.floor(columns) - from)))
}

/**
 * The room the words have beside a beach `width` units wide, in pixels of the page's proportional
 * font (see textPx): the band's width less the beach and its margin, and a cell to spare, so a page
 * whose cells run a little narrower than the budget's (7.2 px) still ends no line in its own
 * ellipsis. The last pixel is that page's too: at 45 columns "Ready when you are" fitted the budget
 * by a tenth of a pixel and ran a pixel past its box at 7.2 px. When the host gives no width (0, or
 * nothing usable), every word is kept and the Text's truncate-end is the only cut.
 */
function deskRoom(columns: number, width: number): number {
  if (!Number.isFinite(columns) || columns <= 0) {
    return Number.POSITIVE_INFINITY
  }

  return columns * CELL_PX - width * U - 3 * CELL_PX - 1
}

/** Draws the desktop band; `scene` is the one the hooks module settled on (sceneOf, with where a nap begins). */
export function desktopBand(el: Desktop, props: BandProps, scene: Scene): RenderElement {
  const { Box, Text, Svg } = el
  const room = deskRoom(props.columns, scene.width)
  const lines = linesFor(props).map(forms => fitLine(forms, room, PIXELS))

  return (
    <Box flexDirection="row" alignItems="center">
      <Box key="beach" position="relative" flexShrink={0}>
        <Svg source={diorama(scene)} alt={altFor(scene, props.percent !== null)} width={scene.width * U} height={FRAME_PX} />
        {/* Parked across the band's bottom edge and moved onto him by the hover; a reveal would be a card above the band and restart his walk. */}
        <Box position="absolute" top={HEART_PARKED} left={0} hover={{ top: HEART_SHOWN }}>
          <Svg source={petHeart(scene)} alt={HEART_ALT} width={scene.width * U} height={FRAME_PX + ROW_PX} />
        </Box>
      </Box>
      <Box flexDirection="column" marginLeft={2} flexGrow={1} flexShrink={1} minWidth={0}>
        {lines.map(line => (
          <Text wrap="truncate-end">
            {line.map(piece => (
              <Text {...style(piece)}>{piece.text}</Text>
            ))}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function isNapping(props: BandProps): boolean {
  return !props.isWorking && props.idleMs !== null && props.idleMs >= NAP_AFTER_MS
}

function within(ms: number | null, limit: number): boolean {
  return ms !== null && ms >= 0 && ms < limit
}

// A turn starts with him watching the words (Claude reading and thinking), and once the turn
// changes something (an edit, a command) he potters about for the rest of it: one change of loop
// a turn at most, so tools starting and finishing never reload the frame. A wait on you (a question,
// a plan to look over) is no work: he sits at rest until you answer, and the loop comes back after.
function moodOf(props: BandProps): Mood {
  if (isNapping(props)) return 'nap'
  // Waiting on you (a question, a plan to look over), he sits at rest, as between turns.
  if (props.isWorking && props.doing !== 'wait') return props.turnWorked ? 'work' : 'read'

  return props.isHigh ? 'high' : 'idle'
}

// A moment plays once, then the loop takes over in the same source. A splash belongs to a turn
// at work. A cheer plays out whole even when a new prompt comes during it: the frame keeps the
// scene it was drawing (the words move on at once), so the spin is never cut or restarted, and
// the new turn's loop begins when the cheer ends. Waking from a nap opens the turn's first loop.
//
// A moment that began before this look came on screen (a /band or /config switch) is over for it:
// the new frame starts at rest rather than replaying the moment from its first beat (which the
// moment's end would then cut short).
function momentOf(props: BandProps, mood: Mood): Moment {
  if (mood === 'nap') {
    return null
  }
  const isWorking = mood === 'read' || mood === 'work'
  const newer = (a: number | null, b: number | null) => b === null || (a !== null && a <= b)
  const isSeen = (ago: number | null) => props.shownForMs === null || (ago !== null && ago <= props.shownForMs)
  // A splash is its wave's: a failure that rides along with it ends with it (see SPLASH_RUSH_MS).
  if (isWorking && within(props.sinceSplashMs, SPLASH_MS) && newer(props.sinceSplashMs, props.sinceCheerMs)) {
    return isSeen(props.sinceSplashMs) ? 'splash' : null
  }
  if (within(props.sinceCheerMs, CHEER_MS) && newer(props.sinceCheerMs, props.sinceSplashMs)) {
    return isSeen(props.sinceCheerMs) ? 'cheer' : null
  }

  if (mood === 'read' && props.woke && isSeen(props.sinceTurnMs)) {
    return 'wake'
  }

  return props.isGreeting && (mood === 'idle' || mood === 'high') ? 'hello' : null
}

export function sceneOf(props: BandProps): Scene {
  const now = moodOf(props)
  const happening = momentOf(props, now)
  // Still, a cheer and a splash are each one frame (arms up with the sparkles held; the wave at
  // his feet, his eyes shut), as on the terminal; waking and hello do not show.
  const moment = props.isStill && happening !== 'cheer' && happening !== 'splash' ? null : happening
  // The cheer is the rest after a turn, so it keeps the rest's loop while it plays.
  const mood = moment === 'cheer' && (now === 'read' || now === 'work') ? (props.isHigh ? 'high' : 'idle') : now
  const wave = moment === 'splash' && !props.isStill ? props.waves : 0

  const treasure = props.treasure === null ? null : Math.round(props.treasure / TIDE_STEP) * TIDE_STEP

  const width = beachWidth(props.columns, props.words.place[0] ?? [])
  const castle = castleStage(props.castle, width)
  const built = moment === 'cheer' && !props.isStill && castle > 0 && CASTLE_TURNS.includes(props.castle)

  // The narrow beach's sky never moves (see skyAt), so its step never reloads the frame.
  const sky = width < WIDE ? 0 : props.sky

  return { mood, tide: tideOf(props, moment), still: props.isStill, moment, from: null, width, wave, night: props.isNight, sky, treasure, castle, built, sea: null }
}

/**
 * The scene with where it starts him and the sea left out: the hooks module keeps `from` and `sea`
 * while this stays the same. So does the hello: the frame that waved keeps its source for a while
 * once the greeting's seconds are up (its loop is the same), and never reloads just to drop a wave
 * that has played.
 */
export function sceneKey(scene: Scene): string {
  return JSON.stringify({ ...scene, from: null, sea: null, phase: undefined, curled: undefined, doze: undefined, moment: scene.moment === 'hello' ? null : scene.moment })
}

/**
 * Whether a frame drawing `scene` has him curled up asleep `ms` after it loaded: a still nap from
 * the first, a lively one once its walk home and its moment standing with his eyes shut are over.
 */
export function isCurledAt(scene: Scene, ms: number): boolean {
  return scene.mood === 'nap' && (scene.still || scene.curled === true || ms / 1000 >= napLead(scene.from ?? 0).intro)
}

/** The z's loop (seconds), and where in it a still nap holds them: the first z up, alone. */
const Z_PERIOD_S = 7.5
const Z_HELD_S = 2.1

/**
 * How many seconds into their loop a nap frame's z's are `ms` after it loaded, or null before
 * their loop has begun. Still, they hold where a still nap draws them.
 */
export function dozeAt(scene: Scene, ms: number): number | null {
  if (scene.mood !== 'nap') return null
  if (scene.still) return Z_HELD_S
  const t = ms / 1000 + zLead(scene)

  return t < 0 ? null : round(t % Z_PERIOD_S)
}

// How far into their loop a nap frame's z's open (seconds; negative: that long before it begins).
// A lively nap's loop begins 1.4 s before he curls up, so its first z comes 0.2 s after he has; a
// nap carried from one curled up on screen opens where that one's z's were.
function zLead(scene: Scene): number {
  if (scene.curled === true) {
    return typeof scene.doze === 'number' && Number.isFinite(scene.doze) ? scene.doze : Z_HELD_S
  }

  return -round(napLead(scene.from ?? 0).intro - 1.4)
}

/**
 * How many seconds into its loop a frame drawing `next` opens, `ms` after the frame drawing `last`
 * did, when it carries the last one's walk straight on: the same loop on the same sand, the last
 * frame past its moment and its walk back, and nothing new to play. Undefined otherwise (the new
 * frame starts him from where he stands, see leadOf).
 */
export function carriedPhase(last: Scene, ms: number, next: Scene): number | undefined {
  if (last.still || next.still || next.moment !== null || last.mood !== next.mood || last.mood === 'nap' || last.width !== next.width) {
    return undefined
  }
  const [was, now] = [layout(last), layout(next)]
  const loop = choreography(last.mood, was.roam)
  if (was.start !== now.start || JSON.stringify(loop) !== JSON.stringify(choreography(next.mood, now.roam)) || loop.period <= 0) {
    return undefined
  }
  const t = ms / 1000 - leadOf(last).length
  if (t < 0) {
    return undefined
  }

  return round((t + (last.phase ?? 0)) % loop.period)
}

/**
 * Where Clawd stands `ms` after a frame drawing `scene` loaded, in pixels out from his home by the
 * shell: the lead plays from the load (the moment where he stood, then his walk to the loop's
 * start), then the loop, so their beats at that time say. The page's frame loads about when the
 * source is first handed out, so this is close enough for the next frame to start him there.
 */
export function positionAt(scene: Scene, ms: number): number {
  const { mood, still } = scene
  if (mood === 'nap') {
    return 0
  }
  const { start } = layout(scene)
  if (still) {
    return start + stillDx(scene) - HOME
  }

  return start + (beatAt(scene, ms)?.x ?? 0) - HOME
}

/**
 * Where a still frame has him, in pixels from his loop's start: where the last frame had him
 * (`from`), inside the sand this tide leaves him, so /band still (or reduced motion coming on) holds
 * him where he stood rather than sending him home, and the lively frame after it walks him on from
 * there. With no last frame to go on, the loop's start.
 */
function stillDx(scene: Scene): number {
  const { start, span } = layout(scene)

  return scene.from === null ? 0 : Math.min(span, Math.max(0, Math.round(scene.from))) - (start - HOME)
}

/** Which of his poses a frame drawing `scene` shows `ms` after it loaded, as positionAt says where. */
export function poseAt(scene: Scene, ms: number): string {
  return scene.mood === 'nap' || scene.still ? 'stand' : (beatAt(scene, ms)?.pose ?? 'stand')
}

// The beat of the lead, or else of the loop, a frame drawing `scene` is on `ms` after it loaded.
function beatAt(scene: Scene, ms: number): Beat | undefined {
  const at = (beats: Beat[], t: number) => {
    let found = beats[0]
    for (const beat of beats) {
      if (beat.at <= t) found = beat
    }
    return found
  }
  const lead = leadOf(scene)
  const t = ms / 1000
  if (t < lead.length) {
    return at(lead.beats, t)
  }
  const { beats, period } = choreography(scene.mood, layout(scene).roam)

  return period <= 0 ? beats[0] : at(beats, (t - lead.length + (scene.phase ?? 0)) % period)
}

/**
 * Where the sea stands as a frame drawing `next` opens, `ms` after the frame drawing `last` did:
 * the crests' clock run on, the lap the last frame had out finished or carried on, and the water's
 * front where the last frame had it (its surge, its glide), so the new frame takes the sea over in
 * mid-motion. A still frame holds the sea where it drew it, so the one after picks up from there. A
 * new width redraws the whole picture, so its sea starts calm at its own line. The crests' clock and
 * the lap are carried to the millisecond: a lap washing in covers a third of a pixel in a fortieth of
 * a second, so a phase rounded to a twentieth moved the wave's lip at the reload.
 */
export function seaAfter(last: Scene, ms: number, next: Scene): Sea {
  const t = Math.max(0, ms / 1000)
  const was = last.sea ?? CALM_SEA
  const clock = roundMs((last.still ? was.clock : was.clock + t) % CLOCK_WRAP)
  const glide = next.still || next.width !== last.width ? 0 : round5(frontAt(last, t) - layout(next).shore)

  return { clock, lap: lapAfter(last, t, next), glide: Math.abs(glide) < 0.1 ? 0 : glide }
}

/**
 * The sea `ms` after a frame drawing `scene` opened: how far its front has run up the sand from the
 * calm line (`front`, in units, the lap's wash included; `glide`, the part of that still gliding to
 * the calm line) and where the two crests are in their roll (0 to 1). What a frame's CSS draws,
 * worked out the same way, so a test can hold one frame's last moment against the next one's first.
 */
export function seaAt(scene: Scene, ms: number): { front: number; glide: number; roll: number; roll2: number } {
  const t = Math.max(0, ms / 1000)
  const clock = (scene.sea ?? CALM_SEA).clock + (scene.still ? 0 : t)

  return {
    front: frontAt(scene, t) - lapShift(lapAt(scene, t)),
    glide: glideAt(scene, t),
    roll: (clock % ROLL_S) / ROLL_S,
    roll2: (clock % ROLL2_S) / ROLL2_S,
  }
}

/** Each mood's lap: every 8 s, two units up the sand (four at high tide, to his feet); a nap's every 14 s. */
function lapOf(mood: Mood): Lap {
  return { period: mood === 'nap' ? 14 : 8, reach: mood === 'high' ? 4 : 2 }
}

// The lap under way `t` s into a frame: the last frame's, while it runs out, then the frame's own.
function lapAt(scene: Scene, t: number): Lap & { offset: number } {
  const own = lapOf(scene.mood)
  if (scene.still) {
    return { ...own, offset: 0 }
  }
  const plan = (scene.sea ?? CALM_SEA).lap
  if (plan.finish !== null && t < plan.start) {
    return { ...plan.finish, offset: plan.finish.offset + t }
  }

  return { ...own, offset: mod(t - plan.start, own.period) }
}

// The same lap goes on in step; a different one waits for the last to run out (or starts afresh
// when the last is at rest, not a hair up the sand), so the wash never jumps to a new reach mid-lap.
function lapAfter(last: Scene, t: number, next: Scene): LapPlan {
  const own = lapOf(next.mood)
  if (next.still) {
    return { finish: null, start: 0 }
  }
  const was = lapAt(last, t)
  if (was.period === own.period && was.reach === own.reach) {
    return { finish: null, start: -roundMs(was.offset) }
  }
  if (lapShift(was) < 1e-6) {
    return { finish: null, start: 0 }
  }
  const offset = roundMs(was.offset)

  return { finish: { period: was.period, reach: was.reach, offset }, start: roundMs(was.period - offset) }
}

// How far a lap has washed up the sand, in units: the `lap` keyframes (see sea), eased as CSS eases them.
function lapShift(lap: Lap & { offset: number }): number {
  const f = mod(lap.offset, lap.period) / lap.period

  return along(
    [
      { at: 0, value: 0, ease: EASE_IN_OUT },
      { at: 0.45, value: 0, ease: EASE_IN_OUT },
      { at: 0.65, value: lap.reach, ease: EASE_IN_OUT },
      { at: 0.72, value: lap.reach, ease: EASE_IN_OUT },
      { at: 1, value: 0, ease: EASE_IN_OUT },
    ],
    f,
  )
}

// Where the water's front stands `t` s into a frame, in units from the diorama's left, before the
// lap: the calm line, the glide easing to it, and a splash's surge.
function frontAt(scene: Scene, t: number): number {
  return layout(scene).shore + glideAt(scene, t) - surgeAt(scene, t)
}

// A splash's frame folds its glide into its surge (see surgeAt): the front rushes on from where it was.
function glideAt(scene: Scene, t: number): number {
  const glide = scene.still || surgeRun(scene) > 0 ? 0 : (scene.sea ?? CALM_SEA).glide
  const length = glideSeconds(glide)
  const wait = glide === 0 ? 0 : glideWait(scene)

  return glide === 0 || t >= wait + length ? 0 : t <= wait ? glide : glide * (1 - EASE_IN_OUT((t - wait) / length))
}

/**
 * How long the water's front holds where the last frame had it before it glides to the calm line:
 * while he stands further out than this tide leaves him room (see leadOf), until the step of his walk
 * that brings him back inside it. No wait when he is already inside.
 */
function glideWait(scene: Scene): number {
  const { start, span } = layout(scene)
  const inside = span - (start - HOME)
  const lead = leadOf(scene)
  if (lead.dx <= inside) {
    return 0
  }

  return lead.beats.find(beat => beat.x <= inside)?.at ?? lead.length
}

/** A glide takes a quarter of a second a unit, gently: from 0.6 s for a nudge to 2 s for a /compact. */
function glideSeconds(glide: number): number {
  return round5(Math.min(2, Math.max(0.6, Math.abs(glide) * 0.25)))
}

// How far a splash's surge has run up the sand `t` s into its frame (the `surge` keyframes), from
// where the last frame left the front (a splash on a splash rushes on, never back to the line first);
// a still frame holds it at his feet.
function surgeAt(scene: Scene, t: number): number {
  const run = surgeRun(scene)
  if (run === 0) {
    return 0
  }
  if (scene.still) {
    return run
  }

  return along(
    [
      { at: 0, value: surgeFrom(scene), ease: bezier(0.25, 0.8, 0.35, 1) },
      { at: 0.24, value: run, ease: EASE_IN_OUT },
      { at: 0.46, value: run * 0.9, ease: bezier(0.45, 0, 0.4, 1) },
      { at: 1, value: 0, ease: EASE_IN_OUT },
    ],
    t / SURGE_S,
  )
}

/** How far a splash's surge runs, in units: from the calm line to his feet, where he stands as it hits. */
function surgeRun(scene: Scene): number {
  if (scene.moment !== 'splash' || scene.mood === 'nap') {
    return 0
  }
  const { shore, start } = layout(scene)
  const dx = scene.still ? stillDx(scene) : leadOf(scene).dx

  return Math.max(0, shore - (start + dx + 11))
}

/** How far up the sand the front stands as a splash's frame opens: where the last frame had it. */
function surgeFrom(scene: Scene): number {
  return scene.still ? 0 : Math.max(0, -(scene.sea ?? CALM_SEA).glide)
}

type Stop = { at: number; value: number; ease: (x: number) => number }

// A value along keyframes at `f` (0 to 1), each stretch eased by its own timing function.
function along(stops: Stop[], f: number): number {
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (a !== undefined && b !== undefined && f <= b.at) {
      return a.value + (b.value - a.value) * a.ease(Math.max(0, f - a.at) / Math.max(1e-9, b.at - a.at))
    }
  }

  return stops[stops.length - 1]?.value ?? 0
}

// CSS's cubic-bezier timing function: the curve's y where its x is `x`.
function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (p1: number, p2: number, s: number) => 3 * p1 * s * (1 - s) ** 2 + 3 * p2 * s * s * (1 - s) + s ** 3

  return x => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let [low, high] = [0, 1]
    for (let i = 0; i < 32; i++) {
      const mid = (low + high) / 2
      if (at(x1, x2, mid) < x) low = mid
      else high = mid
    }

    return at(y1, y2, (low + high) / 2)
  }
}
const EASE_IN_OUT = bezier(0.42, 0, 0.58, 1)

function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

/**
 * To the nearest 0.05 (seconds, or units of the water's glide), so a source reads cleanly. Counted
 * from whole thousandths, so a sum's float noise (9.725 - 8 is 1.7249999999999996) never tips a half
 * the wrong way.
 */
function round5(seconds: number): number {
  return Math.round(Math.round(seconds * 1000) / 50) / 20
}

/** Seconds to the millisecond (a time the frame clock can tell apart), free of a sum's float noise. */
function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/**
 * What plays before the loop, in pixels from where the loop starts: the moment (a cheer, a splash,
 * waking up) where he stood as the frame opened (`dx`), then his scuttle back to the loop's start,
 * a look that way and a pixel a step, as in his loops. Empty when he is already there with no
 * moment to play. A still frame has none: it is one pose at the loop's start.
 */
function leadOf(scene: Scene): { beats: Beat[]; length: number; dx: number } {
  if (scene.phase !== undefined) {
    // He carries straight on with the walk the last frame had him on.
    return { beats: [], length: 0, dx: 0 }
  }
  const { start, span } = layout(scene)
  // He starts where the last frame had him, inside the sand this tide leaves him. Further out (the
  // tide came in a stride while he was at the far end of his scuttle) only by as much as the water
  // still stands out where it was: it waits there until he has walked back in (see glideWait), so
  // he is never snapped back, and never stands in the sea.
  const room = scene.still || scene.moment === 'splash' ? 0 : Math.max(0, Math.floor((scene.sea ?? CALM_SEA).glide))
  const dx = scene.from === null ? 0 : Math.min(span + room, Math.max(0, Math.round(scene.from))) - (start - HOME)
  const beats: Beat[] = []
  let at = 0
  if (scene.moment !== null) {
    beats.push(...beatsOf(scene.moment).map(beat => ({ ...beat, x: dx })))
    at = INTRO[scene.moment]
  }
  let x = dx
  if (x !== 0) {
    const side = x > 0 ? 'L' : 'R'
    beats.push({ at: round(at), pose: `look${side}`, x })
    at += 0.4
    for (let n = 0; x !== 0; n++) {
      x -= Math.sign(x)
      beats.push({ at: round(at), pose: `walk${side}${(n % 2) + 1}`, x })
      at += 0.22
      beats.push({ at: round(at), pose: `look${side}`, x })
      at += 0.34
    }
  }

  return { beats, length: round(at), dx }
}

// Where the diorama's tide stands, in 5% steps. While a turn runs it holds where the turn began and
// moves only in strides of 15 points, so the context creeping up tool by tool never reloads the
// frame (and sends Clawd back to his first step) mid-turn. While a moment plays it holds still
// altogether: where the turn ended for a cheer, where it stood when the tool failed for a splash,
// where the turn began for waking up; so no measure ever starts a moment over. It catches up when
// the moment ends, a redraw that starts a new loop anyway.
function tideOf(props: BandProps, moment: Moment): number {
  const clamp = (n: number) => Math.min(100, Math.max(0, n))
  const live = clamp(props.percent ?? 0)
  const stride = (to: number) => (props.turnPercent === null ? to : props.turnPercent + Math.trunc((to - props.turnPercent) / TIDE_HOLD) * TIDE_HOLD)
  const tide =
    moment === 'cheer'
      ? (props.cheerPercent ?? live)
      : moment === 'splash'
        ? stride(props.oopsPercent ?? live)
        : moment === 'wake'
          ? (props.turnPercent ?? live)
          : props.isWorking
            ? stride(live)
            : live

  return Math.round(clamp(tide) / TIDE_STEP) * TIDE_STEP
}

// The three lines, each as its forms, longest first (see fitLine).
function linesFor(props: BandProps): Words[][] {
  const { words } = props
  const mood = moodOf(props)
  const moment = momentOf(props, mood)
  // A cheer still playing after a new prompt is no longer "Done": the words have moved on.
  const isCheer = moment === 'cheer' && !props.isWorking
  const first = moment === 'splash' ? words.splash : isCheer ? words.cheer : mood === 'nap' ? words.nap : words.now

  return [first, words.tide, words.place]
}

function style(piece: Piece): { color?: string; dimColor?: boolean; bold?: boolean } {
  const bold = piece.bold === true ? { bold: true } : {}
  switch (piece.tone) {
    case 'dim':
      return { dimColor: true, ...bold }
    case 'good':
      return { color: 'success', ...bold }
    case 'warn':
      return { color: 'warning', ...bold }
    case 'bad':
      return { color: 'error', ...bold }
    case 'clay':
      return { color: 'claude', ...bold }
    default:
      return bold
  }
}

const DOING: Record<Mood, string> = {
  // He strolls out along the sand in the frame, never sits: the words say what is drawn.
  idle: 'Clawd strolls on the sand',
  // The tide's own words follow ("The tide is high, close to his feet."), so this says no more.
  high: 'Clawd watches the water come in',
  read: 'Clawd watches the words from the sand',
  work: 'Clawd potters about on the sand',
  nap: 'Clawd naps by a shell',
}
const HAPPENING: Record<Exclude<Moment, null>, string> = {
  cheer: 'Clawd spins with joy, then throws his arms up',
  splash: 'A wave splashes Clawd and slides back out',
  wake: 'Clawd wakes up by his shell, stretches and watches the words',
  hello: 'Clawd waves hello',
}
// (The still splash's own words: "right up to his feet" is how the full tide is told, and beside a
// tide partway in it would read as high water.)
const HELD = { cheer: 'Clawd throws his arms up with joy', splash: "A wave splashes over Clawd's feet" }
// Still, he stands where a lively frame has him potter about, or stroll.
const STILL_WORK = 'Clawd stands on the sand while Claude works'
const STILL_IDLE = 'Clawd stands on the sand'

// The alt text says what the picture shows; the words beside it give the exact percent, so the
// tide here is in words that never disagree with them (and the alt stays the same while the
// percent creeps up within a step). Before the first reading the picture's low water is no reading
// at all, and the alt says so, as the words do, rather than tell of a tide it does not know.
function altFor(scene: Scene, isRead: boolean): string {
  const doing = scene.still && scene.mood === 'work' ? STILL_WORK : scene.still && scene.mood === 'idle' ? STILL_IDLE : DOING[scene.mood]
  const { moment } = scene
  // The hello's and a lively splash's frames go on into the mood's loop (and keep their source as
  // they do): each says both. Still, a cheer or a splash is its one held frame.
  const what =
    moment === null
      ? doing
      : moment === 'hello'
        ? `${HAPPENING.hello}, then ${doing.replace(/^Clawd /, '')}`
        : scene.still && (moment === 'cheer' || moment === 'splash')
          ? HELD[moment]
          : moment === 'splash'
            ? `${HAPPENING.splash}, then he ${doing.replace(/^Clawd /, '')}`
            : HAPPENING[moment]

  const starfish = starfishAt(scene) === null ? '' : ' A starfish lies where the tide was.'

  return `${what}. ${isRead ? tideWords(scene.tide) : 'No context reading yet.'}${starfish}${scene.night ? ' The stars are out.' : ''}`
}

function tideWords(tide: number): string {
  if (tide >= 95) return 'The tide is in, right up to his feet.'
  if (tide >= 80) return 'The tide is high, close to his feet.'
  if (tide >= 55) return 'The tide is more than halfway in.'
  if (tide >= 30) return 'The tide is partway in.'

  return 'The tide is out.'
}

// ── Clawd in pixels ────────────────────────────────────────────────────────────

const QUAD: Record<string, [number, number, number, number]> = {
  '▘': [1, 0, 0, 0], '▝': [0, 1, 0, 0], '▖': [0, 0, 1, 0], '▗': [0, 0, 0, 1],
  '▀': [1, 1, 0, 0], '▄': [0, 0, 1, 1], '▌': [1, 0, 1, 0], '▐': [0, 1, 0, 1],
  '▚': [1, 0, 0, 1], '▞': [0, 1, 1, 0], '▙': [1, 0, 1, 1], '▛': [1, 1, 1, 0],
  '▜': [1, 1, 0, 1], '▟': [0, 1, 1, 1], '█': [1, 1, 1, 1],
}

// Each terminal cell is 2x2 quadrants; a quadrant is a pixel one unit wide and two tall.
function pixels(rows: Row[]): string {
  const grid: Array<Array<string | undefined>> = rows.flatMap(() => [[], []])
  const lids: string[] = []
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      const quad = QUAD[cell.ch]
      const isLid = cell.ch === '▂'
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const isOn = quad !== undefined && quad[qy * 2 + qx] === 1
          const key = isLid ? cell.bg : isOn ? cell.color : cell.bg
          const line = grid[r * 2 + qy]
          if (line !== undefined) line[c * 2 + qx] = key === undefined ? undefined : (PAINT[key] ?? key)
        }
      }
      if (isLid && cell.color !== undefined) {
        lids.push(`<rect x="${c * 2}" y="${r * 4 + 3}" width="2" height="1" fill="${PAINT[cell.color] ?? cell.color}"/>`)
      }
    })
  })
  // A glance in the terminal puts each eye in the top quadrant of the head, where a page's
  // dark background would swallow it. Here the eye drops one pixel, inside the head, on clay.
  const [top, below] = grid
  if (top !== undefined && below !== undefined) {
    top.forEach((fill, x) => {
      if (fill === PAINT[EYE] && below[x] === PAINT[BODY]) {
        top[x] = PAINT[BODY]
        below[x] = PAINT[EYE]
      }
    })
  }
  const out: string[] = []
  grid.forEach((line, y) => {
    let x = 0
    while (x < line.length) {
      const fill = line[x]
      if (fill === undefined) {
        x += 1
        continue
      }
      let w = 1
      while (line[x + w] === fill) w += 1
      out.push(`<rect x="${x}" y="${y * 2}" width="${w}" height="2" fill="${fill}"/>`)
      x += w
    }
  })

  return out.join('') + lids.join('')
}

const POSES: Record<string, Pose> = {
  stand: { eyes: 'open', arms: 'down', feet: 'both' },
  blink: { eyes: 'closed', arms: 'down', feet: 'both' },
  lookL: { eyes: 'left', arms: 'down', feet: 'both' },
  lookR: { eyes: 'right', arms: 'down', feet: 'both' },
  walkL1: { eyes: 'left', arms: 'down', feet: 'left' },
  walkL2: { eyes: 'left', arms: 'down', feet: 'right' },
  walkR1: { eyes: 'right', arms: 'down', feet: 'left' },
  walkR2: { eyes: 'right', arms: 'down', feet: 'right' },
  up: { eyes: 'open', arms: 'up', feet: 'both' },
  splash: { eyes: 'closed', arms: 'up', feet: 'both' },
  stretch: { eyes: 'closed', arms: 'up', feet: 'both' },
  hopL: { eyes: 'closed', arms: 'down', feet: 'left' },
  hopR: { eyes: 'closed', arms: 'down', feet: 'right' },
  wave: { eyes: 'open', arms: 'one-up', feet: 'both' },
}

function frame(name: string): string {
  const spun = /^spin(\d+)$/.exec(name)
  const rows = spun !== null ? spin(Number(spun[1])) : pose(POSES[name] ?? POSES.stand ?? { eyes: 'open', arms: 'down', feet: 'both' })

  return pixels(rows)
}

// ── Choreography ───────────────────────────────────────────────────────────────

type Beat = { at: number; pose: string; x: number }

// A loop of beats: where Clawd stands and how, second by second, strolling `reach` units out at most
// (see layout).
function choreography(mood: Mood, reach: number): { beats: Beat[]; period: number } {
  const beats: Beat[] = []
  let at = 0
  let x = 0
  const hold = (name: string, seconds: number) => {
    beats.push({ at: round(at), pose: name, x })
    at += seconds
  }
  // A scuttle: each pixel sideways lifts a pair of legs, then sets all four down.
  const walk = (to: number, lift: number, rest: number) => {
    const dir = Math.sign(to - x)
    const side = dir < 0 ? 'L' : 'R'
    let n = 0
    while (x !== to) {
      x += dir
      hold(`walk${side}${(n % 2) + 1}`, lift)
      hold(`look${side}`, rest)
      n += 1
    }
  }
  switch (mood) {
    case 'idle':
      hold('stand', 3.2)
      hold('blink', 0.2)
      hold('stand', 2.8)
      if (reach >= 2) walk(reach, 0.22, 0.34)
      hold('stand', 1.8)
      hold('lookR', 2.6)
      hold('blink', 0.2)
      hold('lookR', 1.4)
      hold('stand', 1.6)
      if (reach >= 2) walk(0, 0.22, 0.34)
      hold('stand', 2.4)
      break
    case 'read':
      // Watching the words while Claude reads and thinks: long looks over at them, a blink, a
      // small shuffle along the sand and back.
      hold('stand', 1)
      hold('lookR', 3.2)
      hold('blink', 0.2)
      hold('lookR', 1.8)
      hold('stand', 2.2)
      if (reach >= 2) walk(Math.min(reach, 3), 0.22, 0.34)
      hold('lookR', 2.8)
      hold('stand', 1.4)
      if (reach >= 2) walk(0, 0.22, 0.34)
      hold('stand', 1.2)
      break
    case 'work':
      // One loop for the rest of a turn, glances included, so tools starting and finishing never restart it.
      hold('stand', 1.2)
      if (reach >= 2) walk(reach, 0.2, 0.26)
      hold('lookR', 1.8)
      hold('blink', 0.2)
      hold('lookR', 0.8)
      hold('stand', 0.8)
      if (reach >= 2) walk(0, 0.2, 0.26)
      hold('stand', 0.8)
      hold('lookR', 1.4)
      hold('stand', 0.8)
      break
    case 'high':
      hold('lookR', 3.4)
      hold('blink', 0.2)
      hold('lookR', 2.2)
      hold('stand', 1.8)
      break
    case 'nap':
      hold('stand', 1)
      break
  }

  return { beats, period: round(at) }
}

function round(seconds: number): number {
  return Math.round(seconds * 100) / 100
}

function keyframes(name: string, period: number, beats: Beat[], value: (beat: Beat) => string): string {
  const stops = beats.map(beat => `${pct(beat.at / period)}{${value(beat)}}`)
  const last = beats[beats.length - 1]
  if (last !== undefined) stops.push(`100%{${value(last)}}`)

  return `@keyframes ${name}{${stops.join('')}}`
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100_000) / 1000}%`
}

// ── The diorama ────────────────────────────────────────────────────────────────

// Where the water starts, and where he stands when the loop starts (by the shell for a nap, at the
// water's edge when the tide is high), and how far he strolls from there: up to strollReach on the
// sand the tide leaves.
function layout(scene: Scene): { shore: number; start: number; roam: number; span: number } {
  const { mood, width } = scene
  const shore = width - water(scene.tide, width)
  const span = Math.max(0, shore - 1 - SPRITE_W - HOME)
  const start = mood === 'nap' ? HOME : mood === 'high' ? HOME + span : HOME + Math.min(1, span)
  const roam = mood === 'high' ? 0 : Math.min(strollReach(width), Math.max(0, span - (start - HOME)))

  return { shore, start, roam, span }
}

/** How far he strolls out at most: 10 units on the 64-unit beach, and a unit more for every 4 a wider beach adds. */
function strollReach(width: number): number {
  return 10 + Math.max(0, Math.floor((width - WIDE) / 4))
}

/**
 * Petting him on the desktop: a heart beside him, drawn over the diorama while a pointer rests on
 * the beach. The diorama is an image (an interactive frame blanks for a frame or two each time its
 * source changes), and an image takes no hover, so the heart is a picture of its own, the diorama's
 * size with a row of sky above it, parked across the band's bottom edge until its hover lays it
 * over him (see HEART_PARKED). Both images run on the page's one clock from the same render, so the
 * heart walks his walk step for step: the loop and the lead to it, held where a still frame holds
 * him, handed over from his walk home to its place over him as he curls up.
 */
function petHeart(scene: Scene): string {
  const base = ['.heart{transform-box:fill-box;transform-origin:center}']
  const motion: string[] = []
  let drawn: string
  if (scene.mood === 'nap') {
    const { beats, intro } = napLead(scene.from ?? 0)
    const isWalking = !scene.still && scene.curled !== true
    let walking = ''
    if (isWalking) {
      // The heart rides his walk home beside his claw, and is handed over where it stood as he curls
      // up, drifting over him to its place above his head: one heart all the while.
      const glide = 0.7
      const pop = round(intro + glide)
      const [dx, dy] = [round(WALK_HEART[0] - NAP_HEART[0]), round(WALK_HEART[1] - NAP_HEART[1])]
      base.push('.sleepy{opacity:0}.napheart{transform-box:fill-box;transform-origin:center}')
      motion.push(
        `.sleepy{animation:hide ${intro}s step-end 1 both}@keyframes hide{0%{opacity:1}100%{opacity:0}}`,
        `.homeward{animation:homeward ${intro}s step-end 1 both}`,
        keyframes('homeward', intro, beats, beat => `transform:translateX(${beat.x}px)`),
        `.napheart{animation:napheart ${pop}s linear 1 both}@keyframes napheart{0%{transform:translate(${dx}px,${dy}px) scale(0);animation-timing-function:step-end}${pct(intro / pop)}{transform:translate(${dx}px,${dy}px) scale(1);animation-timing-function:ease-in-out}100%{transform:translate(0,0) scale(1)}}`,
      )
      walking = `<g class="sleepy"><g class="homeward">${heart(...WALK_HEART)}</g></g>`
    }
    drawn = `<g transform="translate(${HOME} ${TOP})">${walking}<g class="napheart">${heart(...NAP_HEART)}</g></g>`
  } else {
    const { start, roam } = layout(scene)
    const { beats, period } = choreography(scene.mood, roam)
    const lead = scene.still ? { beats: [], length: 0, dx: 0 } : leadOf(scene)
    const delay = round(lead.length - (scene.phase ?? 0))
    const walks = [`walk ${period}s step-end ${delay}s infinite both`]
    if (lead.dx !== 0) {
      walks.push(`lead ${lead.length}s step-end 0s 1 none`)
      motion.push(keyframes('lead', lead.length, lead.beats, beat => `transform:translateX(${beat.x}px)`))
    }
    motion.push(`.walk{animation:${walks.join(',')}}`, keyframes('walk', period, beats, beat => `transform:translateX(${beat.x}px)`))
    const stood = scene.still ? stillDx(scene) : 0
    if (stood !== 0) base.push(`.walk{transform:translateX(${stood}px)}`)
    // A cheer's sparkle stands where the heart would: the heart goes up and over it.
    const at = scene.moment === 'cheer' ? CHEER_HEART : WALK_HEART
    drawn = `<g transform="translate(${start} ${TOP})"><g class="walk">${heart(...at)}</g></g>`
  }
  // A slow, soft beat, so the heart a hover shows is alive rather than sitting still; it shows at
  // once, with no pop (only the nap's hand-over scales one in). Never faded, as every heart here.
  motion.push('.heart{animation:beat 1.6s ease-in-out infinite}@keyframes beat{0%,50%,100%{transform:scale(1)}20%{transform:scale(1.14)}}')
  const css = scene.still ? base.join('') : `${base.join('')}@media (prefers-reduced-motion:no-preference){${motion.join('')}}`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-PAD_PX - ROW_PX} ${scene.width * U} ${FRAME_PX + ROW_PX}" width="${scene.width * U}" height="${FRAME_PX + ROW_PX}">`,
    `<style>${css}</style>`,
    `<g transform="scale(${U})">${drawn}</g></svg>`,
  ].join('')
}

// The source has two parts: a still frame (what a person who prefers reduced motion sees, and
// what `/band still` draws), and the motion, which only plays where no one asked for less.
function diorama(scene: Scene): string {
  const { mood, still } = scene
  const { start, roam } = layout(scene)
  const base: string[] = []
  const motion: string[] = []
  // The moment and the walk to the loop's start (none in a still frame, which is one pose).
  const lead = mood === 'nap' || still ? { beats: [], length: 0, dx: 0 } : leadOf(scene)
  const moment = scene.moment

  const parts: string[] = []
  const clock = (scene.sea ?? CALM_SEA).clock
  parts.push(scene.night ? nightSky(scene, clock, base, motion) : daySky(scene, clock, base, motion))
  parts.push(sand(scene.width))
  const shade = umbrella(scene)
  parts.push(shade.under)
  parts.push(castle(scene, clock, base, motion))
  parts.push(shade.over)
  parts.push(starfish(scene))
  parts.push(shell())
  parts.push(fish(scene, layout(scene).shore, clock, base, motion))
  const { water, spray } = sea(scene, base, motion)
  parts.push(water)
  parts.push(boat(scene, clock, base, motion))

  if (mood === 'nap') {
    parts.push(nap(!still, scene.from ?? 0, scene.curled === true, zLead(scene), base, motion))
  } else {
    const { beats, period } = choreography(mood, roam)
    const loopNames = [...new Set(beats.map(beat => beat.pose))]
    const first = beats[0]?.pose ?? 'stand'
    const isCheer = moment === 'cheer'
    // The pose a still frame holds through a moment: arms up for a cheer (its spin is never drawn),
    // eyes shut with the wave at his feet for a splash.
    const held = isCheer ? 'up' : moment === 'splash' ? 'splash' : null
    const leadBeats = still && held !== null ? [{ at: 0, pose: held, x: 0 }] : lead.beats
    const leadNames = [...new Set(leadBeats.map(beat => beat.pose))].filter(name => !loopNames.includes(name))
    // A frame that carries on the last one's walk opens that far into its loop (a negative delay).
    const delay = round(lead.length - (scene.phase ?? 0))

    // The still frame: the moment's held pose, else the loop's first. Where motion plays, the held
    // pose shows only while the moment's own animation does, then the loop has him.
    base.push(`.pose{opacity:0}.p-${held ?? first}{opacity:1}`)
    if (held !== null) motion.push(`.p-${held}{opacity:0}.p-${first}{opacity:1}`)
    // Where he stands: the lead's place and walk (listed last, it wins while it plays), then the loop's.
    const walks = [`walk ${period}s step-end ${delay}s infinite both`]
    if (lead.dx !== 0) {
      walks.push(`lead ${lead.length}s step-end 0s 1 none`)
      motion.push(keyframes('lead', lead.length, lead.beats, beat => `transform:translateX(${beat.x}px)`))
    }
    motion.push(`.walk{animation:${walks.join(',')}}`)
    motion.push(keyframes('walk', period, beats, beat => `transform:translateX(${beat.x}px)`))
    for (const name of [...loopNames, ...leadNames]) {
      const runs: string[] = []
      if (loopNames.includes(name)) {
        runs.push(`v-${name} ${period}s step-end ${delay}s infinite both`)
        motion.push(keyframes(`v-${name}`, period, beats, beat => `opacity:${beat.pose === name ? 1 : 0}`))
      }
      if (lead.length > 0) {
        // Listed last, the lead wins while it plays; it leaves no fill behind, so the loop
        // takes over on the very same frame and the beach is never empty at the handoff.
        runs.push(`m-${name} ${lead.length}s step-end 0s 1 none`)
        motion.push(keyframes(`m-${name}`, lead.length, lead.beats, beat => `opacity:${beat.pose === name ? 1 : 0}`))
      }
      motion.push(`.p-${name}{animation:${runs.join(',')}}`)
    }
    const poses = [...loopNames, ...leadNames].map(name => `<g class="pose p-${name}">${frame(name)}</g>`).join('')
    // The cheer's sparkles stand where he cheers. A still frame holds him (and them) where he stood.
    if (isCheer && lead.dx !== 0) motion.push(`.at{transform:translateX(${lead.dx}px)}`)
    const stood = still ? stillDx(scene) : 0
    if (stood !== 0) base.push(`.walk${isCheer ? ',.at' : ''}{transform:translateX(${stood}px)}`)
    const spark = isCheer ? `<g class="at">${sparkles(INTRO.cheer, base, motion)}</g>` : ''
    // He hops for joy as his arms go up (twice, as the hearth's Clawd does): his own little jump, so
    // the sparkles stay where they popped up.
    if (isCheer) motion.push(hop(INTRO.cheer))
    parts.push(`<g transform="translate(${start} ${TOP})"><g class="walk clawd">${shadow()}<g class="hop">${poses}</g></g>${spark}</g>`)
  }

  parts.push(spray)

  base.push('.clawd{shape-rendering:crispEdges}.shadow{transform-box:fill-box;transform-origin:center}')

  const css = still ? base.join('') : `${base.join('')}@media (prefers-reduced-motion:no-preference){${motion.join('')}}`

  return [
    // The tide it draws, in 5% steps, for anyone reading the source (the alt text says it in words).
    // The view is in whole pixels, the picture drawn in units of exactly three (one Clawd pixel), so
    // every edge lands on a pixel: the 54 px picture sits in the 64 px frame, 5 px from its top.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-PAD_PX} ${scene.width * U} ${FRAME_PX}" width="${scene.width * U}" height="${FRAME_PX}" data-tide="${scene.tide}"${scene.moment === 'splash' ? ` data-wave="${scene.wave}"` : ''}>`,
    `<style>${css}</style>`,
    `<g transform="scale(${U})">`,
    ...parts,
    '</g></svg>',
  ].join('')
}

// How many units the water covers: a strip of open sea, then the shore in proportion to the context used.
function water(tide: number, width: number): number {
  const shore = width - SHORE_START - OPEN_SEA

  return OPEN_SEA + Math.round((tide / 100) * shore)
}

// The sand's gentle rise and fall, drawn for the wide diorama and stretched to a narrower one.
function sand(width: number): string {
  const x = (n: number) => round((n * width) / WIDE)
  const top = `M0 ${GROUND + 0.3}C${x(12)} ${GROUND - 0.5} ${x(22)} ${GROUND + 0.1} ${x(34)} ${GROUND - 0.1}S${x(56)} ${GROUND + 0.4} ${width} ${GROUND}`

  // A narrower beach squeezes the 64-unit beach's four grains in; a wider one sows them again every 64 units.
  const grains: Array<[number, number]> = [[9, 16.2], [21, 15.4], [30, 16.6], [41, 15.8]]
  const sown = width <= WIDE ? grains.map(([at, y]): [number, number] => [x(at), y]) : grains.flatMap(([at, y]) => Array.from({ length: Math.ceil(width / WIDE) }, (_, k): [number, number] => [at + k * WIDE, y]).filter(([at]) => at < width - 2))

  return [
    `<clipPath id="sand"><path d="${top}V${H}H0Z"/></clipPath>`,
    `<path d="${top}V${H}H0Z" fill="${SAND}"/>`,
    `<path d="${top}" fill="none" stroke="${SAND_EDGE}" stroke-width=".35"/>`,
    ...sown.map(([at, y]) => `<rect x="${round(at)}" y="${y}" width=".6" height=".6" fill="${SAND_EDGE}"/>`),
  ].join('')
}

/**
 * Where the starfish a compaction left lies, in units from the diorama's left: at the tide's edge as
 * it stood before (the scene's `treasure`), when that is on the sand the water has left, a unit or
 * more from it. Null with none, or none to see.
 */
function starfishAt(scene: Scene): number | null {
  if (scene.treasure === null) {
    return null
  }
  const at = scene.width - water(scene.treasure, scene.width) + 0.8

  return at < layout(scene).shore - 1.5 && at > HOME + 1 ? at : null
}

// The starfish: Claude's own clay, five round arms on the sand face, a little tipped. It lies in the
// sand, before the sea and him, so the tide washes over it and he walks in front of it.
function starfish(scene: Scene): string {
  const x = starfishAt(scene)
  if (x === null) {
    return ''
  }
  const y = GROUND + 1.7
  const points = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 === 0 ? 1.45 : 0.62
    const a = (Math.PI / 5) * i - Math.PI / 2
    return `${round(x + r * Math.cos(a))} ${round(y + r * Math.sin(a))}`
  })

  return `<path class="starfish" d="M${points.join('L')}Z" fill="${CLAY}" stroke="${CLAY}" stroke-width=".35" stroke-linejoin="round" transform="rotate(14 ${round(x)} ${round(y)})"/>`
}

// Night's moon and stars: a warm gold that reads on both pages, low in the sky over the sea, behind
// everything (he walks in front of them). The stars twinkle each at its own pace, shrinking to a
// glint and back, never fading (a half-faded star is a smudge on the dark page); still, they shine.
// They keep time by the sea's clock, so a new frame never snaps one back mid-twinkle.
const MOON = '#E2B65A'
const STARLIGHT = '#E9C77E'
// The sun's glints on the water by day.
const SUNLIGHT = '#FFFFFF'

function nightSky(scene: Scene, clock: number, base: string[], motion: string[]): string {
  const { width } = scene
  // A crescent: a disc less a disc, opening toward the sea, tipped a little. It crosses the sky
  // through the night (see skyAt), in front of the stars it passes.
  const { x: mx, y: my } = skyAt(width, scene.sky, true)
  const r = 1.9
  const moon =
    `<path class="moon" d="M${mx} ${round(my - r)}A${r} ${r} 0 1 0 ${mx} ${round(my + r)}A${round(r * 1.25)} ${round(r * 1.25)} 0 0 1 ${mx} ${round(my - r)}Z" ` +
    `fill="${MOON}" transform="rotate(-22 ${mx} ${my})"/>`
  // [from the right edge, height, size, its twinkle's period and where in it the sea's clock starts,
  // in seconds]. Each period divides the clock's wrap (CLOCK_WRAP), so it goes on in step across it.
  const places: Array<[number, number, number, number, number]> = [
    [11.5, 1.2, 0.62, 4.5, 1.3],
    [16.5, 5.4, 0.48, 6, 3.9],
    [3.4, 7.2, 0.44, 3.6, 0.4],
    [21.5, 2.6, 0.4, 6.3, 2.2],
  ]
  base.push('.twinkle{transform-box:fill-box;transform-origin:center}')
  motion.push('@keyframes twinkle{0%,100%{transform:scale(1)}45%{transform:scale(.3)}60%{transform:scale(1.15)}}')
  const stars = places.flatMap(([from, y, size, period, phase], i) => {
    if (width - from <= 2) {
      return []
    }
    motion.push(`.twinkle${i}{animation:twinkle ${period}s ease-in-out -${roundMs((clock + phase) % period)}s infinite}`)
    return [star(round(width - from), y, size, i, `twinkle twinkle${i}`, STARLIGHT)]
  })
  // A wider beach's sky has stars all the way over the sand: one every 13 units or so, each at its
  // own height above his head and its own pace, left of the moon's.
  if (width > WIDE) {
    const heights = [1, 2.9, 0.5, 2.2, 3.2, 1.6, 0.8, 2.6]
    const sizes = [0.36, 0.3, 0.42, 0.32, 0.28, 0.38]
    const periods = [4.5, 6, 3.6, 6.3, 5.25, 7, 4.2]
    for (let k = 0, x = 5; x < width - 27; k++, x += 13) {
      const i = places.length + k
      const period = periods[k % periods.length] ?? 6
      motion.push(onClock(`twinkle${i}`, 'twinkle', period, (k * 1.7) % period, clock))
      stars.push(star(round(x + ((k * 5) % 4)), heights[k % heights.length] ?? 1, sizes[k % sizes.length] ?? 0.3, i, `twinkle twinkle${i}`, STARLIGHT))
    }
  }
  // Now and then, on a sky wide enough, a shooting star: once every 42 s it streaks down across the
  // sky over the sand in two thirds of a second, growing from its head and shrinking back into it.
  if (width >= SCENIC) {
    const [x0, y0, period] = [round(width * 0.36), 0.9, 42]
    const at = (seconds: number) => pct(seconds / period)
    base.push('.meteor{transform-box:fill-box;transform-origin:right bottom;transform:scale(0)}')
    motion.push(
      `@keyframes meteor{0%,${at(40)}{transform:translate(0,0) scale(0)}${at(40.12)}{transform:translate(.6px,.18px) scale(1)}` +
        `${at(40.55)}{transform:translate(6px,1.8px) scale(1)}${at(40.7)},100%{transform:translate(7.4px,2.2px) scale(0)}}`,
    )
    motion.push(onClock('meteor', 'meteor', period, 23, clock, 'linear'))
    stars.push(`<path class="meteor" d="M${x0} ${y0}l-3.6 -1.1l.12 -.3z" fill="${STARLIGHT}"/>`)
  }

  return `<g class="sky">${stars.join('')}${moon}</g>`
}

// ── The wide beach's scenery ───────────────────────────────────────────────────

/** The beach a sandcastle needs, in units: a band of 71 columns beside a folder and the model, about 92 beside a branch and a count. */
const SCENIC = 72
/** The beach a beach umbrella needs, in units: a band of 91 columns beside a folder and the model, about 112 beside a branch and a count. */
const SUNNY = 112
/** The sky that holds a third cloud, in units: a band of 123 columns beside a folder and the model, about 144 beside a branch. */
const ROOMY = 176
/** The answered turns at which the sandcastle gains a piece: a mound, a tower, a wall and a second tower, a door, windows, a flag. */
const CASTLE_TURNS = [1, 2, 3, 5, 8, 13]
/** Where the sandcastle stands, in units: just past his place by the shell, so his strolls pass in front of it. */
const CASTLE_AT = HOME + SPRITE_W + 4
// The sandcastle's shaded side and openings, between the dry sand and its edge.
const SAND_SHADE = '#D6B582'
// The sun by day: a soft gold, as the moon is by night.
const SUN = '#F0C35B'
// Clouds: pale on top, a shade bluer underneath, so they read as clouds on the light page and the dark;
// as the sun rises and sets, a peach glow underneath and a blush on top.
const CLOUD = '#DFE6EC'
const CLOUD_UNDER = '#C3D0DB'
const CLOUD_GLOW = '#EDB99B'
const CLOUD_BLUSH = '#F3D9CB'
// The sun's glints on the water as it rises and sets: a warm gold in place of midday's white.
const SUNSET_GLINT = '#F6C27A'
// Gulls: a soft slate stroke that reads on both pages.
const GULL = '#71808F'
// Driftwood, for a mast and the umbrella's pole; a deeper clay for a hull and a rim.
const MAST = '#7A4E37'
const CLAY_DEEP = '#B65D40'
// Cream, for a sail and the umbrella's panels, rimmed so it keeps an edge on the light page.
const CREAM = '#F7F1E8'
const SAIL_EDGE = '#9DB4C7'

/** How built the sandcastle is (0 to 6) after `turns` answered turns, on a beach wide enough for one. */
export function castleStage(turns: number, width: number): number {
  return width < SCENIC ? 0 : CASTLE_TURNS.filter(at => turns >= at).length
}

/** A loop on the sea's clock: `period` divides its wrap (CLOCK_WRAP), so it goes on in step across it and a new frame never restarts it. */
function onClock(name: string, keyframesName: string, period: number, phase: number, clock: number, ease = 'ease-in-out'): string {
  return `.${name}{animation:${keyframesName} ${period}s ${ease} -${roundMs((clock + phase) % period)}s infinite}`
}

/** How high the sun and the moon ride, in units from the top: low over the sand and the sea at either end of their crossing, high at midday or midnight. */
const SKY_LOW = 8.6
const SKY_HIGH = 1.4
// The sun as it rises and sets: a deeper, warmer gold than its midday one.
const SUNSET = '#EE9A57'

/**
 * Where the sun stands by day, and the moon by night, on a beach `width` units wide, `step` steps
 * into the day or the night (see skyStepAt): up from over the sand past where he strolls (and past
 * the umbrella), high at midday or midnight, and down over the sea. `low`: how near the sand and the
 * sea it hangs, 0 overhead to 1 at either end. The narrow beach's sky is too small to cross: its moon
 * hangs over the sea all night.
 */
function skyAt(width: number, step: number, night: boolean): { x: number; y: number; low: number } {
  if (width < WIDE) {
    return { x: width - 6, y: 2.2, low: 0 }
  }
  const f = Math.min(1, Math.max(0, (step + 0.5) / skySteps(night)))
  const from = width >= SUNNY ? umbrellaAt(width) + 10 : HOME + 1 + SPRITE_W + strollReach(width) + 4
  const high = Math.sin(Math.PI * f)

  return { x: round(from + (width - 5 - from) * f), y: round(SKY_LOW - (SKY_LOW - SKY_HIGH) * high), low: round(1 - high) }
}

// Between two colors (#RRGGBB), `t` of the way from the first to the second.
function mixHex(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  const mixed = [0, 1, 2].map(i => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t))

  return `#${mixed.map(n => n.toString(16).padStart(2, '0').toUpperCase()).join('')}`
}

/**
 * The sky by day: the sun crossing it by the person's own clock (see skyAt), a warmer gold and a
 * little larger as it rises and sets, and a few small clouds, each in its own place in the sky past
 * where he strolls, swaying a little back and forth on the sea's clock. Then now and then a pair of
 * gulls. Behind everything; still, the clouds hang where they are.
 */
function daySky(scene: Scene, clock: number, base: string[], motion: string[]): string {
  const { width } = scene
  if (width < WIDE) {
    return ''
  }
  const { x, y, low } = skyAt(width, scene.sky, false)
  const sun = `<circle class="sun" cx="${x}" cy="${y}" r="${round(1.45 + 0.4 * low)}" fill="${mixHex(SUN, SUNSET, low * low)}"/>`
  // [left end, height, size, its sway's period and where in it the sea's clock starts, in seconds]
  const open = HOME + 1 + SPRITE_W + strollReach(width)
  const all: Array<[number, number, number, number, number]> = [
    [open + (width - open) * 0.3, 0.5, 0.8, 63, 11],
    [open + (width - open) * 0.66, 2.8, 0.62, 126, 70],
    [open + (width - open) * 0.88, 0.2, 0.7, 42, 30],
  ]
  const clouds = all.slice(0, width >= ROOMY ? 3 : 2)
  motion.push('@keyframes sway{0%,100%{transform:translateX(-1.2px)}50%{transform:translateX(1.2px)}}')
  const drawn = clouds.map(([cx, cy, size, period, phase], i) => {
    motion.push(onClock(`cloud${i}`, 'sway', period, phase, clock))
    return `<g class="cloud cloud${i}">${cloudShape(round(cx), cy, size, low * low)}</g>`
  })

  return `<g class="sky">${sun}${drawn.join('')}${gulls(scene, clock, base, motion)}</g>`
}

// A soft cloud whose left end is at (x, y): three puffs on a flat base, a bluer underside, `glow` of
// the way to sunrise's and sunset's peach.
function cloudShape(x: number, y: number, size: number, glow: number): string {
  const s = (n: number) => round(n * size)
  const puffs = [
    [s(2.2), s(1.6), s(1.5)],
    [s(4.3), s(1.0), s(2.0)],
    [s(6.6), s(1.7), s(1.4)],
  ]
  const body = puffs.map(([cx, cy, r]) => `<circle cx="${round(x + (cx ?? 0))}" cy="${round(y + (cy ?? 0))}" r="${r}"/>`).join('')
  const flat = `<rect x="${round(x + s(0.8))}" y="${round(y + s(1.6))}" width="${s(7.4)}" height="${s(1.6)}" rx="${s(0.8)}"/>`

  return `<g fill="${mixHex(CLOUD_UNDER, CLOUD_GLOW, glow)}" transform="translate(0 ${s(0.35)})">${flat}</g><g fill="${mixHex(CLOUD, CLOUD_BLUSH, glow)}">${body}${flat}</g>`
}

/**
 * Now and then a pair of gulls flies over the beach, out toward the sea: once a minute (a half wrap
 * of the sea's clock), a quarter of a minute to cross, flapping a couple of beats and gliding. Not
 * by night, and never in a still frame (a gull is a moment).
 */
function gulls(scene: Scene, clock: number, base: string[], motion: string[]): string {
  const { width } = scene
  if (scene.still || width < SCENIC) {
    return ''
  }
  const [period, cross] = [63, 15]
  const wing = 'M-1.5 .1Q-.8 -.8 0 0Q.8 -.8 1.5 .1'
  base.push('.gull{transform:translateX(-4px)}.wings{transform-box:fill-box;transform-origin:center bottom}')
  motion.push(`@keyframes fly{0%{transform:translateX(-4px)}${pct(cross / period)},100%{transform:translateX(${width + 4}px)}}`)
  motion.push('@keyframes flap{0%,36%,100%{transform:scaleY(1)}9%,27%{transform:scaleY(-.35)}18%{transform:scaleY(1.1)}}')
  // [height, size, a beat behind the first, in seconds]
  const pair: Array<[number, number, number]> = [
    [3.1, 1, 0],
    [1.7, 0.8, 1.1],
  ]

  return pair
    .map(([y, size, behind], i) => {
      motion.push(onClock(`gull${i}`, 'fly', period, 31 - behind, clock, 'linear'))
      motion.push(`.wings${i}{animation:flap 1.4s ease-in-out -${roundMs((clock + i * 0.5) % 1.4)}s infinite}`)
      return `<g class="gull gull${i}"><g transform="translate(0 ${y}) scale(${size})"><path class="wings wings${i}" d="${wing}" fill="none" stroke="${GULL}" stroke-width=".32" stroke-linecap="round" stroke-linejoin="round"/></g></g>`
    })
    .join('')
}

/**
 * His sandcastle, built up a piece at a time as turns land in this conversation (castleStage): a
 * bucket's mound, then a tower, a wall and a second tower, a door, windows, and a clay flag that
 * flutters on the sea's clock, with the bucket that built it beside it. In the beach's own sand,
 * its shaded side and openings a shade darker. It stands before the sea, so a tide that comes that
 * far laps round it, and before him, so his strolls pass in front of it.
 */
function castle(scene: Scene, clock: number, base: string[], motion: string[]): string {
  const stage = scene.castle
  if (stage === 0) {
    return ''
  }
  const x = CASTLE_AT
  const foot = GROUND + 0.5
  const block = (x0: number, top: number, w: number) =>
    `<rect x="${round(x + x0)}" y="${round(top)}" width="${round(w)}" height="${round(foot - top)}" fill="${SAND}" stroke="${SAND_EDGE}" stroke-width=".3"/>` +
    `<rect x="${round(x + x0 + w - 0.7)}" y="${round(top + 0.15)}" width=".55" height="${round(foot - top - 0.3)}" fill="${SAND_SHADE}"/>`
  const merlons = (x0: number, top: number, at: number[]) =>
    at.map(dx => `<rect x="${round(x + x0 + dx)}" y="${round(top - 0.9)}" width=".9" height="1" fill="${SAND}" stroke="${SAND_EDGE}" stroke-width=".3"/>`).join('')
  // The bucket that built it, on its side of the castle away from him: blue, with a cream rim and a handle.
  const bx = round(x + (stage >= 3 ? 11.6 : 6.4))
  const bucket =
    `<path d="M${round(bx + 0.15)} ${GROUND - 2.1}A1 1.1 0 0 1 ${round(bx + 2.05)} ${GROUND - 2.1}" fill="none" stroke="${SEA_DEEP}" stroke-width=".22"/>` +
    `<path d="M${bx} ${GROUND - 2.1}H${round(bx + 2.2)}L${round(bx + 1.85)} ${round(GROUND + 0.45)}H${round(bx + 0.35)}Z" fill="${SEA}"/>` +
    `<rect x="${round(bx - 0.1)}" y="${GROUND - 2.3}" width="2.4" height=".5" rx=".2" fill="${FOAM}"/>`
  const pole = x + 2.4
  // Each piece and the stage that adds it, back to front: the wall and the second tower stand behind
  // the first tower, and the mound gives way to it.
  const pieces: Array<[number, string]> = [
    [1, stage === 1 ? `<path d="M${x} ${foot}L${round(x + 0.9)} ${GROUND - 2.4}H${round(x + 4.1)}L${x + 5} ${foot}Z" fill="${SAND}" stroke="${SAND_EDGE}" stroke-width=".3" stroke-linejoin="round"/>` : ''],
    [3, block(4.4, GROUND - 2, 3) + merlons(4.4, GROUND - 2, [0.3, 1.7]) + block(7.2, GROUND - 3.2, 3) + merlons(7.2, GROUND - 3.2, [0, 2.1])],
    [2, block(0.3, GROUND - 4, 4.2) + merlons(0.3, GROUND - 4, [0, 1.65, 3.3])],
    [4, `<path d="M${round(x + 5.3)} ${foot}V${round(GROUND - 0.9)}A.6 .6 0 0 1 ${round(x + 6.5)} ${round(GROUND - 0.9)}V${foot}Z" fill="${WET}"/>`],
    [5, `<rect x="${round(x + 2)}" y="${round(GROUND - 2.9)}" width=".8" height=".9" fill="${WET}"/><rect x="${round(x + 8.3)}" y="${round(GROUND - 2.2)}" width=".8" height=".8" fill="${WET}"/>`],
    [
      6,
      `<path d="M${round(pole)} ${round(GROUND - 4.9)}V${round(GROUND - 7.6)}" stroke="${MAST}" stroke-width=".25"/>` +
        `<g class="flag"><path d="M${round(pole)} ${round(GROUND - 7.6)}L${round(pole + 2.1)} ${round(GROUND - 7)}L${round(pole)} ${round(GROUND - 6.4)}Z" fill="${CLAY}"/></g>`,
    ],
    [1, bucket],
  ]
  if (stage >= 6) {
    base.push('.flag{transform-box:fill-box;transform-origin:left center}')
    motion.push('@keyframes flutter{0%,100%{transform:scaleX(1)}50%{transform:scaleX(.8)}}')
    motion.push(onClock('flag', 'flutter', 2.1, 0.4, clock))
  }
  // The piece this turn built pops up out of the sand as his arms go up, with a little bounce.
  if (scene.built) {
    base.push('.built{transform-box:fill-box;transform-origin:center bottom}')
    motion.push(`@keyframes build{0%{transform:scale(0)}55%{transform:scale(1.18)}100%{transform:scale(1)}}.built{animation:build .5s ease-out ${round(ARMS_UP_S)}s 1 both}`)
  }
  const drawn = pieces
    .filter(([at, svg]) => at <= stage && svg !== '')
    .map(([at, svg]) => (scene.built && at === stage ? `<g class="built">${svg}</g>` : svg))

  return `<g class="castle">${drawn.join('')}</g>`
}

/** Where the beach umbrella's pole stands, in units: midway between the farthest he strolls and the water's edge at 40% context. */
function umbrellaAt(width: number): number {
  return Math.round((HOME + 1 + SPRITE_W + strollReach(width) + width - water(40, width)) / 2)
}

/**
 * A beach umbrella on a wide beach, past where he strolls: clay and cream panels, rimmed in a deeper
 * clay, on a driftwood pole, with a striped towel in its shade. Its shade and towel lie on the sand
 * (`under`, before him and the sea), the umbrella stands over them (`over`). A tide that comes up to
 * it has had it packed away: there is none while the calm water reaches its shade.
 */
function umbrella(scene: Scene): { under: string; over: string } {
  const x = umbrellaAt(scene.width)
  const [top, rim, half] = [2.6, 5.9, 7]
  if (scene.width < SUNNY || layout(scene).shore < x + half + 1.5) {
    return { under: '', over: '' }
  }
  // The rim's points, right to left: five panels, clay at the middle and the edges.
  const edges = [half, 4.2, 1.4, -1.4, -4.2, -half].map(dx => round(x + dx))
  const dome = `M${round(x - half)} ${rim}C${round(x - half + 0.5)} ${round(top + 0.8)} ${round(x - 3.2)} ${top} ${x} ${top}C${round(x + 3.2)} ${top} ${round(x + half - 0.5)} ${round(top + 0.8)} ${round(x + half)} ${rim}`
  const scallops = edges.slice(1).map((e, i) => `Q${round(((edges[i] ?? x) + e) / 2)} ${round(rim + 0.85)} ${e} ${rim}`).join('')
  const canopy = `${dome}${scallops}Z`
  const panels = edges.slice(1).map((e, i) => `<path d="M${x} ${top - 1}L${edges[i]} ${rim + 1.2}L${e} ${rim + 1.2}Z" fill="${i % 2 === 0 ? CLAY : CREAM}"/>`)
  const towel = [0, 1, 2, 3].map(k => `<rect x="${round(x - 5.4 + k * 2.2)}" y="${GROUND + 0.95}" width=".9" height="1.25" fill="${CREAM}"/>`).join('')

  return {
    under:
      `<g class="towel"><rect x="${round(x - 6.2)}" y="${GROUND + 0.95}" width="9.6" height="1.25" rx=".25" fill="${SEA}"/>${towel}` +
      `<ellipse cx="${round(x + 0.8)}" cy="${round(GROUND + 0.6)}" rx="6.4" ry=".7" fill="${SHADOW}"/></g>`,
    over:
      `<g class="umbrella"><path d="M${x} ${top}V${round(GROUND + 0.8)}" stroke="${MAST}" stroke-width=".34"/>` +
      `<clipPath id="canopy"><path d="${canopy}"/></clipPath><g clip-path="url(#canopy)">${panels.join('')}</g>` +
      `<path d="${canopy}" fill="none" stroke="${CLAY_DEEP}" stroke-width=".25" stroke-linejoin="round"/>` +
      `<circle cx="${x}" cy="${round(top - 0.3)}" r=".38" fill="${CLAY_DEEP}"/></g>`,
  }
}

/**
 * Now and then a little fish leaps out of the open sea and dives back in: once every 42 seconds on
 * the sea's clock, an arc of a second, out where the water is wide enough on a beach of 64 units or
 * more. It swims behind the water, so the sea hides it until it leaps. Never in a still frame.
 */
function fish(scene: Scene, shore: number, clock: number, base: string[], motion: string[]): string {
  const { width } = scene
  if (scene.still || width < WIDE || width - shore < 24) {
    return ''
  }
  const x = round(shore + (width - shore) * 0.46)
  const y = GROUND + 0.4
  const [period, from, length, high] = [42, 20, 1.1, 4.2]
  const at = (s: number) => pct((from + s) / period)
  // Across at an even pace, up and over and down again: an arc, tipping nose up, level, nose down.
  base.push('.fishy{transform-box:fill-box;transform-origin:center}')
  motion.push(`@keyframes fishx{0%,${at(0)}{transform:translateX(0)}${at(length)},100%{transform:translateX(4px)}}`)
  motion.push(
    `@keyframes fishy{0%,${at(0)}{transform:translateY(0) rotate(-50deg);animation-timing-function:cubic-bezier(.2,.7,.5,1)}` +
      `${at(length / 2)}{transform:translateY(-${high}px) rotate(0);animation-timing-function:cubic-bezier(.5,0,.8,.3)}${at(length)},100%{transform:translateY(0) rotate(50deg)}}`,
  )
  motion.push(onClock('fishx', 'fishx', period, 5, clock, 'linear'))
  motion.push(onClock('fishy', 'fishy', period, 5, clock, 'linear'))
  const body = `M${round(x - 0.9)} ${y}Q${x} ${round(y - 0.75)} ${round(x + 0.9)} ${y}Q${x} ${round(y + 0.75)} ${round(x - 0.9)} ${y}Z`
  const tail = `M${round(x - 0.7)} ${y}L${round(x - 1.5)} ${round(y - 0.55)}V${round(y + 0.55)}Z`

  return `<g class="fishx"><g class="fishy"><path d="${body}${tail}" fill="${SEA_DEEP}"/></g></g>`
}

/**
 * A little sailboat far out on the open sea, bobbing on the swell on the sea's clock: a clay hull, a
 * mast of driftwood, cream sails rimmed in blue, a clay pennant, and by night a lantern at its
 * masthead. It floats on the water's top past the shore's shoulder, so no tide beaches it, and stays
 * put when a splash's surge runs in.
 */
function boat(scene: Scene, clock: number, base: string[], motion: string[]): string {
  const { width, night } = scene
  if (width < WIDE) {
    return ''
  }
  const x = round(Math.max(width - 8, layout(scene).shore + 6))
  const y = GROUND - 0.9
  const parts = [
    `<path d="M${x} ${round(y - 0.3)}V${round(y - 5.8)}" stroke="${MAST}" stroke-width=".25"/>`,
    `<path d="M${round(x + 0.25)} ${round(y - 5.5)}V${round(y - 0.8)}H${round(x + 3.1)}Z" fill="${CREAM}" stroke="${SAIL_EDGE}" stroke-width=".2" stroke-linejoin="round"/>`,
    `<path d="M${round(x - 0.25)} ${round(y - 4.7)}V${round(y - 0.8)}H${round(x - 2.5)}Z" fill="${CREAM}" stroke="${SAIL_EDGE}" stroke-width=".2" stroke-linejoin="round"/>`,
    `<path d="M${x} ${round(y - 5.8)}L${round(x + 1.2)} ${round(y - 5.45)}L${x} ${round(y - 5.1)}Z" fill="${CLAY}"/>`,
    `<path d="M${round(x - 3.3)} ${round(y - 0.4)}H${round(x + 3.5)}L${round(x + 2.5)} ${round(y + 0.9)}H${round(x - 2.4)}Z" fill="${CLAY_DEEP}"/>`,
  ]
  if (night) {
    parts.push(`<circle class="lantern" cx="${x}" cy="${round(y - 6.15)}" r=".38" fill="${STARLIGHT}"/>`)
  }
  base.push('.boat{transform-box:fill-box;transform-origin:center bottom}')
  motion.push('@keyframes bob{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(.3px) rotate(2.5deg)}}')
  motion.push(onClock('boat', 'bob', 4.5, 1.1, clock))

  return `<g class="boat">${parts.join('')}</g>`
}

function shell(): string {
  return [
    // Rimmed in its ridges' rose, so its pale pink keeps an edge against a light band.
    `<path d="M1.2 ${GROUND + 0.2}C1.4 ${GROUND - 3.4} 5.8 ${GROUND - 3.4} 6 ${GROUND + 0.2}Z" fill="${SHELL}" stroke="${SHELL_RIDGE}" stroke-width=".3" stroke-linejoin="round"/>`,
    ...[2.4, 3.6, 4.8].map(x => `<path d="M3.6 ${GROUND}L${x} ${GROUND - 2.2}" stroke="${SHELL_RIDGE}" stroke-width=".3"/>`),
    `<rect x="2.8" y="${GROUND - 0.2}" width="1.6" height=".7" rx=".3" fill="${SHELL_RIDGE}"/>`,
  ].join('')
}

// The sea: a body of water with a foamy edge, two slow crests rolling on it, and a wave that
// washes up the sand and slides back every eight seconds (right up to his feet at high tide).
// A splash is the same sea surging: the whole body, its foamy rounded front leading, runs up the
// sand to his feet and slides back, so there is never a separate sheet of water with a seam.
// Everything that moves picks up where the last frame had it (see Sea): the crests roll on, a lap
// out on the sand finishes, and the front glides from where it stood to the calm line. The spray
// is drawn apart, after Clawd, so it flies in front of the picture and never behind his head.
function sea(scene: Scene, base: string[], motion: string[]): { water: string; spray: string } {
  const { mood, width } = scene
  const { shore, start } = layout(scene)
  const carried = scene.sea ?? CALM_SEA
  const top = GROUND - 0.9
  const run = surgeRun(scene)
  // The front, from where the last frame left it to the calm line (a splash rushes on from there).
  const glide = scene.still || run > 0 ? 0 : carried.glide
  const rushFrom = run > 0 ? surgeFrom(scene) : 0
  // While it surges, or glides out from up the sand, the sea is longer on the right, so its far end
  // never comes into view.
  const far = width + 8 + Math.max(run, rushFrom, -glide, 0)
  // A rounded, foam-topped shoulder at the shore, and a front that slopes down into the sand (the
  // beach running on under the water), so a surging sea leads with a curve, not a wall.
  const body = `M${shore} ${GROUND + 0.4}C${shore + 0.8} ${top} ${shore + 1.6} ${top} ${shore + 3} ${top}H${far}V${H}H${shore + 5}C${shore + 2.6} ${H - 0.4} ${shore + 0.5} ${GROUND + 2.2} ${shore} ${GROUND + 0.4}Z`
  const crest = (y: number, from: number) => {
    let d = `M${from} ${y}`
    for (let x = from; x < far + 12; x += 6) d += 'q1.5 -.7 3 0t3 0'
    return d
  }

  // The lap: this frame's own, after the last frame's has run out when that one was a different lap.
  const own = lapOf(mood)
  const plan = carried.lap
  const laps = plan.finish === null ? [] : [`lap${plan.finish.reach} ${plan.finish.period}s ease-in-out -${plan.finish.offset}s 1`]
  laps.push(`lap${own.reach} ${own.period}s ease-in-out ${plan.start}s infinite`)
  motion.push(`.lap{animation:${laps.join(',')}}`)
  for (const reach of new Set([own.reach, plan.finish?.reach ?? own.reach])) {
    motion.push(`@keyframes lap${reach}{0%,45%,100%{transform:translateX(0)}65%,72%{transform:translateX(-${reach}px)}}`)
  }
  // The crests roll on from the sea's clock; held, they stand where it has them.
  const [at9, at14] = [roundMs(carried.clock % ROLL_S), roundMs(carried.clock % ROLL2_S)]
  base.push(`.roll{transform:translateX(-${round((6 * at9) / ROLL_S)}px)}.roll2{transform:translateX(-${round(6 * (1 - at14 / ROLL2_S))}px)}`)
  motion.push(`.roll{animation:roll ${ROLL_S}s linear -${at9}s infinite}.roll2{animation:roll ${ROLL2_S}s linear -${at14}s infinite reverse}`)
  motion.push('@keyframes roll{from{transform:translateX(0)}to{transform:translateX(-6px)}}')
  if (glide !== 0) {
    const wait = glideWait(scene)
    motion.push(`.glide{animation:glide ${glideSeconds(glide)}s ease-in-out${wait > 0 ? ` ${wait}s` : ''} 1 both}`)
    motion.push(`@keyframes glide{0%{transform:translateX(${glide}px)}100%{transform:translateX(0)}}`)
  }
  const water = [
    `<defs><clipPath id="water"><path d="${body}"/></clipPath></defs>`,
    // Damp sand where the waves have been, fading into the dry.
    // It runs on under the water's sloping front, so no edge of it ever shows.
    `<linearGradient id="damp" x1="0" x2="1"><stop offset="0" stop-color="${WET}" stop-opacity="0"/><stop offset=".6" stop-color="${WET}"/><stop offset="1" stop-color="${WET}"/></linearGradient>`,
    `<g clip-path="url(#sand)"><g class="glide"><rect x="${shore - 9}" y="${GROUND - 0.2}" width="15" height="${H - GROUND + 0.2}" fill="url(#damp)"/></g></g>`,
    `<g class="glide"><g${run > 0 ? ' class="surge"' : ''}><g class="lap">`,
    `<path d="${body}" fill="${SEA}"/>`,
    `<rect x="${shore}" y="${GROUND + 2}" width="${far - shore}" height="${H - GROUND - 2}" fill="${SEA_DEEP}" clip-path="url(#water)"/>`,
    `<g clip-path="url(#water)"><path class="roll2" d="${crest(GROUND + 1.6, shore - 6)}" fill="none" stroke="${SEA}" stroke-width=".5" opacity=".9"/>`,
    `<path class="roll" d="${crest(top + 0.15, shore - 6)}" fill="none" stroke="${FOAM}" stroke-width=".55"/>${glints(scene, shore, carried.clock, base, motion)}</g>`,
    `<path d="M${shore + 0.2} ${GROUND + 0.3}C${shore + 0.9} ${top + 0.1} ${shore + 1.6} ${top} ${shore + 3} ${top}" fill="none" stroke="${FOAM}" stroke-width=".6" stroke-linecap="round"/>`,
    `</g></g></g>`,
  ].join('')
  if (run === 0) {
    return { water, spray: '' }
  }

  // In fast, a moment at his feet, then back out, slower: 2.4 s of the splash's 2.6.
  const ease = (fn: string) => `animation-timing-function:${fn}`
  motion.push(`.surge{animation:surge ${SURGE_S}s linear 1 both}`)
  motion.push(
    `@keyframes surge{0%{transform:translateX(${rushFrom === 0 ? 0 : `-${rushFrom}px`});${ease('cubic-bezier(.25,.8,.35,1)')}}24%{transform:translateX(-${run}px);${ease('ease-in-out')}}46%{transform:translateX(-${round(run * 0.9)}px);${ease('cubic-bezier(.45,0,.4,1)')}}100%{transform:translateX(0)}}`,
  )
  // Spray off the water just beside him, a unit of sky clear of his raised claw: each drop swells up
  // out of the crest and arcs up and out to sea, the sea going back out under it, and falls back in
  // just past the calm line, where the water is by then, shrinking away as it lands. It flies at an
  // even pace outward (its own group, `dropx`) while it rises and falls (the drop), so its path is a
  // true arc, never the straight legs a single transform draws between keyframes. At full color all
  // the while (a fade, in or out, turns a drop into a slate-gray smudge on the dark page halfway
  // through). They land together, by DROPS_END_S, the later ones on a shorter hop, so no lone speck
  // is left hanging. The still frame holds the sea at his feet and the drops at the top of their arcs
  // (where motion plays, the surge and the drops' own animations take over).
  const by = start + (scene.still ? stillDx(scene) : leadOf(scene).dx) + SPRITE_W + 1.2
  // A burst of four thrown from about one point, each its own way, so they scatter rather than fly
  // in a line: [how high it flies, how far past the calm line it lands, its size, when it leaves].
  const flights: Array<[number, number, number, number]> = [
    [6.6, 0.6, 0.95, 0.4],
    [3.4, 4.6, 0.7, 0.46],
    [5, 6.8, 0.82, 0.55],
    [4.2, 2.6, 0.6, 0.62],
  ]
  base.push(`.surge{transform:translateX(-${run}px)}.drop{transform-box:fill-box;transform-origin:center}`)
  motion.push('@keyframes swell{from{scale:0}to{scale:1}}')
  const drops = flights.map(([height, past, r, leaves], i) => {
    const delay = round(leaves)
    const length = round(DROPS_END_S - delay)
    const cx = round(by + i * 0.8)
    // Where it lands: past the calm line, where the sea is by then, inside the picture.
    const out = round(Math.max(1.5, Math.min(width - 1, shore + past) - cx))
    base.push(`.dropx${i}{transform:translateX(${round(out * PEAK_AT)}px)}.drop${i}{transform:translate(0,-${height}px)}`)
    motion.push(`.dropx${i}{animation:dropx${i} ${length}s linear ${delay}s 1 both}@keyframes dropx${i}{from{transform:translateX(0)}to{transform:translateX(${out}px)}}`)
    motion.push(`.drop${i}{animation:drop${i} ${length}s ease-out ${delay}s 1 both,swell .2s ease-out ${delay}s 1 both}`)
    motion.push(
      `@keyframes drop${i}{0%{transform:translate(0,0) scale(1);animation-timing-function:cubic-bezier(.25,.6,.45,1)}${pct(PEAK_AT)}{transform:translate(0,-${height}px) scale(1);animation-timing-function:cubic-bezier(.55,0,.75,.4)}` +
        `88%{transform:translate(0,.3px) scale(.85);animation-timing-function:ease-in}100%{transform:translate(0,1px) scale(0)}}`,
    )

    return `<g class="dropx${i}"><circle class="drop drop${i}" cx="${cx}" cy="${GROUND - 1}" r="${r}" fill="${i % 2 === 0 ? SEA : DROP}"/></g>`
  })

  return { water, spray: drops.join('') }
}

/**
 * Light on the water: by day, little white glints of sun scattered over the sea; by night, gold glints
 * of moonlight in a path under the moon. Each pops up for a moment now and then, at its own pace, and
 * is gone again: a glint is a moment of light, so the still frame (and a page that asks for less
 * motion) has none. Only out on the water, clear of its front. They keep time by the sea's clock, as
 * the crests do, so a new frame never cuts one short or pops one up afresh.
 */
function glints(scene: Scene, shore: number, clock: number, base: string[], motion: string[]): string {
  const { width, night } = scene
  if (scene.still) {
    return ''
  }
  // By night they lie in a path under the moon, wherever it is over the water. By day they warm to
  // gold as the sun rises and sets.
  const moon = width - skyAt(width, scene.sky, true).x
  const { low } = skyAt(width, scene.sky, false)
  const sunlight = mixHex(SUNLIGHT, SUNSET_GLINT, low * low)
  // [from the right edge, depth below the sand line, size, period and where in it the sea's clock
  // starts, in seconds]. Each period divides the clock's wrap, as the stars' do.
  const places: Array<[number, number, number, number, number]> = night
    ? [
        [moon - 0.6, 1.1, 0.36, 4.5, 0.6],
        [moon + 0.8, 1.9, 0.3, 5.25, 2.9],
        [moon - 1.4, 2.6, 0.26, 6.3, 4.4],
      ]
    : [
        [3.2, 1.1, 0.34, 5.25, 1.2],
        [8.6, 1.9, 0.3, 6.3, 3.8],
        [13.4, 1.3, 0.32, 7.875, 5.6],
      ]
  base.push('.glint{transform-box:fill-box;transform-origin:center;transform:scale(0)}')
  motion.push('@keyframes glint{0%,64%,100%{transform:scale(0)}74%{transform:scale(1)}84%{transform:scale(.45)}92%{transform:scale(.85)}}')

  return places
    .flatMap(([from, depth, size, period, phase], i) => {
      if (width - from <= shore + 1.5 || from < 1) {
        return []
      }
      motion.push(`.glint${i}{animation:glint ${period}s ease-in-out -${roundMs((clock + phase) % period)}s infinite}`)
      return [star(round(width - from), round(GROUND + depth), size, i, `glint glint${i}`, night ? STARLIGHT : sunlight)]
    })
    .join('')
}

// How long each moment plays before the loop takes over, in seconds.
const INTRO: Record<Exclude<Moment, null>, number> = { cheer: 4.2, splash: 2.6, wake: 1.1, hello: 2 }

// The moment that plays once before the loop takes over: a spin, a splash, waking up, or hello.
function beatsOf(kind: Exclude<Moment, null>): Beat[] {
  switch (kind) {
    case 'cheer':
      return [...SPIN.map((_, i) => ({ at: round(i * 0.2), pose: `spin${i}`, x: 0 })), { at: round(SPIN.length * 0.2), pose: 'up', x: 0 }]
    case 'splash':
      // The hit, eyes shut and arms up; then, cold feet, a hop from one pair to the other while
      // the water is at them, a look round at it going back out, and he settles.
      return [
        { at: 0, pose: 'splash', x: 0 },
        { at: 0.7, pose: 'hopL', x: 0 },
        { at: 0.85, pose: 'hopR', x: 0 },
        { at: 1, pose: 'walkR1', x: 0 },
        { at: 1.15, pose: 'walkR2', x: 0 },
        { at: 1.3, pose: 'lookR', x: 0 },
      ]
    case 'wake':
      // Up from his curl with a big stretch, arms up and eyes still shut; arms down; then he opens them.
      return [
        { at: 0, pose: 'stretch', x: 0 },
        { at: 0.6, pose: 'blink', x: 0 },
      ]
    case 'hello':
      // A moment after the frame appears, one claw up, down, and up again: Claude Code's wave.
      return [
        { at: 0, pose: 'stand', x: 0 },
        { at: 0.4, pose: 'wave', x: 0 },
        { at: 1, pose: 'stand', x: 0 },
        { at: 1.3, pose: 'wave', x: 0 },
        { at: 1.9, pose: 'stand', x: 0 },
      ]
  }
}

/** When his arms go up in a cheer, after the spin (seconds). */
const ARMS_UP_S = SPIN.length * 0.2

// Two little hops of joy as his arms go up, the second a touch lower: up quick, down soft, a
// unit (three pixels) at the most, so at rest he is back on his whole pixels.
function hop(length: number): string {
  const at = (seconds: number) => pct((ARMS_UP_S + seconds) / length)
  const y = (units: number, ease: string) => `{transform:translateY(${units}px);animation-timing-function:${ease}}`
  // His shadow stays on the sand, a little smaller while he is up.
  const wide = (scale: number, ease: string) => `{transform:scaleX(${scale});animation-timing-function:${ease}}`

  return (
    `.hop{animation:hop ${length}s linear 1 both}` +
    `@keyframes hop{0%,${at(0)}${y(0, 'ease-out')}${at(0.12)}${y(-1, 'ease-in')}${at(0.26)}${y(0, 'linear')}${at(0.4)}${y(0, 'ease-out')}` +
    `${at(0.5)}${y(-0.67, 'ease-in')}${at(0.62)},100%${y(0, 'linear')}}` +
    `.shadow{animation:shadow ${length}s linear 1 both}` +
    `@keyframes shadow{0%,${at(0)}${wide(1, 'ease-out')}${at(0.12)}${wide(0.8, 'ease-in')}${at(0.26)}${wide(1, 'linear')}${at(0.4)}${wide(1, 'ease-out')}` +
    `${at(0.5)}${wide(0.86, 'ease-in')}${at(0.62)},100%${wide(1, 'linear')}}`
  )
}

/**
 * His shadow on the sand, under his feet: a soft, flat oval in a darker sand, which walks with him
 * and stays on the ground when he hops. Drawn smooth, under his crisp pixels.
 */
function shadow(): string {
  return `<ellipse class="shadow" cx="9" cy="10.35" rx="6.6" ry=".62" fill="${SHADOW}" shape-rendering="geometricPrecision"/>`
}

// Three little clay sparkles while his arms are up after the spin. Each pops up from a point,
// one a beat after another, glints once (a quick swell and a turn, as a star twinkles), and
// shrinks back to a point as the cheer ends: never faded, since a half-faded clay star on the dark
// page is a muddy brown smudge.
function sparkles(length: number, base: string[], motion: string[]): string {
  // Held in the still frame; where motion plays, each pops up in turn and shrinks away.
  base.push('.star{transform-box:fill-box;transform-origin:center}')
  ;[0, 1, 2].forEach(i => {
    const at = ARMS_UP_S + i * 0.12
    // (Only the glint turns: a list without its rotate() is read as one with rotate(0) between them.)
    const scale = (n: number, turn = 0) => `transform:scale(${n})${turn === 0 ? '' : ` rotate(${turn}deg)`}`
    motion.push(`.star${i}{animation:star${i} ${length}s linear 1 both}`)
    motion.push(
      `@keyframes star${i}{0%,${pct(at / length)}{${scale(0)}}${pct((at + 0.18) / length)}{${scale(1.2)};animation-timing-function:ease-out}` +
        `${pct((at + 0.36) / length)},${pct((at + 0.52) / length)}{${scale(1)};animation-timing-function:ease-in-out}${pct((at + 0.64) / length)}{${scale(1.25, 15)};animation-timing-function:ease-in-out}` +
        `${pct((at + 0.78) / length)},${pct((length - 0.5) / length)}{${scale(1)};animation-timing-function:ease-in}100%{${scale(0)}}}`,
    )
  })

  return `<g class="spark">${star(-2.5, 3, 1, 0)}${star(19.5, 1, 1, 1)}${star(20.5, 6.5, 0.7, 2)}</g>`
}

// A four-point sparkle centered on (x, y): the cheer's, in clay, or the night sky's, in starlight.
function star(x: number, y: number, size: number, i: number, kind = `star star${i}`, fill = CLAY): string {
  const s = size
  const p = (n: number) => round(n)
  return `<path class="${kind}" d="M${p(x)} ${p(y - 1.6 * s)}L${p(x + 0.45 * s)} ${p(y - 0.45 * s)}L${p(x + 1.6 * s)} ${p(y)}L${p(x + 0.45 * s)} ${p(y + 0.45 * s)}L${p(x)} ${p(y + 1.6 * s)}L${p(x - 0.45 * s)} ${p(y + 0.45 * s)}L${p(x - 1.6 * s)} ${p(y)}L${p(x - 0.45 * s)} ${p(y - 0.45 * s)}Z" fill="${fill}"/>`
}

function heart(x: number, y: number): string {
  // The terminal's block heart (Clawd's own pixelHeart), each of its pixels two screen pixels wide
  // and three tall: 16 by 12, the hearth's own heart, so it reads as a heart and not a squat bow.
  // Placed on whole pixels and drawn crisp wherever it stands (the sleeper's is outside his crisp
  // body), it is as sharp at 1x and 2x as he is.
  return `<g class="heart" fill="${HEART}" shape-rendering="crispEdges">${pixelHeart(x, y, 2 / U, 3 / U)}</g>`
}

// Curled up by the shell, nestled in the sand, little z's drifting up from him one after another.
// The source is the same for the whole nap (nothing in it counts time), so a redraw while he
// sleeps (a measure, a toast) hands the frame the same source and nothing restarts.
//
// He dozes off where the last loop had him (`from` pixels out on the sand): he looks home, scuttles
// back to the shell, stands there a moment with his eyes shut, then curls up. So the frame that
// takes over from the loop starts him about where he was, rather than cutting him home. A frame
// that takes over from a nap already curled up on screen (`isCurled`) opens on him curled, its z's
// `zsInto` seconds into their loop, where that nap's were.
function nap(isMoving: boolean, from: number, isCurled: boolean, zsInto: number, base: string[], motion: string[]): string {
  const { beats, intro: walk } = napLead(from)
  const intro = isCurled ? 0 : walk

  // z, Z, Z: each appears in its own place a beat after the last, the three hold together a
  // moment, then drift up and away together and the sky stays empty a while. Never sliding into
  // each other. The first comes only once he has curled up (0.2 s after), so it never lands on
  // his standing arm. Each pops up from a point and shrinks back to one as it drifts off, at full
  // color all the while, as the sparkles and the heart do: never a half-faded z, which reads as a
  // muddy slate on the dark page.
  base.push('.z{opacity:0;transform-box:fill-box;transform-origin:center}.z0{opacity:1}')
  const period = Z_PERIOD_S
  const [driftFrom, driftTo] = [5.6, 6.1]
  // Their loop's delay: it begins 1.4 s before he curls up; curled from the first frame, it opens
  // where the nap before had it (from a still nap, as that one holds them: the first z up).
  const settle = round(-zsInto)
  ;[0, 1, 2].forEach(i => {
    const shown = 1.6 + i * 0.9
    const at = (seconds: number) => pct(seconds / period)
    motion.push(`.z${i}{animation:z${i} ${period}s ease-in-out ${settle}s infinite both}`)
    motion.push(
      `@keyframes z${i}{0%,${at(shown)}{opacity:1;transform:translateY(.5px) scale(0);animation-timing-function:ease-out}${at(shown + 0.3)}{opacity:1;transform:translateY(0) scale(1.1)}${at(shown + 0.5)},${at(driftFrom)}{opacity:1;transform:translateY(0) scale(1);animation-timing-function:ease-in}${at(driftTo)},100%{opacity:1;transform:translateY(-1.2px) scale(0)}}`,
    )
  })
  const zs = [0, 1, 2].map(i => doze(HOME + 17.3 + i * 2.6, TOP + 4 - i * 1.9, 0.8 + i * 0.2, i)).join('')
  let settling = ''
  if (isMoving && !isCurled) {
    // A person who prefers reduced motion sees him curled up from the start.
    base.push('.sleepy{opacity:0}')
    motion.push(`.sleepy{animation:hide ${intro}s step-end 1 both}.curl{animation:reveal ${intro}s step-end 1 both}`)
    motion.push('@keyframes hide{0%{opacity:1}100%{opacity:0}}@keyframes reveal{0%{opacity:0}100%{opacity:1}}')
    motion.push(`.homeward{animation:homeward ${intro}s step-end 1 both}`)
    motion.push(keyframes('homeward', intro, beats, beat => `transform:translateX(${beat.x}px)`))
    const names = [...new Set(beats.map(beat => beat.pose))]
    for (const name of names) {
      motion.push(`.n-${name}{animation:n-${name} ${intro}s step-end 1 both}`)
      motion.push(keyframes(`n-${name}`, intro, beats, beat => `opacity:${beat.pose === name ? 1 : 0}`))
    }
    const poses = names.map(name => `<g class="n-${name}">${frame(name)}</g>`).join('')
    settling = `<g class="clawd sleepy"><g class="homeward">${shadow()}${poses}</g></g>`
  }

  return `<g transform="translate(${HOME} ${TOP})">${settling}<g class="clawd curl">${pixels(curled())}</g></g>${zs}`
}

// A nap's lead: the walk home from `from` pixels out, then the eyes-shut stand, in the same beats
// and poses as his loops. `intro`: how long it takes, in seconds, before he curls up.
function napLead(from: number): { beats: Beat[]; intro: number } {
  const beats: Beat[] = []
  let at = 0
  let x = from
  const hold = (pose: string, seconds: number) => {
    beats.push({ at: round(at), pose, x })
    at += seconds
  }
  if (x > 0) {
    hold('lookL', 0.4)
    for (let n = 0; x > 0; n++) {
      x -= 1
      hold(`walkL${(n % 2) + 1}`, 0.22)
      hold('lookL', 0.34)
    }
  }
  hold('blink', from > 0 ? 1 : 1.4)

  return { beats, intro: round(at) }
}

/**
 * Where a petted Clawd's heart stands, from his top left: up beside his right claw, and over him as
 * he sleeps. In whole screen pixels (thirds of a unit), so its edges fall on the pixel grid.
 */
const WALK_HEART: [number, number] = [56 / U, -2 / U]
const NAP_HEART: [number, number] = [11 / U, -11 / U]
/** In a cheer: up and to the right of WALK_HEART, clear of the sparkle beside his claw. */
const CHEER_HEART: [number, number] = [62 / U, -11 / U]

// A small z drawn as a soft stroke, so it stays smooth while it drifts.
function doze(x: number, y: number, size: number, i: number): string {
  const s = 2 * size

  return `<path class="z z${i}" d="M${round(x)} ${round(y)}h${round(s)}l-${round(s)} ${round(s)}h${round(s)}" fill="none" stroke="${DOZE}" stroke-width=".55" stroke-linecap="round" stroke-linejoin="round"/>`
}
