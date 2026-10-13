// Which look the band wears, and what /band says. Pure: the hooks module (register.tsx) does the
// reading and writing. The look lives in one place, the `look` row of /config; /band writes that
// row, and a pick made by /band shows at once, before /config's reload lands.

import type { Look, LookPick, Motion } from '../types'

const PLUGIN = 'session-band'
/** The /config row of the look, as a plugin's own `userConfig` field is keyed; `$.config.list()` finds it when it is keyed otherwise. */
export const LOOK_KEY = `${PLUGIN}.look`
const LOOKS: readonly Look[] = ['tide', 'hearth']
const MOTIONS: readonly Motion[] = ['lively', 'still']
/** The settings' own names: alone, they ask which is on ("/band look"); beside a setting, they are read past ("/band look hearth"). */
const SETTINGS = new Set(['look', 'motion'])
/** Words that ask what is on: the same as /band alone (`h` is what is left of a `-h`). */
const ASKS = new Set(['help', 'h', '?', 'status', ...SETTINGS])
/** Words that ask for no band at all: there is no such switch, so the reply offers the quietest ways it has. */
const OFFS = new Set(['off', 'none', 'hide', 'disable'])
/**
 * The words the band's own replies use for its settings ("/band still calms them"), and a few a person
 * reaches for, read as those settings: the tide was Tidepool before the merge, and people who knew it
 * then still call it that ("/band tidepool", "tide-pool").
 */
const SAYS: Record<string, Look | Motion> = { calm: 'still', quiet: 'still', stop: 'still', pause: 'still', beach: 'tide', tidepool: 'tide', pool: 'tide' }

export function isLook(value: unknown): value is Look {
  return typeof value === 'string' && (LOOKS as readonly string[]).includes(value)
}

function isMotion(value: unknown): value is Motion {
  return typeof value === 'string' && (MOTIONS as readonly string[]).includes(value)
}

/** /config's look, read as the band reads it: a value outside the options counts as unset, so it is the default, the tide. */
export function configuredLook(configured: unknown): Look {
  return configured === 'hearth' ? 'hearth' : 'tide'
}

/**
 * What `/band <args>` asks for: at most one look and one motion, in either order; no band at all
 * (`off`: there is no such switch, so the reply says how to turn the plugin off, and offers the
 * quietest ways it has), alone or beside a look or a motion, which it then switches to; or why it
 * cannot be read.
 */
type BandAsk = { look: Look | null; motion: Motion | null; off?: true } | { off: true } | { error: string }

