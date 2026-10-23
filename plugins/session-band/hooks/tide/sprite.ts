import { APPLE_EYES, APPLE_FEET, ARMS, EYES, FEET, SPIN } from '../clawd'
import type { Arms, Eyes, Feet } from '../clawd'

// Clawd on the beach, exactly as Claude Code draws him, in terminal cells: the terminal band draws
// these rows, the desktop turns them into pixels, and the one-row band keeps his head. They live
// apart from the terminal band, which the hooks module never needs to import.

/** A cell of the scene; `kind` marks the shell and the wave, which a mark keeps a cell of sky from. */
export type Cell = { ch: string; color?: string; bg?: string; dim?: boolean; kind?: 'wave' | 'shell' }
export type Row = Cell[]

// Clawd's colors are the theme's own.
export const BODY = 'clawd_body'
export const EYE = 'clawd_background'
/** How many cells wide he stands. */
export const SPRITE = 9

// His eyes, arms, feet and turning frames are clawd.ts's, the hearth's very own: one Clawd in both looks.
export type Pose = { eyes: Eyes; arms: Arms; feet: Feet }

function blank(): Row {
  return Array.from({ length: SPRITE }, () => ({ ch: ' ' }))
}

/** A run of his glyphs as cells, those in columns [from, to) on his dark background. */
function spriteRow(text: string, from: number, to: number): Row {
  return [...text].map((ch, i) => (ch === ' ' ? { ch } : i >= from && i < to ? { ch, color: BODY, bg: EYE } : { ch, color: BODY }))
}

export function pose({ eyes, arms, feet }: Pose): [Row, Row, Row] {
  const a = ARMS[arms]
  const head: Row = [...spriteRow(a.r1L, 0, 0)]
  for (const span of EYES[eyes]) {
    for (const ch of span.text) {
      head.push(span.isLid === true ? { ch, color: EYE, bg: BODY } : { ch, color: BODY, bg: EYE })
    }
  }
  head.push(...spriteRow(a.r1R, 0, 0))
  const body = [...spriteRow(a.r2L, 0, 0), ...spriteRow('█████', 0, 5).map(cell => ({ ...cell, bg: EYE })), ...spriteRow(a.r2R, 0, 0)]

  return [pad(head), pad(body), pad(spriteRow(FEET[feet], 0, 0))]
}

export function spin(frame: number): [Row, Row, Row] {
  const [r0, a0, b0, r1, a1, b1, r2] = SPIN[frame] ?? SPIN[0] ?? []
  if (r0 === undefined || r1 === undefined || r2 === undefined) {
    return pose({ eyes: 'open', arms: 'down', feet: 'both' })
  }

  return [spriteRow(r0, a0 ?? 0, b0 ?? 0), spriteRow(r1, a1 ?? 0, b1 ?? 0), spriteRow(r2, 0, 0)]
}

// Napping: his own head and body, settled down a row so he is nestled in the sand.
export function curled(): [Row, Row, Row] {
  const [head, body] = pose({ eyes: 'closed', arms: 'down', feet: 'both' })

  return [blank(), head, body]
}

// Apple's Terminal draws block glyphs on colored backgrounds badly, so Claude Code gives it a
// simpler Clawd: his eyes drawn dark into a solid head, a body of plain color, no arms, and no
// spin. The beach draws him the same way there.
export function applePose({ eyes, feet }: Pose): [Row, Row, Row] {
  const head: Row = [
    { ch: '▗', color: BODY },
    ...[...APPLE_EYES[eyes]].map((ch): Cell => ({ ch, color: EYE, bg: BODY })),
    { ch: '▖', color: BODY },
  ]
  const body: Row = [{ ch: ' ' }, ...Array.from({ length: 7 }, (): Cell => ({ ch: ' ', bg: BODY })), { ch: ' ' }]

  return [pad(head), pad(body), pad(spriteRow(APPLE_FEET[feet], 0, 0))]
}

export function appleCurled(): [Row, Row, Row] {
  const [head, body] = applePose({ eyes: 'closed', arms: 'down', feet: 'both' })

  return [blank(), head, body]
}

function pad(row: Row): Row {
  return [...row, ...blank()].slice(0, SPRITE)
}
