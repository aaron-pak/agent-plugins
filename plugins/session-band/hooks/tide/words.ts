import { SKILL, SKILL_ALONE, SUBAGENT, WEB_SEARCH, clockText, durationForms, isWordy, limitLabel, nounsFor, phraseForms, usingForms, usingParts } from '../facts'
import type { BandProps, Info, LastTurn, Piece, Words } from './types'

// The band's words, written once for both surfaces: a line of what is happening, a line about the
// tide (the context window), and a line of where we are. Each line is a chain of forms, longest
// first, and each form only takes something away from the one before: a part from the end, a
// branch's prefix, a label's long form. The band draws the first that fits (fitLine), so a narrower
// band never says more than a wider one, and nothing that went comes back as it narrows. Only a
// name (a file, a branch, a todo, what failed) is ever cut, at its end, with an ellipsis; a figure
// or a label never is.

const SEP: Piece = { text: ' · ', tone: 'dim' }
/** The fewest characters a cut name keeps before its ellipsis: "first-m…", "clawd.t…". */
const NAME_LEAST = 7
/** A web search's query, cut after a whole word, keeps at least this much: its first short word will do. */
const QUERY_LEAST = 3
/** A name beside the todo tally is never cut: the tally gives way first, so a name never shrinks to make room for it. */
const WHOLE = Number.MAX_SAFE_INTEGER

/**
 * Every line of words, in every mood. `isDesktop`: the desktop sets what failed in curly quotes,
 * which a terminal may draw two cells wide (their width is ambiguous), so it keeps straight ones.
 */
export function wordsFor(known: Info, isWorking: boolean, isHigh: boolean, now: number, isDesktop = false): BandProps['words'] {
  return {
    now: nowForms(known, isWorking, isDesktop),
    cheer: cheerForms(known.lastTurn),
    splash: splashForms(known, isDesktop),
    nap: napForms(known.lastTurn),
    tide: tideForms(known, isHigh, now),
    place: placeForms(known),
  }
}

/** A head and the parts after it, most important first: the whole line, then one part fewer from the end at a time. */
function drops(head: Words, parts: Words[]): Words[] {
  return parts.map((_, i) => [...head, ...parts.slice(0, parts.length - i).flat()]).concat([head])
}

/** A name the line may cut at its end, keeping `least` characters of it (all of them: never cut). */
function name(text: string, least: number, tone?: Piece['tone'], cut?: Piece['cut']): Piece {
  return { text, isShort: true, least: Math.min(least, [...text].length), ...(tone === undefined ? {} : { tone }), ...(cut === undefined ? {} : { cut }) }
}

/** Words a person wrote (a todo, a described command, what failed, a search): cut only after a whole word. */
function said(text: string, least: number, tone?: Piece['tone']): Piece {
  return name(text, least, tone, 'word')
}

/** A command as Claude typed it: cut after a whole word where one keeps enough, else as a name is. */
function command(text: string, least: number, tone?: Piece['tone']): Piece {
  return name(text, least, tone, 'command')
}

/**
 * What failed, in quotes, as its cut keeps it: a verb and a name keeps its verb whole and cuts the
 * name ('"Read a-file-that-wi…"'), and the words after the name too ('"Use the plugin-auth… skill"');
 * a command Claude typed is cut as the Running line cuts it; words a person wrote ("Run the tests")
 * after a whole word, two words at least and never ending on a little one. Never the verb alone
 * ('"Read…"', '"Edit…"', '"Run…"'): a quote with no room for more gives way to the line's next form
 * ("A skill failed").
 */
function quote(known: Pick<Info, 'oopsWhat' | 'oopsName' | 'oopsCommand'>, open: string, close: string, tone?: Piece['tone']): Words {
  const what = known.oopsWhat ?? ''
  const named = known.oopsName
  const plain = (text: string): Piece => (tone === undefined ? { text } : { text, tone })
  const at = named === null || named === '' ? -1 : what.endsWith(` ${named}`) ? what.length - named.length : what.indexOf(` ${named} `) + 1
  if (named !== null && at > 0) {
    return [plain(`${open}${what.slice(0, at)}`), name(named, NAME_LEAST, tone), plain(`${what.slice(at + named.length)}${close}`)]
  }

  return [plain(open), known.oopsCommand ? command(what, NAME_LEAST, tone) : name(what, NAME_LEAST, tone, 'quote'), plain(close)]
}

