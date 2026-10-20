/**
 * The band's two looks. `tide` (the default): Clawd on a little beach whose tide comes in as the
 * context fills. `hearth`: Clawd beside three calm lines. The look lives in /config (the
 * `look` userConfig field); `/band tide` and `/band hearth` write it there.
 */
export type Look = 'tide' | 'hearth'

/** Whether Clawd moves on his own. `/band still` and `/band lively` switch it; reduced motion keeps him still either way. */
export type Motion = 'lively' | 'still'

/**
 * The last look picked (by `/band`, or in /config by someone else), and when. A saved pick shows at
 * once, before /config's reload lands, and counts only in the activation that made it (any reload
 * mints a new token): after that /config holds it. A pick /config could not save (`isSaved` false)
 * lasts the session, through reloads, for as long as /config still holds the look it was picked
 * over (`over`); a change in /config ends it. `at` is when the look on screen became this one: a
 * one-off moment (a cheer, a splash, a flinch) that began before it is over for the new look.
 */
export type LookPick = { look: Look; activation: string; isSaved: boolean; at: number; over: Look }

/** One todo, from TodoWrite or the Task tools. */
export type Todo = { id: string; subject: string; activeForm: string | null; status: 'pending' | 'in_progress' | 'completed' }

/**
 * What kind of thing a tool does, which picks Clawd's pose. `ask`: a wait on you (a question, a plan
 * to look over): Claude is not at work, so Clawd is at rest and the words are in the quiet dim.
 */
export type ActivityKind = 'read' | 'edit' | 'run' | 'web' | 'plan' | 'ask' | 'other'

/**
 * What a tool is doing, in a few words: `Editing` `register.tsx`. `kind` picks Clawd's pose;
 * `what` names the call if it fails: `Edit register.tsx`. A described command is its description
 * alone: verb `''`, target `Run the tests`.
 */
export type Activity = { id: string; kind: ActivityKind; verb: string; target: string; what: string }

/**
 * How a turn ended: `answer` (Claude finished; Clawd cheers), `stopped` (you
 * pressed Esc, or the model declined), `error` (an API error ended it).
 */
export type TurnEnding = 'answer' | 'stopped' | 'error'

export type LastTurn = { seconds: number; tools: number; files: number; ending: TurnEnding }

export type Limit = { kind: string; percent: number; resetsAt: string | null }

/**
 * What the hearth's third line shows while Claude works, on both surfaces: the tool at work or the
 * one that failed, held at least a second (`at` is when it went up; 0 when nothing has been shown
 * this turn, so the first tool shows at once). `next`: the latest tool that started while the hold
 * kept the line on something else; once the hold is over it has its second, even if it has ended.
 */
export type Held = { activity: Activity | null; slip: Activity | null; at: number; next?: Activity | null } & TodosShown

/**
 * What the beach's words show Claude doing, on both surfaces: the running tool, held a second at
 * least and through short pauses. `next`, as the hearth's: a tool the hold kept off the line.
 */
export type DeskShown = { activity: Activity | null; shownAt: number; next?: Activity | null } & TodosShown

/**
 * The todos a line shows beside its step (its tally, and the todo at work on the line with no tool on
 * it), as they were when the step went up: a todo ticked off mid-step comes up with the step after it
 * (see tallied in facts.ts). `todosAt`: since when the facts' own todos have been otherwise. Absent
 * (an older build's, or a line not yet stepped this turn): the facts' own.
 */
export type TodosShown = { todos?: Todo[]; todosAt?: number | null }

