import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRepo, Timer } from 'claude-code'

import type { Info, Look, LookPick, Motion } from '../types'
import {
  DEFAULT_WARN_AT,
  EMPTY,
  FILE_TOOLS,
  GIT_WAIT_MS,
  GREET_MS,
  LANDING_MS,
  LOOK_TOOLS,
  NAP_AFTER_MS,
  NAP_LATE_MS,
  NOTHING_HELD,
  NO_DESK,
  QUIET_TOOLS,
  SPLASH_MS,
  TODO_TOOLS,
  basename,
  createdTaskId,
  deskAt,
  describe,
  figures,
  heldId,
  isInterrupted,
  isNewWave,
  isPhrase,
  isTypeahead,
  laterCommand,
  nameIn,
  nextTodos,
  nounOf,
  pendingWakes,
  prettyModel,
  runningAfter,
  skyTurnsIn,
  stepDesk,
  stepHeld,
  todosAfterTurn,
  whole,
} from './facts'
import { hearthRow, tideRow } from './compact'
import { CHEER_FOR_MS, FLINCH_MS, desk } from './hearth/desk'
import { bandProps as hearthProps, doing } from './hearth/props'
import { hearthActivity, hearthInfo, slipAt } from './hearth/view'
import { LOOK_KEY, configuredLook, isLook, isLookRow, isPickOn, lookNow, migrateMotion, newActivation, offReply, parseBand, replyFor, shownSince, toastFor, troubleReply, upgradeToast } from './look'
import { CHEER_MS, desktopBand, linesPx, widthLines } from './tide/desk'
import { STRIDE_WAIT_MS, bandProps as tideProps, desktopScenes } from './tide/props'
import type { ShownScene } from './tide/props'
import { tideInfo } from './tide/view'

// The session band: Clawd above the prompt, with the session at a glance. One set of facts about
// the session, kept in `$.state`, and two looks that draw it: the tide (the default), Clawd on a
// little beach whose tide comes in as the context fills, and the hearth, Clawd beside three calm
// lines. The look lives in /config; /band writes it there. Each look has its own terminal surface
// module (a `Client`) and its own desktop drawing (an `Svg` Clawd beside Box and Text).

const info = atom({ plugin: 'session-band', key: 'info' } as const, EMPTY)
const motionOf = atom({ plugin: 'session-band', key: 'motion' } as const, 'lively')
const pickOf = atom({ plugin: 'session-band', key: 'pick' } as const, null)
/** The tide desktop's last scene, kept through a reload of this module (see sceneMemory). */
const sceneKept = atom({ plugin: 'session-band', key: 'scene' } as const, null)
/** One of the prompt's own menus is up on the terminal (see isTypeahead): the band steps aside for it. */
const menuOf = atom({ plugin: 'session-band', key: 'menu' } as const, false)

/** Each moment's redraws, in ms after it starts: a cheer's end (the hearth's, then the tide's), a splash's, a flinch's. */
const MOMENT_ENDS = { cheer: [CHEER_FOR_MS + 10, CHEER_MS + 100], splash: [SPLASH_MS + 100], flinch: [FLINCH_MS + 10] } as const

/**
 * The module's timers: `desk`, the desktop's next look at what it holds; `nap`, the redraw that shows
 * him asleep; `landing`, the one that ends a landing that never came; `starting`, the one that ends a
 * start the host never confirmed; `stride`, the beach's desktop waiting out a stride of the tide (see
 * STRIDE_WAIT_MS); `bead`, the hearth's desktop waiting before its bead of sweat comes or goes;
 * `sky`, the beach's redraw as its sky next moves (the sun's or the moon's next step); `held`, the
 * desktop band's next look while something else holds its place (see HELD_LOOK_MS); `git`, the
 * beach's first desktop frame once it has waited long enough for git (see GIT_WAIT_MS). Each look
 * lets go of the other's wait as it draws, so a switch never leaves one waiting on the other's.
 * `isFresh` until this activation first draws: a reload drops every timer, so the first draw arms
 * again whatever the facts say is still to come.
 */
type Timers = {
  desk: Timer | null
  nap: Timer | null
  landing: Timer | null
  starting: Timer | null
  stride: Timer | null
  bead: Timer | null
  sky: Timer | null
  held: Timer | null
  git: Timer | null
  isFresh: boolean
}

/**
 * How often the desktop band, stepped aside for what holds its place (a survey, and by the look of
 * it the app's own notice above the prompt, such as its effort warning), asks to be drawn again. The
 * app asks for the band again only when the engine says it changed, so the band asks until its place
 * is free.
 */
const HELD_LOOK_MS = 2_000

/**
 * How soon before an Esc'd turn's end a failed call counts as the Esc's own (the call it cut), not a
 * failure of Claude's: the call settles a moment before the turn does.
 */
const ESC_MS = 1000

/** What the band has seen of the work since the prompt: whether Claude Code said it was working, and since when it has said it is not. */
type Landing = { sawWork: boolean; quietSince: number | null }

/**
 * What the band knows of the prompt's menus: the draft it last read them from, whether one was up
 * then, what `$.state` holds as far as it knows (null before its first write lands, or after one
 * fails), and how many looks at the prompt it has taken, so only the newest one counts.
 */
type MenuSeen = { text: string | null; isUp: boolean; written: boolean | null; looks: number }

type Saved = { kind: 'saved' } | { kind: 'denied'; reason: string } | { kind: 'unsaved' }
type Row = { key: string }

