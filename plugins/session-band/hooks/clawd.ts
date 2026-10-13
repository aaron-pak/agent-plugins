// Clawd as Claude Code draws him, cell by cell (CLAWD.md): his poses, eyes,
// arms, feet and turning frames, shared by both looks' terminal bands, both
// desktops (which draw him from the same cells) and the tests. His marks too
// (the pet's heart, the nap's z), so one Clawd answers one gesture the same way
// in either look. And how many terminal cells a text takes, so every fit is
// measured the way a terminal draws it, never by String.length.

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

/** Apple's Terminal's feet, under the solid body. */
export const APPLE_FEET: Record<Feet, string> = { both: ' ▘▘   ▝▝', left: ' ▘▘', right: '      ▝▝' }

// ── His marks, the same in both looks ─────────────────────────────────────────
//
// Raw colors, since no theme key covers them and an Svg cannot follow the page's theme: each reads
// on a dark and a light terminal and on both claude.ai pages (#faf9f5 and #262624).

/** His clay and his eye, as both desktops paint him. */
export const CLAY = '#D77757'
export const EYE_INK = '#1B1A19'
/** The pet's heart on both desktops. */
export const HEART_PINK = '#E9789B'
/**
 * The pet's heart in both terminal looks: the same pink moved onto xterm's 256-color entry 175
 * (#d787af), so a terminal that shows only 256 colors keeps its hue.
 */
export const TERMINAL_HEART = '#E37DA2'
/** The nap's z's, on both desktops. */
export const DOZE_SLATE = '#7E95B5'
/** A pointer must rest on him this long before it counts as petting: one passing on its way to the composer does not. */
export const HOVER_S = 0.15

/**
 * The terminal's block heart as one Svg path: 8 pixels across and 4 down, each `w` by `h` units, its
 * corner at (x, y). One path, a run of a row to each part, so it fills as one shape and no hairline
 * of the page shows between its pixels as it pops and settles.
 */
export function pixelHeart(x: number, y: number, w: number, h: number): string {
  const rows = ['.XX..XX.', 'XXXXXXXX', '.XXXXXX.', '...XX...']
  const at = (n: number) => Math.round(n * 1000) / 1000
  const runs = rows.flatMap((row, r) =>
    [...row.matchAll(/X+/gu)].map(run => {
      const [left, top] = [at(x + (run.index ?? 0) * w), at(y + r * h)]
      const [right, bottom] = [at(left + run[0].length * w), at(top + h)]
      return `M${left} ${top}L${right} ${top}L${right} ${bottom}L${left} ${bottom}Z`
    }),
  )

  return `<path d="${runs.join('')}"/>`
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

// Glyph advances at 14 px, in tenths of a pixel, for ASCII 32 to 126: the widest
// of Inter, DejaVu Sans and Liberation Sans (Arial's metrics), regular and semibold.
// prettier-ignore
const REGULAR = [45,57,66,118,90,138,110,42,55,55,71,118,45,65,45,51,90,90,90,90,91,90,90,90,90,90,48,48,118,118,118,78,143,97,96,103,108,94,86,109,106,42,80,95,80,127,106,111,94,111,102,94,91,105,97,139,96,95,96,55,51,55,118,78,70,86,89,80,89,87,52,89,89,39,39,82,39,137,89,86,89,89,58,74,55,89,83,115,83,83,78,90,48,90,118]
// prettier-ignore
const BOLD = [49,64,74,118,98,141,123,46,64,64,76,118,54,66,54,53,98,98,98,98,98,98,98,98,98,98,56,56,118,118,118,86,140,109,107,104,117,96,96,115,118,53,82,109,90,140,118,119,103,119,108,101,96,114,109,155,108,102,102,64,53,64,118,78,70,95,101,83,101,95,61,101,100,48,48,94,48,146,100,97,101,101,69,84,67,100,92,130,91,92,82,100,52,100,118]

/**
 * A text's width in pixels at 14 px, as the desktop draws it in a proportional font, erring wide:
 * CJK and emoji at 18, any other symbol at 14. Both looks' desktops fit their words with it.
 */
export function textPx(text: string, isBold: boolean): number {
  let px = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const ascii = code >= 32 && code < 127 ? (isBold ? BOLD : REGULAR)[code - 32] : undefined
    px += ascii !== undefined ? ascii / 10 : char === '·' ? 5.4 : cells(char) === 0 ? 0 : cells(char) === 2 ? 18 : 14
  }

  return px
}

/** Little words a cut of words a person wrote never ends on before its ellipsis: "Review the…" reads unfinished. */
const LITTLE = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'why', 'with'])

/**
 * A cut of words a person wrote (back to a whole word already), less the little words it would end
 * on: "Investigate why the…" reads "Investigate…", "reloads twice at…" reads "reloads twice…". Only
 * while `floor` characters of it stay: a cut too short to lose its little word ("Run the…") still
 * ends on it, and is no cut at all (see endsLittle): the line takes its next form.
 */
export function trimLittle(text: string, floor: number): string {
  let out = text
  for (;;) {
    const last = /\s+(\S+)$/u.exec(out)
    if (last === null || !LITTLE.has((last[1] ?? '').toLowerCase())) {
      return out
    }
    const shorter = out.slice(0, last.index).replace(/[\s/._:;,-]+$/u, '')
    if ([...shorter].length < floor) {
      return out
    }
    out = shorter
  }
}

/** Whether a cut of words ends on a little word ("Run the", "Look at"), which reads unfinished before an ellipsis. */
export function endsLittle(text: string): boolean {
  const last = /(\S+)$/u.exec(text.trimEnd())?.[1]

  return last !== undefined && LITTLE.has(last.toLowerCase())
}