/**
 * What failed, in quotes, as its forms, longest first (see quote). A web search is quoted in one way,
 * the shorter one its Running line comes to ('"Search for ink terminals"'), its query keeping whole
 * words down to its first ('"Search for ink…"'), so a quote never ends on "web" or "for".
 */
function quotes(known: Pick<Info, 'oopsWhat' | 'oopsName' | 'oopsCommand' | 'oopsNoun'>, open: string, close: string, tone?: Piece['tone']): Words[] {
  const plain = (text: string): Piece => (tone === undefined ? { text } : { text, tone })
  // Another server's tool keeps its server whole, and what it did is cut after two words at least
  // ('"Use GitHub: create pull…"'); narrower, the server's tool in words, not an order nobody gave
  // ('A GitHub tool failed', 'An Asana tool failed').
  const server = known.oopsNoun === null && known.oopsName === null && !known.oopsCommand ? /^Use ([^:]+): (.+)$/u.exec(known.oopsWhat ?? '') : null
  if (server !== null) {
    const [, owner = '', action = ''] = server
    return [[plain(`${open}Use ${owner}: `), name(action, NAME_LEAST, tone, 'quote'), plain(close)], [plain(`${article(owner)} ${owner} tool`)]]
  }
  const search = known.oopsNoun === WEB_SEARCH ? /^Search the web for (.+)$/u.exec(known.oopsWhat ?? '') : null
  const query = search?.[1]
  if (query === undefined) {
    return [quote(known, open, close, tone)]
  }

  return [
    [plain(`${open}Search for `), said(query, WHOLE, tone), plain(close)],
    [plain(`${open}Search for `), said(query, QUERY_LEAST, tone), plain(close)],
  ]
}

/**
 * "A" or "An" before a server's name, as it is said: "An Asana tool", "An MCP tool" (an acronym is
 * said a letter at a time), "A GitHub tool", "A Unity tool", "An Upstash tool".
 */
export function article(owner: string): string {
  const word = owner.split(' ')[0] ?? ''
  if (/^\p{Lu}{2,}(?:\P{L}|$)/u.test(word)) return /^[AEFHILMNORSX]/u.test(word) ? 'An' : 'A'

  return /^(?:[aeio]|u(?:n(?![iu])|p|m|g|l|b(?!i)))/iu.test(word) ? 'An' : 'A'
}

// ── Line 1: what is happening ─────────────────────────────────────────────────

// The splash: the verdict first, so a narrow band still says what happened. What failed is in
// quotes, since it reads as an order ("Run the tests"): 'Splash! "Run the tests" failed'. Narrower,
// its name is cut, so the line still ends in "failed"; narrower still, the line keeps its verdict
// and gives up the quote for a word for what failed ('Splash! A subagent failed', 'A command', 'A
// skill', 'A web search'), and under it 'Splash! A tool failed', which any failure is; then
// 'Splash!' alone. A tool whose words are a set phrase is no order to quote: the phrase says it
// ('Splash! Finding tools failed'), then "A command" for a command's ('Checking on a command'),
// then "A tool". A command Claude typed with no description is cut as the Running line cuts it
// ('Splash! "cd /Users/robin…" failed'), never on a shell joint, and never jumping from the whole
// path to no quote at all.
const SPLASH: Piece = { text: 'Splash!', tone: 'clay', bold: true }

function splashForms(known: Info, isDesktop: boolean): Words[] {
  const [open, close] = isDesktop ? ['“', '”'] : ['"', '"']
  const what = known.oopsWhat
  const failed = (words: Words): Words => [SPLASH, { text: ' ' }, ...words, { text: ' failed' }]
  // A subagent sent with no task in words is no order to quote: 'Splash! A subagent failed'.
  const named: Words[] = what === null || what === '' || what === SUBAGENT ? [] : quotes(known, open, close).map(failed)

  return [...named, ...nounForms(known).map(failed), [SPLASH]]
}

