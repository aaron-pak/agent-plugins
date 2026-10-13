// Hearth's own view of the session: exactly the facts and props its band was built and tested on.
// The shared facts (types/index.d.ts) are turned into this `Info` by hearthInfo() in ./view.ts.

/** One todo, from TodoWrite or the Task tools. */
export type Todo = { id: string; subject: string; activeForm: string | null; status: 'pending' | 'in_progress' | 'completed' }

/** What a tool is doing, in a few words: `Editing` `register.tsx` (and what it is: "Edit register.tsx"). `kind` picks Clawd's pose. */
export type Activity = { id: string; kind: ActivityKind; verb: string; target: string; what: string }

/** `ask`: a wait on you (a question, a plan to look over): he rests, and the words are dim. */
export type ActivityKind = 'read' | 'edit' | 'run' | 'web' | 'plan' | 'ask' | 'other'

/** How the last turn went: the shared facts' own (types/index.d.ts), the same for both looks. */
export type { LastTurn, Limit } from '../../types'
import type { LastTurn, Limit } from '../../types'

/**
 * What the desktop's third line shows while Claude works: the tool at work or
 * the one that failed, held at least a second (`at` is when it went up; 0
 * when nothing has been shown this turn, so the first tool shows at once).
 */
export type Held = { activity: Activity | null; slip: Activity | null; at: number }

/** Everything the band knows about the session, kept in `$.state`. */
export type Info = {
  model: string | null
  project: string | null
  branch: string | null
  dirty: number | null
  percent: number | null
  tokens: number | null
  window: number | null
  usd: number | null
  limit: Limit | null
  startedAt: number | null
  lastActiveAt: number | null
  activity: Activity | null
  /** The last tool of this turn that failed, until another tool starts. */
  slip: Activity | null
  /** The last tool of this turn that failed, until the turn ends: the terminal's band holds its hiccup a second, whatever starts next. */
  lastSlip: Activity | null
  /** A failure whose hiccup has yet to have its second on the desktop's third line. */
  slipDue: Activity | null
  /** When the desktop's hiccup went up: Clawd flinches with it. */
  flinchAt: number | null
  /** A prompt was sent and its turn has not been written down yet. */
  isTurnOpen: boolean
  /** When the last tool finished: a pause shorter than three quarters of a second is no pause. */
  toolEndedAt: number | null
  /** The desktop's third line while Claude works. */
  held: Held
  lastTurn: LastTurn | null
  todos: Todo[]
  cheers: number
  oops: number
  /** The person's `prefersReducedMotion` setting, read at the start, on each prompt and on /band. */
  isCalm: boolean
  /** Apple's Terminal, where Claude Code draws a simpler Clawd. */
  isAppleTerminal: boolean
  /** Bumped when a moment ends with nothing else to say so (a cheer, a flinch, a nap coming on), so the desktop redraws. */
  beat: number
}

/** One thing Claude is doing or did, ready to draw: a dim verb and its object, and what it is in a few words ("Find tools"). */
export type Doing = { kind: ActivityKind; verb: string; target: string; what: string }

/** What the hooks module hands the band: plain, already formatted data. */
export type BandProps = {
  isStill: boolean
  isAppleTerminal: boolean
  /** The band's first few seconds in the session, before any turn: Clawd waves hello. Once a session. */
  isGreeting: boolean
  /**
   * How long ago the greeting began (the session's start), while it lasts: a band that comes back
   * mid-wave carries the wave on, never from its start. Absent: it begins as the band appears.
   */
  greetedMs?: number | null
  columns: number
  isWorking: boolean
  isHigh: boolean
  model: string | null
  project: string | null
  branch: string | null
  dirty: number | null
  percent: number | null
  cost: string | null
  /** `resetsAt`: when the limit resets, as a time of day ("4:30pm"), or null. */
  limit: { label: string; percent: number; resetsAt: string | null } | null
  idleMs: number | null
  /** The tool at work: as it is on the terminal (whose band holds what it shows itself), as held on the desktop. */
  activity: Doing | null
  slip: Doing | null
  /** The last tool of this turn that failed, kept when the next one starts: a new failure (`oops`) shows its hiccup a second whatever comes next. */
  lastSlip: Doing | null
  /** Milliseconds since `slip` failed. */
  slipAgoMs: number | null
  /** Milliseconds since the desktop's hiccup went up (Clawd flinches with it). */
  flinchAgoMs: number | null
  lastTurn: LastTurn | null
  /** `current`: the todo at work, as it says itself ("Writing the tests"); `next`: the first not yet done, by its name. */
  todos: { done: number; total: number; current: string | null; next: string | null } | null
  cheers: number
  oops: number
  /**
   * Milliseconds since this look came on screen (a /band or /config switch), or null when it has
   * been on all along: the desktop never replays a cheer, flinch or hello that began before it.
   */
  shownForMs: number | null
}
