// The band's words, shared by both surfaces: each line as its forms, longest
// first, and the fit that picks the first one with room. The terminal measures
// in cells; the desktop measures the same forms in pixels of a proportional
// font (desk.tsx). Parts drop whole, so a figure or a label is never cut: only
// a branch, a file name or a todo may be cut, at its end, and only once enough
// of it still shows.

import type { BandProps, Doing, LastTurn } from './types'
import { cells, cut, endsLittle, partCut, trimJoints, trimLittle, wordFloor } from '../clawd'
import { A_COMMAND, A_TASK, A_TOOL, SKILL, SKILL_ALONE, SUBAGENT, WEB_SEARCH, durationForms, isWordy, phraseForms, usingForms, usingParts } from '../facts'

export type Seg = { text: string; color?: string; backgroundColor?: string; bold?: boolean }
export type Row = Seg[]
/**
 * One line of words: `left` and its figures on the `right`. A line may name a
 * part of `left` that gives way first when room runs short (a branch, a file
 * name, a todo): it sits between `left` and `tail`, cut at its end. Figures
 * and labels are never in it. Words a person wrote (`isSaid`: a todo, a
 * described command, a web search) are cut only after a whole word, and never
 * end on a little word. A command as Claude typed it (`isCommand`) is cut after
 * a whole word where one keeps enough, else as a name is. Words quoted as what
 * failed (`isQuote`: a described command, a task, a search) keep two whole words
 * at least, so a hiccup never reads as a bare verb ("Hiccup · Check…"). `squeezeWidth`,
 * when set, is the room it is cut to, in cells (the terminal's: see band.tsx).
 */
export type Line = { left: Row; squeeze?: Row; tail?: Row; right: Row; isSaid?: boolean; isQuote?: boolean; isCommand?: boolean; squeezeWidth?: number }
/** A form of a line, and how many cells of its squeezed part must show for it to count as fitting. */
export type Form = { line: Line; least: number }

/** How a surface measures a row, and the two-cell gap before the right-hand figures. */
export type Measure = { row: (row: Row) => number; gap: number }

// Theme keys: the words' colors follow the person's theme on both surfaces.
export const DIM = 'inactive'
export const ACCENT = 'claude'
const WARN = 'warning'
const SUCCESS = 'success'

/**
 * A squeezed part (a branch, a file name) must show at least this much, or the line takes a shorter
 * form: seven characters and the ellipsis, the tide's rule too, so a switch never cuts a name
 * differently.
 */
const LEAST = 8
/** A web search's query may be cut to its first word of three letters or more ("Searching for ink…"), as on the beach. */
const QUERY_LEAST = 4

/** A plain space: the bold project and the warm figures never sit right beside dim words. */
export const SPACE: Seg = { text: ' ' }

/**
 * The widest the words' panel grows, in cells, on either surface: 68 at 100 columns, a little more
 * on wider bands (78 at 140) and never more than 80, so the figures stay near their lines.
 */
export function panelMost(columns: number): number {
  return Math.min(80, 68 + Math.max(0, Math.floor((columns - 100) / 4)))
}

function needs({ line, least }: Form, m: Measure): number {
  const text = line.squeeze === undefined ? '' : rowText(line.squeeze)
  // The shortest cut the squeezed part may take, measured as the surface draws it (cells, or pixels).
  const fewest = line.isQuote === true ? quoteLeast(text, least) : line.isSaid === true ? saidLeast(text, least) : line.isCommand === true ? commandLeast(text, least) : nameLeast(text, least)
  const bold = line.squeeze?.[0]?.bold === true
  const squeeze = line.squeeze === undefined ? 0 : Math.min(m.row(line.squeeze), fewest === null ? Number.POSITIVE_INFINITY : m.row([{ text: fewest, bold }]))

  return m.row(line.left) + squeeze + m.row(line.tail ?? []) + (line.right.length === 0 ? 0 : m.gap + m.row(line.right))
}

/** The first form that fits the room; the last form when none does. */
export function firstFit(forms: Form[], room: number, m: Measure): Line {
  return (forms.find(form => needs(form, m) <= room) ?? forms[forms.length - 1])?.line ?? { left: [], right: [] }
}

/**
 * Words a person wrote, cut to what `kept` (a cut at a character) leaves of them: back to the end of
 * the last whole word, never after a separator. Writing that puts no spaces between its words
 * (Japanese, Chinese) may be cut between any two of its characters, as on the beach.
 */
