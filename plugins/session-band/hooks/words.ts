// The band's words, shared by both surfaces: each line as its forms, longest
// first, and the fit that picks the first one with room. The terminal measures
// in cells; the desktop measures the same forms in pixels of a proportional
// font (desk.tsx). Parts drop whole, so a figure or a label is never cut: only
// a branch, a file name or a todo may be cut, at its end, and only once enough
// of it still shows.

import type { BandProps, Doing, LastTurn } from '../types'
import { cells } from './clawd'

export type Seg = { text: string; color?: string; backgroundColor?: string; bold?: boolean }
export type Row = Seg[]
/**
 * One line of words: `left` and its figures on the `right`. A line may name a
 * part of `left` that gives way first when room runs short (a branch, a file
 * name, a todo): it sits between `left` and `tail`, cut at its end. Figures
 * and labels are never in it. `squeezeWidth`, when set, is the room it is cut
 * to, in cells (the terminal's: see band.tsx).
 */
export type Line = { left: Row; squeeze?: Row; tail?: Row; right: Row; squeezeWidth?: number }
/** A form of a line, and how many cells of its squeezed part must show for it to count as fitting. */
export type Form = { line: Line; least: number }

/** How a surface measures a row, the two-cell gap before the right-hand figures, and `n` cells of a squeezed part. */
export type Measure = { row: (row: Row) => number; gap: number; least: (n: number) => number }

// Theme keys: the words' colors follow the person's theme on both surfaces.
export const DIM = 'inactive'
export const ACCENT = 'claude'
export const WARN = 'warning'
const SUCCESS = 'success'

/** A squeezed part (a branch, a file name) must show at least this much, or the line takes a shorter form. */
export const LEAST = 6
/** With the model beside it, a branch must keep eight cells and its cut; any less and the model gives way first. */
const LEAST_BESIDE_MODEL = 9

/** A plain space: the bold project and the warm figures never sit right beside dim words. */
export const SPACE: Seg = { text: ' ' }

export function needs({ line, least }: Form, m: Measure): number {
  const squeeze = line.squeeze === undefined ? 0 : Math.min(m.row(line.squeeze), m.least(least))

  return m.row(line.left) + squeeze + m.row(line.tail ?? []) + (line.right.length === 0 ? 0 : m.gap + m.row(line.right))
}

/** The first form that fits the room; the last form when none does. */
export function firstFit(forms: Form[], room: number, m: Measure): Line {
  return (forms.find(form => needs(form, m) <= room) ?? forms[forms.length - 1])?.line ?? { left: [], right: [] }
}

/** The room left for a line's squeezed part once everything else has its place. */
export function squeezeRoom(line: Line, room: number, m: Measure): number {
  return room - m.row(line.left) - m.row(line.tail ?? []) - (line.right.length === 0 ? 0 : m.gap + m.row(line.right))
}

// ── Line 1: where you are ──────────────────────────────────────────────────────
//
// The project, its branch, what is uncommitted, and the model. When room runs
// short the branch loses its prefix (claude/first-mod reads first-mod), then
// the count gets shorter (· 3 changed, · 3 files, · 3) so the branch still
// shows whole; only then is the branch cut at its end (beside the model, only
// while eight cells of it still show), then the model goes, then the branch.

