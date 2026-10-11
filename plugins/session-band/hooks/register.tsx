import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import type { Activity, BandProps, BandStyle, Doing, Held, Info, Todo } from '../types'
import { CHEER_FOR_MS, FLINCH_MS, desk } from './desk'

type Figures = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const STYLES: readonly BandStyle[] = ['hearth', 'still']
const DEFAULT_WARN_AT = 80
const NAP_AFTER_MS = 3 * 60_000
/** Clawd waves hello when the band first appears in a session, and only then (not each time a dialog hides and shows it again). */
const GREET_MS = 5000
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

// The desktop has no frame clock, so this module holds what its third line
// shows while Claude works: a tool's words stay up at least a second, and a
// pause between tools shorter than three quarters of a second is no pause, so
// a burst of quick tools reads as one calm stretch of work. (The terminal's
// band does the same on its own frame clock.)
const HOLD_MS = 1000
const GAP_MS = 750
/**
 * Claude Code may say the work is over a moment before the turn's own write
 * lands. Until it does, and for this long at most, the band goes on showing
 * the work: it never flashes the last turn's words, and the desktop never
 * draws Clawd idle and then cheering.
 */
const LANDING_MS = 1500

const NOTHING_HELD: Held = { activity: null, slip: null, at: 0 }

const EMPTY: Info = {
  model: null,
  project: null,
  branch: null,
  dirty: null,
  percent: null,
  tokens: null,
  window: null,
  usd: null,
  limit: null,
  startedAt: null,
  lastActiveAt: null,
  activity: null,
  slip: null,
  lastSlip: null,
  slipDue: null,
  flinchAt: null,
  isTurnOpen: false,
  toolEndedAt: null,
  held: NOTHING_HELD,
  lastTurn: null,
  todos: [],
  cheers: 0,
  oops: 0,
  isCalm: false,
  isAppleTerminal: false,
  beat: 0,
}

const info = atom({ plugin: 'session-band', key: 'info' } as const, EMPTY)
const style = atom({ plugin: 'session-band', key: 'style' } as const, 'hearth')

/** The desktop's next look at what it holds, the redraw that shows him asleep, and the one that ends a landing that never came. */
type Timers = { desk: Timer | null; nap: Timer | null; landing: Timer | null }

/** What the band has seen of the work since the prompt: whether Claude Code said it was working, and since when it has said it is not. */
type Landing = { sawWork: boolean; quietSince: number | null }

