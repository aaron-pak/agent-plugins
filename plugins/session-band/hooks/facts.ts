// The band's facts about the session, and the pure functions that keep them: one set of facts that
// both looks read (each through its own view, ./tide/view.ts and ./hearth/view.ts). Nothing here
// touches the engine, so every rule can be tested on its own.

import type { SessionRateLimit, SessionUsage } from 'claude-code'

import { cells } from './clawd'
import type { Activity, DeskShown, Held, Info, LastTurn, Todo } from '../types'

export type Figures = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

export const DEFAULT_WARN_AT = 80
export const NAP_AFTER_MS = 3 * 60_000
/** The redraw that puts him to sleep comes this long after the nap is due (so it never comes early). */
export const NAP_LATE_MS = 1000
/** Clawd waves hello when the band first appears in a session, and only then (not each time a dialog hides and shows it again). */
export const GREET_MS = 5000
/**
 * How long a fresh session's desktop beach waits for git before its first frame: its words' lines
 * set the beach's width, and git's answer (the branch, the count, the model) joining line 3 would
 * narrow the beach under the words and start the frame over. git's answer draws it at once.
 */
export const GIT_WAIT_MS = 500
export const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
/** Tools that look at things: the tide's Clawd watches the words while they run. */
export const LOOK_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS', 'NotebookRead', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
/**
 * The tools that keep Claude's todos: bookkeeping, not a step of the work, so "Done in 41s · 5 tools"
 * counts the steps a turn took and leaves these out.
 */
export const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
/** Bookkeeping, handing off and asking: a turn doing only these is still a turn of watching, not of changing things. */
export const QUIET_TOOLS = new Set([
  ...TODO_TOOLS,
  'TaskOutput',
  'TaskStop',
  'BashOutput',
  'KillShell',
  'KillBash',
  'Agent',
  'Task',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'Skill',
  'ToolSearch',
  'SendMessage',
  'CronCreate',
  'CronDelete',
  'CronList',
])

// The desktop has no frame clock, so the hooks module holds what the words show while Claude
// works: a tool's words stay up at least a second, and a pause between tools shorter than three
// quarters of a second is no pause, so a burst of quick tools reads as one calm stretch of work.
// Both surfaces show this held step (the terminal's bands take it up on a tick of their own).
export const HOLD_MS = 1000
export const GAP_MS = 750
/**
 * How long the beach's splash is its line (both surfaces): its words, and on the desktop its frame's
 * moment. Nothing is held under it; the line moves on as it ends (see stepDesk).
 */
export const SPLASH_MS = 3_000
/**
 * A failure this soon after the wave began rides along with it, rather than splashing him again: the
 * wave is still rushing up the sand. Its words and its frame end with that wave (see splashAt).
 */
export const SPLASH_RUSH_MS = 1_250
/**
 * Claude Code may say the work is over a moment before the turn's own write lands. Until it
 * does, and for this long at most, the band goes on showing the work: it never flashes the last
 * turn's words, and the desktop never draws Clawd idle and then cheering.
 */
export const LANDING_MS = 1500
/** The most tools the band keeps as running at once: more is a turn gone strange, and the oldest give way. */
export const RUNNING_MAX = 32

/**
 * The tools still running once one starts (`started`) or ends (`ended`), in start order, and what the
 * band then says Claude is doing: the latest one still running. Tools overlap (Claude Code runs reads
 * and subagents side by side), so the words never drop to "Thinking it over" while one still runs,
 * and go back to the one still running when a later one ends first.
 */
export function runningAfter(running: readonly Activity[], change: { started: Activity } | { ended: string }): { running: Activity[]; activity: Activity | null } {
  const next = 'started' in change ? [...running.filter(one => one.id !== change.started.id), change.started].slice(-RUNNING_MAX) : running.filter(one => one.id !== change.ended)

  return { running: next, activity: next[next.length - 1] ?? null }
}

/** The longest an undescribed command is kept, its first line with an ellipsis. */
const COMMAND_MAX = 200

export const NOTHING_HELD: Held = { activity: null, slip: null, at: 0, next: null }
/** Shown since forever, so the first tool of a turn shows at once. */
export const NO_DESK: DeskShown = { activity: null, shownAt: 0, next: null }

export const EMPTY: Info = {
  model: null,
  project: null,
  branch: null,
  dirty: null,
  percent: null,
  usd: null,
  limit: null,
  lastActiveAt: null,
  activity: null,
  running: [],
  slip: null,
  lastSlip: null,
  slipDue: null,
  flinchAt: null,
  isFlinchAgain: false,
  isTurnOpen: false,
  toolEndedAt: null,
  held: NOTHING_HELD,
  lastTurn: null,
  todos: [],
  cheers: 0,
  oops: 0,
  isCalm: false,
  isAppleTerminal: false,
  isGhostty: false,
  isGitRead: false,
  beat: 0,
  turnPercent: null,
  turnWorked: false,
  workedAt: null,
  woke: false,
  desk: NO_DESK,
  cheeredAt: null,
  cheerPercent: null,
  oopsAt: null,
  oopsWhat: null,
  oopsName: null,
  oopsCommand: false,
  oopsNoun: null,
  oopsPercent: null,
  splashAt: null,
  waves: 0,
  treasurePercent: null,
  treasures: 0,
  castleFrom: 0,
  turnAt: null,
  greetedAt: null,
  isWarned: false,
  turnTools: 0,
  turnTodoTools: 0,
  turnFiles: [],
  unsavedMotion: null,
  livelyAt: null,
}

type Stored = Partial<Info> & { isStill?: unknown; lastTurn?: (Partial<LastTurn> & { isError?: unknown }) | null }

/**
 * The stored facts, with every field an older build did not keep filled in: older builds wrote a
 * narrower `info`, one with no beach facts, one with no hearth facts.
 */
export function whole(stored: Partial<Info>): Info {
  const old = stored as Stored
  const held = { ...NOTHING_HELD, ...old.held }
  const desk = { ...NO_DESK, ...old.desk }
  const activity = complete(old.activity)

  return {
    ...EMPTY,
    ...stored,
    activity,
    // An older build kept only the one activity: it is all that was running, as far as it knew.
    running: Array.isArray(old.running) ? old.running.flatMap(one => complete(one) ?? []) : activity === null ? [] : [activity],
    slip: complete(old.slip),
    lastSlip: complete(old.lastSlip),
    slipDue: complete(old.slipDue),
    held: { ...held, activity: complete(held.activity), slip: complete(held.slip), next: complete(held.next) },
    desk: { ...desk, activity: complete(desk.activity), next: complete(desk.next) },
    lastTurn: endingOf(old.lastTurn),
    turnFiles: Array.isArray(old.turnFiles) ? old.turnFiles : [],
    unsavedMotion: old.unsavedMotion === 'still' || old.unsavedMotion === 'lively' ? old.unsavedMotion : null,
    livelyAt: typeof old.livelyAt === 'number' ? old.livelyAt : null,
    // An older build splashed once a failure, from its own time, and counted no waves apart.
    splashAt: typeof old.splashAt === 'number' ? old.splashAt : (old.oopsAt ?? null),
    waves: typeof old.waves === 'number' ? old.waves : (old.oops ?? 0),
    // An older build kept the reduced-motion setting as `isStill`.
    isCalm: typeof old.isCalm === 'boolean' ? old.isCalm : old.isStill === true,
    // An older build wrote the project only once git had answered.
    isGitRead: typeof old.isGitRead === 'boolean' ? old.isGitRead : typeof old.project === 'string',
  }
}