export function whereForms(props: Pick<BandProps, 'project' | 'branch' | 'dirty' | 'model'>): Form[] {
  const project = props.project ?? ''
  const name: Row = project === '' ? [] : [{ text: project, bold: true }]
  const joint: Row = project === '' ? [] : [SPACE, { text: 'on', color: DIM }, SPACE]
  const count = props.dirty !== null && props.dirty > 0 ? props.dirty : null
  const counts: Row[] =
    count === null
      ? [[]]
      : [`${count} changed`, `${count} file${count === 1 ? '' : 's'}`, `${count}`].map(text => [SPACE, { text: `· ${text}`, color: DIM }])
  const terse = counts[counts.length - 1] ?? []
  const whole = props.branch ?? ''
  const tail = whole.slice(whole.lastIndexOf('/') + 1)
  const model = props.model ?? ''
  const rights: Row[] = model === '' ? [[]] : [[{ text: model, color: ACCENT }], []]

  const forms: Form[] = []
  for (const right of rights) {
    if (whole !== '') {
      const named: Array<[string, Row]> = [[whole, counts[0] ?? []], ...(tail === whole ? counts.slice(1) : counts).map((c): [string, Row] => [tail, c])]
      for (const [branch, dirty] of named) {
        forms.push({ line: { left: [...name, ...joint], squeeze: [{ text: branch }], tail: dirty, right }, least: cells(branch) })
      }
      forms.push({ line: { left: [...name, ...joint], squeeze: [{ text: tail }], tail: terse, right }, least: right.length > 0 ? LEAST_BESIDE_MODEL : LEAST })
    }
  }
  for (const dirty of counts) {
    forms.push({ line: { left: [...name, ...dirty], right: [] }, least: 0 })
  }
  forms.push({ line: { left: [], squeeze: name, tail: [], right: [] }, least: 1 })

  return forms
}

// ── Line 3: what is happening ──────────────────────────────────────────────────
//
// The tool at work, a hiccup, the next todo, or how the last turn went. It
// changes when the session does, never by itself: a nap is Clawd's to show,
// not the words'.

/** What line 3 is drawn from. */
export type Said = Pick<BandProps, 'isWorking' | 'activity' | 'slip' | 'todos' | 'isHigh' | 'limit' | 'lastTurn'> & {
  /** The reset countdown in words ("2h 10m"), or null. */
  resetsIn: string | null
  /** Nothing ticks here (the desktop): a countdown would go stale, so point to /usage instead. */
  isStatic: boolean
  /** A turn just landed and Clawd is cheering: its summary says what finished, before any warning. */
  isLanding: boolean
}

export function happeningForms(said: Said): Form[] {
  const todos = said.todos
  const tallies: Row[] =
    todos === null ? [] : [`${todos.done} of ${todos.total} done`, `${todos.done}/${todos.total} done`, `${todos.done}/${todos.total}`].map(text => [{ text, color: DIM }])
  const lefts = leftsOf(said)
  const shortest = tallies[tallies.length - 1]
  const tallied = (form: Form | undefined, right: Row): Form[] => (form === undefined ? [] : [{ line: { ...form.line, right }, least: form.least }])
  // The tally shortens first, then the words lose their detail beside the
  // shortest tally, then the tally goes (and the words may say more again)
  // before they are cut. Each step only ever takes away, so a narrower band
  // never says more than a wider one beside the same figure.
  return [
    ...tallies.flatMap(right => tallied(lefts[0], right)),
    ...(shortest === undefined ? [] : lefts.slice(1).flatMap(form => tallied(form, shortest))),
    ...lefts,
    { line: { left: [], squeeze: lefts[0]?.line.left.concat(lefts[0].line.squeeze ?? []) ?? [], tail: [], right: [] }, least: 1 },
  ]
}

