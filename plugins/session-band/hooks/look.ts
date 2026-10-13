// Which look the band wears, and what /band says. Pure: the hooks module (register.tsx) does the
// reading and writing. The look lives in one place, the `look` row of /config; /band writes that
// row, and a pick made by /band shows at once, before /config's reload lands.

import type { Look, LookPick, Motion } from '../types'
import { cells, cut } from './clawd'

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
 * reaches for, read as those settings: the beach is a tidepool too ("/band tidepool", "tide-pool").
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
      // What /band takes first, then the word it did not know, cut to fit the line (see unknownReply).
      return { error: unknownReply(meant.get(word) ?? word) }
    }
  }
  if (looks.length > 1) {
    return { error: 'One look at a time: /band tide or /band hearth.' }
  }
  if (motions.length > 1) {
    return { error: 'One motion at a time: /band still or /band lively.' }
  }
  if (isOff && looks.length + motions.length === 0) {
    return { off: true }
  }
  // "/band hearth off": the look it names, and then the word on turning the band off.
  return { look: looks[0] ?? null, motion: motions[0] ?? null, ...(isOff ? { off: true as const } : {}) }
}

/**
 * The reply to a word /band does not know: what it takes, then the word quoted back. A word too long
 * for the line (a long pasted token, or a word in a wide script) is cut with an ellipsis, counted as
 * two cells since terminals differ on its width, so the reply stays one line like every other.
 */
function unknownReply(word: string): string {
  const said = (quoted: string) => `Try tide, hearth, still or lively, not "${quoted}".`
  const room = REPLY_MOST - cells(said(''))
  if (cells(word) <= room) {
    return said(word)
  }

  return said(`${cut(word, room - 2)}\u2026`)
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
  return !isMotion(motion) && style === 'hearth' && look === 'tide' ? `The beach is the new look. ${BACK.tide}` : null
}

export function newActivation(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The most cells a /band reply takes. Claude Code prints a command's reply after a 19-cell prefix
 * that already names the plugin ("  ⎿  session-band: "), so 61 would fill an 80-column terminal to
 * its last cell; 60 keeps one to spare, should the host hold the last column back. A reply that fits
 * there never leaves a word alone on a second line at any wider width. Only /config's own reason for
 * a refusal may run past it; a word /band does not know is cut to fit (see unknownReply).
 */
export const REPLY_MOST = 60

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
  /** The words named a motion too ("/band hearth still"), so a refusal's reply keeps the motion: it is news. */
  isMotionAsked?: boolean
  /** The words asked for no band too ("/band hearth off"): the reply ends on how to turn it off. */
  isOff?: boolean
}

const OTHER: Record<Look, Look> = { tide: 'hearth', hearth: 'tide' }
const OTHER_MOTION: Record<Motion, Motion> = { lively: 'still', still: 'lively' }
// A look's name as a reply opens on it: the prefix before the reply already says whose it is.
const NAME: Record<Look, string> = { tide: 'Tide', hearth: 'Hearth' }

// How each look moves, and how it rests, each said once in its own voice.
const LIVELY: Record<Look, string> = {
  tide: 'Waves lap the shore.',
  hearth: 'Clawd blinks and cheers.',
}
const STILL: Record<Look, string> = {
  tide: 'The waves rest.',
  hearth: 'Clawd rests.',
}
// The way back from a look to the other one: what an opt-out most needs to say.
const BACK: Record<Look, string> = {
  tide: '/band hearth to switch back.',
  hearth: '/band tide to switch back.',
}
// The way from one motion to the other, after the sentence that says who "them" and "him" are.
const TO_STILL: Record<Look, string> = { tide: '/band still calms them.', hearth: '/band still calms him.' }
const TO_LIVELY: Record<Look, string> = { tide: '/band lively brings them back.', hearth: '/band lively lets him move.' }
// Reduced motion on: whatever /band asks, the look stays still, and the reply says so instead of
// pointing at a /band lively that would change nothing.
const CALM: Record<Look, string> = {
  tide: 'Reduced motion keeps the beach calm either way.',
  hearth: 'Reduced motion keeps Clawd calm either way.',
}
const FOR_CALM = 'still for reduced motion'
// Lively asked for under reduced motion: when it will be, and what holds it still till then.
const LIVELY_LATER: Record<Look, string> = {
  tide: 'Lively once reduced motion is off; the waves rest till then.',
  hearth: 'Lively once reduced motion is off; Clawd rests till then.',
}
/** The band has no off switch of its own: the plugin manager turns it off. */
const TURN_OFF = '/plugin turns the band off.'
/** Before /config's own reason for a refusal. */
const KEPT = '/config kept the look:'

/**
 * /band's reply: one line, in the voice of the look on screen, of at most REPLY_MOST cells (a
 * refusal quotes /config's own reason, which may run longer). It says what is on, then the one
 * thing most worth knowing next: after a look, the way back; after a motion, the way to the other.
 */
