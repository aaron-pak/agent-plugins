import type { Register, SessionUsage } from 'claude-code'

type Figures = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const DEFAULT_WARN_AT = 80

export const register: Register = (on, options) => {
  const warnAt = typeof options.warnAt === 'number' ? options.warnAt : DEFAULT_WARN_AT
  // A module variable is enough here: a reload starting it over only means one more toast.
  let hasWarned = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meter',
      description: 'Show context fill, session cost and rate limits',
    })
    $.ui.status(statusLine(await $.session.usage()))

    return next(e)
  })

  // Pushed after each main-thread turn and when a rate-limit window moves.
  on('session.measure', ($, e, next) => {
    $.ui.status(statusLine(e))

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
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') {
      hasWarned = false
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => ({
    text: report(await $.session.usage()),
  }))
}

function statusLine({ context, cost }: Figures): string | undefined {
  const parts = [
    context.percent === undefined ? undefined : `context ${context.percent}%`,
    cost === undefined ? undefined : dollars(cost.usd),
  ].filter(part => part !== undefined)

  return parts.length === 0 ? undefined : parts.join(' · ')
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
