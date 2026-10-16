// The shared facts, seen exactly as the hearth's code reads them.

import type { Activity as Fact, Info as Facts } from '../../types'
import { shownTodos } from '../facts'
import type { Activity, Info } from './types'

export function hearthInfo(known: Facts): Info {
  return {
    // The model stands at line 1's right end, and on a narrow band it is the first thing the line
    // gives up for the branch: it joins with git's first answer, so the branch never pushes it off
    // (the project is up from the first frame).
    model: known.isGitRead ? known.model : null,
    project: known.project,
    branch: known.branch,
    dirty: known.dirty,
    percent: known.percent,
    usd: known.usd,
    limit: known.limit,
    lastActiveAt: known.lastActiveAt,
    activity: hearthActivity(known.activity),
    slip: hearthActivity(known.slip),
    lastSlip: hearthActivity(known.lastSlip),
    flinchAt: known.flinchAt,
    lastTurn: known.lastTurn,
    // As its line holds them: a todo ticked off comes up with the step after it (see tallied).
    todos: shownTodos(known, known.held),
    cheers: known.cheers,
    oops: known.oops,
    isCalm: known.isCalm,
    isAppleTerminal: known.isAppleTerminal,
  }
}

/** An activity as Hearth drew it: its kind, verb and target. */
export function hearthActivity(activity: Fact | null): Activity | null {
  if (activity === null) {
    return null
  }

  return { id: activity.id, kind: activity.kind, verb: activity.verb, target: activity.target, what: activity.what }
}

/** When the hiccup on screen failed: the failing tool's end, kept until the next tool starts. */
export function slipAt(known: Facts): number | null {
  return known.slip !== null ? known.oopsAt : null
}