export const register: Register = (on, options) => {
  const warnAt = typeof options.warnAt === 'number' ? options.warnAt : DEFAULT_WARN_AT
  let hasWarned = false
  let turnTools = 0
  let turnFiles = new Set<string>()
  let slipAt: number | null = null
  let greetedAt: number | null = null
  const timers: Timers = { desk: null, nap: null, landing: null }
  const landing: Landing = { sawWork: false, quietSince: null }
  const settled = () => {
    landing.sawWork = false
    landing.quietSince = null
    timers.landing?.cancel()
    timers.landing = null
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'band',
      description: 'Let Clawd move about (hearth) or keep still (still)',
      argumentHint: '[hearth|still]',
    })
    const saved = await $.store.get('style')
    if (isStyle(saved)) {
      await update($, style, () => saved)
    }

    const [usage, model, repo, git, isCalm, isAppleTerminal, now] = await Promise.all([
      $.session.usage(),
      $.session.model(),
      $.session.repo(),
      gitState($),
      prefersReducedMotion($),
      appleTerminal($),
      $.clock.now(),
    ])
    await patch($, () => ({
      ...figures(usage),
      model: prettyModel(model),
      project: repo?.name?.split('/').pop() ?? basename(repo?.root ?? e.cwd),
      startedAt: usage.startedAt,
      lastActiveAt: now,
      isCalm,
      isAppleTerminal,
      ...git,
    }))
    napLater($, timers)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await patch($, () => figures(e))

    const percent = e.context.percent
    if (percent !== undefined && percent >= warnAt && !hasWarned) {
      hasWarned = true
      $.ui.toast(`Context is ${percent}% full. Run /compact soon.`, { timeoutMs: 8000 })
    } else if (percent !== undefined && percent < warnAt) {
      hasWarned = false
    }

    return next(e)
  })

  // The band only watches the prompt and the tools. If its bookkeeping fails,
  // the `.catch` hands the event on, or replays what the hook's own `next`
  // already settled to (nothing runs twice), so a failed state write never
  // touches the prompt or the tool.
  on('prompt.submit', async ($, e, next) => {
    turnTools = 0
    turnFiles = new Set()
    slipAt = null
    timers.desk?.cancel()
    settled()
    // Read again with each prompt, so a change in /config takes hold without a restart.
    const [now, isCalm] = await Promise.all([$.clock.now(), prefersReducedMotion($)])
    await patch($, () => ({
      lastActiveAt: now,
      slip: null,
      lastSlip: null,
      slipDue: null,
      flinchAt: null,
      toolEndedAt: null,
      held: NOTHING_HELD,
      isTurnOpen: true,
      isCalm,
    }))
    napLater($, timers)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const activity = describe(e.tool_use_id, e)
    turnTools += 1
    const started = await $.clock.now()
    await settle($, timers, started, () => ({ activity, slip: null, lastActiveAt: started }))

    const ran = await next(e)

    const isFailed = ran.deny === undefined && ran.isError === true
    const ended = await $.clock.now()
    if (isFailed) {
      slipAt = ended
    }
    if (!isFailed && FILE_TOOLS.has(String(e.tool)) && 'file_path' in e && typeof e.file_path === 'string') {
      turnFiles.add(e.file_path)
    }
    const todoId = e.tool === 'TaskCreate' && ran.deny === undefined ? createdTaskId(ran) : undefined
    await settle($, timers, ended, now => ({
      activity: now.activity?.id === activity.id ? null : now.activity,
      todos: nextTodos(now.todos, e, todoId),
      oops: isFailed ? now.oops + 1 : now.oops,
      slip: isFailed ? activity : now.slip,
      // A failure keeps its claim on line 3 when the next tool starts: its hiccup has its second, with Clawd's flinch.
      lastSlip: isFailed ? activity : now.lastSlip,
      slipDue: isFailed ? activity : now.slipDue,
      toolEndedAt: ended,
      lastActiveAt: ended,
    }))
    napLater($, timers)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    timers.desk?.cancel()
    settled()
    const [git, now] = await Promise.all([gitState($), $.clock.now()])
    await patch($, before => ({
      ...git,
      activity: null,
      slip: null,
      lastSlip: null,
      slipDue: null,
      flinchAt: null,
      toolEndedAt: null,
      held: NOTHING_HELD,
      isTurnOpen: false,
      lastActiveAt: now,
      lastTurn: {
        seconds: Math.round(e.durationMs / 1000),
        tools: turnTools,
        files: turnFiles.size,
        // Only an answered turn is "Done" (and a cheer); Esc or a refusal is a calm "Stopped".
        ending: e.reason === 'answer' ? 'answer' : e.reason === 'error' ? 'error' : 'stopped',
      },
      cheers: e.reason === 'answer' ? before.cheers + 1 : before.cheers,
    }))
    if (e.reason === 'answer') {
      // The desktop draws the cheer for its first seconds; one redraw as it ends settles him back to rest.
      nudge($, CHEER_FOR_MS + 10)
    }
    napLater($, timers)

    return next(e)
  })

  // /clear starts a fresh conversation without a new session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      hasWarned = false
      timers.desk?.cancel()
      settled()
      const now = await $.clock.now()
      await patch($, () => ({
        ...figures(null),
        startedAt: now,
        lastActiveAt: now,
        lastTurn: null,
        todos: [],
        activity: null,
        slip: null,
        lastSlip: null,
        slipDue: null,
        flinchAt: null,
        toolEndedAt: null,
        held: NOTHING_HELD,
        isTurnOpen: false,
      }))
      napLater($, timers)
    }

    return next(e)
  })

  on('command.run', { command: 'band' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    const current = await read($, style)
    if (asked !== '' && !isStyle(asked)) {
      return { text: `No band style "${asked}". Try ${STYLES.join(', ')}.` }
    }

    const picked: BandStyle = isStyle(asked) ? asked : current === 'hearth' ? 'still' : 'hearth'
    await update($, style, () => picked)
    await $.store.set('style', picked)
    // Read the reduced-motion setting again, so /band is all it takes after changing it.
    const isCalm = await prefersReducedMotion($)
    await patch($, () => ({ isCalm }))

    if (picked === 'still') {
      return { text: 'Band: still. Clawd keeps to one pose per moment. /band hearth lets him move again.' }
    }

    return {
      text: isCalm
        ? 'Band: hearth. Your reduced-motion setting keeps Clawd to one pose per moment for now.'
        : 'Band: hearth. Clawd blinks, reads along and cheers. /band still keeps him still.',
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }

    const [now, picked, stored] = await Promise.all([$.clock.now(), read($, style), read($, info)])
    const known = whole(stored)
    greetedAt ??= now
    const isFirstMoments = now - greetedAt < GREET_MS
    // The work goes on until the turn is written down (or a second and a half has gone by): see LANDING_MS.
    let isWorking = e.props.isWorking
    if (isWorking) {
      landing.sawWork ||= known.isTurnOpen
      landing.quietSince = null
    } else if (known.isTurnOpen && landing.sawWork) {
      landing.quietSince ??= now
      const left = landing.quietSince + LANDING_MS - now
      if (left > 0) {
        isWorking = true
        timers.landing ??= nudge($, left + 10)
      }
    }
    const props = bandProps(known, slipAt, picked, isWorking, warnAt, e.props.bodyColumns, now, isFirstMoments)

    if (e.surface === 'desktop') {
      // The desktop's words are the held ones; the terminal's band holds what it shows on its own clock.
      return desk($.ui.resolve(e), { ...props, activity: doing(known.held.activity), slip: doing(known.held.slip) })
    }

    const { Client } = $.ui.resolve(e)

    return <Client key="band" module="./band.tsx" props={props} width={e.props.bodyColumns} height={3} />
  })
}