export const register: Register = (on, options) => {
  const warnAt = typeof options.warnAt === 'number' ? options.warnAt : DEFAULT_WARN_AT
  const configured = options.look
  // On the terminal: three rows (Clawd on his beach or by the hearth), or one (see compact.tsx).
  const isCompact = options.size === 'compact'
  const menu: MenuSeen = { text: null, isUp: false, written: null, looks: 0 }
  // A pick /band makes counts only in this activation: any reload (a /config change among them) spends it.
  const activation = newActivation()
  // The look's /config row, found again through /config's own list where it is keyed otherwise.
  const row: Row = { key: LOOK_KEY }
  // When this activation first drew, for state from an older build that kept no `greetedAt`.
  let firstDrawnAt: number | null = null
  // The project as a band drawn before the start wrote one reads it: asked once, and every redraw
  // until the start's write lands shares the answer.
  let projectEarly: Promise<string | null> | null = null
  // The look each terminal band last drew, by its instance (the host keeps one band above the prompt
  // and its id): a look drawn where the other one stood is a module swapped under a band on screen,
  // which keeps pace with the old look's last second. A band mounted afresh has no such second.
  const drawnLooks = new Map<string, Look>()
  // How wide the beach's context and where-lines have been at their widest on the desktop (see wordsPx).
  let wordsPx = 0
  const timers: Timers = { desk: null, nap: null, landing: null, starting: null, stride: null, bead: null, sky: null, held: null, git: null, isFresh: true }
  // The desktop bands stepped aside since the last ask (by id): one coming free stops the asking only
  // once none is left, so a band drawn free beside it (another desktop, a terminal) never strands it.
  const heldOn = new Set<string>()
  const landing: Landing = { sawWork: false, quietSince: null }
  const scenes = desktopScenes()
  // git's answers at a turn's end, each stamped: one that comes back after a newer one has landed
  // (a slow `git status` overtaken by the next turn's) is dropped, so the count never goes back.
  const answers = { asked: 0, landed: 0 }
  // The hearth desktop's bead of sweat as its frame last drew it, and since when a change has waited.
  const bead: { shown: boolean | null; since: number | null } = { shown: null, since: null }
  // The hearth desktop's last flinch as its frame drew it (the bead and stillness then), and whether
  // that frame may stay up once the flinch is over (see the desktop's draw).
  let flinch: { at: number; isSweating: boolean; isStill: boolean; isUp: boolean } | null = null
  // The hearth desktop's nap frame: how far its z had drifted when the frame came, decided then,
  // so every redraw through the nap draws the very same frame. Any other frame lets it go.
  let nap: { since: number; isStill: boolean; dozedS: number } | null = null
  const settled = () => {
    landing.sawWork = false
    landing.quietSince = null
    timers.landing?.cancel()
    timers.landing = null
    timers.starting?.cancel()
    timers.starting = null
  }

  on('session.start', async ($, e, next) => {
    // git is the slow lookup: asked first, and its answer joins the facts last (see below).
    const asked = ++answers.asked
    const git = gitState($).catch(() => ({}))
    try {
      // Every step of the start stands on its own: a command the host will not register, a store or a
      // state it cannot read, never costs the session its facts (line 3, the nap's timer, the hello).
      await $.command
        .register({
          name: 'band',
          description: "Pick the band's look (tide or hearth) and whether Clawd moves (still or lively)",
          argumentHint: '[tide|hearth] [still|lively]',
        })
        .catch(() => undefined)
      // Still or lively: remembered across sessions. An older build's stored style becomes a motion once.
      // A motion the store would not keep stays this session's through a reload, and is offered to the
      // store again. A store that cannot be read gives the default, lively.
      const [storedMotion, storedStyle, kept] = await Promise.all([orNothing($.store.get('motion')), orNothing($.store.get('style')), orNothing(read($, info))])
      const unsaved = whole(kept ?? {}).unsavedMotion
      const motion = unsaved ?? migrateMotion(storedMotion, storedStyle)
      await update($, motionOf, () => motion).catch(() => undefined)
      // Whether a menu is up as the prompt stands now (one a reload left marked would keep the band aside).
      void lookAtPrompt($, menu)
      const isRemembered = storedMotion === motion || (await remember($, motion))

      // Each fact on its own: a lookup that fails leaves its own field as it was (or as the folder
      // names it), and every other fact still lands, so one slow or broken lookup never blanks line 3.
      const [usage, model, repo, isCalm, isAppleTerminal, isGhostty, now] = await Promise.all([
        orNothing($.session.usage()),
        modelNow($),
        orNothing($.session.repo()),
        prefersReducedMotion($),
        appleTerminal($),
        ghostty($),
        $.clock.now(),
      ])
      // Idempotent: a reload that runs this again keeps a napping Clawd asleep and never waves twice.
      let lastActiveAt = now
      await patch($, before => {
        lastActiveAt = before.lastActiveAt ?? now

        return {
          ...(usage === undefined ? {} : figures(usage)),
          model: model ?? before.model,
          project: repo === undefined ? (before.project ?? basename(e.cwd)) : projectOf(repo, e.cwd),
          lastActiveAt,
          greetedAt: before.greetedAt ?? now,
          unsavedMotion: isRemembered ? null : motion,
          isCalm,
          isAppleTerminal,
          isGhostty,
          // Written with the project, so both looks know to hold the model until git answers.
          isGitRead: before.isGitRead,
        }
      })
      napLater($, timers, Math.max(0, NAP_AFTER_MS - (now - lastActiveAt)) + 1000)
      // Once the migrated motion is stored, the upgrade's one word (a store that keeps nothing would
      // bring it back every session, so it says nothing). A pick that cannot be read leaves /config's
      // look, and never holds up git's write below, which lets the model join the line.
      const look = isRemembered ? await lookOf($, activation, configured).catch(() => configuredLook(configured)) : null
      const upgraded = look === null ? null : upgradeToast(storedMotion, storedStyle, look)
      if (upgraded !== null) {
        $.ui.toast(upgraded, { timeoutMs: 8000 })
      }
    } finally {
      // The branch and the uncommitted count join the project already on screen, after it, so nothing
      // that showed moves; an answer a turn's newer one overtook is dropped (see answers). Written
      // even when a step above went wrong, so a start that failed partway still tells both looks
      // that git has answered, and the model joins the line as soon as it is known.
      const found = await git
      if (asked > answers.landed) {
        answers.landed = asked
        await patch($, () => ({ ...found, isGitRead: true }))
      }
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const percent = e.context.percent
    let isToast = false
    await patch($, before => {
      if (percent === undefined) {
        return figures(e)
      }
      // One toast per crossing: it comes again only once the context has dropped back under.
      isToast = percent >= warnAt && !before.isWarned
      // The tide back up to where a compaction left the starfish washes it away.
      const isWashed = before.treasurePercent !== null && percent >= before.treasurePercent

      return { ...figures(e), isWarned: percent >= warnAt, ...(isWashed ? { treasurePercent: null } : {}) }
    })
    if (isToast && percent !== undefined) {
      $.ui.toast(toastFor(await lookOf($, activation, configured), percent), { timeoutMs: 8000 })
    }

    return next(e)
  })

  // A compaction lets the tide out (a measure says how far), and leaves a starfish on the sand at the
  // high-water mark: the context as it stood before the compaction ran, read first, since a measure
  // may land while it runs. The main conversation's only, and only one that went through (not a
  // precompute, nor one a hook skipped).
  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined && e.trigger !== 'precompute'
    const high = isMain ? whole((await orNothing(read($, info))) ?? EMPTY).percent : null
    const result = await next(e)
    if (high !== null && result.messages !== undefined) {
      await patch($, before => ({ treasurePercent: high, treasures: before.treasures + 1 }))
    }

    return result
  }).catch((_$, e, next) => next(e))

  // A /model, the picker or a fallback names the new model on line 3 at once. Only the main loop's
  // switch counts (a subagent's runs its own model), and the git hold still keeps it off the line
  // until the project's facts arrive together.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.agent_id === undefined && typeof e.to_model === 'string' && e.to_model.trim() !== '') {
      const model = prettyModel(e.to_model)
      await patch($, () => ({ model }))
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  // The prompt's own menus (a / command being named, an @ file) open just above the prompt, where the
  // band sits, which would push them up over Clawd's beach: on the terminal the band steps aside while
  // one is up. Typing and deleting come as edits, and a recalled entry, a clear or a submit as
  // changes; after each the band looks at the prompt as it then stands (a plugin above may have
  // changed what an edit put in, and a clear may have come since), a moment later, once the edit has
  // landed, or failed below it and left the editor's own. Nothing here holds a keystroke up.
  on('prompt.edit', ($, e, next) => {
    const box = next(e)
    const look = () => after($, 0, () => void lookAtPrompt($, menu))
    void box.then(look, look)

    return box
  })
  on('prompt.change', async ($, e, next) => {
    after($, 0, () => void lookAtPrompt($, menu))

    return next(e)
  })

  // The band only watches the prompt and the tools. Should its bookkeeping throw, the `.catch`
  // says outright what the engine would do anyway: hand the event on untouched, or keep what the
  // hook's own `next` already settled to (nothing runs twice). A failed state write never touches
  // the prompt or the tool.
  on('prompt.submit', async ($, e, next) => {
    // The last turn's look-again timer goes with it. (The fresh turn's facts would make a stale timer's
    // look a no-op anyway: this only keeps one timer at a time, see settle.)
    letGo(timers)
    settled()
    // Read again with each prompt, so a change in /config takes hold without a restart (and a model
    // switch the hook above missed shows by the next Enter).
    const [now, isCalm, model] = await Promise.all([$.clock.now(), prefersReducedMotion($), modelNow($)])
    await patch($, before => ({
      model: model ?? before.model,
      // Reduced motion turned off: lively from here (see livelyAt).
      livelyAt: before.isCalm && !isCalm ? now : before.livelyAt,
      lastActiveAt: now,
      activity: null,
      running: [],
      slip: null,
      lastSlip: null,
      slipDue: null,
      flinchAt: null,
      isFlinchAgain: false,
      toolEndedAt: null,
      held: NOTHING_HELD,
      desk: NO_DESK,
      isTurnOpen: true,
      isCalm,
      turnPercent: before.percent ?? 0,
      turnAt: now,
      turnWorked: false,
      workedAt: null,
      // Read before lastActiveAt moves on: this turn woke him from a nap.
      woke: before.lastActiveAt !== null && now - before.lastActiveAt >= NAP_AFTER_MS,
      turnTools: 0,
      turnTodoTools: 0,
      turnFiles: [],
    }))
    napLater($, timers)

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const tool = String(e.tool)
    const activity = describe(e.tool_use_id, e)
    // A turn that changes something (an edit, a command; not a look, a todo or a question) is a turn at work.
    const isWork = !LOOK_TOOLS.has(tool) && !QUIET_TOOLS.has(tool)
    const started = await $.clock.now()
    await settle($, timers, started, now => ({
      ...runningAfter(now.running, { started: activity }),
      slip: null,
      lastActiveAt: started,
      turnWorked: now.turnWorked || isWork,
      workedAt: now.workedAt ?? (isWork ? started : null),
      turnTools: now.turnTools + 1,
      turnTodoTools: now.turnTodoTools + (TODO_TOOLS.has(tool) ? 1 : 0),
    }))

    const ran = await next(e)

    // An error Claude's own step made: not one the person refused, and not Esc cutting the call (the
    // dispatch's signal, or the abort's own words as the model reads them). A wait on you that ends
    // in an error (a question waved off, a plan sent back) is the person's answer, not a failure.
    const isError = ran.deny === undefined && ran.isError === true && !isInterrupted(ran.text, next.signal) && activity.kind !== 'ask'
    let isFailed = false
    let isWave = false
    const ended = await $.clock.now()
    const todoId = e.tool === 'TaskCreate' && ran.deny === undefined ? createdTaskId(ran) : undefined
    await settle($, timers, ended, now => {
      // A tool of this turn, still running: one from a turn already over (a command Esc left behind
      // that answers late) leaves this turn's words, splash and hiccup alone.
      const isOwn = now.running.some(one => one.id === activity.id)
      isFailed = isError && isOwn
      // A failure in the first rush of the beach's wave rides along with it: one wave, one end, on
      // both surfaces. A later one starts a wave of its own.
      isWave = isFailed && isNewWave(now, ended)
      const file = isOwn && !isFailed && FILE_TOOLS.has(tool) && 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : null

      return {
        // The latest tool still running, if one is: overlapping tools never leave the band "Thinking".
        ...runningAfter(now.running, { ended: activity.id }),
        todos: nextTodos(now.todos, e, todoId),
        oops: isFailed ? now.oops + 1 : now.oops,
        oopsAt: isFailed ? ended : now.oopsAt,
        oopsWhat: isFailed ? (isPhrase(activity) ? null : activity.what) : now.oopsWhat,
        oopsName: isFailed ? nameIn(activity) : now.oopsName,
        oopsCommand: isFailed ? activity.verb === 'Running' : now.oopsCommand,
        oopsNoun: isFailed ? nounOf(activity) : now.oopsNoun,
        // The sea a wave splashes from is the sea as that wave began: one that rides along keeps it.
        oopsPercent: isWave ? now.percent : now.oopsPercent,
        splashAt: isWave ? ended : now.splashAt,
        waves: isWave ? now.waves + 1 : now.waves,
        // A tool that ends well while a failure is on the line ran beside it (the next tool to start
        // clears the failure): with it over, the line moves on rather than going back to the failure.
        slip: isFailed ? activity : isOwn ? null : now.slip,
        // A failure keeps its claim on the hearth's line 3 when the next tool starts: its hiccup has its second, with Clawd's flinch.
        lastSlip: isFailed ? activity : now.lastSlip,
        slipDue: isFailed ? activity : now.slipDue,
        toolEndedAt: isOwn ? ended : now.toolEndedAt,
        lastActiveAt: ended,
        turnFiles: file === null || now.turnFiles.includes(file) ? now.turnFiles : [...now.turnFiles, file].slice(-256),
      }
    })
    if (isWave) {
      // The tide desktop's splash plays its seconds; one redraw as it ends settles the sea. (A failure
      // that rides along ends with its wave, whose redraw is already set.)
      for (const ms of MOMENT_ENDS.splash) nudge($, ms)
    }
    napLater($, timers)

    return ran
  }).catch(async ($, e, next) => {
    // The call itself went wrong (the tool threw, or its dispatch was cut short) after it began: it
    // runs no more, so the words never keep it up until the turn ends. No splash: nothing says the
    // step failed, only that it stopped. (What the call settled to is passed on as it was.)
    if (next.called && e.agentId === undefined) {
      try {
        const ended = await $.clock.now()
        await settle($, timers, ended, now => {
          const isOwn = now.running.some(one => one.id === e.tool_use_id)
          return isOwn ? { ...runningAfter(now.running, { ended: e.tool_use_id }), toolEndedAt: ended, lastActiveAt: ended } : {}
        })
      } catch {
        // The band's state cannot be reached from here: the turn's end clears what runs.
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    letGo(timers)
    // The model again: a /model typed while the turn ran names the model the next turn will use.
    const [now, model] = await Promise.all([$.clock.now(), modelNow($)])
    // Only an answered turn is "Done" (and a cheer); Esc or a refusal is a calm "Stopped".
    const ending = e.reason === 'answer' ? 'answer' : e.reason === 'error' ? 'error' : 'stopped'
    // The turn's own facts first, git's after: a band drawn while `git status` runs (seconds, in a
    // big or cold repository) already cheers, rather than showing the last turn beside an idle Clawd.
    await patch($, before => ({
      // Esc while a tool runs ends that call in an error a moment before the turn says it was stopped:
      // where nothing at the call's end said so (see isInterrupted), the failure is taken back here,
      // and both looks end its splash or hiccup at once (nothing failed: the person stopped it).
      ...(e.reason === 'aborted' && before.oopsAt !== null && now - before.oopsAt <= ESC_MS && before.oopsAt >= (before.turnAt ?? 0)
        ? { oops: Math.max(0, before.oops - 1), oopsAt: null, oopsWhat: null, oopsName: null, oopsCommand: false, oopsNoun: null, oopsPercent: null, splashAt: null }
        : {}),
      model: model ?? before.model,
      activity: null,
      running: [],
      slip: null,
      lastSlip: null,
      slipDue: null,
      flinchAt: null,
      isFlinchAgain: false,
      toolEndedAt: null,
      held: NOTHING_HELD,
      // The words go with the turn: the potter stays only if they had come to the work, so the host's
      // last word of work draws the frame it already had (see tideInfo).
      workedAt: before.workedAt !== null && before.desk.shownAt >= before.workedAt ? before.workedAt : null,
      desk: NO_DESK,
      isTurnOpen: false,
      lastActiveAt: now,
      lastTurn: { seconds: Math.round(e.durationMs / 1000), tools: Math.max(0, before.turnTools - before.turnTodoTools), files: before.turnFiles.length, ending },
      todos: todosAfterTurn(before.todos),
      cheers: ending === 'answer' ? before.cheers + 1 : before.cheers,
      cheeredAt: ending === 'answer' ? now : before.cheeredAt,
      cheerPercent: ending === 'answer' ? before.percent : before.cheerPercent,
    }))
    // Only now that the turn is written down does the landing guard stand down: until this write, a
    // draw that hears the host say the work is over still shows the work (see LANDING_MS).
    settled()
    if (ending === 'answer') {
      // The desktop draws the cheer for its first seconds; one redraw as it ends settles him back to rest.
      for (const ms of MOMENT_ENDS.cheer) nudge($, ms)
    }
    napLater($, timers)
    // The uncommitted count catches up when git answers, off the turn's handoff: a slow repository
    // never holds up what another hook shows beneath the answer.
    const asked = ++answers.asked
    void gitState($)
      .then(found => {
        if (asked > answers.landed) {
          answers.landed = asked
          return patch($, () => ({ ...found, isGitRead: true }))
        }
        return undefined
      })
      .catch(() => undefined)

    return next(e)
  }).catch((_$, e, next) => next(e))

  // /clear starts a fresh conversation without a new session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      letGo(timers)
      settled()
      const now = await $.clock.now()
      await patch($, before => ({
        ...figures(null),
        lastActiveAt: now,
        lastTurn: null,
        todos: [],
        activity: null,
        running: [],
        slip: null,
        lastSlip: null,
        slipDue: null,
        flinchAt: null,
        isFlinchAgain: false,
        toolEndedAt: null,
        held: NOTHING_HELD,
        desk: NO_DESK,
        isTurnOpen: false,
        turnPercent: null,
        turnAt: null,
        // A cheer or a splash under way belongs to the conversation /clear ended: it ends with it.
        cheeredAt: null,
        cheerPercent: null,
        oopsAt: null,
        oopsWhat: null,
        oopsName: null,
        oopsCommand: false,
        oopsNoun: null,
        oopsPercent: null,
        splashAt: null,
        treasurePercent: null,
        // The sandcastle belongs to the conversation: the next one builds its own.
        castleFrom: before.cheers,
        turnWorked: false,
        workedAt: null,
        woke: false,
        isWarned: false,
        turnTools: 0,
        turnTodoTools: 0,
        turnFiles: [],
      }))
      napLater($, timers)
    }

    return next(e)
  })

  // /band: the look (written to /config, its one home) and the motion (remembered in the store).
  on('command.run', { command: 'band' }, async ($, e) => {
    const ask = parseBand(e.args)
    if ('error' in ask) {
      return { text: ask.error }
    }
    if (!('look' in ask)) {
      // No such switch: the quietest ways there are, from the look and motion on screen (a refused
      // read: the tide's, lively), so a band already still is never offered /band still.
      const [look, motion, isCalm] = await Promise.all([
        lookOf($, activation, configured).catch((): Look => 'tide'),
        read($, motionOf).catch((): Motion => 'lively'),
        prefersReducedMotion($),
      ])

      return { text: offReply(look, motion, isCalm) }
    }
    try {
      // Read the reduced-motion setting again, so /band is all it takes after changing it. Noting
      // it is best-effort: a store that refuses the write still gets its answer.
      const [isCalm, was, at] = await Promise.all([prefersReducedMotion($), read($, motionOf), $.clock.now()])
      // Still to lively: a lively desktop frame opens at rest, never replaying a moment under way.
      const isStill = (ask.motion ?? was) === 'still' || isCalm
      await patch($, before => ({ isCalm, ...((was === 'still' || before.isCalm) && !isStill ? { livelyAt: at } : {}) })).catch(() => undefined)

      let motion = was
      if (ask.motion !== null) {
        // Before the look: a /config write reloads the plugin, and the motion must not be lost to it.
        const asked = ask.motion
        motion = asked
        await update($, motionOf, () => asked)
        const isRemembered = await remember($, asked)
        await patch($, () => ({ unsavedMotion: isRemembered ? null : asked }))
      }

      let denied: string | undefined
      // A look already on is no switch: /config is asked nothing, and the reply is the status (or the
      // motion's), never "to switch back" to a look that was not on.
      const isSwitch = ask.look !== null && ask.look !== (await lookOf($, activation, configured))
      if (ask.look !== null && isSwitch) {
        const look = ask.look
        const saved = await save($, row, look)
        if (saved.kind === 'denied') {
          denied = saved.reason
        } else {
          // On screen at once; /config's reload lands a moment later with the same look. `at` is kept
          // in $.state, so that reload still knows when this look came on screen. Back to the look
          // /config already holds is no unsaved pick, even where /config cannot be reached: a restart
          // shows it anyway, so the reply never says "this session only".
          const at = await $.clock.now()
          const isSaved = saved.kind === 'saved' || look === configuredLook(configured)
          await update($, pickOf, (): LookPick => ({ look, activation, isSaved, at, over: configuredLook(configured) }))
        }
      }

      const pick = await read($, pickOf)
      const look = lookNow(pick, activation, configured)
      const isSessionOnly = isPickOn(pick, activation, configured) && !pick.isSaved

      return {
        text: replyFor({
          kind: isSwitch ? 'look' : ask.motion !== null ? 'motion' : 'status',
          look,
          motion,
          isCalm,
          isSessionOnly,
          ...(denied === undefined ? {} : { denied }),
          ...(ask.motion === null ? {} : { isMotionAsked: true }),
          ...(ask.off === true ? { isOff: true } : {}),
        }),
      }
    } catch {
      // A store that refuses a write (or anything else) never leaves /band without an answer, and
      // one that fits what was asked: /band alone switches nothing.
      const isStatus = ask.look === null && ask.motion === null

      return { text: troubleReply(isStatus) }
    }
  })

  // Someone else changed the look in /config (the menu, or another plugin): it shows at once, and
  // any look /band picked gives way to it. Our own `$.config.set` never comes here.
  on('config.set', async ($, e, next) => {
    if (e.key !== row.key && !isLookRow(e)) {
      return next(e)
    }
    const result = await next(e)
    if (result.value !== undefined) {
      const look: Look = isLook(result.value) ? result.value : 'tide'
      const [at, before] = await Promise.all([$.clock.now(), read($, pickOf)])
      // The same look again changes nothing on screen, so it keeps the time it came on.
      const was = lookNow(before, activation, configured)
      const since = was === look ? (shownSince(before, look) ?? 0) : at
      await update($, pickOf, (): LookPick => ({ look, activation, isSaved: true, at: since, over: configuredLook(configured) }))
    }

    return result
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      return next(e)
    }
    if (e.props.hasSurvey) {
      // Something else holds the band's place: Claude Code's survey (and on the desktop, by the look
      // of it, the app's own notice above the prompt). Step aside, but keep watching: a draw that
      // read nothing is never drawn again by a write, so read the facts (any change to them draws
      // the band again), and on the desktop ask to be drawn again every HELD_LOOK_MS until the place
      // is free. The terminal draws the band again itself as its survey goes.
      await orNothing(read($, info))
      if (e.surface === 'desktop') {
        heldOn.add(e.requestId)
        timers.held ??= after($, HELD_LOOK_MS, () => {
          timers.held = null
          // Each band still held says so again as it draws.
          heldOn.clear()
          try {
            $.ui.invalidate('ui.render')
          } catch {
            // Nothing to draw again: the band is gone with its session.
          }
        })
      }

      return next(e)
    }
    // This band's place is free: it asks no more, unless another desktop's band is still held.
    if (heldOn.delete(e.requestId) && heldOn.size === 0) {
      timers.held?.cancel()
      timers.held = null
    }
    // One of the prompt's menus is up just above it (the fullscreen layout: inline, they open below
    // the prompt), or no row is left: the band takes no rows. Its terminal band stays mounted at no
    // height, so Clawd carries on where he was once the menu goes; reading whether the menu is up
    // draws the band again as it goes.
    const isMenu = e.surface === 'terminal' && e.viewport?.isFullscreen !== false && (await orNothing(read($, menuOf))) === true
    const isAside = e.surface === 'terminal' && (isMenu || e.props.maxRows < 1)
    // One row on the terminal when the person keeps it there, or when Claude Code leaves fewer than
    // three (a tall draft): never three rows scrolled in a smaller window. One row has nothing to keep.
    const isOneRow = e.surface === 'terminal' && (isCompact || e.props.maxRows < 3)
    if (isAside && isOneRow) {
      return next(e)
    }

    // A store that cannot be read leaves the band as a fresh session draws it, never nothing at all.
    const [now, { stored, isRead }, motion, pick, kept] = await Promise.all([
      $.clock.now(),
      orNothing(read($, info)).then(found => ({ stored: found ?? EMPTY, isRead: found !== undefined })),
      orNothing(read($, motionOf)).then((found): Motion => found ?? 'lively'),
      orNothing(read($, pickOf)).then(found => found ?? null),
      orNothing(read($, sceneKept)).then(found => found ?? null),
    ])
    // A band drawn before the start has written down where you are (its lookups still under way)
    // reads the project as the start does, so even the first frame says where you are. The model is
    // not asked for: both looks hold it back until git answers (see the views).
    const facts = whole(stored)
    const known: Info = { ...facts, project: facts.project ?? (await (projectEarly ??= projectNow($))) }
    firstDrawnAt ??= now
    // The work goes on until the turn is written down (or a second and a half has gone by): see LANDING_MS.
    // The landing timer is let go two ways, each enough alone: when it fires, and when work resumes
    // (canceled). They back each other up, so a later quiet stretch always re-arms; keep both.
    let landed = e.props.isWorking
    if (landed) {
      landing.sawWork ||= known.isTurnOpen
      landing.quietSince = null
      // Work again: the next quiet stretch has its own wait, and its own redraw at the end of it.
      timers.landing?.cancel()
      timers.landing = null
    } else if (known.isTurnOpen && landing.sawWork) {
      landing.quietSince ??= now
      const left = landing.quietSince + LANDING_MS - now
      if (left > 0) {
        landed = true
        timers.landing ??= nudge($, left + 10, () => {
          timers.landing = null
        })
      }
    }
    if (timers.isFresh) {
      timers.isFresh = false
      rearm($, timers, known, now)
    }
    const columns = e.props.bodyColumns
    const look = lookNow(pick, activation, configured)
    // How long this look has been on screen, and lively if it is: a desktop never replays a moment
    // that began before it came on, or before he went lively (still, a moment is one held frame,
    // right whenever it opens; lively, it would start from its first beat and be cut short).
    const isStill = motion === 'still' || known.isCalm
    const since = Math.max(shownSince(pick, look) ?? 0, isStill ? 0 : (known.livelyAt ?? 0))
    const shownForMs = since <= 0 ? null : Math.max(0, now - since)

    // The hello is the session's, once: one that began before this look came on is over for it.
    const greeted = now - (known.greetedAt ?? firstDrawnAt)
    const isFirstMoments = greeted < GREET_MS && (shownForMs === null || greeted <= shownForMs)
    const greetedMs = isFirstMoments ? Math.max(0, greeted) : null

    // Both looks start the turn as the prompt is written, before the host says it is working, so the
    // host's word changes nothing on screen (and a napping Clawd wakes with the turn's words in the
    // same frame); it never claims work for long without that word.
    let isStarting = false
    if (!landed && known.isTurnOpen && !landing.sawWork && known.turnTools === 0 && known.lastActiveAt !== null) {
      const left = known.lastActiveAt + LANDING_MS - now
      if (left > 0) {
        isStarting = true
        // Let go when it fires; settled() also lets it go at every prompt, so this release is only
        // belt and braces (no test can tell the two apart).
        timers.starting ??= nudge($, left + 10, () => {
          timers.starting = null
        })
      }
    }

    // Swapped in where the other look's band was drawn (see drawnLooks); at most a few bands remembered.
    const wasDrawn = e.surface === 'terminal' ? drawnLooks.get(e.requestId) : undefined
    const isSwapped = wasDrawn !== undefined && wasDrawn !== look
    if (e.surface === 'terminal') {
      drawnLooks.delete(e.requestId)
      drawnLooks.set(e.requestId, look)
      for (const id of [...drawnLooks.keys()].slice(0, -8)) drawnLooks.delete(id)
    }

    if (look === 'hearth') {
      scenes.forget()
      if (kept !== null) {
        keepScene($, null)
      }
      timers.stride?.cancel()
      timers.stride = null
      timers.sky?.cancel()
      timers.sky = null
      // Both surfaces show the line the facts' hold settled on (stepHeld), so they name the same tools,
      // however quick: the terminal's band only takes it up on a tick of its own clock.
      const props = {
        ...hearthProps(hearthInfo(known), slipAt(known), motion, landed || isStarting, warnAt, columns, now, greetedMs, shownForMs),
        activity: doing(hearthActivity(known.held.activity)),
        slip: doing(hearthActivity(known.held.slip)),
      }
      if (e.surface === 'desktop') {
        // The bead comes (or goes) with the reading at once, except while Claude works: then it waits
        // a moment, as the tide's stride does, in case the turn is landing and the cheer's frame
        // would replace it at once (two reloads in an instant). The words have the reading at once.
        let isSweating = props.isHigh
        if (!landed || bead.shown === null || bead.shown === isSweating) {
          bead.since = null
        } else {
          bead.since ??= now
          const left = bead.since + STRIDE_WAIT_MS - now
          if (left > 0) {
            isSweating = bead.shown
            timers.bead ??= nudge($, left + 10, () => {
              timers.bead = null
            })
          } else {
            bead.since = null
          }
        }
        bead.shown = isSweating
        // The flinch's frame goes on into his taps: once the flinch is over it stays up while the turn
        // runs and nothing else changes his frame (the bead, stillness), rather than reloading for its
        // end and, as often as not, again a moment later for the cheer. Once it gives way it is gone.
        if (known.flinchAt === null) {
          flinch = null
        } else if (flinch?.at !== known.flinchAt) {
          flinch = { at: known.flinchAt, isSweating, isStill: props.isStill, isUp: true }
        } else if (flinch.isSweating !== isSweating || flinch.isStill !== props.isStill) {
          flinch.isUp = false
        }
        // (Still, his eyes stay shut a moment and he rests: that frame gives way as it ends.)
        const isFlinchKept = props.isWorking && !props.isStill && flinch?.isUp === true && known.flinchAt !== null && known.flinchAt >= (known.turnAt ?? Number.POSITIVE_INFINITY)
        // Asleep: his z carries on from the frame before (see dozedS). Only the nap's own redraw, a
        // moment after it fell due, follows a frame that never showed a z: the one after a cheer
        // (or the hello), which came seconds after he went idle and so dozes off seconds later.
        const napFor = props.idleMs === null ? -1 : props.idleMs - NAP_AFTER_MS
        if (props.isWorking || napFor < 0 || known.lastActiveAt === null) {
          nap = null
        } else if (nap?.since !== known.lastActiveAt || nap.isStill !== props.isStill) {
          const isOwnRedraw = nap === null && napFor <= NAP_LATE_MS + 1_000 && (props.shownForMs === null || props.shownForMs > napFor)
          const isFresh = known.lastTurn === null || known.lastTurn.ending === 'answer'
          nap = { since: known.lastActiveAt, isStill: props.isStill, dozedS: isOwnRedraw && isFresh ? 0 : NAP_LATE_MS / 1000 }
        }
        const dozedS = nap?.dozedS
        return desk($.ui.resolve(e), {
          ...props,
          isFlinchAgain: known.isFlinchAgain,
          isFlinchKept,
          isSweating,
          dozedS,
        })
      }
      if (isOneRow) {
        return hearthRow($.ui.resolve(e), props, columns)
      }
      const { Client } = $.ui.resolve(e)

      return <Client key="hearth" module="./hearth/band.tsx" props={props} width={columns} height={isAside ? 0 : 3} />
    }

    // The hearth's frame is gone: its bead starts afresh when it comes back, and its nap frame
    // follows the beach's (whose z's were drifting).
    bead.shown = null
    bead.since = null
    nap = null
    timers.bead?.cancel()
    timers.bead = null
    // The sun crosses the beach's sky by the person's own clock, and the moon and stars come out as
    // night falls: one redraw at the sky's next step, armed from whichever draw comes first (a second
    // late, so the minute has turned).
    timers.sky ??= nudge($, skyTurnsIn(now) + 1_000, () => {
      timers.sky = null
    })
    // Under a splash the words are those its end hands the line on to (see deskAt), so the terminal's
    // splash, ending on its own frame clock, never shows a moment of what comes before them.
    const drawn = tideProps(tideInfo(deskAt(known, now)), motion, landed || isStarting, warnAt, columns, now, shownForMs, e.surface === 'desktop', greetedMs)
    if (e.surface === 'desktop') {
      // A fresh session's beach waits a moment for git: its where-line sets the beach's width, and
      // the branch joining it would narrow the beach under the words and start its frame over.
      // git's answer draws the band (this draw read the facts); a git slower than that, the wait's end.
      // Facts that cannot be read say nothing of git: the band draws at once, as a fresh one.
      const waited = now - firstDrawnAt
      if (isRead && !known.isGitRead && waited < GIT_WAIT_MS) {
        timers.git ??= nudge($, GIT_WAIT_MS - waited + 10, () => {
          timers.git = null
        })

        return next(e)
      }
      wordsPx = Math.max(wordsPx, linesPx(widthLines(drawn)))
      const props = { ...drawn, wordsPx }
      const shown = scenes.settle(props, now, kept)
      if (shown.keep !== undefined) {
        keepScene($, shown.keep)
      }
      if (shown.wakeIn !== null) {
        timers.stride ??= nudge($, shown.wakeIn + 10, () => {
          timers.stride = null
        })
      }

      return desktopBand($.ui.resolve(e), props, shown.scene)
    }
    if (isOneRow) {
      return tideRow($.ui.resolve(e), drawn, columns)
    }
    const { Client } = $.ui.resolve(e)

    return <Client key="band" module="./tide/band.tsx" props={{ ...drawn, isSwapped }} width={columns} height={isAside ? 0 : 3} />
  })
}