function saidCut(text: string, kept: string): string {
  // Never ending on a little word ("Review the…") while a name's seven characters stay, or a first
  // word of four letters or more ("Survey…"), nor on a shell's joint ("&&…"). A cut too short to lose
  // its little word ("Run the…") is never made: the form needs room for more (see saidLeast).
  const floor = wordFloor(text, LEAST - 1)

  return trimLittle(trimJoints(backTo(text, kept, isWordEdge), floor), floor)
}

/**
 * Words quoted as what failed, cut to what `kept` leaves of them: back to the end of the last whole
 * word, never on a little word, and never down to one word ("Hiccup · Check…" would read as an order
 * cut off): two at least, as the beach quotes them. The line's form has room for them (see quoteLeast).
 */
function quoteCut(text: string, kept: string): string {
  const floor = LEAST - 1
  const words = trimLittle(backTo(text, kept, isWordEdge), floor)
  const least = quoteLeast(text, LEAST)

  return isQuoteCut(words) && [...words].length >= floor ? words : least === null ? words : least.slice(0, -1)
}

/** How a line's squeezed part is cut to what `kept` leaves of it, on either surface. */
export function squeezeCut(line: Line, text: string, kept: string): string {
  return line.isQuote === true ? quoteCut(text, kept) : line.isSaid === true ? saidCut(text, kept) : line.isCommand === true ? commandCut(text, kept) : nameCut(text, kept)
}

/** A cut that keeps two words (or writing with no spaces between its words) and does not end on a little one. */
function isQuoteCut(words: string): boolean {
  return (/\s/u.test(words) || [...words].some(char => cells(char) > 1)) && !endsLittle(words)
}

/**
 * The shortest cut of words quoted as what failed, its ellipsis with it: their first two whole words
 * or more, `least - 1` characters at least, never ending on a little word. Null when there is none:
 * the words show whole, or the line takes a shorter form.
 */
function quoteLeast(text: string, least: number): string | null {
  const chars = [...text]
  for (let end = 1; end < chars.length; end++) {
    const start = neat(chars.slice(0, end).join(''))
    if (isWordEdge(chars, end) && [...start].length >= least - 1 && isQuoteCut(start)) {
      return `${start}…`
    }
  }

  return null
}

/**
 * A name (a file, a branch, a page's host) cut to what `kept` leaves of it, as the beach cuts one
 * (see partCut): never inside its last '.'-part ("register.t…" reads "register…"), back to the end
 * of a part where that keeps a name's seven characters ("a-file-that…"), never a letter or two into
 * a new part or short of its stem ("a-file-t…", "registe…" read as typos), and never an ellipsis
 * after a separator.
 */
function nameCut(text: string, kept: string): string {
  return neat(partCut(text, kept, LEAST - 1))
}

/**
 * The shortest cut of a name, its ellipsis with it: the first cut as wide as `least - 1` cells (or
 * the plain cut there, a wide character short of it) that nameCut keeps as it is. A name with none
 * (one too short before its dot, "index.tsx", or whose only cuts read as typos) shows whole, or the
 * line takes a shorter form.
 */
function nameLeast(text: string, least: number): string {
  const chars = [...text]
  if (cells(text) <= least) {
    return text
  }
  const start = cut(text, least - 1)
  for (let end = [...start].length; end < chars.length; end++) {
    const kept = nameCut(text, chars.slice(0, end).join(''))
    if (cells(kept) >= cells(start)) {
      return `${kept}…`
    }
  }

  return text
}

/**
 * A command as Claude typed it, cut to what `kept` leaves of it: back to the end of its last whole
 * word where that keeps a name's seven characters ("git log…"); else to the end of a part of a path
 * ("node_modules/.bin…", "cd /Users/robin…"). Never inside a word: the line's form needs room for
 * one of these (see commandLeast).
 */
function commandCut(text: string, kept: string): string {
  const words = trimJoints(backTo(text, kept, isWordEdge), LEAST - 1)

  return [...words].length >= LEAST - 1 ? words : backTo(text, kept, isPartEdge)
}

/** The shortest cut of a command, its ellipsis with it: its first part of a path or whole word that has seven characters. */
function commandLeast(text: string, least: number): string | null {
  const chars = [...text]
  for (let end = 1; end < chars.length; end++) {
    const start = neat(chars.slice(0, end).join(''))
    if (isPartEdge(chars, end) && [...start].length >= least - 1) {
      return `${start}…`
    }
  }

  return null
}

