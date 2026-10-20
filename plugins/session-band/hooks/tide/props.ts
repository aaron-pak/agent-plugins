// The tide's props: the facts, with every line of words already written, and the desktop scene it
// last handed out.

import { NAP_AFTER_MS, SPLASH_MS, isNightAt, skyStepAt } from '../facts'
import { beachWidth, carriedPhase, dozeAt, isCurledAt, positionAt, sceneKey, sceneOf, seaAfter } from './desk'
import type { Scene } from './desk'
import type { Motion } from '../../types'
import type { BandProps, Info } from './types'
import { wordsFor } from './words'

// How long past the nap's start the desktop still trusts where its last frame had Clawd. Longer,
// and the frame was likely closed and opened again: he simply starts where the new frame starts him.
const SCENE_MEMORY_MS = 60_000
// How long a frame that waved hello keeps its source once the greeting is over (see sceneKey): a
// redraw in the session's first minute never reloads it, and a band that comes back later (a
// dialog closed) starts a plain loop rather than waving again.
const HELLO_KEPT_MS = 60_000
// How long a turn's tide stride waits before its frame reloads: a measure lands just before the turn
// does, and the cheer's frame would replace a stride's at once (two reloads in an instant).
export const STRIDE_WAIT_MS = 400

/**
 * `shownForMs`: how long this look has been on screen, or null when it has been on all along (see
 * BandProps). `isDesktop`: the words are for the page, whose font draws curly quotes the terminal
 * may not. `greetedMs`: how long ago the session's greeting began, in its first few seconds while
 * this look has been on; null after (or when this look came on later).
 */
export function bandProps(
  known: Info,
  motion: Motion,
  isWorking: boolean,
  warnAt: number,
  columns: number,
  now: number,
  shownForMs: number | null = null,
  isDesktop = false,
  greetedMs: number | null = null,
): BandProps {
  const isHigh = known.percent !== null && known.percent >= warnAt
  const pct = (n: number | null) => (n === null ? null : Math.min(100, Math.max(0, n)))

  return {
    columns,
    percent: pct(known.percent),
    turnPercent: pct(known.turnPercent),
    isWorking,
    isHigh,
    isStill: motion === 'still' || known.isCalm,
    doing: isWorking && known.activity !== null ? known.activity.kind : null,
    turnWorked: known.turnWorked,
    woke: known.woke,
    idleMs: known.lastActiveAt === null ? null : now - known.lastActiveAt,
    cheers: known.cheers,
    sinceCheerMs: known.cheeredAt === null ? null : now - known.cheeredAt,
    cheerPercent: pct(known.cheerPercent),
    oops: known.oops,
    sinceOopsMs: known.oopsAt === null ? null : now - known.oopsAt,
    oopsPercent: pct(known.oopsPercent),
    sinceSplashMs: known.splashAt === null ? null : now - known.splashAt,
    waves: known.waves,
    sinceTurnMs: known.turnAt === null ? null : now - known.turnAt,
    shownForMs,
    isAppleTerminal: known.isAppleTerminal,
    isNight: isNightAt(now),
    sky: skyStepAt(now),
    treasure: pct(known.treasurePercent),
    treasures: known.treasures,
    castle: Math.max(0, known.cheers - known.castleFrom),
    isGreeting: greetedMs !== null && known.lastTurn === null && !isWorking,
    greetedMs: greetedMs !== null && known.lastTurn === null && !isWorking ? greetedMs : null,
    words: wordsFor(known, isWorking, isHigh, now, isDesktop),
  }
}

/** A desktop scene as handed out: its key, when, and the scene (with where it started him and the sea). */
export type ShownScene = { key: string; at: number; scene: Scene }