async function lookOf($: EngineInterface, activation: string, configured: unknown): Promise<Look> {
  return lookNow(await read($, pickOf), activation, configured)
}

/**
 * Writes the look to its /config row. Where the row is keyed otherwise (a folder loaded with
 * --plugin-dir is `session-band@inline`), /config's own list finds it, and `row` remembers it.
 */
async function save($: EngineInterface, row: Row, look: Look): Promise<Saved> {
  try {
    return savedAs(await $.config.set({ key: row.key, value: look }))
  } catch {
    try {
      const found = (await $.config.list()).find(isLookRow)
      if (found !== undefined && found.key !== row.key) {
        row.key = found.key

        return savedAs(await $.config.set({ key: row.key, value: look }))
      }
    } catch {
      // /config cannot be reached: the look switches for this session, and the reply says so.
    }

    return { kind: 'unsaved' }
  }
}

function savedAs(result: { deny?: string }): Saved {
  return result.deny !== undefined ? { kind: 'denied', reason: result.deny } : { kind: 'saved' }
}

function patch($: EngineInterface, change: (now: Info) => Partial<Info>): Promise<unknown> {
  return update($, info, stored => {
    const now = whole(stored)

    return { ...now, ...change(now) }
  })
}

/**
 * A change, with both looks' words stepped toward what is happening in the same write (the hearth's
 * held line and the tide's shown tool, each shown on both surfaces); when a hold runs out before
 * anything else happens, a timer looks again. The desktop's Clawd flinches as a hearth hiccup goes
 * up, and settles back (one redraw) as the flinch ends.
 */