function isPartEdge(chars: string[], at: number): boolean {
  return isWordEdge(chars, at) || [chars[at], chars[at - 1]].some(char => char !== undefined && /[/._-]/u.test(char))
}

/** `text` cut back from where `kept` ends to the last edge, with no separator before the ellipsis. */
function backTo(text: string, kept: string, isEdge: (chars: string[], at: number) => boolean): string {
  const chars = [...text]
  let end = [...kept].length
  while (end > 0 && !isEdge(chars, end)) end -= 1

  return neat(chars.slice(0, end).join(''))
}

/**
 * The shortest cut of words a person wrote, its ellipsis with it: its first whole words, at least
 * `least - 1` characters of them, or its first word alone when that is a real word of four letters
 * or more (see wordFloor), never ending on a little one. Null when there is none: the words show
 * whole, or the line takes a shorter form.
 */
function saidLeast(text: string, least: number): string | null {
  const chars = [...text]
  const floor = wordFloor(text, least - 1)
  for (let end = 1; end < chars.length; end++) {
    const start = neat(chars.slice(0, end).join(''))
    // Never down to a little word ("Run the…"): the next whole word, or the line's next form.
    if (isWordEdge(chars, end) && [...start].length >= floor && !endsLittle(start)) {
      return `${start}…`
    }
  }

  return null
}

function isWordEdge(chars: string[], at: number): boolean {
  return [chars[at], chars[at - 1]].some(char => char !== undefined && (/\s/u.test(char) || cells(char) > 1))
}

/** Never an ellipsis straight after a hyphen, a slash, a dot or a space ("first-…", "register.…"). */
function neat(text: string): string {
  return text.replace(/[\s/._:;,-]+$/u, '')
}

/** Terminal cells: wide CJK characters and emoji count two (see `cells`). */
export const CELLS: Measure = { row: segs => segs.reduce((sum, seg) => sum + cells(seg.text), 0), gap: 2 }

/**
 * A squeezed part that must be cut, on the terminal, is given a box exactly as wide as what shows of
 * it and Ink's ellipsis. A cut that would end inside a wide character (CJK, an emoji) then lands on a
 * cell boundary, so no stray blank cell opens up before what follows it.
 */
export function cutAt(line: Line, panel: number): Line {
  if (line.squeeze === undefined) {
    return line
  }
  const room = squeezeRoom(line, panel, CELLS)
  const text = line.squeeze.map(seg => seg.text).join('')
  if (cells(text) <= room) {
    return line
  }

  // Never an ellipsis straight after a hyphen, a slash, a dot or a space ("first-…", "register.…"):
  // the cut steps back to the last letter, as the tide's does; words a person wrote, to the end of
  // their last whole word ("Run the…").
  const kept = cut(text, room - 1)
  const neat = squeezeCut(line, text, kept)

  return { ...line, squeezeWidth: Math.max(1, cells(neat === '' ? kept : neat) + 1) }
}

/** The room left for a line's squeezed part once everything else has its place. */
export function squeezeRoom(line: Line, room: number, m: Measure): number {
  return room - m.row(line.left) - m.row(line.tail ?? []) - (line.right.length === 0 ? 0 : m.gap + m.row(line.right))
}

// ── Line 1: where you are ──────────────────────────────────────────────────────
//
// The project, its branch, what is uncommitted, and the model. When room runs
// short the branch loses its prefix (claude/first-mod reads first-mod), then
// the model goes, then the count goes whole (never a bare number, nor "files",
// which line 3 already uses for what the last turn changed), then the branch is
// cut at its end while LEAST cells of it still show (seven characters and the
// ellipsis), then it goes, and last the
// project is cut. Each form only takes away from the one before, so a narrower
// band never says more than a wider one.