function leftsOf(said: Said): Form[] {
  const todos = said.todos
  const plain = (...rows: Row[]): Form[] => rows.map(left => ({ line: { left, right: [] }, least: 0 }))
  const loose = (left: Row, text: string): Form => ({ line: { left, squeeze: [{ text }], tail: [], right: [] }, least: Math.min(cells(text), LEAST) })

  if (said.isWorking) {
    const activity = said.activity
    if (activity !== null) {
      return [doing(activity)]
    }
    if (said.slip !== null) {
      const hiccup: Row = [{ text: 'Hiccup', color: ACCENT }]
      return [loose([...hiccup, SPACE, { text: '·', color: DIM }, SPACE], said.slip.target === '' ? said.slip.verb : said.slip.target), ...plain(hiccup)]
    }
    if (todos !== null && todos.current !== null) {
      return [loose([{ text: 'Now', color: DIM }, SPACE], todos.current)]
    }

    return plain([{ text: 'Thinking it through', color: DIM }], [{ text: 'Thinking', color: DIM }])
  }
  const landed = said.lastTurn === null ? null : plain(...lastTurn(said.lastTurn))
  if (said.isLanding && landed !== null) {
    // Clawd cheers for this turn: the words say what finished. The warnings come back as the cheer ends.
    return landed
  }
  if (said.isHigh) {
    const full: Row = [{ text: 'Getting full', color: ACCENT }]
    return plain([...full, SPACE, { text: '· /compact when you are ready', color: DIM }], [...full, SPACE, { text: '· try /compact', color: DIM }], full)
  }
  const limit = said.limit
  if (limit !== null && limit.percent >= 80) {
    const near: Row = [{ text: `Near the ${limit.label} limit`, color: ACCENT }]
    const short: Row = [{ text: `Near ${limit.label} limit`, color: ACCENT }]
    if (said.isStatic) {
      return plain([...near, SPACE, { text: '· /usage shows when it resets', color: DIM }], near, short)
    }
    const resetsIn = said.resetsIn
    return resetsIn === null
      ? plain(near, short)
      : plain(
          [...near, SPACE, { text: `· resets in ${resetsIn}`, color: DIM }],
          [...short, SPACE, { text: `· resets in ${resetsIn}`, color: DIM }],
          [...short, SPACE, { text: `· ${resetsIn}`, color: DIM }],
          short,
        )
  }
  if (todos !== null && todos.current !== null && todos.done < todos.total) {
    return [loose([{ text: 'Next', color: DIM }, SPACE], todos.current)]
  }
  if (landed !== null) {
    return landed
  }

  return plain([{ text: 'Ready when you are', color: DIM }], [{ text: 'Ready', color: DIM }])
}

// A dim verb and its object; a described command is its description alone ("Run the tests").
function doing(activity: Doing): Form {
  const least = Math.min(cells(activity.target), LEAST)
  if (activity.verb === '') {
    return { line: { left: [], squeeze: [{ text: activity.target }], tail: [], right: [] }, least }
  }
  if (activity.target === '') {
    return { line: { left: [{ text: activity.verb, color: DIM }], right: [] }, least: 0 }
  }

  return { line: { left: [{ text: activity.verb, color: DIM }, SPACE], squeeze: [{ text: activity.target }], tail: [], right: [] }, least }
}

// How the last turn went, in forms longest first.
function lastTurn(turn: LastTurn): Row[] {
  const after = `after ${turn.seconds}s`
  if (turn.ending === 'error') {
    const stopped: Row = [{ text: 'Stopped on an error', color: WARN }]
    return [[...stopped, SPACE, { text: after, color: DIM }], stopped, [{ text: 'Stopped (error)', color: WARN }]]
  }
  if (turn.ending === 'stopped') {
    // Esc, or a turn the model declined: no cheer, no green, just where it ended.
    return [[{ text: `Stopped ${after}`, color: DIM }], [{ text: 'Stopped', color: DIM }]]
  }
  const done: Row = [{ text: 'Done', color: SUCCESS }]
  const took = `in ${turn.seconds}s`
  const tools = `${turn.tools} tool${turn.tools === 1 ? '' : 's'}`
  const files = `${turn.files} file${turn.files === 1 ? '' : 's'}`
  // A turn that only talked says how long it took, not "0 tools".
  const details =
    turn.tools === 0
      ? [took]
      : turn.files > 0
        ? [`${took} · ${tools} · ${files} changed`, `${took} · ${tools} · ${files}`, `${took} · ${tools}`, took]
        : [`${took} · ${tools}`, took]

  return [...details.map((text): Row => [...done, SPACE, { text, color: DIM }]), done]
}

export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