async function settle($: EngineInterface, timers: Timers, time: number, change: (now: Info) => Partial<Info> = () => ({})): Promise<void> {
  let wakeIn = Infinity
  let isFlinch = false
  await patch($, now => {
    const changed = { ...now, ...change(now) }
    const held = stepHeld(changed, time)
    const shown = stepDesk(changed, time)
    // Each step changes its hold only when a threshold is crossed, so looking at the sooner of the two times changes neither.
    wakeIn = Math.min(held.wakeIn, shown.wakeIn)
    isFlinch = held.held.slip !== null && heldId(held.held) !== heldId(changed.held)

    return {
      ...changed,
      held: held.held,
      slipDue: held.slipDue,
      desk: shown.desk,
      flinchAt: isFlinch ? time : changed.flinchAt,
      // A flinch while the last one's frame may still be up (it plays, or stays up through the turn
      // after it: see the desktop's draw) is drawn under the other name, so the page starts it over.
      isFlinchAgain: isFlinch
        ? changed.flinchAt !== null && (time - changed.flinchAt < FLINCH_MS || changed.flinchAt >= (changed.turnAt ?? Number.POSITIVE_INFINITY)) && !changed.isFlinchAgain
        : changed.isFlinchAgain,
    }
  })
  if (isFlinch) {
    for (const ms of MOMENT_ENDS.flinch) nudge($, ms)
  }
  // One look again at a time: the last one's deadline is spent, whatever it was.
  letGo(timers)
  timers.desk = Number.isFinite(wakeIn) ? lookAgain($, timers, wakeIn + 10) : null
}