/**
 * The desktop scene last handed out, and when: each new scene starts him where that scene's frame
 * has him (see positionAt), and the sea where it had the water (see seaAfter). A cheer or a splash
 * plays where he stood, and a new loop or a nap opens with his walk from there, so a new frame never
 * jumps him, or the sea, back to a start.
 *
 * It lives in this activation, and the hooks module keeps a copy in `$.state` (`seed` takes it up
 * again after a reload, a /config change or a respawned worker): the same scene then hands the
 * frame the very same source, so a reload that changes nothing on the beach never reloads the frame.
 *
 * `settle` says whether the scene is new (the copy to keep), and `wakeIn`: a turn's tide moved a
 * stride, and its frame waits a moment (STRIDE_WAIT_MS) in case the turn is landing, whose cheer
 * would replace it at once: draw again then.
 */
export function sceneMemory(): {
  settle: (props: BandProps, now: number) => { scene: Scene; wakeIn: number | null; isNew: boolean }
  forget: () => void
  seed: (kept: unknown) => void
  shown: () => ShownScene | null
} {
  let shownScene: ShownScene | null = null
  let strideSince: number | null = null
  let isSeeded = false
  const settle = (props: BandProps, now: number): { scene: Scene; wakeIn: number | null; isNew: boolean } => {
    const scene = sceneOf(props)
    const key = sceneKey(scene)
    const isWaveOver = shownScene !== null && shownScene.scene.moment === 'hello' && scene.moment !== 'hello' && now - shownScene.at >= HELLO_KEPT_MS
    if (shownScene !== null && shownScene.key !== key && isSplashOver(shownScene.scene, scene)) {
      // The splash's frame goes on into the turn's loop once the wave has slid back out: it stays up
      // until something else changes the beach (the turn lands, the work changes, the tide strides),
      // rather than reloading for its end and, as often as not, again a moment later for the cheer.
      return { scene: shownScene.scene, wakeIn: null, isNew: false }
    }
    // A splash's frame kept on into the work is that work's loop once the wave is back out: a stride
    // of the tide waits for it as for any working frame.
    const loop = shownScene !== null && isSplashKept(shownScene.scene, now - shownScene.at) ? { ...shownScene.scene, moment: null, wave: scene.wave } : shownScene?.scene
    if (shownScene !== null && loop !== undefined && shownScene.key !== key && isStride(loop, scene)) {
      strideSince ??= now
      const left = strideSince + STRIDE_WAIT_MS - now
      if (left > 0) {
        return { scene: shownScene.scene, wakeIn: left, isNew: false }
      }
    }
    strideSince = null
    // A step of the sky, or a starfish washed up or away, never plays a moment still on over again (a
    // cheer, a splash, the stretch up from a nap, which lasts as long as he reads): it waits for the
    // moment's own end, whose frame brings it.
    if (shownScene !== null && shownScene.key !== key && scene.moment !== null && scene.moment === shownScene.scene.moment && isBackdropStep(shownScene.scene, scene)) {
      return { scene: shownScene.scene, wakeIn: null, isNew: false }
    }
    // A step of the sky alone never reloads a frame too old for his walk to carry on from (a long
    // tool running): his loop would start over. The sky catches up with the frame's next change, and
    // nightfall and daybreak come at once. A nap sleeps on through it (see `curled`), so the sky
    // crosses on over him.
    if (shownScene !== null && loop !== undefined && shownScene.key !== key && scene.mood !== 'nap' && !isRecent(shownScene, now) && loop.night === scene.night && isSkyStep(loop, scene)) {
      return { scene: shownScene.scene, wakeIn: null, isNew: false }
    }
    if (shownScene === null || shownScene.key !== key || isWaveOver) {
      const last = shownScene
      const isTrusted = last !== null && isRecent(last, now)
      // Still too: a still frame holds him where the last one had him (see stillDx in desk.tsx). Up
      // from a nap, though, a still frame stands him at his loop's start, as the lively walk home from
      // the shell would: the nap curls him by the shell, a step in from where he stands, and holding
      // him there would quietly move his still home for the rest of the session. Standing up from
      // the curl is a new pose anyway, so the step can't be seen.
      const isUp = scene.still && scene.mood !== 'nap' && last !== null && last.scene.mood === 'nap'
      const from = isTrusted && !isUp ? positionAt(last.scene, now - last.at) : null
      // The same walk on the same sand (a stride far out to sea): he carries straight on with it.
      const phase = isTrusted ? carriedPhase(last.scene, now - last.at, scene) : undefined
      // A nap taking over from one he is already curled up in (a /band still or lively, a new
      // width, the sky's next step): he sleeps on, never standing up to curl down again, and his z's
      // drift on as they were. However long ago that frame came up: asleep then, he is curled by now.
      const curled = scene.mood === 'nap' && !scene.still && last !== null && isCurledAt(last.scene, now - last.at)
      const doze = curled ? dozeAt(last.scene, now - last.at) : null
      const carried = { ...scene, from, ...(phase === undefined ? {} : { phase }), ...(curled ? { curled } : {}), ...(doze === null ? {} : { doze }) }
      const sea = last === null ? null : seaAfter(last.scene, now - last.at, carried)
      shownScene = { key, at: now, scene: { ...carried, sea } }

      return { scene: shownScene.scene, wakeIn: null, isNew: true }
    }

    return { scene: shownScene.scene, wakeIn: null, isNew: false }
  }

  // The other look is on screen: the beach's frame is gone, and with it where its loop had Clawd
  // (and any scene kept from before: it is no longer on screen to carry on from).
  const forget = () => {
    shownScene = null
    strideSince = null
    isSeeded = true
  }

  // A fresh activation takes up the scene the last one handed out, if it reads as one: once, as it
  // first draws the beach (later, its own memory is the newer).
  const seed = (kept: unknown) => {
    if (!isSeeded) {
      isSeeded = true
      shownScene ??= isShownScene(kept) ? kept : null
    }
  }

  return { settle, forget, seed, shown: () => shownScene }
}