/** The stored info, with any field an older build of the band did not keep filled in. */
function whole(stored: Partial<Info>): Info {
  return { ...EMPTY, ...stored, held: { ...NOTHING_HELD, ...stored.held } }
}

function patch($: EngineInterface, change: (now: Info) => Partial<Info>): Promise<unknown> {
  return update($, info, stored => {
    const now = whole(stored)

    return { ...now, ...change(now) }
  })
}

/**
 * A change, with the desktop's third line stepped toward what is happening in
 * the same write; when a hold runs out before anything else happens, a timer
 * looks again. Clawd flinches as a hiccup goes up, and settles back (one
 * redraw) as the flinch ends.
 */
async function settle($: EngineInterface, timers: Timers, time: number, change: (now: Info) => Partial<Info> = () => ({})): Promise<void> {
  let wakeIn = Infinity
  let isFlinch = false
  await patch($, now => {
    const changed = { ...now, ...change(now) }
    const step = stepHeld(changed, time)
    wakeIn = step.wakeIn
    isFlinch = step.held.slip !== null && heldId(step.held) !== heldId(changed.held)

    return { ...changed, held: step.held, slipDue: step.slipDue, flinchAt: isFlinch ? time : changed.flinchAt }
  })
  if (isFlinch) {
    nudge($, FLINCH_MS + 10)
  }
  timers.desk?.cancel()
  timers.desk = Number.isFinite(wakeIn)
    ? after($, wakeIn + 10, () => {
        void $.clock
          .now()
          .then(at => settle($, timers, at))
          .catch(() => undefined)
      })
    : null
}

/**
 * What the desktop's third line shows next: the tool at work (or the one that
 * failed), once what is up has been up a second; nothing at all once the tools
 * have been quiet three quarters of a second. A failure's hiccup has its second
 * whatever starts next, and only then gives way. `wakeIn` is when to look again.
 */