/** The desktop's look again, canceled and let go, so a later hold arms its own. */
function letGo(timers: Timers): void {
  timers.desk?.cancel()
  timers.desk = null
}

function lookAgain($: EngineInterface, timers: Timers, ms: number): Timer | null {
  return after($, ms, () => {
    void $.clock
      .now()
      .then(at => settle($, timers, at))
      .catch(() => undefined)
  })
}

/** The first draw of an activation: arms whatever the facts say is still to come (a reload dropped the timers). */
function rearm($: EngineInterface, timers: Timers, known: Info, now: number): void {
  const wakes = pendingWakes(known, now, MOMENT_ENDS)
  if (timers.nap === null && wakes.nap !== null) {
    timers.nap = nudge($, wakes.nap)
  }
  for (const ms of wakes.moments) {
    nudge($, ms)
  }
  if (timers.desk === null && wakes.hold !== null) {
    timers.desk = lookAgain($, timers, wakes.hold + 10)
  }
}

// A redraw a while from now, for a moment that ends with nothing else to say so. `fired` lets
// a timer kept in Timers let go of itself, so the next wait can arm its own.
function nudge($: EngineInterface, ms: number, fired: () => void = () => undefined): Timer | null {
  return after($, ms, () => {
    fired()
    void patch($, now => ({ beat: now.beat + 1 })).catch(() => undefined)
  })
}