/**
 * How long another beach width must have been drawing, since this one last drew, before this one's
 * memory is stale: its desktop went to another width a while, then came back. (Two desktops at once
 * draw in the same redraws, so neither ever finds the other drawing a second on its own.)
 */
const STALE_MS = 1_000
/**
 * The beach widths remembered at most: a desktop dragged through many widths keeps only its latest
 * few. Above 64 units a beach is two units wider a column, so desktops side by side each draw their
 * own width; this keeps far more than ever draw together, since one evicted before it draws again
 * would start afresh on every redraw, and the widest would write its kept scene each time.
 */
const WIDTHS_KEPT = 16

/**
 * The desktop scenes, one memory per beach width (see sceneMemory). A session may draw its band on
 * several desktops at once, and each beach carries on from its own last scene: taking turns at one
 * memory, two widths would each find the other's scene new every time they drew, and write the
 * kept copy back and forth forever. A width drawn for the first time, or again after another width
 * has had the screen a while (a desktop resized there and back), starts from the latest scene any
 * width handed out, the one that was on screen: so a resize never jumps him back to where an old
 * frame of that width had him. Only the widest beach on screen keeps its scene in `$.state` (`keep`),
 * the one a reload most likely draws again.
 */
export function desktopScenes(): {
  settle: (props: BandProps, now: number, kept: unknown) => { scene: Scene; wakeIn: number | null; keep: ShownScene | null | undefined }
  forget: () => void
} {
  type Beach = { memory: ReturnType<typeof sceneMemory>; drawnAt: number; othersFrom: number | null }
  const beaches = new Map<number, Beach>()
  let latest: ShownScene | null = null
  // Once the other look has drawn, the kept copy is no longer on screen to carry on from.
  let isKeptStale = false
  const settle = (props: BandProps, now: number, kept: unknown) => {
    const width = beachWidth(props.columns, props.words.place[0] ?? [])
    const others = [...beaches.entries()].filter(([at]) => at !== width)
    const othersLast = Math.max(Number.NEGATIVE_INFINITY, ...others.map(([, other]) => other.drawnAt))
    let beach = beaches.get(width)
    if (beach === undefined || (beach.othersFrom !== null && othersLast - beach.othersFrom > STALE_MS)) {
      const memory = sceneMemory()
      memory.seed(latest ?? (isKeptStale ? null : kept))
      beach = { memory, drawnAt: now, othersFrom: null }
    }
    beaches.delete(width)
    beaches.set(width, { ...beach, drawnAt: now, othersFrom: null })
    for (const [, other] of others) other.othersFrom ??= now
    for (const old of [...beaches.keys()].slice(0, -WIDTHS_KEPT)) beaches.delete(old)
    const shown = beach.memory.settle(props, now)
    if (shown.isNew) {
      latest = beach.memory.shown()
    }
    const isWidest = others.every(([at, other]) => at < width || now - other.drawnAt > STALE_MS)

    return { scene: shown.scene, wakeIn: shown.wakeIn, keep: shown.isNew && isWidest ? latest : undefined }
  }
  const forget = () => {
    beaches.clear()
    latest = null
    isKeptStale = true
  }

  return { settle, forget }
}