export function whereForms(props: Pick<BandProps, 'project' | 'branch' | 'dirty' | 'model'>): Form[] {
  const project = props.project ?? ''
  const name: Row = project === '' ? [] : [{ text: project, bold: true }]
  const joint: Row = project === '' ? [] : [SPACE, { text: 'on', color: DIM }, SPACE]
  const count: Row = props.dirty !== null && props.dirty > 0 ? [SPACE, { text: `· ${props.dirty} uncommitted`, color: DIM }] : []
  const whole = props.branch ?? ''
  const tail = whole.slice(whole.lastIndexOf('/') + 1)
  const model: Row = props.model === null || props.model === '' ? [] : [{ text: props.model, color: ACCENT }]

  const forms: Form[] = []
  const at = (branch: string, dirty: Row, right: Row, least = cells(branch)): void => {
    forms.push({ line: { left: [...name, ...joint], squeeze: [{ text: branch }], tail: dirty, right }, least })
  }
  if (whole !== '') {
    at(whole, count, model)
    if (tail !== whole) at(tail, count, model)
    if (model.length > 0) at(tail, count, [])
    if (count.length > 0) at(tail, [], [])
    at(tail, [], [], LEAST)
  } else {
    if (model.length > 0) forms.push({ line: { left: [...name, ...count], right: model }, least: 0 })
    if (count.length > 0) forms.push({ line: { left: [...name, ...count], right: [] }, least: 0 })
  }
  forms.push({ line: { left: name, right: [] }, least: 0 })
  forms.push({ line: { left: [], squeeze: name, tail: [], right: [] }, least: 1 })

  return forms
}

function rowText(row: Row): string {
  return row.map(seg => seg.text).join('')
}

// ── Line 3: what is happening ──────────────────────────────────────────────────
//
// The tool at work, a hiccup, the next todo, or how the last turn went. It
// changes when the session does, never by itself: a nap is Clawd's to show,
// not the words'.

/** What line 3 is drawn from. */
export type Said = Pick<BandProps, 'isWorking' | 'activity' | 'slip' | 'todos' | 'isHigh' | 'percent' | 'limit' | 'lastTurn'> & {
  /** When the limit resets, as a time of day ("4:30pm"): it never goes stale, so both surfaces say it. */
  resetsAt: string | null
  /** A turn just landed and Clawd is cheering: its summary says what finished, before any warning. */
  isLanding: boolean
}


export function happeningForms(said: Said): Form[] {
  const todos = said.todos
  const tallies: Row[] = todos === null ? [] : [`${todos.done} of ${todos.total} done`, `${todos.done}/${todos.total} done`].map(text => [{ text, color: DIM }])
  const lefts = leftsOf(said)
  const first = lefts[0]
  // The tally shortens, then goes, before the words lose anything: beside it the words are whole, with
  // nothing left to cut ("Writing… 2 of 3 done" would put the count ahead of what it counts). Each
  // form only ever takes away, so nothing comes back as the band narrows.
  const tallied: Form[] = first === undefined ? [] : tallies.map(right => ({ line: { ...uncut(first.line), right }, least: 0 }))

  return [
    ...tallied,
    ...lefts,
    { line: { left: [], squeeze: first?.line.left.concat(first.line.squeeze ?? []) ?? [], tail: [], right: [] }, least: 1 },
  ]
}

/** A line with its squeezed part set whole among its words: it fits whole, or not at all. */
function uncut({ left, squeeze, tail, right }: Line): Line {
  return { left: [...left, ...(squeeze ?? []), ...(tail ?? [])], right }
}

