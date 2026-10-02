import { expect, test } from 'claude-code/testing'
import type { On, SessionMeasureInput } from 'claude-code'

function measured(percent: number, usd: number): SessionMeasureInput {
  return {
    context: { tokens: percent * 2000, window: 200_000, percent },
    rateLimits: [],
    cost: { usd },
    changed: ['context', 'cost'],
  }
}

function watchScreen(on: On) {
  const screen = { status: undefined as string | undefined, toasts: [] as string[] }
  on('ui.status', ($, e) => {
    screen.status = e.text

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    screen.toasts.push(e.text)

    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))

  return screen
}

test('the status line shows context fill and cost', async ($, on) => {
  const screen = watchScreen(on)

  await $.session.measure(measured(42, 0.314))

  expect(screen.status).toBe('context 42% · $0.31')
  expect(screen.toasts).toEqual([])
})

test('crossing the threshold toasts once, and again after context drops', async ($, on) => {
  const screen = watchScreen(on)

  await $.session.measure(measured(81, 1))
  await $.session.measure(measured(90, 1.2))
  expect(screen.toasts).toEqual(['Context is 81% full. Run /compact soon.'])

  await $.session.measure(measured(20, 1.3))
  await $.session.measure(measured(85, 1.5))
  expect(screen.toasts.length).toBe(2)
})

test('warnAt from the plugin options moves the threshold', { options: { warnAt: 50 } }, async ($, on) => {
  const screen = watchScreen(on)

  await $.session.measure(measured(55, 0.5))

  expect(screen.toasts).toEqual(['Context is 55% full. Run /compact soon.'])
})

test('/meter reports context, cost and rate limits', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
      cost: { usd: 0.31 },
    },
  }))

  const ran = await $.command.run({
    command: 'meter',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(ran.text).toBe(
    ['Context: 84k of 200k tokens (42%)', 'Cost so far: $0.31', 'Rate limit five_hour: 23.5% used'].join('\n'),
  )
})

test('session start registers /meter, and /clear empties the status line', async ($, on) => {
  const screen = watchScreen(on)
  const commands: string[] = []
  on('command.register', ($, e) => {
    commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(commands).toEqual(['meter'])
  expect(screen.status).toBe('$0.00')

  await $.session.measure(measured(42, 0.3))
  await $.session.end({ reason: 'clear', sessionId: 'one', resume: { id: 'one' } })
  expect(screen.status).toBeUndefined()
})