// What failed in a word, for a line with no room to quote it ("A subagent"), down to "A tool", one
// step at a time: a phrase ("Checking on a command"), then "A command", then "A tool".
function nounForms(known: Info, tone?: Piece['tone']): Words[] {
  const nouns = nounsFor(known.oopsWhat === SUBAGENT ? SUBAGENT : known.oopsNoun)

  return nouns.map(noun => [tone === undefined ? { text: noun } : { text: noun, tone }])
}

function nowForms(known: Info, isWorking: boolean, isDesktop: boolean): Words[] {
  const tallies = tallyParts(known)
  // A name and the todo tally after it: the tally shortens, then goes, before the name is cut at
  // all; the name is cut only while NAME_LEAST characters of it show, and then the line's last
  // forms stand in, each a part of what came before (never a stub like "L…").
  const tallied = (head: (least: number) => Words, last: Words[]): Words[] => [
    ...tallies.map(tally => [...head(WHOLE), ...tally]),
    head(NAME_LEAST),
    ...last,
  ]
  if (isWorking) {
    const activity = known.activity
    if (activity !== null) {
      const { verb, target } = activity
      if (activity.kind === 'wait') {
        // A wait on you, in the quiet dim as "Ready" is: "Asking you: Auth method", then "Asking
        // you"; "Plan ready for you", then "Plan ready". The question's header is words Claude wrote
        // for you, cut after a whole word ("Asking you: Auth…"), never mid-word ("Auth met…").
        const dim = (text: string): Piece => ({ text, tone: 'dim' })
        if (target === '') {
          const [whole = verb, ...short] = phraseForms(verb)
          return tallied(() => [dim(whole)], short.map(text => [dim(text)]))
        }
        return tallied(least => [dim(`${verb}: `), said(target, least, 'dim')], [[dim(verb)]])
      }
      if (verb === '') {
        // A described command ("Run the tests"), cut at its end if it must be, and on the narrowest
        // band "Running".
        return tallied(least => [said(target, least)], [[{ text: 'Running' }]])
      }
      if (target === '') {
        // A verb alone ("Planning"), or a set phrase that on the narrowest band says what it is
        // doing ("Checking on a command", then "Checking").
        const [whole = verb, ...short] = phraseForms(verb)
        return tallied(() => [{ text: whole }], short.map(text => [{ text }]))
      }
      if (verb === SKILL) {
        // A skill by its name, cut as a name is, the word "skill" kept after it ("Using the
        // plugin-auth… skill"); narrower, "Using a skill", and on the narrowest band "Using a tool".
        return tallied(least => [{ text: `${SKILL} ` }, name(target, least), { text: ' skill' }], phraseForms(SKILL_ALONE).map(text => [{ text }]))
      }

      // "Reading clawd.tsx", and on the narrowest band the verb alone: "Reading", "Searching".
      const alone: Words = [{ text: verb.replace(/ (?:the web )?for$/u, '') }]
      if (verb.endsWith(' the web for')) {
        // A web search gives up "the web" before its query loses a word, and then its query keeps
        // whole words, down to its first: "Searching the web for ink terminals", "Searching for ink
        // terminals", "Searching for ink…", "Searching". (A search is a few short words: its first
        // alone still says what is being looked for.)
        const short = verb.replace(/ the web for$/u, ' for')
        return [
          ...tallies.map(tally => [{ text: `${verb} ` }, said(target, WHOLE), ...tally]),
          [{ text: `${verb} ` }, said(target, WHOLE)],
          [{ text: `${short} ` }, said(target, WHOLE)],
          [{ text: `${short} ` }, said(target, QUERY_LEAST)],
          alone,
        ]
      }
      if (verb === 'Using') {
        // Another server's tool, in words, what it does cut at a word, its server never: "Using
        // Linear: create issue", "Using Linear: create…", then its server alone, "Using Linear", or
        // "Using a tool".
        const { server, action } = usingParts(target)
        return tallied(least => [{ text: server === '' ? 'Using ' : `Using ${server}: ` }, said(action, least)], usingForms(target).map(text => [{ text }]))
      }
      if (isWordy(verb)) {
        // A command, or what a subagent was asked to do: words to read whole, so cut only after a
        // whole word ("Running git log…", "Delegating: Explore the hooks…"); narrowest, the verb alone.
        // A subagent's task is a sentence of its own, so a colon sets it apart from the verb. A
        // command with no space early on is cut as a name is ("Running node_modules/.bin…"), so
        // it shows something of itself rather than a bare "Running".
        const lead = verb === 'Delegating' ? 'Delegating: ' : `${verb} `
        return tallied(least => [{ text: lead }, verb === 'Running' ? command(target, least) : said(target, least)], [alone])
      }
      return tallied(least => [{ text: `${verb} ` }, name(target, least)], [alone])
    }
    if (isAfterSplash(known)) {
      // The splash is over and no tool has run since: what failed stays, quietly, until one does
      // (a look back a few seconds later still finds it).
      const [open, close] = isDesktop ? ['“', '”'] : ['"', '"']
      const what = known.oopsWhat
      const failed = (words: Words): Words => [...words, { text: ' failed', tone: 'dim' }]
      const named: Words[] = what === null || what === '' || what === SUBAGENT ? [] : quotes(known, open, close, 'dim').map(failed)

      // Then a word for what failed ("A subagent failed", "A tool failed"), and the narrowest says
      // it in one word, as the settled line's last forms do ("Done", "Stopped"): a bare "It failed"
      // has nothing before it to point back to.
      return [...named, ...nounForms(known, 'dim').map(failed), [{ text: 'Failed', tone: 'dim' }]]
    }
    const current = currentTodo(known)
    if (current !== null) {
      // The todo at work, as it says itself ("Drawing the beach"); on the narrowest band, "Thinking".
      return tallied(least => [said(current, least)], [[{ text: 'Thinking', tone: 'dim' }]])
    }

    return [...tallies.map(tally => [THINKING, ...tally]), [THINKING], [{ text: 'Thinking', tone: 'dim' }]]
  }

  const turn = known.lastTurn
  if (turn?.ending === 'error') {
    return errorForms(turn)
  }
  // How the last turn went, or "Ready": what the line says with nothing queued.
  const settled: Words[] = turn === null ? READY : turn.ending === 'stopped' ? stoppedForms(turn) : doneForms(turn, false)
  const next = known.todos.find(todo => todo.status !== 'completed')
  if (next !== undefined) {
    // "Next up: Write the tests", then "Next: Write the tests" when the whole name no longer fits
    // beside the long label, its name cut after a whole word when it must be, two words at least, as
    // a quote is ("Next: Write the tests…"): "Next: Write…" alone would read as an order cut off. The
    // name is never cut beside "Next up:", so a narrower band never shows more of it. Narrower still,
    // the line says what it would with nothing queued ("Done in 41s", "Ready").
    const label = (text: string): Piece => ({ text, tone: 'dim' })
    return [
      ...tallies.map(tally => [label('Next up: '), said(next.subject, WHOLE), ...tally]),
      [label('Next up: '), said(next.subject, WHOLE)],
      [label('Next: '), name(next.subject, NAME_LEAST, undefined, 'quote')],
      ...settled,
    ]
  }

  return settled
}

