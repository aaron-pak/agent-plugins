// The merged facts, seen exactly as the tide's beach was built and tested to see them.

import type { Activity as Fact, Info as Facts } from '../../types'
import { shownTodos } from '../facts'
import type { Activity, Info } from './types'

export function tideInfo(known: Facts): Info {
  const desk = { activity: tideActivity(known.desk.activity), shownAt: known.desk.shownAt }
  const turn = known.lastTurn

  return {
    model: known.model,
    project: known.project,
    branch: known.branch,
    dirty: known.dirty,
    percent: known.percent,
    tokens: known.tokens,
    window: known.window,
    usd: known.usd,
    limit: known.limit,
    turnPercent: known.turnPercent,
    startedAt: known.startedAt,
    lastActiveAt: known.lastActiveAt,
    // Both surfaces show the tool the facts' hold settled on (stepDesk), so they name the same tools,
    // however quick: the terminal's band only takes it up on a tick of its own clock.
    activity: desk.activity,
    toolEndedAt: known.toolEndedAt,
    desk,
    // He potters once the turn has changed something and the words have moved on since it began (to
    // the edit itself, or past it): the picture and its words change together, never the potter under
    // a read the line still holds. Once the turn is written down as over (its words gone with it), he
    // keeps what he had for the moment the host still says it works, so the stop is one new frame.
    turnWorked: known.turnWorked && known.workedAt !== null && (known.desk.shownAt >= known.workedAt || !known.isTurnOpen),
    woke: known.woke,
    lastTurn: turn === null ? null : { seconds: turn.seconds, tools: turn.tools, files: turn.files, ending: turn.ending },
    // As its line holds them: a todo ticked off comes up with the step after it (see tallied).
    todos: shownTodos(known, known.desk),
    cheers: known.cheers,
    cheeredAt: known.cheeredAt,
    cheerPercent: known.cheerPercent,
    oops: known.oops,
    oopsAt: known.oopsAt,
    oopsWhat: known.oopsWhat,
    oopsName: known.oopsName,
    oopsCommand: known.oopsCommand,
    oopsNoun: known.oopsNoun,
    oopsPercent: known.oopsPercent,
    splashAt: known.oopsAt === null ? null : (known.splashAt ?? known.oopsAt),
    waves: known.waves,
    isSlipped: known.slip !== null,
    turnAt: known.turnAt,
    isStill: known.isCalm,
    isAppleTerminal: known.isAppleTerminal,
    beat: known.beat,
  }
}

/** An activity as the tide draws it: Clawd watches the words while Claude looks at things, potters while it works, and sits while it waits on you. */
function tideActivity(activity: Fact | null): Activity | null {
  if (activity === null) {
    return null
  }
  const kind = activity.kind === 'read' || activity.kind === 'web' ? 'look' : activity.kind === 'ask' ? 'wait' : 'work'

  return { id: activity.id, verb: activity.verb, target: activity.target, kind, what: activity.what }
}