function stepHeld(now: Info, time: number): { held: Held; slipDue: Activity | null; wakeIn: number } {
  const held = now.held
  const age = time - held.at
  let due = now.slipDue
  if (due !== null && held.slip?.id === due.id && age >= HOLD_MS) {
    due = null
  }
  const quietFor = now.toolEndedAt === null ? Infinity : time - now.toolEndedAt
  let wakeIn = Infinity
  let want: Pick<Held, 'activity' | 'slip'>
  if (due !== null) {
    want = { activity: null, slip: due }
  } else if (now.slip !== null) {
    want = { activity: null, slip: now.slip }
  } else if (now.activity !== null) {
    want = { activity: now.activity, slip: null }
  } else if (quietFor < GAP_MS) {
    // A pause this short is no pause: what is up stays up.
    want = held
    wakeIn = GAP_MS - quietFor
  } else {
    want = { activity: null, slip: null }
  }
  if (heldId(want) === heldId(held)) {
    // A hiccup up: look again when its second is over.
    return { held, slipDue: due, wakeIn: due !== null ? Math.min(wakeIn, HOLD_MS - age) : wakeIn }
  }
  // A hiccup takes over from its own tool at once: the line keeps its subject and says it stumbled.
  const isOwn = want.slip !== null && held.activity?.id === want.slip.id
  if (age >= HOLD_MS || isOwn) {
    return { held: { ...want, at: time }, slipDue: due, wakeIn: due !== null ? HOLD_MS : wakeIn }
  }

  return { held, slipDue: due, wakeIn: Math.min(wakeIn, HOLD_MS - age) }
}

function heldId(held: Pick<Held, 'activity' | 'slip'>): string {
  return held.slip !== null ? `slip ${held.slip.id}` : held.activity !== null ? held.activity.id : ''
}

// A redraw a while from now, for a moment that ends with nothing else to say so.
function nudge($: EngineInterface, ms: number): Timer | null {
  return after($, ms, () => {
    void patch($, now => ({ beat: now.beat + 1 })).catch(() => undefined)
  })
}

// Any activity puts the nap off: the desktop's redraw that shows him asleep moves to three quiet minutes from now.
function napLater($: EngineInterface, timers: Timers): void {
  timers.nap?.cancel()
  timers.nap = nudge($, NAP_AFTER_MS + 1000)
}

function after($: EngineInterface, ms: number, fn: () => void): Timer | null {
  try {
    return $.clock.after(ms, fn)
  } catch {
    return null
  }
}

function isStyle(value: unknown): value is BandStyle {
  return typeof value === 'string' && (STYLES as readonly string[]).includes(value)
}

function figures(usage: Figures | null): Partial<Info> {
  const limit = usage?.rateLimits.find(one => one.kind === 'five_hour') ?? usage?.rateLimits[0]

  return {
    percent: usage?.context.percent ?? null,
    tokens: usage?.context.tokens ?? null,
    window: usage?.context.window ?? null,
    usd: usage?.cost?.usd ?? null,
    limit: limit === undefined ? null : { kind: limit.kind, percent: limit.percentUsed, resetsAt: limit.resetsAt ?? null },
  }
}

async function gitState($: EngineInterface): Promise<Pick<Info, 'branch' | 'dirty'>> {
  try {
    const [head, status] = await Promise.all([
      $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 3000 }),
      $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 3000 }),
    ])
    if (head.exitCode !== 0) {
      return { branch: null, dirty: null }
    }

    return {
      branch: head.stdout.trim(),
      dirty: status.exitCode === 0 ? status.stdout.split('\n').filter(line => line.trim() !== '').length : null,
    }
  } catch {
    return { branch: null, dirty: null }
  }
}