// A tool failed in this turn, and it was the last to finish: none has started since.
function isAfterSplash(known: Info): boolean {
  return known.isSlipped && known.oopsAt !== null
}

const READY: Words[] = [[{ text: 'Ready when you are', tone: 'dim' }], [{ text: 'Ready', tone: 'dim' }]]

// Esc, or a turn the model declined: never "Done", just where it ended.
function stoppedForms(turn: LastTurn): Words[] {
  return [...durationForms(turn.seconds).map((took): Words => [{ text: `Stopped after ${took}`, tone: 'dim' }]), [{ text: 'Stopped', tone: 'dim' }]]
}

// An API error ended the turn: "Stopped on an error after 12s", then "Error after 12s", "Error".
// (The figure outlasts the long verdict, so it never goes and comes back.)
function errorForms(turn: LastTurn): Words[] {
  const after = durationForms(turn.seconds).map((took): Piece => ({ text: ` after ${took}`, tone: 'dim' }))

  return [
    [{ text: 'Stopped on an error', tone: 'warn' }, after[0] ?? { text: '' }],
    ...after.map((part): Words => [{ text: 'Error', tone: 'warn' }, part]),
    [{ text: 'Error', tone: 'warn' }],
  ]
}

// Napping, and how long the last turn took: "Napping · last turn took 2m 14s", "… 2m", "Napping".
function napForms(turn: LastTurn | null): Words[] {
  const napping: Piece = { text: 'Napping', tone: 'dim' }
  const took = turn === null ? [] : durationForms(turn.seconds)

  return [...took.map((text): Words => [napping, SEP, { text: `last turn took ${text}`, tone: 'dim' }]), [napping]]
}

