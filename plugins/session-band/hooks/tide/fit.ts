import { cells, cut, endsLittle, partCut, textPx, trimJoints, trimLittle, wordFloor } from '../clawd'
import type { Piece, Words } from './types'

// Fitting a line of the beach's words to its room. A line comes as forms, longest first, each one
// taking something away from the one before (see words.ts); the first that fits is drawn. A form
// fits when its words do, or when its one name (`isShort`) can be cut at its end, with an ellipsis,
// and still keep its `least` characters. Each surface measures in its own unit: the terminal in
// cells, the desktop in pixels of a proportional font.

/** How a surface measures a run of text, and the room its ellipsis takes. */
export type Measure = { text: (text: string, isBold: boolean) => number; ellipsis: number }

/**
 * Terminal cells: a CJK character or an emoji takes two, and the ellipsis is counted as two (its
 * width is ambiguous), so a terminal that draws it wide still fits the line.
 */
export const CELLS: Measure = { text: text => cells(text) + (text.match(/…/gu)?.length ?? 0), ellipsis: 2 }

/** Pixels at 14 px, each glyph at the widest of three common UI fonts (see textPx). */
export const PIXELS: Measure = { text: textPx, ellipsis: textPx('…', false) }

const ELLIPSIS = '…'

/**
 * The first form that fits the room. When none does, the last with its name cut as far as it must
 * be; failing even that (a band too narrow for any name), the last whole, which Ink (or the page)
 * cuts at its end.
 */
export function fitLine(forms: Words[], room: number, m: Measure): Words {
  for (const form of forms) {
    const fitted = fitForm(form, room, m)
    if (fitted !== null) {
      return fitted
    }
  }
  const last = forms[forms.length - 1] ?? []

  return fitForm(last, room, m, 1) ?? last
}

function fitForm(form: Words, room: number, m: Measure, least?: number): Words | null {
  const width = (piece: Piece) => m.text(piece.text, piece.bold === true || piece.fitsAsBold === true)
  const total = form.reduce((sum, piece) => sum + width(piece), 0)
  if (total <= room) {
    return form
  }
  const at = form.findIndex(piece => piece.isShort === true)
  const piece = form[at]
  if (piece === undefined) {
    return null
  }
  const chars = [...piece.text]
  const keep = least ?? piece.least ?? 1
  // A name no longer than what a cut must keep is never cut: it shows whole, or the form gives way.
  if (chars.length <= keep) {
    return null
  }
  // Words a person wrote may stop after their first word alone, when it is a real word of four
  // letters or more ("Survey…"), but never in a quote of what failed ('"Survey…" failed' would quote
  // a bare verb); everything else keeps `keep` characters.
  const isWords = piece.cut === 'word' || piece.cut === 'quote'
  const floor = piece.cut === 'word' ? wordFloor(piece.text, keep) : keep
  const left = room - (total - width(piece)) - m.ellipsis
  let kept = ''
  if (m === CELLS) {
    // Never half of a wide character.
    kept = cut(piece.text, left)
  } else {
    for (const char of chars) {
      if (m.text(kept + char, piece.bold === true) > left) break
      kept += char
    }
  }
  if (piece.cut !== undefined) {
    // Back to the end of the last whole word (or part of a name) the cut keeps. Writing that puts
    // no spaces between its words (Japanese, Chinese) may be cut between any two of its characters.
    const isWide = (char: string | undefined) => char !== undefined && cells(char) > 1
    const backTo = (isBreak: RegExp) => {
      const isEdge = (at: number) => [chars[at], chars[at - 1]].some(char => char !== undefined && (isBreak.test(char) || isWide(char)))
      let end = [...kept].length
      while (end > 0 && !isEdge(end)) end -= 1
      return chars.slice(0, end).join('').replace(/[\s/._:;,-]+$/u, '')
    }
    const words = piece.cut === 'part' ? '' : backTo(/\s/u)
    // Words a person wrote never end on a little word ("Review the…"), and nothing ends on a shell's
    // joint ("&&…"), which no person writes as words.
    const whole = piece.cut === 'part' ? backTo(/[\s._-]/u) : isWords ? trimLittle(trimJoints(words, floor), floor) : trimJoints(words, keep)
    // A quote keeps two words at least (or writing with no spaces between its words).
    const isPhrase = /\s/u.test(whole) || [...whole].some(char => cells(char) > 1)
    if ([...whole].length >= floor && !(isWords && endsLittle(whole)) && (piece.cut !== 'quote' || isPhrase)) {
      kept = whole
    } else if (isWords) {
      // Words a person wrote are never cut mid-word, nor down to a little word ("Run the…") or, quoted,
      // to one word: the line takes a shorter form.
      return null
    } else if (piece.cut === 'command') {
      // A command with no space early on ("node_modules/.bin/vitest…", "cd /Users/robin/…") is cut
      // as a name instead, after a part of a path where one keeps enough; never inside a short
      // word ("npm tes…"): the line takes a shorter form.
      const part = backTo(/[\s/._-]/u)
      if ([...part].length < keep) {
        return null
      }
      kept = part
    }
  }
  if (piece.cut === undefined) {
    // A name is never cut inside its extension ("register.t…"), and goes back to the end of a part
    // where one keeps enough ("a-file-that…", "docs.anthropic…"); never a letter or two into a new
    // part ("a-file-t…") or short of its stem ("registe…"), which read as typos.
    kept = partCut(piece.text, kept, keep)
  }
  kept = kept.replace(/[\s/._:;,-]+$/u, '')
  if ([...kept].length < floor) {
    return null
  }

  return form.map((p, i) => (i === at ? { ...p, text: `${kept}${ELLIPSIS}` } : p))
}