// An activity from a build that kept no `what` names the call by what it showed.
function complete(activity: Activity | null | undefined): Activity | null {
  if (activity === null || activity === undefined) {
    return null
  }

  return typeof activity.what === 'string' ? activity : { ...activity, what: activity.target || activity.verb }
}

// An older build's last turn knew only whether it ended on an error.
function endingOf(turn: Stored['lastTurn']): LastTurn | null {
  if (turn === null || turn === undefined) {
    return null
  }
  if (turn.ending === 'answer' || turn.ending === 'stopped' || turn.ending === 'error') {
    return turn as LastTurn
  }
  const number = (n: unknown) => (typeof n === 'number' ? n : 0)

  return { seconds: number(turn.seconds), tools: number(turn.tools), files: number(turn.files), ending: turn.isError === true ? 'error' : 'answer' }
}

/**
 * Whether a tool the hold kept off the line (`next`) is still owed its second once nothing is at
 * work: only while the pause since the tools last ran is under a second (a step done with longer ago
 * is the past, never news), never what is already up, and never a plan or a wait on you once over.
 * A plan's todos are already on the line (the thinking line names the todo at work, the tally
 * counts it), so "Planning" after them would only go back to before them; a question answered is
 * no question. (A `next` that is what is up is already cleared as it goes up; the id check only
 * keeps this function true to its name on its own.)
 */
function isOwed(next: Activity | null, shown: Activity | null, quietFor: number, within = HOLD_MS): next is Activity {
  return next !== null && next.id !== shown?.id && next.kind !== 'plan' && next.kind !== 'ask' && quietFor < within
}

/**
 * Whether a step now on the line is a wait on you that is over (a question answered, a plan looked
 * over): it goes at once, with no pause held, since the person has just answered it.
 */
function isAnswered(shown: Activity | null, running: Activity | null): boolean {
  return shown !== null && shown.kind === 'ask' && shown.id !== running?.id
}

/**
 * What the hearth's third line shows next, on both surfaces (the terminal's band takes it up on a
 * tick of its own frame clock): the tool at work (or the one that failed), once what is up has been
 * up a second; nothing at all once the tools have been quiet three quarters of a second. A tool the
 * hold kept off the line (one that started and, often, ended while something else had its second:
 * `next`) has its second once the hold is over, if nothing else is at work by then and it is still
 * owed one (see isOwed); only the latest such tool, so a burst still reads as a calm few. A failure's
 * hiccup has its second whatever starts next, or runs on beside it, and only then gives way: to a
 * tool still running, else it stays until the next tool starts. It takes over at once from its own
 * tool, and from "Thinking it over": a failure is never a flicker to be held back. A question once
 * answered goes at once. `wakeIn` is when to look again.
 */
export function stepHeld(now: Info, time: number): { held: Held; slipDue: Activity | null; wakeIn: number } {
  const was: Held = { ...NOTHING_HELD, ...now.held }
  const line = heldLine(now, time)
  const isStep = line.held.at !== was.at || heldId(line.held) !== heldId(was)
  // A hiccup stays up until the next tool starts: only a step of work that is over moves the line on.
  const tally = tallied(was, now, time, isStep, isMoving(line.held.activity, line.held.next ?? null, now.activity))
  const isThinking = line.held.activity === null && line.held.slip === null

  return {
    held: { ...line.held, at: tally.isTodoStep && isThinking ? time : line.held.at, todos: tally.todos, todosAt: tally.todosAt },
    slipDue: line.slipDue,
    wakeIn: Math.min(line.wakeIn, tally.wakeIn),
  }
}

/** The hearth's line alone, before its todos (see stepHeld). */
function heldLine(now: Info, time: number): { held: Held; slipDue: Activity | null; wakeIn: number } {
  const held: Held = { ...NOTHING_HELD, ...now.held }
  const age = time - held.at
  let due = now.slipDue
  if (due !== null && held.slip?.id === due.id && age >= HOLD_MS) {
    due = null
  }
  const quietFor = now.toolEndedAt === null ? Infinity : time - now.toolEndedAt
  const isFailed = (activity: Activity | null | undefined) => activity != null && activity.id === now.lastSlip?.id
  // A running tool on the line, or a failure, ends any claim a tool the hold kept off it had.
  let next = (now.activity !== null && now.activity.id === held.activity?.id) || isFailed(held.next) ? null : (held.next ?? null)
  let wakeIn = Infinity
  let want: Pick<Held, 'activity' | 'slip'>
  if (due !== null) {
    want = { activity: null, slip: due }
  } else if (now.activity !== null) {
    // A tool still running beside the one that failed (a subagent, say) has the line back once the
    // hiccup has had its second: the words never sit on a failure while something else works.
    want = { activity: now.activity, slip: null }
  } else if (now.slip !== null) {
    want = { activity: null, slip: now.slip }
  } else if (quietFor < GAP_MS && !isAnswered(held.activity, now.activity)) {
    // A pause this short is no pause: what is up stays up.
    want = held
    wakeIn = GAP_MS - quietFor
  } else {
    want = { activity: null, slip: null }
  }
  // Nothing at work, and a tool the hold kept off the line: it has its second now, if still owed it.
  const isQuiet = due === null && now.activity === null && now.slip === null
  const kept = isQuiet && isOwed(next, held.activity, quietFor) ? next : null
  if (kept !== null && age >= HOLD_MS) {
    return { held: { activity: kept, slip: null, at: time, next: null }, slipDue: due, wakeIn: HOLD_MS }
  }
  if (age >= HOLD_MS && kept === null && isQuiet) {
    // The hold is over and nothing it kept off the line is owed a second: none waits any more.
    next = null
  }
  if (heldId(want) === heldId(held)) {
    // A hiccup up, or a tool waiting its turn: look again when this second is over.
    const isWaiting = due !== null || kept !== null
    return { held: { ...held, next }, slipDue: due, wakeIn: isWaiting ? Math.min(wakeIn, HOLD_MS - age) : wakeIn }
  }
  // A hiccup takes over from its own tool at once (the line keeps its subject and says it stumbled),
  // and from "Thinking it over".
  const isOwn = want.slip !== null && (held.activity?.id === want.slip.id || (held.activity === null && held.slip === null))
  if (age >= HOLD_MS || isOwn) {
    return { held: { activity: want.activity, slip: want.slip, at: time, next: null }, slipDue: due, wakeIn: due !== null ? HOLD_MS : wakeIn }
  }
  if (want.activity !== null && want.activity.id === now.activity?.id && !isSaid(want.activity, held.activity)) {
    next = want.activity
  }

  return { held: { ...held, next }, slipDue: due, wakeIn: Math.min(wakeIn, HOLD_MS - age) }
}

