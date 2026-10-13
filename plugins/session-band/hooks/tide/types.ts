// The tide's own view of the session: exactly the facts and props its beach was built and tested on.
// The merged facts (types/index.d.ts) are turned into this `Info` by tideInfo() in ./view.ts.

/** One todo, from TodoWrite or the Task tools. */
export type Todo = { id: string; subject: string; activeForm: string | null; status: 'pending' | 'in_progress' | 'completed' }

/**
 * How Clawd reacts to a running tool: he glances at what Claude reads, scuttles while it works, and
 * sits at rest while it waits on you (a question, a plan to look over).
 */
export type ActivityKind = 'look' | 'work' | 'wait'

/** What a running tool is doing, in a few words: `Editing` `register.tsx`; `what` names the call if it fails: `Edit register.tsx`. */
export type Activity = { id: string; verb: string; target: string; kind: ActivityKind; what: string }

/** How the last turn went; `ending`: answered (Done, and a cheer), stopped (Esc, or the model declined) or an API error. The merged facts' own (types/index.d.ts). */
export type { LastTurn, Limit } from '../../types'
import type { LastTurn, Limit } from '../../types'

/**
 * What the desktop's words show Claude doing: the running tool, held a second at least and through
 * short pauses, and when it went up.
 */
export type DeskShown = { activity: Activity | null; shownAt: number }

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
  /** The context fill when the current (or last) turn began: the desktop holds its tide there while a turn runs. */
  turnPercent: number | null
  startedAt: number | null
  lastActiveAt: number | null
  activity: Activity | null
  /** When the last tool finished: a pause shorter than three quarters of a second is no pause. */
  toolEndedAt: number | null
  /** The desktop has no frame clock, so the hooks module holds what its words show. */
  desk: DeskShown
  /** This turn has changed something (an edit, a command): the desktop's Clawd potters rather than reads. */
  turnWorked: boolean
  /** This turn began while Clawd napped: the desktop wakes him gently. */
  woke: boolean
  lastTurn: LastTurn | null
  todos: Todo[]
  cheers: number
  /** When the last good turn finished: Clawd spins for a few seconds after. */
  cheeredAt: number | null
  /** The context fill when the last good turn finished: the desktop holds its tide there while the cheer plays. */
  cheerPercent: number | null
  oops: number
  /** When a tool last failed, what it was doing, and the context fill then: a wave splashes Clawd. */
  oopsAt: number | null
  oopsWhat: string | null
  /** The name in what failed, when it is a verb and a name ("Read register.tsx"): the quote cuts the name, never down to the verb. */
  oopsName: string | null
  /** What failed was a command as Claude typed it: quoted, it is cut as a command is ("cd /Users/robin…"), never on a joint. */
  oopsCommand: boolean
  /** What failed, in a word a narrow splash can stand on: "A subagent", "A command", "A skill", "A web search". */
  oopsNoun: string | null
  oopsPercent: number | null
  /** When the beach's wave for this turn's failures began, and how many waves the session has seen. */
  splashAt: number | null
  waves: number
  /** The last tool to finish failed, and none has started since: the line keeps what failed, quietly. */
  isSlipped: boolean
  /** When this (or the last) turn's prompt was sent. */
  turnAt: number | null
  /** The person's prefersReducedMotion setting: the beach holds still. */
  isStill: boolean
  /** Apple's Terminal, where Claude Code draws a simpler Clawd. */
  isAppleTerminal: boolean
  /** Bumped when a moment ends or a nap is due, so a surface with no frame clock (the desktop) redraws then. */
  beat: number
}

/** How a run of text is coloured; each surface maps it to theme keys (`clay` is Claude's own, `claude`). */
type Tone = 'plain' | 'dim' | 'good' | 'warn' | 'bad' | 'clay'

