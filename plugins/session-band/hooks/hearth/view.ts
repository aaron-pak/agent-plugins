// The merged facts, seen exactly as Hearth's band was built and tested to see them.

import type { Activity as Fact, Info as Facts } from '../../types'
import { shownTodos } from '../facts'
import type { Activity, Held, Info } from './types'

export function hearthInfo(known: Facts): Info {
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
    startedAt: known.startedAt,
    lastActiveAt: known.lastActiveAt,
    activity: hearthActivity(known.activity),
    slip: hearthActivity(known.slip),
    lastSlip: hearthActivity(known.lastSlip),
    slipDue: hearthActivity(known.slipDue),
    flinchAt: known.flinchAt,
    isTurnOpen: known.isTurnOpen,
    toolEndedAt: known.toolEndedAt,
    held: hearthHeld(known.held),
    lastTurn: known.lastTurn,
    // As its line holds them: a todo ticked off comes up with the step after it (see tallied).
    todos: shownTodos(known, known.held),
    cheers: known.cheers,
    oops: known.oops,
    isCalm: known.isCalm,
    isAppleTerminal: known.isAppleTerminal,
    beat: known.beat,
  }
}

/** An activity as Hearth drew it: its kind, verb and target. */
export function hearthActivity(activity: Fact | null): Activity | null {
  if (activity === null) {
    return null
  }

  return { id: activity.id, kind: activity.kind, verb: activity.verb, target: activity.target, what: activity.what }
}

function hearthHeld(held: Facts['held']): Held {
  return { activity: hearthActivity(held.activity), slip: hearthActivity(held.slip), at: held.at }
}

/** When the hiccup on screen failed: the failing tool's end, kept until the next tool starts. */
export function slipAt(known: Facts): number | null {
  return known.slip !== null ? known.oopsAt : null
}