// A copy of the desktop's last scene in `$.state`, so a reload of this module picks it up (a render
// cannot write, so the write comes a moment after).
function keepScene($: EngineInterface, shown: ShownScene | null): void {
  after($, 0, () => {
    void update($, sceneKept, () => shown).catch(() => undefined)
  })
}

// Any activity puts the nap off: the desktop's redraw that shows him asleep moves to three quiet minutes from now.
function napLater($: EngineInterface, timers: Timers, ms = NAP_AFTER_MS + NAP_LATE_MS): void {
  timers.nap?.cancel()
  timers.nap = nudge($, ms)
}

function after($: EngineInterface, ms: number, fn: () => void): Timer | null {
  try {
    return $.clock.after(ms, fn)
  } catch {
    return null
  }
}

// The motion is the band's own to remember; a store that will not take it still switches for the
// session (and through its reloads: see unsavedMotion). Whether the store took it.
async function remember($: EngineInterface, motion: string): Promise<boolean> {
  try {
    await $.store.set('motion', motion)

    return true
  } catch {
    return false
  }
}

/**
 * Looks at the prompt as it stands and writes whether one of its menus is up, only as one comes or
 * goes (typing is many edits, and each write redraws the band). A look that a newer one has followed
 * writes nothing, so looks that come back out of order still leave the band as the prompt is; a write
 * that fails is tried again at the next look.
 */