function leftsOf(said: Said): Form[] {
  const todos = said.todos
  const plain = (...rows: Row[]): Form[] => rows.map(left => ({ line: { left, right: [] }, least: 0 }))
  const loose = (left: Row, text: string, isSaid: boolean, isCommand = false): Form => ({
    line: { left, squeeze: [{ text }], tail: [], right: [], isSaid: isSaid && !isCommand, isCommand },
    least: Math.min(cells(text), LEAST),
  })
  const ready = plain([{ text: 'Ready when you are', color: DIM }], [{ text: 'Ready', color: DIM }])

  if (said.isWorking) {
    const activity = said.activity
    if (activity !== null) {
      return doing(activity)
    }
    if (said.slip !== null) {
      return hiccupForms(said.slip)
    }
    if (todos !== null && todos.current !== null) {
      // The todo at work, as it says itself ("Writing the tests"), cut at a word; on the narrowest
      // band, "Thinking".
      return [loose([], todos.current, true), ...plain([{ text: 'Thinking', color: DIM }])]
    }

    return plain([{ text: 'Thinking it over', color: DIM }], [{ text: 'Thinking', color: DIM }])
  }
  const landed = said.lastTurn === null ? null : plain(...lastTurn(said.lastTurn, said.isLanding))
  if (said.isLanding && landed !== null) {
    // Clawd cheers for this turn: the words say what finished. The warnings come back as the cheer ends.
    return landed
  }
  const limit = said.limit
  // At or past a usage limit nothing more runs until it resets, so that is the story, ahead of the
  // context's own warning (a /compact would not help yet), as on the beach. (Its percent is whole,
  // as its meter shows it: 99.6% is "At".)
  if (said.isHigh && (limit === null || limit.percent < 100)) {
    // At 100% it is full, as the meter beside it says; before that, getting there.
    const full: Row = [{ text: (said.percent ?? 0) >= 100 ? 'Full' : 'Getting full', color: ACCENT }]
    return plain([...full, SPACE, { text: "· /compact when you're ready", color: DIM }], [...full, SPACE, { text: '· try /compact', color: DIM }], full)
  }
  if (limit !== null && limit.percent >= 80) {
    // Near it, then at it (Claude Code waits for the reset), or past it (a spend limit can be).
    const how = limit.percent > 100 ? 'Over' : limit.percent >= 100 ? 'At' : 'Near'
    const near: Row = [{ text: `${how} the ${limit.label} limit`, color: ACCENT }]
    const short: Row = [{ text: `${how} ${limit.label} limit`, color: ACCENT }]
    const resets: Row = said.resetsAt === null ? [] : [SPACE, { text: `· resets ${said.resetsAt}`, color: DIM }]

    return resets.length === 0 ? plain(near, short) : plain([...near, ...resets], [...short, ...resets], short)
  }
  if (todos !== null && todos.next !== null) {
    // "Next up: Write the tests for the splash ladder", cut after a whole word when it must be, two
    // words at least, as a quote is ("Next up: Write the tests…"): "Next up: Write…" alone would read
    // as an order cut off. Narrower still, what the line would say with nothing queued.
    const next: Form = { line: { left: [{ text: 'Next up:', color: DIM }, SPACE], squeeze: [{ text: todos.next }], tail: [], right: [], isQuote: true }, least: Math.min(cells(todos.next), LEAST) }
    return [next, ...(landed ?? ready)]
  }
  if (landed !== null) {
    return landed
  }

  return ready
}

/**
 * Line 3 as a step fails: "Hiccup ·" and what failed, longest first, as the beach's splash says it.
 * A file or a pattern by its name, cut where it must be ("Hiccup · register…"); a command as typed,
 * cut at a word or a part of a path; words quoted as what failed (a described command, a subagent's
 * task, a search) cut after two whole words at least ("Hiccup · Check why the build…"); a set phrase
 * ("Hiccup · Find tools", "Hiccup · Check on a command") whole or not at all; another server's tool
 * with its server whole ("Hiccup · Linear: create issue", then "Hiccup · Linear"). Narrower, what
 * failed in a word ("Hiccup · A command", "Hiccup · A file", then "Hiccup · A tool"), and last
 * "Hiccup" alone: never a word or two and an ellipsis that reads as an order cut off.
 */
function hiccupForms(slip: Doing): Form[] {
  const hiccup: Row = [{ text: 'Hiccup', color: ACCENT }]
  const lead: Row = [...hiccup, SPACE, { text: '·', color: DIM }, SPACE]
  const whole = (text: string): Form => ({ line: { left: [...lead, { text }], right: [] }, least: 0 })
  const squeezed = (left: Row, text: string, how: { isQuote?: boolean; isCommand?: boolean }, tail: Row = []): Form => ({
    line: { left, squeeze: [{ text }], tail, right: [], ...how },
    least: Math.min(cells(text), LEAST),
  })
  const after = [...hiccupNouns(slip).map(whole), { line: { left: hiccup, right: [] }, least: 0 }]
  if (slip.verb === SKILL) {
    // A skill by its name, which is cut as a name is: "Hiccup · plugin-authoring skill".
    return [squeezed(lead, slip.target, {}, [{ text: ' skill' }]), ...after]
  }
  if (slip.target === '') {
    // A tool with nothing to name says what it was doing as a set phrase ("Hiccup · Find tools",
    // "Hiccup · Update the todos"); a subagent sent with no task in words is named as one ("Hiccup ·
    // A subagent"), as the beach says it, never by the verb that was to come before its task.
    return slip.verb === 'Delegating' ? after : [whole(slip.what), ...after]
  }
  if (slip.verb === 'Using') {
    const { server, action } = usingParts(slip.target)
    return server === '' ? [squeezed(lead, action, { isQuote: true }), ...after] : [squeezed([...lead, { text: `${server}: ` }], action, { isQuote: true }), whole(server), ...after]
  }
  if (slip.verb === 'Running') {
    return [squeezed(lead, slip.target, { isCommand: true }), ...after]
  }

  return [squeezed(lead, slip.target, isWordy(slip.verb) ? { isQuote: true } : {}), ...after]
}