const THINKING: Piece = { text: 'Thinking it over', tone: 'dim' }

// While he spins and cheers, the line wears one of his sparkles: "✻ Done in 41s". Narrow, the
// sparkle goes before any figure does: "Done in 2m 14s", then "Done in 2m", then "Done".
function cheerForms(turn: LastTurn | null): Words[] {
  if (turn === null) {
    return [[{ text: '✻', tone: 'clay' }, { text: ' ' }, { text: 'Done', tone: 'good', bold: true }], [{ text: 'Done', tone: 'good', bold: true }]]
  }

  return doneForms(turn, true)
}

// A finished turn, cheered (a clay ✻ and a bold green "Done") or settled after (the ✻ dim, as
// Claude Code marks a finished turn, and "Done" plain). Both are the same words in the same chain,
// so at any width the cheer hands over to the settled line without a word changing: only the
// colors calm down. The ✻ goes before any figure does.
function doneForms(turn: LastTurn, isCheer: boolean): Words[] {
  const done: Piece = isCheer ? { text: 'Done', tone: 'good', bold: true } : { text: 'Done', fitsAsBold: true }
  const sparkle: Words = [{ text: '✻', tone: isCheer ? 'clay' : 'dim' }, { text: ' ' }]

  return [...turnForms([...sparkle, done], turn, false), ...turnForms([done], turn, true).slice(-durationForms(turn.seconds).length), [done]]
}

// How a turn went, longest first, down to how long it took: "Done in 2m 14s · 7 tools · 2 files
// changed", "… · 2 files", "Done in 2m 14s · 7 tools", "Done in 2m 14s", and with `isShort` the
// figure without its seconds, "Done in 2m". A turn that only talked says how long it took, not "0 tools".
function turnForms(done: Words, turn: LastTurn, isShort: boolean): Words[] {
  const [long = '', ...short] = durationForms(turn.seconds)
  const took = (text: string): Words => [...done, { text: ` in ${text}` }]
  const tools: Words = turn.tools === 0 ? [] : [SEP, { text: `${turn.tools} tool${turn.tools === 1 ? '' : 's'}`, tone: 'dim' }]
  const files = `${turn.files} file${turn.files === 1 ? '' : 's'}`
  const changed: Words[] = turn.tools === 0 || turn.files === 0 ? [] : [[SEP, { text: `${files} changed`, tone: 'dim' }], [SEP, { text: files, tone: 'dim' }]]

  return [
    ...changed.map(part => [...took(long), ...tools, ...part]),
    ...(tools.length === 0 ? [] : [[...took(long), ...tools]]),
    took(long),
    ...(isShort ? short.map(took) : []),
  ]
}

// The todo tally after the words: "3 of 7 done", then "3/7 done" (as the hearth says it).
function tallyParts(known: Info): Words[] {
  if (known.todos.length === 0) {
    return []
  }
  const done = known.todos.filter(todo => todo.status === 'completed').length
  const total = known.todos.length

  return [`${done} of ${total} done`, `${done}/${total} done`].map(text => [SEP, { text, tone: 'dim' }])
}

