// Hearth's props: the facts, already formatted for its band.

import { clockText, limitLabel } from '../facts'
import type { Motion } from '../../types'
import type { Activity, BandProps, Doing, Info } from './types'

export function bandProps(
  known: Info,
  slipAt: number | null,
  motion: Motion,
  isWorking: boolean,
  warnAt: number,
  columns: number,
  now: number,
  greetedMs: number | null,
  shownForMs: number | null = null,
): BandProps {
  const done = known.todos.filter(todo => todo.status === 'completed').length
  const current = known.todos.find(todo => todo.status === 'in_progress') ?? known.todos.find(todo => todo.status === 'pending')
  const next = known.todos.find(todo => todo.status !== 'completed')
  const resetsAt = known.limit?.resetsAt == null ? NaN : Date.parse(known.limit.resetsAt)

  return {
    isStill: motion === 'still' || known.isCalm,
    isAppleTerminal: known.isAppleTerminal,
    isGreeting: greetedMs !== null && known.lastTurn === null && !isWorking,
    greetedMs: greetedMs !== null && known.lastTurn === null && !isWorking ? greetedMs : null,
    columns,
    isWorking,
    isHigh: known.percent !== null && known.percent >= warnAt,
    model: known.model,
    project: known.project,
    branch: known.branch,
    dirty: known.dirty,
    percent: known.percent,
    // Nothing spent yet says nothing: "$0.00" is only noise at the start of a session.
    cost: known.usd === null || known.usd < 0.005 ? null : `$${known.usd.toFixed(2)}`,
    limit:
      known.limit === null
        ? null
        : {
            label: limitLabel(known.limit.kind),
            percent: Math.round(known.limit.percent),
            // A time of day, which never goes stale: "resets 4:30pm".
            resetsAt: clockText(Number.isNaN(resetsAt) ? null : resetsAt, now),
          },
    idleMs: known.lastActiveAt === null ? null : Math.max(0, now - known.lastActiveAt),
    activity: doing(known.activity),
    slip: doing(known.slip),
    lastSlip: doing(known.lastSlip),
    slipAgoMs: known.slip === null || slipAt === null ? null : Math.max(0, now - slipAt),
    flinchAgoMs: known.flinchAt === null ? null : Math.max(0, now - known.flinchAt),
    lastTurn: known.lastTurn === null ? null : { ...known.lastTurn, ending: known.lastTurn.ending ?? 'answer' },
    todos:
      known.todos.length === 0
        ? null
        : {
            done,
            total: known.todos.length,
            current: current === undefined ? null : (current.activeForm ?? current.subject),
            next: next === undefined ? null : next.subject,
          },
    cheers: known.cheers,
    oops: known.oops,
    shownForMs,
  }
}

export function doing(activity: Activity | null): Doing | null {
  return activity === null ? null : { kind: activity.kind, verb: activity.verb, target: activity.target, what: activity.what }
}