export function replyFor(reply: Reply): string {
  const line = replyLine(reply)
  if (reply.denied !== undefined) {
    // /config's reason runs as long as it runs, so it comes last, after a plain part: what is on, the
    // off note when the words asked for it, and "/config kept the look:". What is on gives way to a
    // shorter form when that lets the whole reply fit the line (never to the look's name alone when
    // the words asked for a motion, which is news); when nothing lets it fit, the shortest form goes
    // first, so the reason wraps as little as it can. So the plain part always fits, and a wrap only
    // ever moves the reason. The refusal is the news, so a look /config could not save before goes
    // unmarked here. A reason with no words in it ("", "...") leaves the reply on "/config kept the look."
    const off = reply.isOff === true ? ` ${TURN_OFF}` : ''
    const reason = reasonOf(reply.denied)
    const plains = whatIsOn(reply, NAME[reply.look]).map(on => `${on}${off} ${KEPT}`)
    const whole = (plain: string) => (reason === '' ? `${plain.slice(0, -1)}.` : `${plain} ${reason}.`)
    const kept = reply.isMotionAsked === true ? plains.slice(0, -1) : plains
    const plain = kept.find(form => cells(whole(form)) <= REPLY_MOST) ?? [...kept].reverse().find(form => cells(form) <= REPLY_MOST) ?? plains[plains.length - 1] ?? line

    return whole(plain)
  }
  if (reply.isOff !== true) {
    return line
  }
  // Then how to turn the band off, after what is on: all the reply would say if that fits, else what
  // is on, as short as it needs to be ("Tide, lively.", "Hearth, still.", "Hearth.").
  const forms = [line, ...whatIsOn(reply)].map(form => `${form} ${TURN_OFF}`)

  return forms.find(form => cells(form) <= REPLY_MOST) ?? forms[forms.length - 1] ?? line
}

/** The look as a reply names it, marked when /config could not save it ("Hearth (session only)"). */
function nameOf(reply: Reply): string {
  return reply.isSessionOnly === true ? `${NAME[reply.look]} (session only)` : NAME[reply.look]
}

/** What is on as a reply opens on it, longest first: "Hearth, still for reduced motion.", "Hearth, still.", "Hearth." */
function whatIsOn(reply: Reply, named = nameOf(reply)): string[] {
  const forms = [`${named}, ${reply.isCalm ? FOR_CALM : reply.motion}.`, `${named}, ${reply.isCalm ? 'still' : reply.motion}.`, `${named}.`]

  return [...new Set(forms)]
}

function replyLine(reply: Reply): string {
  const { kind, look, motion, isCalm } = reply
  const isSessionOnly = reply.isSessionOnly === true
  // "Session only" belongs to the look, never the motion (which is always remembered).
  const named = nameOf(reply)
  const moving = isCalm ? FOR_CALM : motion
  if (reply.denied !== undefined) {
    // What is on; replyFor adds /config's refusal after it.
    return `${NAME[look]}, ${moving}.`
  }
  if (kind === 'status') {
    // The ways to change what is on: the other look, the other motion (none under reduced motion,
    // where it would change nothing), and /config, which holds the look (unless it cannot be reached).
    // Short of room (a look /config could not save), the ways go from the last, so the way to the
    // other look stays longest; under reduced motion "still" gives up its reason before that way goes;
    // with no room even for that, what is on is the news.
    const ways = [`/band ${OTHER[look]}`, ...(isCalm ? [] : [`/band ${OTHER_MOTION[motion]}`]), ...(isSessionOnly ? [] : ['/config'])]
    for (const on of whatIsOn(reply).slice(0, isCalm ? 2 : 1)) {
      for (let kept = ways.length; kept > 0; kept--) {
        const some = ways.slice(0, kept)
        const offered = some.length > 1 ? `${some.slice(0, -1).join(', ')} or ${some.at(-1) ?? ''}` : (some[0] ?? '')
        const said = `${on} Try ${offered}.`
        if (cells(said) <= REPLY_MOST) {
          return said
        }
      }
    }

    return `${named}, ${moving}.`
  }
  if (kind === 'motion') {
    if (isCalm) {
      return motion === 'lively' ? LIVELY_LATER[look] : `Still. ${CALM[look]}`
    }

    return motion === 'still' ? `Still. ${STILL[look]} ${TO_LIVELY[look]}` : `Lively. ${LIVELY[look]} ${TO_STILL[look]}`
  }
  if (isSessionOnly) {
    // Why it lasts this session only, said once, when it happens; /band alone gives the way back.
    return `${named}${motion === 'still' && !isCalm ? ', still' : ''}. /config couldn't save it.`
  }
  if (isCalm) {
    return `${named}, ${FOR_CALM}. ${BACK[look]}`
  }

  return motion === 'still' ? `${named}, still. ${STILL[look]} ${BACK[look]}` : `${named}. ${LIVELY[look]} ${BACK[look]}`
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
 * /plugin), then offers the quietest ways it has, from what is on: the hearth is the plainer look,
 * and still the quieter motion. A band that is still already, by its motion or by reduced motion, is
 * never offered a /band still that would change nothing, and a still hearth is as quiet as it gets,
 * which the reply says (naming reduced motion when that is what keeps it still).
 */
export function offReply(look: Look, motion: Motion, isCalm: boolean): string {
  const isStill = isCalm || motion === 'still'
  const ways = [...(isStill ? [] : ['/band still']), ...(look === 'tide' ? ['/band hearth'] : [])]
  if (ways.length > 0) {
    return `${TURN_OFF} Try ${ways.join(' or ')}.`
  }

  return isCalm ? `${TURN_OFF} Reduced motion keeps it still.` : `${TURN_OFF} It's as quiet as it gets.`
}

/** /band's answer when the store refused a write: it never leaves the person without one. */
export function troubleReply(isStatus: boolean): string {
  return `Couldn't ${isStatus ? 'check' : 'switch'} just now. Try /band again in a moment.`
}

/**
 * The one toast when the context crosses warnAt, in the voice of the look on screen, with the same
 * nudge its band gives: the tide's "try /compact", the hearth's "/compact when you're ready".
 */
export function toastFor(look: Look, percent: number): string {
  const rounded = Math.round(percent)

  return look === 'tide' ? `High tide: context is ${rounded}% full. Try /compact soon.` : `Context is ${rounded}% full. Run /compact when you're ready.`
}