function currentTodo(known: Info): string | null {
  const current =
    known.todos.find(todo => todo.status === 'in_progress') ?? known.todos.find(todo => todo.status === 'pending')

  return current === undefined ? null : (current.activeForm ?? current.subject)
}

// ── Line 2: the tide ──────────────────────────────────────────────────────────

// The percent first, then at high tide the band's one call to action (short, and second in line, so
// it outlasts the cost), the cost, and the 5-hour limit with when it resets. Narrow, they go from
// the end; at high tide "context" gives way before the nudge does ("86% · try /compact"), then the
// nudge's separator ("86% try /compact": never a bare "/compact", which reads as a fragment). A
// limit near its end (80% and up) outlasts the cost and the word "context" too, then its own label
// ("42% · 5h limit 86%", "42% · 5h 86%"): someone about to be cut off sees it at every width a band
// with room for it has. Before the first reading (every session starts so, and every /clear), it
// says so, down to "No reading": a label is never cut.
function tideForms(known: Info, isHigh: boolean, now: number): Words[] {
  if (known.percent === null) {
    const none = (text: string): Words => [{ text, tone: 'dim' }]
    return [...drops(none('No context reading yet'), extras(known, now)), none('No reading yet'), none('No reading')]
  }
  // The number in plain bold, the clearest text in the band; the water carries the sea blue. At high
  // tide it is in Claude's clay, as the nudge after it is: one color for the one warning (the
  // theme's warning yellow beside the clay read as two alarms). A plain space between bold and
  // dim: Ink closes both with one code, so neighbors would bleed.
  const figure: Piece = { text: `${Math.round(known.percent)}%`, tone: isHigh ? 'clay' : 'plain', bold: true }
  const labeled: Words = [figure, { text: ' ' }, { text: 'context', tone: 'dim' }]
  // The nudge's words are in the clay, and its separator is dim, as every other on the line is, so
  // the dots keep one rhythm. Right after the bold percent a plain space comes first, as a limit's
  // separator there has (see nearLimit), since Ink closes bold and dim with one code.
  const nudge = (ask: string): Words => [{ text: ' ' }, { text: '· ', tone: 'dim' }, { text: ask, tone: 'clay' }]
  const head: Words = isHigh ? [...labeled, SEP, { text: 'try /compact', tone: 'clay' }] : labeled
  const bare = isHigh ? [figure, ...nudge('try /compact')] : [figure]
  const near = nearLimit(known)
  // With a limit near its end, the line never shows its head alone: the limit goes only after "context" has.
  const wide = drops(head, extras(known, now)).slice(0, near === null ? undefined : -1)
  const limited = near === null ? [] : near.map(limit => [...bare, ...limit])
  const last: Words[] = isHigh ? [bare, [figure, { text: ' ' }, { text: 'try /compact', tone: 'clay' }], [figure]] : [bare]
  // At or past a limit nothing more runs until it resets, so the limit is the story, and a /compact
  // would not help yet: the nudge stays off at every width (the hearth says the same, "At the 5h
  // limit"), and on the narrowest band the limit outlasts even the percent, which the water still
  // shows: "86% context · 5h limit 100%", "86% · 5h limit 100%", "86% · 5h 100%", "5h 100%".
  const limit = known.limit
  if (near !== null && limit !== null && Math.round(limit.percent) >= 100) {
    const reached = drops(labeled, extras(known, now)).slice(0, -1)
    return [...reached, ...near.map(one => [figure, ...one]), [{ text: `${limitLabel(limit.kind)} `, tone: 'dim' }, { text: `${Math.round(limit.percent)}%`, tone: 'clay' }]]
  }

  return [...wide, ...limited, ...last]
}