export function parseBand(args: string): BandAsk {
  // Lenient with what fingers add: "hearth," "--help", "tide, still." and "hearth-still" or
  // "hearth/still" (as the looks are named elsewhere) read as meant, and so does a word set in quotes,
  // backticks or brackets ('"hearth"', "`tide`", "(still)", "<hearth>"), which a reply then never
  // quotes twice; so do "look=hearth" and "motion: still", as /config names the settings, and the
  // command typed twice ("/band /band hearth"). A word said twice, or two words for one setting
  // ("still calm", "tide beach"), ask for it once. Something with no word in it at all ("...") is
  // quoted back as it was typed.
  const said = args
    .trim()
    .toLowerCase()
    .split(/[\s,;:=/\-\u2013\u2014]+/u)
    .map(typed => ({ typed, word: typed.replace(/^[\p{Pi}\p{Ps}"'`<]+/u, '').replace(/(?<=.)[\p{Pf}\p{Pe}"'`>.,;:!?]+$/u, '') }))
    .filter(({ word }) => word !== '')
  if (said[0]?.word === 'band') said.shift()
  const meant = new Map<string, string>()
  for (const { typed, word } of said) {
    const setting = SAYS[word] ?? word
    if (!meant.has(setting)) meant.set(setting, /[\p{L}\p{N}]/u.test(word) ? word : typed)
  }
  const words = [...meant.keys()]
  if (words.length === 1 && ASKS.has(words[0] ?? '')) {
    return { look: null, motion: null }
  }
  const looks: Look[] = []
  const motions: Motion[] = []
  let isOff = false
  for (const word of words) {
    if (isLook(word)) {
      looks.push(word)
    } else if (isMotion(word)) {
      motions.push(word)
    } else if (OFFS.has(word)) {
      isOff = true
    } else if (SETTINGS.has(word)) {
      // "/band look hearth": a setting's name before the setting says nothing more.
    } else {
      return { error: `Band: "${meant.get(word) ?? word}" isn't a look or a motion. Try tide, hearth, still or lively.` }
    }
  }
  if (looks.length > 1) {
    return { error: 'Band: one look at a time. /band tide or /band hearth.' }
  }
  if (motions.length > 1) {
    return { error: 'Band: one motion at a time. /band still or /band lively.' }
  }
  if (isOff && looks.length + motions.length === 0) {
    return { off: true }
  }
  // "/band hearth off": the look it names, and then the word on turning the band off.
  return { look: looks[0] ?? null, motion: motions[0] ?? null, ...(isOff ? { off: true as const } : {}) }
}

/**
 * Whether a pick still decides the look. A saved pick counts in the activation that made it, until
 * /config's reload lands with the same look. One /config could not save lasts the session, through
 * any reload, for as long as /config holds the look it was picked over.
 */
export function isPickOn(pick: LookPick | null | undefined, activation: string, configured: unknown): pick is LookPick {
  if (pick === null || pick === undefined || !isLook(pick.look)) {
    return false
  }

  return pick.isSaved ? pick.activation === activation : pick.over === configuredLook(configured)
}

/** The look on screen: a pick that still decides it (see isPickOn), else /config's. */
export function lookNow(pick: LookPick | null | undefined, activation: string, configured: unknown): Look {
  return isPickOn(pick, activation, configured) ? pick.look : configuredLook(configured)
}

/**
 * Since when the look on screen has been on screen, as far as the band knows: the time of the last
 * pick that chose it. Null when the band never saw it picked (it was on from the start).
 */
export function shownSince(pick: LookPick | null | undefined, look: Look): number | null {
  return pick !== null && pick !== undefined && pick.look === look && typeof pick.at === 'number' ? pick.at : null
}

/** Whether a /config row (or a change to one) is this plugin's look: `session-band.look`, or `session-band@inline.look` for a folder loaded with --plugin-dir. */
export function isLookRow(row: { key: string; provider: { plugin: string }; options?: readonly string[] }): boolean {
  return (
    row.key.endsWith('.look') &&
    row.provider.plugin.split('@')[0] === PLUGIN &&
    (row.options === undefined || row.options.includes('hearth'))
  )
}

/**
 * The motion a session starts with: the one stored, or one read from an older build's stored
 * style. Only `still` meant still there; every look's name (hearth, tide, cozy, trail, peek) meant
 * "let him move". The look is never read from it: /config holds the look.
 */
export function migrateMotion(motion: unknown, style: unknown): Motion {
  if (isMotion(motion)) {
    return motion
  }

  return style === 'still' ? 'still' : 'lively'
}

/**
 * The one toast on the first session after the upgrade, for the person whose older build stored
 * the hearth's own look (`hearth`, which only the Hearth build wrote) and who now lands on the
 * beach, the new default: what changed, and the way back. A stored motion says the upgrade
 * already happened, and a look already back on the hearth (/config) needs no word.
 */
export function upgradeToast(motion: unknown, style: unknown, look: Look): string | null {
  return !isMotion(motion) && style === 'hearth' && look === 'tide' ? 'Band: the beach is the new look. /band hearth brings the hearth back.' : null
}

export function newActivation(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** What /band did, for its one-line reply. `look` and `motion` are what is on after the command. */
type Reply = {
  /** `status`: /band alone. `look`: a look word (with or without a motion word). `motion`: a motion word alone. */
  kind: 'status' | 'look' | 'motion'
  look: Look
  motion: Motion
  /** The person's reduced-motion setting, which keeps both looks still whatever the motion says. */
  isCalm: boolean
  /** The look on screen was picked by /band and /config could not save it. */
  isSessionOnly?: boolean
  /** /config refused the look, and why. */
  denied?: string
  /** The words asked for no band too ("/band hearth off"): the reply ends on how to turn it off. */
  isOff?: boolean
}

const OTHER: Record<Look, Look> = { tide: 'hearth', hearth: 'tide' }

// How each look moves, and how it rests, each said once in its own voice.
const LIVELY: Record<Look, string> = {
  tide: 'Waves lap the shore and Clawd potters about.',
  hearth: 'Clawd blinks, reads along and cheers.',
}
const STILL: Record<Look, string> = {
  tide: 'The waves rest, and the tide shows your context.',
  hearth: 'Clawd sits quietly, and the lines keep you posted.',
}
// The way back from a look to the other one: what an opt-out most needs to say.
const BACK: Record<Look, string> = {
  tide: '/band hearth to switch back.',
  hearth: '/band tide to switch back.',
}
// The way from one motion to the other.
const TO_STILL: Record<Look, string> = { tide: '/band still calms them.', hearth: '/band still calms him.' }
const TO_LIVELY: Record<Look, string> = { tide: '/band lively brings them back.', hearth: '/band lively lets him move.' }
// The same, with nothing before it to say who "them" and "him" are (see replyFor's shorter forms).
const ALONE: Record<string, string> = {
  [TO_STILL.tide]: '/band still calms the waves.',
  [TO_STILL.hearth]: '/band still calms Clawd.',
  [TO_LIVELY.tide]: '/band lively brings the waves back.',
  [TO_LIVELY.hearth]: '/band lively lets Clawd move.',
}
// Reduced motion on: whatever /band asks, the look stays still, and the reply says so instead of
// pointing at a /band lively that would change nothing.
const CALM: Record<Look, string> = {
  tide: 'Your reduced-motion setting keeps the beach calm either way.',
  hearth: 'Your reduced-motion setting keeps Clawd calm either way.',
}
const FOR_CALM = 'still for your reduced-motion setting'
// Lively asked for under reduced motion: when it will be, and what holds it still till then.
const LIVELY_LATER: Record<Look, string> = {
  tide: 'Band: lively once reduced motion is off; until then the beach stays calm.',
  hearth: 'Band: lively once reduced motion is off; until then Clawd stays calm.',
}
/** The band has no off switch of its own: the plugin manager turns it off. */
const TURN_OFF = '/plugin turns the band off.'

/**
 * /band's reply: one line, in the voice of the look on screen, at most 100 characters (a refusal
 * quotes /config's own reason, which may run longer). It says what is on, then the one thing most
 * worth knowing next: after a look, the way back; after a motion, the way to the other one.
 */
export function replyFor(reply: Reply): string {
  const line = replyLine(reply)
  if (reply.isOff !== true) {
    return line
  }
  // Then how to turn the band off: after the whole reply where it fits, else after what is on and
  // the way on from it (the look's words on how it moves go, so the way on names who moves: "the
  // waves", "Clawd", never a "them" with nothing before it), else after what is on alone.
  // ("Band: lively once reduced motion is off" is what is on, without what holds it still till then.)
  const sentences = line.split(/(?<=\.) /u)
  const [head = line] = sentences
  const last = sentences.at(-1) ?? ''
  const forms = [line, sentences.length > 2 ? `${head} ${ALONE[last] ?? last}` : line, head, head.replace(/;.*$/u, '.')].map(form => `${form} ${TURN_OFF}`)

  return forms.find(form => form.length <= 100) ?? forms[forms.length - 1] ?? line
}

function replyLine(reply: Reply): string {
  const { kind, look, motion, isCalm } = reply
  const isSessionOnly = reply.isSessionOnly === true
  // "This session only" belongs to the look, never the motion (which is always remembered).
  const named = isSessionOnly ? `${look} (this session only)` : look
  const moving = isCalm ? FOR_CALM : motion
  if (reply.denied !== undefined) {
    return `Band: ${named}, ${moving}. /config kept the look: ${reasonOf(reply.denied)}.`
  }
  if (kind === 'status') {
    const where = isSessionOnly ? `Look: /band ${OTHER[look]}.` : `Look: /band ${OTHER[look]} or /config.`

    return isCalm ? `Band: ${named}, ${FOR_CALM}. ${where}` : `Band: ${named}, ${motion}. ${where} Motion: /band ${motion === 'still' ? 'lively' : 'still'}.`
  }
  if (kind === 'motion') {
    if (isCalm) {
      return motion === 'lively' ? LIVELY_LATER[look] : `Band: ${motion}. ${CALM[look]}`
    }

    return motion === 'still' ? `Band: still. ${STILL[look]} ${TO_LIVELY[look]}` : `Band: lively. ${LIVELY[look]} ${TO_STILL[look]}`
  }
  if (isSessionOnly) {
    // Still the way back, as every look reply gives it.
    return `Band: ${named}${motion === 'still' && !isCalm ? ', still' : ''}; /config could not save it. ${BACK[look]}`
  }
  if (isCalm) {
    return `Band: ${look}, ${FOR_CALM}. ${BACK[look]}`
  }

  return motion === 'still' ? `Band: ${look}, still. ${STILL[look]} ${BACK[look]}` : `Band: ${look}. ${LIVELY[look]} ${BACK[look]}`
}

/**
 * /config's reason, quoted mid-sentence after a colon: its own closing mark goes, whatever it is (the
 * reply adds its stop), and a capital that only opened its sentence comes down ("Locked by your
 * organization" reads "locked by…"). A name keeps its capital: one whose next word has one too
 * ("Claude Code manages…"), or Claude's and Anthropic's own; so does an acronym, a lone "I" or a
 * command: "ID 42…", "/config…".
 */
function reasonOf(denied: string): string {
  const reason = denied.trim().replace(/[\s.!?…]+$/u, '')
  const [first = '', second] = reason.split(/\s+/u)
  const isName = NAMES.has(first) || (second !== undefined && /^\p{Lu}/u.test(second))

  return isName ? reason : reason.replace(/^\p{Lu}(?=\p{Ll})/u, letter => letter.toLowerCase())
}

/** Names a reason may open with, which keep their capital. */
const NAMES = new Set(['Claude', 'Anthropic'])

/**
 * `/band off`: the band has no such switch, so the reply says what turns it off (the plugin manager,
 * /plugin), then offers the quietest ways it has, from the look on screen: the hearth is already the
 * plainer one. With reduced motion on, the band is still already, so the reply says so rather than
 * offer a /band still that would change nothing.
 */
export function offReply(look: Look, isCalm = false): string {
  const still = isCalm ? 'reduced motion keeps it still' : '/band still stops the motion'

  return look === 'hearth' ? `Band: ${TURN_OFF} The hearth is the plainer look, and ${still}.` : `Band: ${TURN_OFF} ${isCalm ? 'Reduced motion keeps it still' : '/band still stops the motion'}; /band hearth is the plainer look.`
}

/**
 * The one toast when the context crosses warnAt, in the voice of the look on screen, with the same
 * nudge its band gives: the tide's "try /compact", the hearth's "/compact when you're ready".
 */
export function toastFor(look: Look, percent: number): string {
  const rounded = Math.round(percent)

  return look === 'tide' ? `The tide is coming in: context is ${rounded}% full. Try /compact soon.` : `Context is ${rounded}% full. Run /compact when you're ready.`
}