async function lookAtPrompt($: EngineInterface, menu: MenuSeen): Promise<void> {
  const look = ++menu.looks
  const box = await $.prompt.read().catch(() => null)
  if (box === null || look !== menu.looks) {
    return
  }
  // The typeahead reads the draft again only when its text changes: the caret moved alone leaves its
  // menu as it was, and so the band. A command named later in the draft needs the session's commands.
  if (box.text !== menu.text) {
    const commands = laterCommand(box.text, box.cursor) === null ? [] : await $.command.list().then(list => list.map(command => command.name), () => [])
    if (look !== menu.looks) {
      return
    }
    menu.text = box.text
    menu.isUp = isTypeahead(box.text, box.cursor, commands)
  }
  if (menu.isUp === menu.written) {
    return
  }
  try {
    // The newest answer, not this look's: two writes that land out of order still leave it right.
    menu.written = await update($, menuOf, () => menu.isUp)
  } catch {
    menu.written = null
  }
}

/**
 * What git says of the branch and the uncommitted count, each on its own: a command that answers
 * is written down, one that cannot (`git status` past its time in a big or cold repository, git
 * not there at all) says nothing, so the last thing known stays on line 3 rather than going blank.
 * Only git's own word that this is no repository clears both.
 */
async function gitState($: EngineInterface): Promise<Partial<Pick<Info, 'branch' | 'dirty'>>> {
  const [head, status] = await Promise.allSettled([
    $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 3000 }),
    $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 3000 }),
  ])
  if (head.status === 'fulfilled' && head.value.exitCode !== 0) {
    return { branch: null, dirty: null }
  }
  const found: Partial<Pick<Info, 'branch' | 'dirty'>> = {}
  if (head.status === 'fulfilled') {
    found.branch = head.value.stdout.trim()
  }
  if (status.status === 'fulfilled') {
    found.dirty = status.value.exitCode === 0 ? status.value.stdout.split('\n').filter(line => line.trim() !== '').length : null
  }

  return found
}

