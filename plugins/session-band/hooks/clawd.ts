// Clawd as Claude Code draws him, cell by cell (CLAWD.md): his poses, eyes,
// arms, feet and turning frames, shared by the terminal band and its tests.
// And how many terminal cells a text takes, so every fit is measured the way a
// terminal draws it, never by String.length.

export type Eyes = 'open' | 'left' | 'right' | 'closed' | 'wink'
export type Arms = 'down' | 'up' | 'one-up'
export type Feet = 'both' | 'left' | 'right'

export const ARMS: Record<Arms, { r1L: string; r1R: string; r2L: string; r2R: string }> = {
  down: { r1L: ' ▐', r1R: '', r2L: '▝▜', r2R: '█▀' },
  up: { r1L: '▗▟', r1R: '▄', r2L: ' ▜', r2R: '█▘' },
  'one-up': { r1L: ' ▐', r1R: '▄', r2L: '▝▜', r2R: '█▘' },
}

/** Each span laid from column 2. A lid is drawn dark on his body; any other span body on dark, so a glyph's empty quadrant is a pupil. */
export const EYES: Record<Eyes, Array<{ text: string; isLid?: boolean }>> = {
  open: [{ text: '▛███▛█' }],
  left: [{ text: '▟███▟█' }],
  right: [{ text: '█▟███▟' }],
  closed: [{ text: '▂', isLid: true }, { text: '███' }, { text: '▂', isLid: true }, { text: '█' }],
  wink: [{ text: '▛███' }, { text: '▂', isLid: true }, { text: '█' }],
}

export const FEET: Record<Feet, string> = { both: ' ▝▝   ▝▝', left: ' ▝▝', right: '      ▝▝' }

/**
 * Claude Code's turning frames, a full spin from facing you round to facing
 * you again: three rows each, and for the head and body rows the columns
 * [from, to) drawn on his dark background.
 */
export const SPIN: ReadonlyArray<readonly [string, number, number, string, number, number, string]> = [
  [' ▐█▜██▛█ ', 2, 8, '▝▜██████▀', 2, 7, ' ▝▝   ▝▝ '],
  ['  █▛██▛▌ ', 2, 7, ' ▝█████▛ ', 2, 7, '  ▘▘  ▘▘ '],
  ['  ▐█▛█▜  ', 3, 7, '  ▐████  ', 3, 7, '  ▝▝ ▝▝  '],
  ['   ██▛▌  ', 3, 6, '   ███▌  ', 3, 6, '   ▘  ▘  '],
  ['   ▐██   ', 4, 6, '   ▐██   ', 4, 6, '   ▝ ▝   '],
  ['   ███▌  ', 3, 6, '   ███▌  ', 3, 6, '   ▘  ▘  '],
  ['  ▐████  ', 3, 7, '  ▐████  ', 3, 7, '  ▝▝ ▝▝  '],
  ['  █████▌ ', 2, 7, ' ▝█████▛ ', 2, 7, '  ▘▘  ▘▘ '],
  [' ▐██████ ', 2, 8, '▝▜██████▀', 2, 7, ' ▝▝   ▝▝ '],
  ['   ▛██▌  ', 3, 6, '   ███▌  ', 3, 6, '   ▘  ▘  '],
  ['  ▐▜▛██  ', 3, 7, '  ▐████  ', 3, 7, '  ▝▝ ▝▝  '],
  ['  ▛██▛█▌ ', 2, 7, ' ▝█████▛ ', 2, 7, '  ▘▘  ▘▘ '],
  [' ▐▛███▜█ ', 2, 8, '▝▜██████▀', 2, 7, ' ▝▝   ▝▝ '],
]

/** Apple's Terminal: Claude Code's simpler Clawd, his eyes drawn into a solid head. */
export const APPLE_EYES: Record<Eyes, string> = {
  open: ' ▗   ▖ ',
  left: ' ▘   ▘ ',
  right: ' ▝   ▝ ',
  closed: ' ▂   ▂ ',
  wink: ' ▗   ▂ ',
}

/** How many terminal cells a text takes: wide (East Asian) characters and emoji two, combining marks none. */
export function cells(text: string): number {
  const codes = [...text].map(char => char.codePointAt(0) ?? 0)
  let sum = 0
  for (let i = 0; i < codes.length; i++) {
    const width = cellWidth(codes[i] ?? 0)
    // A text-style symbol followed by the emoji selector (U+FE0F) is drawn as a wide emoji.
    sum += width === 1 && codes[i + 1] === 0xfe0f ? 2 : width
  }

  return sum
}

/** The longest start of `text` that fits in `room` cells. */
export function cut(text: string, room: number): string {
  let out = ''
  for (const char of text) {
    if (cells(out + char) > room) {
      break
    }
    out += char
  }

  return out
}

function cellWidth(code: number): number {
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0x1f3fb && code <= 0x1f3ff) ||
    (code >= 0xe0020 && code <= 0xe007f)
  ) {
    return 0
  }
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    EMOJI_WIDE.has(code) ||
    (code >= 0x1f000 && code <= 0x1f02f) ||
    (code >= 0x1f0a0 && code <= 0x1f0ff) ||
    (code >= 0x1f18e && code <= 0x1f1ff) ||
    (code >= 0x1f200 && code <= 0x1f2ff) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    (code >= 0x1f7e0 && code <= 0x1f7ff) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)

  return isWide ? 2 : 1
}

// The symbols below U+1F000 that terminals draw as wide emoji (Unicode's
// Emoji_Presentation set there): watches, hourglasses, weather, zodiac,
// sports, ✅ ✨ ❌ ❓ ❗ ➕ and friends.
const EMOJI_WIDE = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c,
  0x264d, 0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce,
  0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757,
  0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
])