/**
 * What failed, in a word, for a hiccup with no room to say more: a command (described, as typed, or
 * looked in on), a task in the background, a subagent, a skill, a web search; a tool at a name by
 * what the name is (a file, a search, a folder, a page); and under each of them any tool. So a
 * hiccup at a name goes from its name, cut to its stem, to "Hiccup · A file", and "Hiccup" alone is
 * left for a band too narrow for any word.
 */
function hiccupNouns(slip: Doing): string[] {
  if (slip.verb === 'Delegating') return [SUBAGENT, A_TOOL]
  // "A tool" is just as short as "A task": under it, it would only show where the desktop's font fits
  // the one a pixel before the other, the less exact word for a column (as the beach's, see nounsFor).
  if (TASK_VERBS.has(slip.verb)) return [A_TASK]
  if (slip.kind === 'run') return [A_COMMAND, A_TOOL]
  if (slip.verb === SKILL || slip.verb === SKILL_ALONE) return ['A skill', A_TOOL]
  if (slip.verb.endsWith(' the web for')) return [WEB_SEARCH, A_TOOL]
  const noun = slip.target === '' || slip.verb === 'Using' ? null : nameNoun(slip)

  return noun === null ? [A_TOOL] : [noun, A_TOOL]
}

/** A task in the background, looked in on or stopped: "Hiccup · A task", never "A command". */
const TASK_VERBS = new Set(['Checking on a task', 'Stopping a task'])

/** What a tool at a name worked on, in a word: a file read or changed, a search, a folder, a web page. */
function nameNoun(slip: Doing): string | null {
  if (slip.kind === 'edit') return 'A file'
  if (slip.kind === 'web') return 'A page'
  if (slip.verb === 'Searching for') return 'A search'
  if (slip.verb === 'Listing') return 'A folder'
  if (slip.verb === 'Reading') return 'A file'

  return null
}