/** Everything the band knows about the session, kept in `$.state`: one set of facts both looks read. */
export type Info = {
  model: string | null
  project: string | null
  branch: string | null
  dirty: number | null
  percent: number | null
  usd: number | null
  limit: Limit | null
  lastActiveAt: number | null
  /**
   * What the band says Claude is doing: the latest tool still running (null when none is). Tools
   * overlap (parallel reads, several subagents at once): when the later one ends first, the words go
   * back to the one still running, never to "Thinking it over" while it runs.
   */
  activity: Activity | null
  /** Every tool of the turn still running, in the order they started (at most RUNNING_MAX). */
  running: Activity[]
  /** The last tool of this turn that failed, until another tool starts. */
  slip: Activity | null
  /** The last tool of this turn that failed, until the turn ends: the hearth terminal holds its hiccup a second, whatever starts next. */
  lastSlip: Activity | null
  /** A failure whose hiccup has yet to have its second on the hearth's third line, on both surfaces. */
  slipDue: Activity | null
  /** When the hearth's hiccup went up: the desktop's Clawd flinches with it. */
  flinchAt: number | null
  /**
   * The hiccup now up came while Clawd still flinched from the last one: its flinch is drawn under
   * a second name, so the desktop gets a new source and plays it from the start.
   */
  isFlinchAgain: boolean
  /** A prompt was sent and its turn has not been written down yet. */
  isTurnOpen: boolean
  /** When the last tool finished: a pause shorter than three quarters of a second is no pause. */
  toolEndedAt: number | null
  /** The hearth's third line while Claude works, on both surfaces. */
  held: Held
  lastTurn: LastTurn | null
  todos: Todo[]
  cheers: number
  oops: number
  /** The person's `prefersReducedMotion` setting, read at the start, on each prompt and on /band. */
  isCalm: boolean
  /** Apple's Terminal, where Claude Code draws a simpler Clawd. */
  isAppleTerminal: boolean
  /**
   * git has answered this session (or given up). Until it has, both looks hold back the model, so the
   * branch joins the where line without moving or taking anything from it: on the beach the model
   * stands after the branch, and by the hearth it is the first thing a narrow line gives up for it.
   */
  isGitRead: boolean
  /** Bumped when a moment ends with nothing else to say so (a cheer, a flinch, a splash, a nap coming on), so the desktop redraws. */
  beat: number

  /** The context fill when the current (or last) turn began: the tide desktop holds its water there while a turn runs. */
  turnPercent: number | null
  /** This turn has changed something (an edit, a command): the tide desktop's Clawd potters rather than reads. */
  turnWorked: boolean
  /**
   * When this turn first started to change something: the potter waits for the words to move on from
   * what was up then. Kept past the turn's end only if they had, so the frame stays as it was.
   */
  workedAt: number | null
  /** This turn began while Clawd napped: the tide desktop wakes him gently. */
  woke: boolean
  /** What the beach's words show, on both surfaces, held by the hooks module (the desktop has no frame clock). */
  desk: DeskShown
  /** When the last answered turn finished, and the context fill then. */
  cheeredAt: number | null
  cheerPercent: number | null
  /** When a tool last failed, what it was doing, and the context fill then: a wave splashes Clawd. */
  oopsAt: number | null
  oopsWhat: string | null
  /**
   * The name in what failed (a file, a host, a folder, a pattern), when what failed is a verb and a
   * name ("Read register.tsx"): its quote keeps the verb and cuts the name ('"Read regist…"'),
   * never the verb alone.
   */
  oopsName: string | null
  /** What failed was a command as Claude typed it (no description): its quote is cut as a command is, never on a shell joint. */
  oopsCommand: boolean
  /**
   * What failed, in a word the splash can stand on when there is no room to quote it: "Splash! A
   * subagent failed", "A command", "A skill", "A web search". Null for a tool with no better word
   * than "A tool".
   */
  oopsNoun: string | null
  oopsPercent: number | null
  /**
   * When the beach's wave for this turn's failures began. A failure in its first rush up the sand
   * (SPLASH_RUSH_MS) rides along with it, so its words and its frame end with that wave on both
   * surfaces; a later one starts a new wave. `waves` counts the waves the session has seen.
   */
  splashAt: number | null
  waves: number
  /**
   * A compaction let the tide out: the context fill just before it, the high-water mark, where the
   * beach leaves a starfish on the sand until the tide comes back up to it (null: none on the sand).
   * `treasures` counts the compactions that left one this session, so a new one is told from the last.
   */
  treasurePercent: number | null
  treasures: number
  /**
   * `cheers` when the conversation began (0, or what it was at the last /clear): the answered turns
   * since are the ones the beach's sandcastle is built from, so a new conversation starts a new one.
   */
  castleFrom: number
  /** When the current (or last) turn's prompt was sent. */
  turnAt: number | null

  /** When the band first appeared in this session: Clawd waves hello in its first moments, once. */
  greetedAt: number | null
  /** The context crossed warnAt and the toast said so; cleared when it drops back under. */
  isWarned: boolean
  /** The tools this turn has run, and the files it changed. */
  turnTools: number
  /** Of those tools, the ones that kept its todos (TODO_TOOLS): bookkeeping, which the turn's count of tools leaves out. */
  turnTodoTools: number
  turnFiles: string[]
  /** A motion /band picked that the store would not keep: a reload (a /config change) keeps it for the session. */
  unsavedMotion: Motion | null
  /**
   * When Clawd last went from still to lively (a /band lively, or reduced motion turned off): a
   * lively desktop frame never opens on a moment that began before it, which it would replay from its
   * first beat only for the moment's end to cut it short. It opens at rest, as after a look switch.
   */
  livelyAt: number | null
}

/**
 * The tide desktop's last scene, as its hooks module handed it out (`{ key, at, scene }`): a reload
 * of the module takes it up again, so the frame on screen keeps its source. Read back through a
 * check of its shape; anything else counts as none.
 */
export type KeptScene = { key: string; at: number; scene: unknown }

declare module 'claude-code' {
  interface PluginState {
    'session-band': { info: Info; motion: Motion; pick: LookPick | null; scene: KeptScene | null }
  }
}
