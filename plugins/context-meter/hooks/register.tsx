import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

import type { ClawdProps, Meter } from '../types'

type Figures = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const DEFAULT_WARN_AT = 80

const meter = atom({ plugin: 'context-meter', key: 'meter' } as const, null)

export const register: Register = (on, options) => {
  const warnAt = typeof options.warnAt === 'number' ? options.warnAt : DEFAULT_WARN_AT
  // A module variable is enough here: a reload starting it over only means one more toast.
  let hasWarned = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meter',
      description: 'Show context fill, session cost and rate limits',
    })
    const figures = toMeter(await $.session.usage())
    await update($, meter, () => figures)

    return next(e)
  })

  // Pushed after each main-thread turn and when a rate-limit window moves.
  on('session.measure', async ($, e, next) => {
    await update($, meter, () => toMeter(e))

    const percent = e.context.percent
    if (percent !== undefined && percent >= warnAt && !hasWarned) {
      hasWarned = true
      $.ui.toast(`Context is ${percent}% full. Run /compact soon.`, { timeoutMs: 8000 })
    } else if (percent !== undefined && percent < warnAt) {
      hasWarned = false
    }

    return next(e)
  })

  // /clear starts a fresh conversation without a new session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      hasWarned = false
      await update($, meter, () => null)
    }

    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => ({
    text: report(await $.session.usage()),
  }))

  // The band above the prompt: Clawd's surface module animates on the surface's own clock.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }

    const { Client } = $.ui.resolve(e)
    const props = clawdProps(await read($, meter), e.props.isWorking, warnAt, e.props.bodyColumns)

    return <Client key="clawd" module="./clawd.tsx" props={props} width={e.props.bodyColumns} height={3} />
  })
}

function toMeter({ context, cost }: Figures): Meter {
  return {
    percent: context.percent ?? null,
    tokens: context.tokens ?? null,
    window: context.window,
    usd: cost?.usd ?? null,
  }
}

function clawdProps(figures: Meter | null, isWorking: boolean, warnAt: number, columns: number): ClawdProps {
  const percent = figures?.percent ?? null

  return {
    percent,
    usage:
      figures?.tokens == null
        ? 'No reading yet'
        : `${shortCount(figures.tokens)} of ${shortCount(figures.window)}`,
    cost: figures?.usd == null ? null : dollars(figures.usd),
    isWorking,
    isHigh: percent !== null && percent >= warnAt,
    columns,
  }
}

function report({ context, rateLimits, cost }: Figures): string {
  const lines = [
    context.tokens === undefined
      ? `Context: nothing measured yet (window ${shortCount(context.window)})`
      : `Context: ${shortCount(context.tokens)} of ${shortCount(context.window)} tokens (${context.percent ?? 0}%)`,
    cost === undefined ? 'Cost: not tracked here' : `Cost so far: ${dollars(cost.usd)}`,
    ...rateLimits.map(limit => `Rate limit ${limit.kind}: ${limit.percentUsed}% used`),
  ]

  return lines.join('\n')
}

function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`
}

function shortCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`
  }

  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`
}