function describe(id: string, e: { tool: string } & Record<string, unknown>): Activity {
  const text = (key: string) => (typeof e[key] === 'string' ? oneLine(e[key] as string) : '')
  const tool = String(e.tool)
  switch (tool) {
    case 'Read':
      return { id, kind: 'read', verb: 'Reading', target: basename(text('file_path')) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { id, kind: 'edit', verb: 'Editing', target: basename(text('file_path') || text('notebook_path')) }
    case 'Write':
      return { id, kind: 'edit', verb: 'Writing', target: basename(text('file_path')) }
    case 'Bash': {
      // A described command reads best as its description alone: "Run the tests".
      const description = text('description')
      return description !== ''
        ? { id, kind: 'run', verb: '', target: description }
        : { id, kind: 'run', verb: 'Running', target: text('command').slice(0, 80) }
    }
    case 'Grep':
    case 'Glob':
      return { id, kind: 'read', verb: 'Searching for', target: text('pattern') }
    case 'WebFetch':
      return { id, kind: 'web', verb: 'Reading', target: hostOf(text('url')) }
    case 'WebSearch':
      return { id, kind: 'web', verb: 'Searching the web for', target: text('query') }
    case 'Agent':
    case 'Task':
      return { id, kind: 'other', verb: 'Delegating', target: text('description') }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { id, kind: 'plan', verb: 'Planning', target: '' }
    default:
      return { id, kind: 'other', verb: 'Using', target: tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool }
  }
}

/** The first line of a text, its runs of spaces and tabs made single spaces. */
function oneLine(text: string): string {
  return (text.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim()
}

function createdTaskId(ran: unknown): string | undefined {
  const id = (ran as { result?: { task?: { id?: unknown } } }).result?.task?.id

  return typeof id === 'string' ? id : undefined
}

function nextTodos(todos: Todo[], e: { tool: string } & Record<string, unknown>, createdId: string | undefined): Todo[] {
  if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) {
    return (e.todos as Array<{ content: string; status: Todo['status']; activeForm?: string }>).map((todo, i) => ({
      id: String(i),
      subject: todo.content,
      activeForm: todo.activeForm ?? null,
      status: todo.status,
    }))
  }
  if (e.tool === 'TaskCreate' && createdId !== undefined) {
    const subject = typeof e.subject === 'string' ? e.subject : 'Task'
    const activeForm = typeof e.activeForm === 'string' ? e.activeForm : null

    return [...todos, { id: createdId, subject, activeForm, status: 'pending' }]
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

function bandProps(
  known: Info,
  slipAt: number | null,
  picked: BandStyle,
  isWorking: boolean,
  warnAt: number,
  columns: number,
  now: number,
  isFirstMoments: boolean,
): BandProps {
  const done = known.todos.filter(todo => todo.status === 'completed').length
  const current = known.todos.find(todo => todo.status === 'in_progress') ?? known.todos.find(todo => todo.status === 'pending')
  const resetsAt = known.limit?.resetsAt == null ? NaN : Date.parse(known.limit.resetsAt)

  return {
    isStill: picked === 'still' || known.isCalm,
    isAppleTerminal: known.isAppleTerminal,
    isGreeting: isFirstMoments && known.lastTurn === null && !isWorking,
    columns,
    isWorking,
    isHigh: known.percent !== null && known.percent >= warnAt,
    model: known.model,
    project: known.project,
    branch: known.branch,
    dirty: known.dirty,
    percent: known.percent,
    cost: known.usd === null ? null : `$${known.usd.toFixed(2)}`,
    limit:
      known.limit === null
        ? null
        : {
            label: known.limit.kind === 'five_hour' ? '5h' : known.limit.kind === 'seven_day' ? '7d' : known.limit.kind,
            percent: Math.round(known.limit.percent),
            resetsInMs: Number.isNaN(resetsAt) ? null : Math.max(0, resetsAt - now),
          },
    idleMs: known.lastActiveAt === null ? null : Math.max(0, now - known.lastActiveAt),
    activity: doing(known.activity),
    slip: doing(known.slip),
    lastSlip: doing(known.lastSlip),
    slipAgoMs: known.slip === null || slipAt === null ? null : Math.max(0, now - slipAt),
    flinchAgoMs: known.flinchAt === null ? null : Math.max(0, now - known.flinchAt),
    lastTurn: known.lastTurn === null ? null : { ...known.lastTurn, ending: known.lastTurn.ending ?? 'answer' },
    todos:
      known.todos.length === 0
        ? null
        : { done, total: known.todos.length, current: current === undefined ? null : (current.activeForm ?? current.subject) },
    cheers: known.cheers,
    oops: known.oops,
  }
}

function doing(activity: Activity | null): Doing | null {
  return activity === null ? null : { kind: activity.kind, verb: activity.verb, target: activity.target }
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
// gives it a simpler Clawd, and so does the band.
async function appleTerminal($: EngineInterface): Promise<boolean> {
  try {
    return (await $.env.get('TERM_PROGRAM')) === 'Apple_Terminal'
  } catch {
    return false
  }
}

function prettyModel(id: string): string {
  const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id)
  if (match === null) {
    return id
  }
  const [, family = '', major = '', minor] = match

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor === undefined || minor.length > 2 ? '' : `.${minor}`}`
}

function basename(path: string): string {
  return path.split('/').filter(part => part !== '').pop() ?? path
}

function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url
}