/**
 * Whether two tools read the same on the line ("Planning" for a TaskCreate and the TaskUpdate after
 * it, a file read twice): one the hold kept off the line that says what is already up has no second
 * of its own to wait for.
 */
function isSaid(one: Activity, other: Activity | null): boolean {
  return other !== null && one.kind === other.kind && one.verb === other.verb && one.target === other.target
}

/** How long a todo ticked off waits for a step to bring it (the step after it usually starts within this). */
export const TALLY_WAIT_MS = 500
/** The longest it waits for a step on its way to the line (one takes it within its hold, a second or so). */
export const TALLY_MOST_MS = 2_000

/** The todos a line shows beside its step, and since when the facts' own have been otherwise (null: they agree). */
type Tally = { todos?: Todo[]; todosAt?: number | null }

/**
 * The todos a line shows beside its step (the tally, "1 of 3 done", and the todo at work on the line
 * with no tool on it, "Doing step 1"): the list as it was when the step went up. A todo ticked off
 * (TodoWrite) while a step is up waits for the step the line moves on to, which brings it, so the
 * line changes once, the same on all four views: never the tally on its own for a tick before the
 * step, nor a todo's own line ("Doing step 1") for a tick before the read that follows it. It
 * waits half a second for a step to start, and while the line is on its way to one (two seconds at
 * most); then it shows on its own, and a new todo at work on the line with no tool on it is a step of
 * its own (`isTodoStep`: it has its second, as any step does). Out of a turn the list is as it is.
 */
function tallied(shown: Tally, known: Info, time: number, isStep: boolean, isLineMoving: boolean): Required<Tally> & { wakeIn: number; isTodoStep: boolean } {
  const was = shown.todos
  if (isStep || was === undefined || !known.isTurnOpen || JSON.stringify(was) === JSON.stringify(known.todos)) {
    return { todos: known.todos, todosAt: null, wakeIn: Infinity, isTodoStep: false }
  }
  const since = shown.todosAt ?? time
  const left = (isLineMoving ? TALLY_MOST_MS : TALLY_WAIT_MS) - (time - since)
  if (left > 0) {
    return { todos: was, todosAt: since, wakeIn: left, isTodoStep: false }
  }

  return { todos: known.todos, todosAt: null, wakeIn: Infinity, isTodoStep: atWork(was) !== atWork(known.todos) }
}

/**
 * Whether a line is on its way to another step: the step of work on it is over (the next tool, or
 * the line with no tool on it, takes it within its hold or its pause), or a tool waits for the hold
 * to take it. A plan or a wait on you kept off the line never takes it (see isOwed).
 */
function isMoving(shown: Activity | null, next: Activity | null, running: Activity | null): boolean {
  const isOver = shown !== null && shown.id !== running?.id
  const isWaiting = running !== null && running.id !== shown?.id
  const isOwedNext = next !== null && next.id !== shown?.id && next.kind !== 'plan' && next.kind !== 'ask'

  return isOver || isWaiting || isOwedNext
}

/** The todo at work, as the line with no tool on it says it: the one in progress, else the first to do. */
function atWork(todos: Todo[]): string | null {
  const current = todos.find(todo => todo.status === 'in_progress') ?? todos.find(todo => todo.status === 'pending')

  return current === undefined ? null : (current.activeForm ?? current.subject)
}

/** The todos a view shows: as its line holds them while a turn runs (see tallied), else as they are. */
export function shownTodos(known: Pick<Info, 'isTurnOpen' | 'todos'>, shown: Tally): Todo[] {
  return known.isTurnOpen && shown.todos !== undefined ? shown.todos : known.todos
}

export function heldId(held: Pick<Held, 'activity' | 'slip'>): string {
  return held.slip !== null ? `slip ${held.slip.id}` : held.activity !== null ? held.activity.id : ''
}

/** How much longer than its second a step the splash hands the line on to may be held: a terminal tick (see stepDesk). */
const HANDED_LATE_MS = 250

/**
 * When the beach's splash for this turn's failures ends, while it is still to end or its end has yet
 * to hand the line on (see stepDesk): its wave's start, and its seconds. A failure that rode along
 * with the wave ends with it. Null with no failure in this turn, or one Esc took back.
 */
function splashEndOf(known: Pick<Info, 'lastSlip' | 'oopsAt' | 'splashAt'>): number | null {
  return known.lastSlip !== null && known.oopsAt !== null ? (known.splashAt ?? known.oopsAt) + SPLASH_MS : null
}

/**
 * Whether a failure at `at` starts a new wave on the beach: none is under way, the one that is began
 * in an earlier turn (one that landed, with its cheer, since), or it has had its first rush up the
 * sand, so it splashes him again. A failure in that rush, in the same turn, rides along.
 */
export function isNewWave(known: Pick<Info, 'oopsAt' | 'splashAt' | 'turnAt'>, at: number): boolean {
  return known.oopsAt === null || known.splashAt === null || at - known.splashAt >= SPLASH_RUSH_MS || (known.turnAt !== null && known.splashAt < known.turnAt)
}

/**
 * What the beach's words show Claude doing next, on both surfaces (the terminal's band takes it up on
 * its own frame clock), and in how many ms to look again (Infinity: nothing pending). The tool at
 * work, once what is up has been up a second; the last one through a pause shorter than three
 * quarters of a second; a tool the hold kept off the line (`next`, as the hearth's) once the hold is
 * over, if still owed it (see isOwed). A step that failed is never held up as if it still ran: the
 * line lets it go at once, for the splash (and then what failed) to say what happened.
 *
 * The splash is the line for its seconds: no hold runs under it (one would run out unseen, and the
 * words would flash its last few milliseconds as the splash ended). The latest tool to start under it
 * waits (`next`), and as it ends the line moves on, with a second of its own from there: to a tool
 * still at work, or one that ended less than three quarters of a second before (a pause that short is
 * no pause), held a tick past its second so the terminal has its second too; else to nothing (the dim line of what failed, or "Thinking it over"), with no second
 * held, so the next tool shows as it starts.
 */