function isShownScene(kept: unknown): kept is ShownScene {
  const shown = kept as Partial<ShownScene> | null | undefined
  const scene = shown?.scene as Partial<Scene> | undefined

  return (
    typeof shown?.key === 'string' &&
    typeof shown.at === 'number' &&
    typeof scene?.mood === 'string' &&
    typeof scene.tide === 'number' &&
    typeof scene.width === 'number' &&
    typeof scene.still === 'boolean' &&
    typeof scene.wave === 'number' &&
    typeof scene.night === 'boolean' &&
    typeof scene.sky === 'number' &&
    (scene.treasure === null || typeof scene.treasure === 'number') &&
    typeof scene.castle === 'number' &&
    typeof scene.built === 'boolean' &&
    'from' in scene &&
    'sea' in scene &&
    // Only a scene this build would draw the same: its key is what this build makes of it.
    sceneKey(scene as Scene) === shown.key
  )
}

// The splash on screen is over, and the turn's loop it went on into is the scene now. (Still, a
// splash is one held frame, the wave at his feet: it gives way as it ends.)
function isSplashOver(shown: Scene, scene: Scene): boolean {
  return shown.moment === 'splash' && !shown.still && scene.moment === null && sceneKey({ ...scene, moment: 'splash', wave: shown.wave }) === sceneKey(shown)
}

// A lively splash's frame whose splash is over: it has gone on into the work (see isSplashOver).
function isSplashKept(shown: Scene, ms: number): boolean {
  return shown.moment === 'splash' && !shown.still && ms >= SPLASH_MS
}

// Whether the frame that came up with `shown` is recent enough to trust where it has him (see SCENE_MEMORY_MS).
function isRecent(shown: ShownScene, now: number): boolean {
  return now - shown.at < NAP_AFTER_MS + SCENE_MEMORY_MS
}

// The same scene with only its sky moved on: the sun's or the moon's step, nightfall or daybreak.
function isSkyStep(shown: Scene, scene: Scene): boolean {
  return sceneKey({ ...scene, sky: shown.sky, night: shown.night }) === sceneKey(shown)
}

// The same scene with only what lies behind him changed: the sky, or a starfish come or gone.
function isBackdropStep(shown: Scene, scene: Scene): boolean {
  return sceneKey({ ...scene, sky: shown.sky, night: shown.night, treasure: shown.treasure }) === sceneKey(shown)
}

// The same working loop, only its tide moved on a stride (and its sun, which a frame held through a
// step may be behind on).
function isStride(shown: Scene, scene: Scene): boolean {
  const working = (s: Scene) => (s.mood === 'read' || s.mood === 'work') && s.moment === null

  return working(shown) && working(scene) && sceneKey({ ...shown, tide: 0, sky: scene.sky }) === sceneKey({ ...scene, tide: 0 })
}