// A limit near its end as it stands beside the bare percent, once "context" has gone: whole, then
// with its short label. Null when no limit is near its end.
function nearLimit(known: Info): Words[] | null {
  const limit = known.limit
  if (limit === null || Math.round(limit.percent) < NEAR) {
    return null
  }
  const label = limitLabel(limit.kind)
  const used: Piece = { text: `${Math.round(limit.percent)}%`, tone: 'clay' }
  // It may follow the bold percent directly: a plain space first, as "42% context" has, since Ink
  // closes bold and dim with one code and a dim separator there would come out bold.
  const sep: Words = [{ text: ' ' }, { text: '· ', tone: 'dim' }]

  return [
    [...sep, { text: `${label} limit `, tone: 'dim' }, used],
    [...sep, { text: `${label} `, tone: 'dim' }, used],
  ]
}

/** Where a limit counts as near its end: it outlasts the cost, and its figure is in clay. */
const NEAR = 80

// The cost, the limit, and when the limit resets (a time of day, which never goes stale). Near the
// limit (80% and up) it matters more than the cost: the limit and its reset come first, and the
// cost is the first to go on a narrow band, so someone about to be cut off always sees it.
function extras(known: Info, now: number): Words[] {
  // Nothing spent yet says nothing: "$0.00" is only noise at the start of a session.
  const cost: Words[] = known.usd === null || known.usd < 0.005 ? [] : [[SEP, { text: `$${known.usd.toFixed(2)}` }]]
  const limit = known.limit
  if (limit === null) {
    return cost
  }
  const used = Math.round(limit.percent)
  const isNear = used >= NEAR
  const parts: Words[] = [[SEP, { text: `${limitLabel(limit.kind)} limit `, tone: 'dim' }, { text: `${used}%`, tone: isNear ? 'clay' : 'plain' }]]
  const resets = used >= 50 && limit.resetsAt !== null ? clockText(Date.parse(limit.resetsAt), now) : null
  if (resets !== null) {
    parts.push([SEP, { text: `resets ${resets}`, tone: 'dim' }])
  }

  return isNear ? [...parts, ...cost] : [...cost, ...parts]
}

// ── Line 3: where we are ──────────────────────────────────────────────────────

// The project, the branch, git's count of uncommitted files, and the model. As room runs short the
// branch loses its prefix (claude/first-mod reads first-mod), then the model goes, then the count,
// then the branch is cut at its end ("first-m…"), then it goes; the project stays, cut last of all.
// Not "changed" for the count: line one already counts the files the last turn changed.
function placeForms(known: Info): Words[] {
  const project = known.project
  const whole = known.branch ?? ''
  const tail = whole.slice(whole.lastIndexOf('/') + 1)
  const dirty: Words = known.dirty !== null && known.dirty > 0 ? [SEP, { text: `${known.dirty} uncommitted`, tone: 'dim' }] : []
  const model: Words = known.model === null ? [] : [SEP, { text: known.model, tone: 'dim' }]
  const head: Words = project === null ? [] : [{ text: project }]
  const at = (branch: Words): Words => (head.length === 0 ? branch : [...head, SEP, ...branch])
  const forms: Words[] = []
  if (whole !== '') {
    const branch = (text: string): Words => [{ text, tone: 'dim' }]
    const branches = tail === whole ? [whole] : [whole, tail]
    for (const text of branches) forms.push(at([...branch(text), ...dirty, ...model]))
    if (model.length > 0) forms.push(at([...branch(tail), ...dirty]))
    if (dirty.length > 0) forms.push(at(branch(tail)))
    forms.push(at([name(tail, NAME_LEAST, 'dim')]))
  } else {
    forms.push(...drops(head, [dirty, model].filter(part => part.length > 0)))
  }
  if (project !== null) {
    forms.push(head, [name(project, 5, undefined, 'part')])
  }

  return dedupe(forms)
}

// Each form once, and none starting with a separator (a line with no project).
function dedupe(forms: Words[]): Words[] {
  const seen = new Set<string>()

  return forms
    .map(form => (form[0] === SEP ? form.slice(1) : form))
    .filter(form => {
      const key = JSON.stringify(form)
      if (seen.has(key) || form.length === 0) return false
      seen.add(key)
      return true
    })
}

/** The words as plain text, for an alt text or a test. */
export function plain(words: Words): string {
  return words.map(piece => piece.text).join('')
}