/**
 * The main loop's model as line 3 names it ("Opus 5.5"), read at the start and again at each prompt
 * and each turn's end, behind the model switch hook. A lookup that fails says nothing (null), and the
 * band keeps the last model it knew.
 */
async function modelNow($: EngineInterface): Promise<string | null> {
  try {
    const id = await $.session.model()
    return typeof id === 'string' && id.trim() !== '' ? prettyModel(id) : null
  } catch {
    return null
  }
}

/**
 * The project the band names where it says where you are (line 3 on the beach, line 1 by the
 * hearth): the repository's own name, else its root's folder, else the session's folder outside a
 * repository.
 */
function projectOf(repo: SessionRepo | null, cwd: string): string {
  return repo === null ? basename(cwd) : (repo.name?.split('/').pop() ?? basename(repo.root))
}

/**
 * The project for a band drawn before the start has written one down, read as the start reads it,
 * so the first frame already says where you are and the start's own word changes nothing. Null when
 * neither the repository nor the folder can be read.
 */
async function projectNow($: EngineInterface): Promise<string | null> {
  const [repo, cwd] = await Promise.all([orNothing($.session.repo()), orNothing($.session.cwd())])
  if (cwd === undefined) {
    return repo === undefined || repo === null ? null : projectOf(repo, repo.root)
  }

  return repo === undefined ? basename(cwd) : projectOf(repo, cwd)
}

/** What a lookup answered, or undefined when it failed. */
function orNothing<T>(asked: Promise<T>): Promise<T | undefined> {
  return asked.then(
    found => found,
    () => undefined,
  )
}

// Claude Code's own setting; when it asks for less motion, Clawd keeps still.
async function prefersReducedMotion($: EngineInterface): Promise<boolean> {
  try {
    const settings = await $.settings.read()
    return settings.prefersReducedMotion === true
  } catch {
    return false
  }
}

// Apple's Terminal draws block glyphs on colored backgrounds badly; Claude Code
// gives it a simpler Clawd, and both looks draw that one there too.
async function appleTerminal($: EngineInterface): Promise<boolean> {
  try {
    return (await $.env.get('TERM_PROGRAM')) === 'Apple_Terminal'
  } catch {
    return false
  }
}

// Ghostty, as Claude Code tells it (by TERM): its spinner draws its ✽ as a ✻ there, and the beach's
// cheer does the same.
async function ghostty($: EngineInterface): Promise<boolean> {
  try {
    return (await $.env.get('TERM')) === 'xterm-ghostty'
  } catch {
    return false
  }
}