export function stepDesk(known: Info, time: number): { desk: DeskShown; wakeIn: number } {
  const was: DeskShown = { ...NO_DESK, ...known.desk }
  const line = deskLine(known, time)
  const isStep = line.desk.shownAt !== was.shownAt || (line.desk.activity?.id ?? null) !== (was.activity?.id ?? null)
  const tally = tallied(was, known, time, isStep, isMoving(line.desk.activity, line.desk.next ?? null, known.activity))

  return {
    desk: { ...line.desk, shownAt: tally.isTodoStep && line.desk.activity === null ? time : line.desk.shownAt, todos: tally.todos, todosAt: tally.todosAt },
    wakeIn: Math.min(line.wakeIn, tally.wakeIn),
  }
}

/** The beach's line alone, before its todos (see stepDesk). */
function deskLine(known: Info, time: number): { desk: DeskShown; wakeIn: number } {
  const desk: DeskShown = { ...NO_DESK, ...known.desk }
  const shown = desk.activity
  const running = known.activity
  const age = time - desk.shownAt
  const quiet = known.toolEndedAt === null ? Infinity : time - known.toolEndedAt
  const isFailed = (activity: Activity | null | undefined) => activity != null && activity.id === known.lastSlip?.id
  const splashEnd = splashEndOf(known)
  if (splashEnd !== null && desk.shownAt < splashEnd) {
    const waiting = running ?? (isFailed(desk.next) ? null : (desk.next ?? null))
    if (time < splashEnd) {
      // Under the splash: a failed step's running words go at once (to a tool still running beside
      // it), and nothing else moves until it ends. (Nothing shows them under the splash, and its end
      // hands the line on from `waiting` alone, so keeping them would draw the same. Letting them go
      // keeps the facts true to what runs.)
      const under: DeskShown = isFailed(shown) ? { activity: running, shownAt: time, next: waiting } : { ...desk, next: waiting }
      return { desk: under, wakeIn: splashEnd - time }
    }
    // (`waiting` is never the failed step, which `waiting` already leaves out: the second test only
    // says so again, and drawing would be the same without it.)
    const after = running ?? (isOwed(waiting, null, quiet, GAP_MS) && !isFailed(waiting) ? waiting : null)
    if (after === null) {
      // Nothing to hand on to: the line falls to the dim words of what failed (or "Thinking it over")
      // with no second held, so the next tool to start shows at once, as after any splash.
      return { desk: { activity: null, shownAt: desk.shownAt, next: null }, wakeIn: Infinity }
    }
    // Its second counts from when the terminal can take it up, so it has its second there too: a tick
    // past the splash's end for one already waiting (the terminal's splash frames fill its second, so
    // it takes the step up no sooner than its next tick: see pace.ts); for one that starts in the quiet
    // just after, a tick after it starts, or two past the splash's end, whichever is sooner (the
    // terminal's splash falls to its quiet line on its first tick past the end, and that line keeps a
    // tick: see quietAt in tide/band.tsx). A later one counts from its start, as any step does.
    const shownAt = Math.max(time, Math.min(time + HANDED_LATE_MS, splashEnd + 2 * HANDED_LATE_MS))
    const handed: DeskShown = { activity: after, shownAt, next: null }

    return { desk: handed, wakeIn: deskLine({ ...known, desk: handed }, time).wakeIn }
  }
  if (isFailed(shown)) {
    return { desk: { activity: running, shownAt: time, next: null }, wakeIn: Infinity }
  }
  let next = (running !== null && running.id === shown?.id) || isFailed(desk.next) ? null : (desk.next ?? null)
  let wakeIn = Infinity
  let want = running
  if (want === null && quiet < GAP_MS && !isAnswered(shown, running)) {
    // Between two tools: the words stay on the last one unless the pause lasts.
    want = shown
    wakeIn = GAP_MS - quiet
  }
  // Nothing at work, and a tool the hold kept off the line: it has its second now, if still owed it.
  const kept = running === null && isOwed(next, shown, quiet) ? next : null
  if (kept !== null && age >= HOLD_MS) {
    return { desk: { activity: kept, shownAt: time, next: null }, wakeIn: HOLD_MS }
  }
  if (age >= HOLD_MS && kept === null && running === null) {
    // The hold is over and nothing it kept off the line is owed a second: none waits any more.
    next = null
  }
  if ((want?.id ?? null) === (shown?.id ?? null)) {
    return { desk: { ...desk, next }, wakeIn: kept !== null ? Math.min(wakeIn, HOLD_MS - age) : wakeIn }
  }
  if (age >= HOLD_MS) {
    return { desk: { activity: want, shownAt: time, next: null }, wakeIn }
  }
  if (want !== null && want.id === running?.id && !isSaid(want, shown)) {
    next = want
  }

  return { desk: { ...desk, next }, wakeIn: Math.min(wakeIn, HOLD_MS - age) }
}

/**
 * The facts as the beach draws them at `now`: its words' own step, except while a splash has yet to
 * hand the line on, when they are the step its end hands on to, as things stand (see stepDesk; any
 * tool that starts or ends before then writes the facts, and so draws again). Neither surface shows
 * those words before the splash is over (the terminal's splash, timed on its own frame clock, may end
 * up to a tick before the hand-over is written, and keeps its words until the facts say it is over).
 */
export function deskAt(known: Info, now: number): Info {
  const splashEnd = splashEndOf(known)

  return splashEnd !== null && known.desk.shownAt < splashEnd ? { ...known, desk: stepDesk(known, Math.max(now, splashEnd)).desk } : known
}

/** When each moment's redraws come, in ms after it starts (a cheer has one per look), so a fresh activation knows which are still to come. */
type MomentSpans = { cheer: readonly number[]; splash: readonly number[]; flinch: readonly number[] }

/**
 * The redraws a fresh activation of the plugin must arm (in ms from `now`): a reload (a /config
 * change, a worker respawn) drops every timer, while the facts say a moment is still playing, a
 * hold is still running or the nap is still to come. Each comes from the facts alone.
 */
export function pendingWakes(known: Info, now: number, spans: MomentSpans): { nap: number | null; moments: number[]; hold: number | null } {
  const ahead = (at: number | null, ends: readonly number[]): number[] =>
    at === null ? [] : ends.filter(end => at + end > now).map(end => at + end - now)
  const napAt = known.lastActiveAt === null ? null : known.lastActiveAt + NAP_AFTER_MS + NAP_LATE_MS
  const hold = Math.min(stepHeld(known, now).wakeIn, stepDesk(known, now).wakeIn)

  return {
    nap: napAt === null || napAt <= now ? null : napAt - now,
    moments: [...ahead(known.cheeredAt, spans.cheer), ...ahead(known.oopsAt === null ? null : (known.splashAt ?? known.oopsAt), spans.splash), ...ahead(known.flinchAt, spans.flinch)],
    hold: Number.isFinite(hold) ? hold : null,
  }
}