/**
 * A run of text drawn one way. `isShort`: a name the line may cut at its end with an ellipsis (a
 * file, a branch, a todo, what failed), keeping at least `least` characters of it; never a figure
 * or a label. `cut`: where it may be cut. Words a person wrote (a todo, a described command, a
 * search) only after a whole word that is not a little one (`word`): "Write the tests…", never
 * "Write the te…" or "Write the…". Quoted as what failed (`quote`), the same, and never down to
 * one word: '"Survey the hooks…"', never '"Survey…"'. A project after a whole part of its name
 * where one keeps enough (`part`: "agent…" of agent-plugins), else at its end. A command after a
 * whole word where one keeps enough ("git log…"), else after a part of a path (`command`:
 * "node_modules/.bin…", "cd /Users/robin…"), never inside a word. Anything else (a file, a branch)
 * at its end. `fitsAsBold`: drawn plain but measured as bold, so a line fits exactly where its
 * bold twin does (the settled "Done" after the cheer's).
 */
export type Piece = { text: string; tone?: Tone; bold?: boolean; fitsAsBold?: boolean; isShort?: boolean; least?: number; cut?: 'word' | 'quote' | 'part' | 'command' }

/** One form of a line of the band's words. */
export type Words = Piece[]

/** What the hooks module hands the band's surface module: the tide, the timing, and every line already written. */
export type BandProps = {
  columns: number
  /** Context fill, 0 to 100: how far the tide has come in. */
  percent: number | null
  /** Context fill when this turn began. The desktop's tide holds there while a turn or its moment plays, so its Svg never reloads mid-turn. */
  turnPercent: number | null
  isWorking: boolean
  isHigh: boolean
  /** Nothing moves: the `still` style, or the person prefers reduced motion. */
  isStill: boolean
  /** What the running tool asks of Clawd, while a tool runs. */
  doing: ActivityKind | null
  /** This turn has changed something: the desktop's Clawd potters about rather than watching the words. */
  turnWorked: boolean
  /** This turn began while Clawd napped. */
  woke: boolean
  /** Milliseconds since the session was last active. */
  idleMs: number | null
  napAfterMs: number
  cheers: number
  /** Milliseconds since the last good turn finished, and the context fill then. */
  sinceCheerMs: number | null
  cheerPercent: number | null
  oops: number
  sinceOopsMs: number | null
  /** The context fill when the last tool failed: the desktop holds its tide there while the splash plays. */
  oopsPercent: number | null
  /**
   * Milliseconds since the beach's wave for the last failure began, and how many waves the session
   * has seen: a failure in the wave's first rush rides along with it (see SPLASH_RUSH_MS), so the
   * splash ends with that wave on both surfaces.
   */
  sinceSplashMs: number | null
  waves: number
  /** Milliseconds since this turn's prompt was sent. */
  sinceTurnMs: number | null
  /**
   * Milliseconds since this look came on screen (a /band or /config switch), or null when it has
   * been on all along. A one-off moment that began before it (a cheer, a splash, waking up) is over
   * for the desktop's new frame, which never replays it.
   */
  shownForMs: number | null
  /**
   * On the terminal: this band was just put in place of the hearth's band on screen (a look switch
   * under it), so it keeps pace with the hearth's last second (see pace.ts). A band mounted afresh
   * after a switch has no second to keep pace with, and a pet on it shows at once.
   */
  isSwapped?: boolean
  /** Apple's Terminal: Claude Code's simpler Clawd, with no spin. */
  isAppleTerminal: boolean
  /** The band's first few seconds in a fresh session, before any turn: Clawd waves hello. Once a session. */
  isGreeting: boolean
  /**
   * How long ago the greeting began (the session's start), while it lasts: a band that comes back
   * mid-wave (a dialog that briefly took the prompt's place) carries the wave on, never from its
   * start. Absent: it begins as the band appears.
   */
  greetedMs?: number | null
  /**
   * The three lines beside the beach, in each mood the surface module may be in, each as its forms,
   * longest first: each form takes something away from the one before (a part from the end, a
   * prefix, a label's long form), and the band shows the first that fits (see fitLine). So a
   * narrower band never says more than a wider one, and nothing comes back as it narrows.
   */
  words: {
    now: Words[]
    cheer: Words[]
    splash: Words[]
    nap: Words[]
    tide: Words[]
    place: Words[]
  }
}