/**
 * Where a name's last '.'-part begins (a file's extension, a host's "com"): the index of its dot,
 * in characters, or null when it has none. A test's, a story's or a type file's double extension
 * is one ("band.test.tsx", "index.d.ts", "app.module.css" end in theirs), so a cut never leaves
 * half of it ("band.test…"). A glob's last part from its star (a "*.failing.tsx" after its
 * folders) is its extension too, so a cut never ends inside it, a letter or two after the dot.
 */
export function lastDot(text: string): number | null {
  const glob = /\*+\.[^/*]*$/u.exec(text)
  if (glob !== null) {
    const at = [...text.slice(0, glob.index)].length
    return at > 0 ? at : null
  }
  const chars = [...text]
  const dot = chars.lastIndexOf('.')
  if (dot <= 0 || dot >= chars.length - 1) {
    return null
  }
  const before = chars.slice(0, dot).join('')
  const inner = /\.(?:test|spec|stories|story|module|config|min|mock|e2e|d)$/iu.exec(before)
  const inside = inner === null ? -1 : [...before.slice(0, inner.index)].length

  return inside > 0 ? inside : dot
}

/** A cut of a name that ends fewer than this many letters into one of its parts, or short of its end, reads as a typo ("a-file-t…", "registe…"). */
const STUB = 3

/**
 * A name (a file, a host, a branch, a pattern) cut to `kept`, its start cut at a character: never
 * inside its extension (see trimExtension), and back to the end of one of its parts wherever that
 * keeps `least` characters: "an-extraordinarily-long-component…", "docs.anthropic…", "useEffect…"
 * (its parts meet at a '-', '_', '.', '/' or space, or a camelCase hump). Where none does, the cut
 * stays inside the part, three letters in at least and three short of its end at least: a letter or
 * two either way reads as a typo ("a-file-t…", "docs.an…", "an-extraordinaril…", "registe…"). With
 * no such room, it is no cut at all (''), and the line takes a shorter form. Writing with no spaces
 * between its words (Japanese, Chinese) is cut between any two of its characters.
 */
export function partCut(text: string, kept: string, least: number): string {
  const chars = [...text]
  const cut = [...trimExtension(text, kept)]
  const end = cut.length
  if (end >= chars.length) {
    return text
  }
  if (isPartEnd(chars, end)) {
    return trailing(cut.join(''))
  }
  if (cells(chars[end - 1] ?? '') > 1) {
    // Writing that puts no spaces between its words (Japanese, Chinese) may be cut between any two
    // of its characters, as words a person wrote are: no typo to fear ("日本語の…").
    return cut.join('')
  }
  // Back to where the part the cut is in begins, and on to where it ends.
  let start = end
  while (start > 0 && !isPartEnd(chars, start)) start -= 1
  if (start > 0) {
    const back = trailing(chars.slice(0, start).join(''))
    if ([...back].length >= least) {
      return back
    }
  }
  const first = start > 0 && isSeparator(chars[start]) ? start + 1 : start
  let stop = end
  while (stop < chars.length && !isPartEnd(chars, stop)) stop += 1
  if (first > 0 && end - first < STUB) {
    return ''
  }
  if (stop - end < STUB) {
    const shorter = stop - STUB
    return first > 0 && shorter - first < STUB ? '' : chars.slice(0, Math.max(0, shorter)).join('')
  }

  return cut.join('')
}

function isSeparator(char: string | undefined): boolean {
  return char !== undefined && /[\s/._-]/u.test(char)
}

/** Whether a cut before `at` ends one of a name's parts: at a separator, either side of it, or a camelCase hump. */
function isPartEnd(chars: string[], at: number): boolean {
  if (at <= 0 || at >= chars.length) {
    return false
  }
  const before = chars[at - 1] ?? ''
  const after = chars[at] ?? ''

  return isSeparator(after) || isSeparator(before) || (/[\p{Ll}\d]/u.test(before) && /\p{Lu}/u.test(after))
}

/** Never an ellipsis after a separator or a glob's star ("first-…", "**…"). */
function trailing(text: string): string {
  return text.replace(/[\s/._:;,*-]+$/u, '')
}

/**
 * A name cut to `kept` (its start, cut at a character), never inside its last '.'-part: a partial
 * extension reads as a typo ("register.t…"), so the cut steps back to before its dot ("register…").
 */
function trimExtension(text: string, kept: string): string {
  const dot = lastDot(text)
  const length = [...kept].length

  return dot !== null && length > dot && length < [...text].length ? [...text].slice(0, dot).join('') : kept
}

/**
 * The fewest characters a cut of words a person wrote keeps: `floor`, or fewer when the words open
 * with a whole word of four letters or more, which may stand alone ("Survey…", "Check…", "List…").
 * Never a short or little one ("Run the…" keeps its "the"). Names keep their floor (see the cuts).
 */
export function wordFloor(text: string, floor: number): number {
  const first = /^(\p{L}{4,})\s/u.exec(text)?.[1]

  return first === undefined || LITTLE.has(first.toLowerCase()) ? floor : Math.min(floor, [...first].length)
}

/**
 * A cut of a command, less the shell's joints it would end on ("cd /work &&…" reads "cd /work…"),
 * and less a one-letter flag whose argument the cut left behind ("tsc --noEmit -p…" reads "tsc
 * --noEmit…"), while `floor` characters of it stay.
 */
export function trimJoints(text: string, floor: number): string {
  const joints = (cut: string) => cut.replace(/(?:\s+(?:&&|\|\||\||;|&))+$/u, '')
  const bare = joints(text)
  const unflagged = joints(bare.replace(/\s+-\p{L}$/u, ''))

  return [unflagged, bare].find(cut => [...cut].length >= floor) ?? text
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