/**
 * How long something took, the way Claude Code's own spinner says it, longest first: "41s";
 * "2m 14s", then "2m"; "1h 2m", then "1h". The shorter form is for a narrow band, which keeps the
 * figure whole rather than cutting it; a round figure ("2m", "1h") has only the one form.
 */
export function durationForms(seconds: number): string[] {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) {
    return [`${s}s`]
  }
  if (s < 3600) {
    const [m, rest] = [Math.floor(s / 60), s % 60]
    return rest === 0 ? [`${m}m`] : [`${m}m ${rest}s`, `${m}m`]
  }
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)]

  return m === 0 ? [`${h}h`] : [`${h}h ${m}m`, `${h}h`]
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * When a limit resets, as a time of day the way Claude Code says one ("3pm", "4:30pm"), in the
 * person's own time; a day name before it when it is most of a day away ("Tue 4pm"). A time of day
 * never goes stale on a band that is not redrawn, as a countdown would. Null once it has passed.
 */
export function clockText(at: number | null, now: number): string | null {
  if (at === null || !Number.isFinite(at) || at <= now) {
    return null
  }
  const when = new Date(Math.round(at / 60_000) * 60_000)
  const hours = when.getHours()
  const minutes = when.getMinutes()
  const time = `${hours % 12 === 0 ? 12 : hours % 12}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`}${hours < 12 ? 'am' : 'pm'}`

  return at - now >= 20 * 3_600_000 ? `${DAYS[when.getDay()] ?? ''} ${time}` : time
}

/** Night over the beach, in the person's own time: from 8 in the evening until 6 in the morning. */
export const NIGHT_FROM_HOUR = 20
export const NIGHT_UNTIL_HOUR = 6

/** Whether it is night at `now`, by the person's own clock: the stars are out over the beach. */
export function isNightAt(now: number): boolean {
  const hour = new Date(now).getHours()

  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR
}

/** The sun crosses the beach's sky by day, and the moon by night, a step every this many minutes. */
export const SKY_STEP_MINUTES = 20

/**
 * How many steps (SKY_STEP_MINUTES each) the sun has taken across the sky by day, or the moon by
 * night, at `now`, by the person's own clock: 0 as day breaks or night falls.
 */
export function skyStepAt(now: number): number {
  const at = new Date(now)
  const from = (isNightAt(now) ? NIGHT_FROM_HOUR : NIGHT_UNTIL_HOUR) * 60
  const minutes = (at.getHours() * 60 + at.getMinutes() - from + 24 * 60) % (24 * 60)

  return Math.floor(minutes / SKY_STEP_MINUTES)
}

/** How many steps the sun takes across the sky in a day (`isNight` false), or the moon in a night. */
export function skySteps(isNight: boolean): number {
  const hours = isNight ? 24 - NIGHT_FROM_HOUR + NIGHT_UNTIL_HOUR : NIGHT_FROM_HOUR - NIGHT_UNTIL_HOUR

  return (hours * 60) / SKY_STEP_MINUTES
}

/**
 * How long from `now` until the sky next moves, in milliseconds, by the person's own clock: the sun's
 * or the moon's next step, nightfall and daybreak among them (each falls on a step).
 */
export function skyTurnsIn(now: number): number {
  const at = new Date(now)
  const into = ((at.getMinutes() % SKY_STEP_MINUTES) * 60 + at.getSeconds()) * 1000 + at.getMilliseconds()

  return SKY_STEP_MINUTES * 60_000 - into
}

export function figures(usage: Figures | null): Partial<Info> {
  const limit = limitShown(usage?.rateLimits ?? [])

  return {
    percent: usage?.context.percent ?? null,
    usd: usage?.cost?.usd ?? null,
    limit: limit === undefined ? null : { kind: limit.kind, percent: limit.percentUsed, resetsAt: limit.resetsAt ?? null },
  }
}

/**
 * The limit the band shows: the 5-hour one (the one a session most often runs into, and soonest
 * reset), unless another is nearer its end and at 80% or more (a 7-day limit at 95% beside a
 * 5-hour one at 10%). Below that the 5-hour one keeps its place, so the line never flips between
 * two limits that are both a long way off.
 */
export function limitShown(limits: readonly SessionRateLimit[]): SessionRateLimit | undefined {
  const usual = limits.find(one => one.kind === 'five_hour') ?? limits[0]
  const nearest = [...limits].sort((a, b) => b.percentUsed - a.percentUsed)[0]

  return nearest !== undefined && nearest.percentUsed >= 80 && nearest.percentUsed > (usual?.percentUsed ?? -1) ? nearest : usual
}

/** A limit's short name, as Claude Code's own notices say it: "5h", "7d", "spend". */
export function limitLabel(kind: string): string {
  return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind.replace(/_/gu, ' ')
}

/**
 * What a tool is doing, in a few words, and what to call it if it fails. A described command reads
 * best as its description alone ("Run the tests"); every text is kept to its first line, its runs
 * of spaces and tabs made one space, so nothing but plain words ever reaches a terminal cell.
 */
export function describe(id: string, e: { tool: string } & Record<string, unknown>): Activity {
  const text = (key: string) => (typeof e[key] === 'string' ? oneLine(e[key] as string) : '')
  const tool = String(e.tool)
  switch (tool) {
    case 'Read': {
      const file = basename(text('file_path'))
      return { id, kind: 'read', verb: 'Reading', target: file, what: `Read ${file}` }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = basename(text('file_path') || text('notebook_path'))
      return { id, kind: 'edit', verb: 'Editing', target: file, what: `Edit ${file}` }
    }
    case 'Write': {
      const file = basename(text('file_path'))
      return { id, kind: 'edit', verb: 'Writing', target: file, what: `Write ${file}` }
    }
    case 'Bash': {
      const description = text('description')
      if (description !== '') {
        return { id, kind: 'run', verb: '', target: description, what: description }
      }
      const command = capped(text('command'))
      return { id, kind: 'run', verb: 'Running', target: command, what: command }
    }
    case 'Grep':
    case 'Glob': {
      const pattern = text('pattern')
      return { id, kind: 'read', verb: 'Searching for', target: pattern, what: `Search for ${pattern}` }
    }
    case 'WebFetch': {
      const host = hostOf(text('url'))
      // Quoted as its working line reads it ('"Read docs.anthropic.com" failed'), one verb for one step.
      return { id, kind: 'web', verb: 'Reading', target: host, what: `Read ${host}` }
    }
    case 'WebSearch': {
      const query = text('query')
      return { id, kind: 'web', verb: 'Searching the web for', target: query, what: `Search the web for ${query}` }
    }
    case 'Agent':
    case 'Task': {
      // What the subagent was asked to do, in Claude's own words: "Delegating: Explore the hooks folder".
      const description = text('description')
      return { id, kind: 'other', verb: 'Delegating', target: description, what: description || SUBAGENT }
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { id, kind: 'plan', verb: 'Planning', target: '', what: 'Update the todos' }
    case 'TaskList':
    case 'TaskGet':
      return { id, kind: 'plan', verb: 'Planning', target: '', what: 'Check the todos' }
    case 'EnterPlanMode':
      return { id, kind: 'plan', verb: 'Planning', target: '', what: 'Start planning' }
    case 'AskUserQuestion': {
      // A question for you, by the chip Claude gave its first question ("Asking you: Auth method"): a
      // wait on you, so Clawd is at rest and the words are in the quiet dim, as "Ready" is.
      const first: unknown = Array.isArray(e.questions) ? e.questions[0] : undefined
      const header = typeof first === 'object' && first !== null && typeof (first as { header?: unknown }).header === 'string' ? oneLine((first as { header: string }).header) : ''
      return header === ''
        ? { id, kind: 'ask', verb: ASKING_ALONE, target: '', what: 'Ask you a question' }
        : { id, kind: 'ask', verb: ASKING, target: header, what: 'Ask you a question' }
    }
    case 'ExitPlanMode':
      // The plan, ready for you to look over: a wait on you too.
      return { id, kind: 'ask', verb: 'Plan ready for you', target: '', what: 'Share the plan' }
    case 'Skill': {
      // "Using the plugin-authoring skill", its name as the person knows it (without its plugin's).
      const skill = text('skill').replace(/^.*:/u, '')
      return skill === ''
        ? { id, kind: 'other', verb: SKILL_ALONE, target: '', what: 'Use a skill' }
        : { id, kind: 'other', verb: SKILL, target: skill, what: `Use the ${skill} skill` }
    }
    case 'ToolSearch':
      return { id, kind: 'other', verb: 'Finding tools', target: '', what: 'Find tools' }
    case 'EnterWorktree':
      // A worktree of its own for the work (Claude Code makes it and moves the session into it).
      return { id, kind: 'other', verb: 'Entering a worktree', target: '', what: 'Enter a worktree' }
    case 'ExitWorktree':
      return { id, kind: 'other', verb: 'Leaving the worktree', target: '', what: 'Leave the worktree' }
    case 'BashOutput':
      // A command left running in the background, looked in on, or stopped.
      return { id, kind: 'run', verb: 'Checking on a command', target: '', what: 'Check on a command' }
    case 'TaskOutput':
      return { id, kind: 'run', verb: 'Checking on a task', target: '', what: 'Check on a task' }
    case 'KillShell':
    case 'KillBash':
      return { id, kind: 'run', verb: 'Stopping a command', target: '', what: 'Stop a command' }
    case 'TaskStop':
      return { id, kind: 'run', verb: 'Stopping a task', target: '', what: 'Stop a task' }
    case 'SendMessage':
      // A word to another agent at work beside this one.
      return { id, kind: 'other', verb: 'Sending a message', target: '', what: 'Send a message' }
    case 'CronCreate':
      return { id, kind: 'other', verb: 'Scheduling a task', target: '', what: 'Schedule a task' }
    case 'CronDelete':
      return { id, kind: 'other', verb: 'Canceling a scheduled task', target: '', what: 'Cancel a scheduled task' }
    case 'CronList':
      return { id, kind: 'other', verb: 'Checking the schedule', target: '', what: 'Check the schedule' }
    case 'ListMcpResourcesTool':
      return { id, kind: 'other', verb: 'Listing resources', target: '', what: 'List resources' }
    case 'ReadMcpResourceTool':
      return { id, kind: 'other', verb: 'Reading a resource', target: '', what: 'Read a resource' }
    case 'LS': {
      // Looking, so Clawd glances at it, and said in words as a read is: "Listing hooks".
      const folder = basename(text('path'))
      return { id, kind: 'read', verb: 'Listing', target: folder, what: folder === '' ? 'List the files' : `List ${folder}` }
    }
    case 'NotebookRead': {
      const file = basename(text('notebook_path'))
      return { id, kind: 'read', verb: 'Reading', target: file, what: `Read ${file}` }
    }
    default: {
      if (tool.startsWith('mcp__')) {
        // Another server's tool, by the name the person knows it by: "Using Linear: create issue";
        // what it did, an order as every other tool's is: "Use Linear: create issue".
        const name = mcpName(tool)
        return { id, kind: 'other', verb: 'Using', target: name, what: `Use ${name}` }
      }
      // One of Claude Code's own with no words of its own here: its name in words, as a set phrase
      // read whole or not at all ("Using memory list", then "Using a tool"), never a code name.
      const words = toolWords(tool)
      return { id, kind: 'other', verb: `Using ${words}`, target: '', what: `Use ${words}` }
    }
  }
}

/** A question for you, by its chip: "Asking you: Auth method". */
const ASKING = 'Asking you'
/** A question for you with no chip to name it. */
const ASKING_ALONE = 'Asking you a question'
/** A skill at work, before its name: "Using the plugin-authoring skill". */
export const SKILL = 'Using the'
/** A skill with no name to give, or no room for it. */
export const SKILL_ALONE = 'Using a skill'

/**
 * The forms of a line for a tool with nothing to name, whose words are a set phrase ("Finding
 * tools", "Checking on a command", "Plan ready for you"), longest first: on the narrowest band, what
 * it is doing ("Checking", "Plan ready"), or for a tool it is "Using", "Using a tool". A phrase is
 * read whole or not at all: never cut ("Using enter…"). A verb alone ("Planning") has one form.
 */
export function phraseForms(verb: string): string[] {
  const shorter = PHRASES[verb] ?? (verb.startsWith('Using ') && verb !== USING_A_TOOL ? USING_A_TOOL : undefined)

  return [verb, ...(shorter === undefined ? [] : typeof shorter === 'string' ? [shorter] : shorter)]
}

/** Any tool, on a line with no room to say which: the last form of every "Using" line. */
const USING_A_TOOL = 'Using a tool'

const PHRASES: Record<string, string | readonly string[]> = {
  [ASKING_ALONE]: ASKING,
  'Plan ready for you': 'Plan ready',
  'Checking on a command': 'Checking',
  'Checking on a task': 'Checking',
  'Stopping a command': 'Stopping',
  'Stopping a task': 'Stopping',
  'Finding tools': 'Searching',
  // Never a bare "Entering" or "Leaving", which want their object.
  'Entering a worktree': 'New worktree',
  'Leaving the worktree': ['Leaving worktree', USING_A_TOOL],
  'Sending a message': 'Sending',
  'Scheduling a task': 'Scheduling',
  'Canceling a scheduled task': 'Canceling',
  'Checking the schedule': 'Checking',
  'Listing resources': 'Listing',
  'Reading a resource': 'Reading',
}

/**
 * A tool's code name in words, its humps and underscores made spaces and its words in lower case
 * (an acronym stays as it is, or is put back as one: "Mcp" reads "MCP"), less a "Tool" at its end
 * that says nothing: `EnterWorktree` reads "enter worktree", `memory_list` "memory list", `LSP`
 * "LSP", `ReadMcpResourceDirTool` "read MCP resource dir".
 */
function toolWords(tool: string): string {
  const words = tool
    .replace(/[_\s]+/gu, ' ')
    .replace(/(\p{Ll}|\d)(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .trim()
    .split(' ')
    .filter(word => word !== '')
  const said = words.length > 1 && words.at(-1)?.toLowerCase() === 'tool' ? words.slice(0, -1) : words

  return said
    .map(word => ([...word].length > 1 && word === word.toUpperCase() ? word : ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()))
    .join(' ')
}

/** Short names a tool's code name may spell as a word ("Mcp"), said as the acronyms they are. */
const ACRONYMS = new Set(['mcp', 'lsp', 'api', 'url', 'id', 'ui', 'cli', 'sdk', 'json', 'html', 'css', 'http', 'ssh', 'pr', 'ide'])

/**
 * An MCP tool's name in words: its server as the person knows it, and what it does, with underscores
 * and hyphens made spaces. A connector's server drops the `claude_ai_` Claude puts before it, and a
 * plugin's its `plugin_<plugin>_`; a server named all in lower case is a name all the same, so its
 * first letter goes up (and a few known brands are spelled their way): `mcp__claude_ai_Linear__create_issue`
 * reads "Linear: create issue", `mcp__plugin_github_github__create_pull_request` "GitHub: create pull
 * request", `mcp__Google_Drive__search_files` "Google Drive: search files".
 */
function mcpName(tool: string): string {
  const [server = '', ...rest] = tool.split('__').slice(1)
  const spaced = (text: string) => text.replace(/[_\s-]+/gu, ' ').trim()
  const owner = spaced(server.replace(/^claude_ai_(?=.)/u, '').replace(/^plugin_[^_]+_(?=.)/u, '')) || spaced(server)
  const action = spaced(rest.join(' '))
  const named = BRANDS[owner.toLowerCase()] ?? (owner === owner.toLowerCase() ? owner.replace(/^\p{Ll}/u, first => first.toUpperCase()) : owner)

  return action === '' ? named : `${named}: ${action}`
}

/** Servers whose names are spelled their own way. */
const BRANDS: Record<string, string> = { 'claude ai': 'Claude', github: 'GitHub', gitlab: 'GitLab', youtube: 'YouTube', hubspot: 'HubSpot', clickup: 'ClickUp' }

/**
 * The name in what a tool did, when that is a verb and a name ("Read register.tsx", "Read
 * docs.anthropic.com", "Search for useEffect"): quoted, the name is cut and the verb stays with it.
 * Null for words read whole (a described or raw command, a subagent's task, a web search's query).
 */
export function nameIn(activity: Activity): string | null {
  const { verb, target, what } = activity

  return target !== '' && !isWordy(verb) && what !== target && (what.endsWith(` ${target}`) || what.includes(` ${target} `)) ? target : null
}

/**
 * Whether a tool's words are a set phrase with nothing to name ("Finding tools", "Checking on a
 * command", "Entering a worktree", "Using memory list"): no order to quote when it fails, so the
 * beach says the phrase itself ("Splash! Finding tools failed").
 */
export function isPhrase(activity: Activity): boolean {
  return activity.target === '' && (activity.kind === 'run' || activity.kind === 'other') && activity.verb !== '' && activity.verb !== 'Delegating'
}

/** What failed, for a subagent sent with no task in words: a stand-in, never quoted as an order. */
export const SUBAGENT = 'A subagent'
/** What failed, for a command (described, as typed, or one looked in on or stopped). */
export const A_COMMAND = 'A command'
/** What failed, for any tool: the last word a failure has before none. */
export const A_TOOL = 'A tool'
/** What failed, for a task in the background (an agent's or a shell's), looked in on or stopped. */
export const A_TASK = 'A task'
/** The set phrases of a command in the background, looked in on or stopped: under the phrase, "A command" failed. */
const RUN_PHRASES = new Set(['Checking on a command', 'Stopping a command'])
/** The same of a task: under the phrase, "A task" failed. */
const TASK_PHRASES = new Set(['Checking on a task', 'Stopping a task'])
/** A web search, as a splash with no room to quote it says it failed. */
export const WEB_SEARCH = 'A web search'

/**
 * What failed, in a word a narrow splash can stand on ("Splash! A subagent failed"): a subagent, a
 * command (described or as typed), a skill, a web search; for a tool whose words are a set phrase,
 * that phrase ("Splash! Finding tools failed"); for a tool at a name, what it did to what kind of
 * thing, with the verb its working line used ("Splash! A file read failed", "A search failed", "A
 * page failed": the hearth's file, search, page and folder, said as a step that can fail, so the beach
 * names what the hearth names at the same widths). Null for any other tool: "A tool".
 */
export function nounOf(activity: Activity): string | null {
  if (activity.verb === 'Delegating') return SUBAGENT
  if (activity.kind === 'run' && (activity.verb === '' || activity.verb === 'Running')) return A_COMMAND
  if (activity.verb === SKILL || activity.verb === SKILL_ALONE) return 'A skill'
  if (activity.verb.endsWith(' the web for')) return WEB_SEARCH
  if (isPhrase(activity)) return activity.verb
  if (activity.target !== '') return NAME_NOUNS[`${activity.kind} ${activity.verb}`] ?? null

  return null
}

/** A tool at a name, by its kind and verb, as a narrow splash says it failed. */
const NAME_NOUNS: Record<string, string> = {
  'read Reading': 'A file read',
  // (Just as short as "A tool", so it stands in for it at every width: "Splash! A page failed".)
  'web Reading': 'A page',
  'edit Editing': 'A file edit',
  'edit Writing': 'A file write',
  'read Searching for': 'A search',
  'read Listing': 'A listing',
}

/**
 * What failed, in a word, from the most particular down to any tool: the noun nounOf gives (or none),
 * then "A command" under a command's own phrase ("Checking on a command"), or "A task" under a
 * task's ("Stopping a task"), then "A tool", each once.
 * A narrow line steps down them one at a time ("Splash! Finding tools failed", "Splash! A tool
 * failed"), so it never jumps from a phrase to a bare "Failed".
 */
export function nounsFor(noun: string | null): string[] {
  const isRun = noun === A_COMMAND || (noun !== null && RUN_PHRASES.has(noun))
  const isTask = noun !== null && TASK_PHRASES.has(noun)
  const nouns = [...new Set([...(noun === null ? [] : [noun]), ...(isRun ? [A_COMMAND] : []), ...(isTask ? [A_TASK] : [])])]
  // "A tool" under a word just as short ("A task") would only show where the desktop's proportional
  // font fits the one a pixel or two before the other: the less exact word for one column.
  const least = nouns.at(-1)

  return least !== undefined && cells(least) === cells(A_TOOL) ? nouns : [...nouns, A_TOOL]
}

/**
 * Whether what a tool works on (its target) is words to be read whole, cut after a whole word
 * ("Running git log…", "Delegating: Explore the…", "Using linear: create…"), rather than a name (a
 * file, a pattern), which may be cut at its last character. A described command (verb `''`) and a
 * web search's query are words too. (A raw command with no space early on is cut as a name is,
 * so a narrow band still shows something of it: "Running node_modules/.bin…".)
 */
export function isWordy(verb: string): boolean {
  return verb === '' || verb === 'Running' || verb === 'Delegating' || verb === 'Using' || verb.endsWith(' the web for')
}

/**
 * How a band too narrow for a tool's name ends the line for a tool it is "Using": the tool's server
 * when it has one ("Using linear"), then "Using a tool"; never a bare "Using", which wants its object.
 */
export function usingForms(target: string): string[] {
  const at = target.indexOf(': ')
  const owner = at > 0 ? `Using ${target.slice(0, at)}` : null

  return owner === null ? [USING_A_TOOL] : cells(owner) <= cells(USING_A_TOOL) ? [owner] : [owner, USING_A_TOOL]
}

/**
 * Another server's tool in its two parts: the server, read whole ("Google Drive"), and what it does,
 * which a narrow line cuts after a whole word ("Using Google Drive: search…"); never the server cut
 * short ("Using Google…"). Below that, the line's last forms stand in (see usingForms). A tool with
 * no server to name is all action.
 */
export function usingParts(target: string): { server: string; action: string } {
  const at = target.indexOf(': ')

  return at > 0 ? { server: target.slice(0, at), action: target.slice(at + 2) } : { server: '', action: target }
}

/**
 * Whether one of the prompt's own menus is up for this draft: a command being named (the draft opens
 * with "/" and the caret is still in its first word), or a file (the word at the caret opens with "@").
 */
export function isTypeahead(text: string, cursor: number): boolean {
  const before = text.slice(0, Math.max(0, Math.min(text.length, cursor)))

  return /^\/\S*$/u.test(before) || /(?:^|\s)@\S*$/u.test(before)
}

/** The first line of a text, its runs of spaces and tabs made single spaces. */
function oneLine(text: string): string {
  return (text.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim()
}

function capped(text: string): string {
  const chars = [...text]

  return chars.length <= COMMAND_MAX ? text : `${chars.slice(0, COMMAND_MAX - 1).join('').trimEnd()}…`
}

/**
 * The todos a turn leaves for the next: none once every one is done, so the next plan counts from
 * its own first task ("0 of 2 done"), as Claude Code's list starts afresh, never "300 of 302 done".
 */
export function todosAfterTurn(todos: Todo[]): Todo[] {
  return todos.length > 0 && todos.every(todo => todo.status === 'completed') ? [] : todos
}

export function createdTaskId(ran: unknown): string | undefined {
  const id = (ran as { result?: { task?: { id?: unknown } } }).result?.task?.id

  return typeof id === 'string' ? id : undefined
}

/** The most todos kept (as `turnFiles` keeps 256 files): a session's longest plan, and then some. */
export const TODOS_MAX = 256

export function nextTodos(todos: Todo[], e: { tool: string } & Record<string, unknown>, createdId: string | undefined): Todo[] {
  if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) {
    return (e.todos as Array<{ content: string; status: Todo['status']; activeForm?: string }>).slice(0, TODOS_MAX).map((todo, i) => ({
      id: String(i),
      subject: todo.content,
      activeForm: todo.activeForm ?? null,
      status: todo.status,
    }))
  }
  if (e.tool === 'TaskCreate' && createdId !== undefined) {
    const subject = typeof e.subject === 'string' ? e.subject : 'Task'
    const activeForm = typeof e.activeForm === 'string' ? e.activeForm : null

    const created: Todo = { id: createdId, subject, activeForm, status: 'pending' }

    return [...todos, created].slice(-TODOS_MAX)
  }
  if (e.tool === 'TaskUpdate' && typeof e.taskId === 'string') {
    if (e.status === 'deleted') {
      return todos.filter(todo => todo.id !== e.taskId)
    }

    return todos.map(todo =>
      todo.id !== e.taskId
        ? todo
        : {
            ...todo,
            subject: typeof e.subject === 'string' ? e.subject : todo.subject,
            activeForm: typeof e.activeForm === 'string' ? e.activeForm : todo.activeForm,
            status: e.status === 'pending' || e.status === 'in_progress' || e.status === 'completed' ? e.status : todo.status,
          },
    )
  }

  return todos
}

/**
 * A model as a person names it: `claude-opus-5-5[1m]` is "Opus 5.5", `claude-sonnet-4-20250514`
 * "Sonnet 4", an older `claude-3-5-haiku-20241022` "Haiku 3.5", and a bare alias such as `sonnet`
 * (what a /model may leave) "Sonnet". Anything else is shown as given.
 */
export function prettyModel(id: string): string {
  const bare = id.replace(/\[[^\]]*\]$/, '').trim()
  const named = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(bare)
  const older = /claude-(\d+)(?:-(\d+))?-([a-z]+)/i.exec(bare)
  const [family, major, minor] =
    named !== null ? [named[1], named[2], named[3]] : older !== null ? [older[3], older[1], older[2]] : /^(opus|sonnet|haiku)$/i.test(bare) ? [bare, undefined, undefined] : []
  if (family === undefined) {
    return id
  }
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}`

  return major === undefined ? name : `${name} ${major}${minor === undefined || minor.length > 2 ? '' : `.${minor}`}`
}

export function basename(path: string): string {
  return path.split('/').filter(part => part !== '').pop() ?? path
}

function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url
}

/**
 * Whether Esc (or a hook above settling first) cut a call rather than the call failing: the dispatch
 * was abandoned, or the result is the abort's own words, which Claude Code gives the model for a
 * call it cut ("[Request interrupted by user for tool use]").
 */
export function isInterrupted(text: string | undefined, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (text ?? '').includes('[Request interrupted by user')
}