// A dim verb and its object, then on the narrowest band the verb alone
// ("Reading", "Searching"); a described command is its description alone
// ("Run the tests"), cut after a whole word if it must be, then "Running".
// A web search gives up "the web" before its query loses a word.
function doing(activity: Doing): Form[] {
  const least = Math.min(cells(activity.target), LEAST)
  const dim = (text: string): Form => ({ line: { left: [{ text, color: DIM }], right: [] }, least: 0 })
  if (activity.kind === 'ask') {
    // A wait on you, all in the quiet dim as "Ready" is: "Asking you: Auth method", then "Asking
    // you"; "Plan ready for you", then "Plan ready". The question's header is words Claude wrote for
    // you, cut after a whole word ("Asking you: Auth…"), never mid-word ("Auth met…").
    if (activity.target === '') {
      return phraseForms(activity.verb).map(dim)
    }
    return [{ line: { left: [{ text: `${activity.verb}:`, color: DIM }, SPACE], squeeze: [{ text: activity.target, color: DIM }], tail: [], right: [], isSaid: true }, least }, dim(activity.verb)]
  }
  if (activity.verb === '') {
    // A described command, cut at a word ("Run the…"); on the narrowest band, "Running".
    return [{ line: { left: [], squeeze: [{ text: activity.target }], tail: [], right: [], isSaid: true }, least }, { line: { left: [{ text: 'Running', color: DIM }], right: [] }, least: 0 }]
  }
  const verb: Form = { line: { left: [{ text: activity.verb.replace(/ (?:the web )?for$/u, ''), color: DIM }], right: [] }, least: 0 }
  if (activity.target === '') {
    // A verb alone ("Planning"), or a set phrase that on the narrowest band says what it is doing
    // ("Checking on a command", then "Checking").
    return phraseForms(activity.verb).map(dim)
  }
  const object = (text: string, fewest: number, isSaid = false, isCommand = false): Form => ({
    line: { left: [{ text, color: DIM }, SPACE], squeeze: [{ text: activity.target }], tail: [], right: [], isSaid, isCommand },
    least: fewest,
  })
  if (activity.verb.endsWith(' the web for')) {
    // The query is words a person wrote: cut at a word, down to its first ("Searching for ink…"); a
    // few short words, so its first alone still says what is being looked for.
    return [object(activity.verb, cells(activity.target), true), object(activity.verb.replace(/ the web for$/u, ' for'), Math.min(cells(activity.target), QUERY_LEAST), true), verb]
  }

  if (activity.verb === SKILL) {
    // A skill by its name, cut as a name is, the word "skill" kept after it ("Using the plugin-auth…
    // skill"); narrower, "Using a skill", and on the narrowest band "Using a tool".
    return [{ line: { left: [{ text: SKILL, color: DIM }, SPACE], squeeze: [{ text: activity.target }], tail: [{ text: ' skill', color: DIM }], right: [] }, least }, ...phraseForms(SKILL_ALONE).map(dim)]
  }
  if (activity.verb === 'Using') {
    // Another server's tool, what it does cut at a word, its server never ("Using Linear: create…");
    // on the narrowest band its server, "Using Linear", or "Using a tool"; never a bare "Using",
    // which wants its object.
    const { server, action } = usingParts(activity.target)
    const head: Row = [{ text: 'Using', color: DIM }, SPACE, ...(server === '' ? [] : [{ text: `${server}:` }, SPACE])]
    return [
      { line: { left: head, squeeze: [{ text: action }], tail: [], right: [], isSaid: true }, least: Math.min(cells(action), LEAST) },
      ...usingForms(activity.target).map((text): Form => ({ line: { left: [{ text, color: DIM }], right: [] }, least: 0 })),
    ]
  }
  if (activity.verb === 'Running') {
    // A command, cut at a word ("Running git log…"); one with no space early on, as a name is
    // ("Running node_modules/.bin…"), so even the desktop's panel shows something of it.
    return [object(activity.verb, least, false, true), verb]
  }
  if (isWordy(activity.verb)) {
    // What a subagent was asked to do, cut at a word ("Delegating: Explore the hooks…"): a
    // subagent's task is a sentence of its own, so a colon sets it apart from the verb.
    return [object(activity.verb === 'Delegating' ? 'Delegating:' : activity.verb, least, true), verb]
  }

  return [object(activity.verb, least), verb]
}

// How the last turn went, in forms longest first. Durations as Claude Code says them ("41s",
// "2m 14s", "1h 2m"), each with a shorter form that keeps the figure whole ("2m", "1h"). "Done" is
// green while Clawd cheers for it, then plain ink, as the beach greens it only for the cheer.
function lastTurn(turn: LastTurn, isLanding: boolean): Row[] {
  const [long = '', ...short] = durationForms(turn.seconds)
  if (turn.ending === 'error') {
    // "Stopped on an error after 12s", then "Error after 12s", "Error": the figure outlasts the long
    // verdict, so it never goes and comes back.
    const error: Row = [{ text: 'Error', color: WARN }]
    return [
      [{ text: 'Stopped on an error', color: WARN }, SPACE, { text: `after ${long}`, color: DIM }],
      ...[long, ...short].map((took): Row => [...error, SPACE, { text: `after ${took}`, color: DIM }]),
      error,
    ]
  }
  if (turn.ending === 'stopped') {
    // Esc, or a turn the model declined: no cheer, no green, just where it ended.
    return [...[long, ...short].map((took): Row => [{ text: `Stopped after ${took}`, color: DIM }]), [{ text: 'Stopped', color: DIM }]]
  }
  const done: Row = [isLanding ? { text: 'Done', color: SUCCESS } : { text: 'Done' }]
  const took = `in ${long}`
  const tools = `${turn.tools} tool${turn.tools === 1 ? '' : 's'}`
  const files = `${turn.files} file${turn.files === 1 ? '' : 's'}`
  // A turn that only talked says how long it took, not "0 tools".
  const details =
    turn.tools === 0
      ? [took]
      : turn.files > 0
        ? [`${took} · ${tools} · ${files} changed`, `${took} · ${tools} · ${files}`, `${took} · ${tools}`, took]
        : [`${took} · ${tools}`, took]

  return [...[...details, ...short.map(text => `in ${text}`)].map((text): Row => [...done, SPACE, { text, color: DIM }]), done]
}
