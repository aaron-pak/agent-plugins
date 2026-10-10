import { expect, test } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf, SessionMeasureInput } from 'claude-code'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

// At 80 columns the track is 54 cells, so Clawd's left edge stands at 42% of 45 cells: 19.
const CLAWD_AT_42 = 19

function measured(percent: number, usd: number): SessionMeasureInput {
  return {
    context: { tokens: percent * 2000, window: 200_000, percent },
    rateLimits: [],
    cost: { usd },
    changed: ['context', 'cost'],
  }
}

function watchToasts(on: On): string[] {
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))

  return toasts
}

// The band's rows as the terminal would print them.
function rows(tree: RenderElement): string[] {
  const text = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(text).join('')

  return ((tree as { children?: unknown[] }).children ?? []).map(text)
}

test('crossing the threshold toasts once, and again after context drops', async ($, on) => {
  const toasts = watchToasts(on)

  await $.session.measure(measured(81, 1))
  await $.session.measure(measured(90, 1.2))
  expect(toasts).toEqual(['Context is 81% full. Run /compact soon.'])

  await $.session.measure(measured(20, 1.3))
  await $.session.measure(measured(85, 1.5))
  expect(toasts.length).toBe(2)
})

test('warnAt from the plugin options moves the threshold', { options: { warnAt: 50 } }, async ($, on) => {
  const toasts = watchToasts(on)

  await $.session.measure(measured(55, 0.5))

  expect(toasts).toEqual(['Context is 55% full. Run /compact soon.'])
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

test('Clawd walks the track to the context fill, on terminal and desktop', async ($, on) => {
  watchToasts(on)
  await $.session.measure(measured(42, 0.31))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-meter', surface, component: 'AbovePrompt', props: BAND })
    await ui.resize({ columns: 80, rows: 3, in: 'clawd' })

    const start = rows(await ui.drawn({ in: 'clawd' }))
    expect(start[0]?.indexOf('▐▛███▜▌')).toBe(1)

    await ui.advance(10_000)
    const settled = rows(await ui.drawn({ in: 'clawd' }))
    expect(settled[0]?.indexOf('▐')).toBe(CLAWD_AT_42 + 1)
    expect(settled[0]).toContain('✻ Context')
    expect(settled[1]).toContain('84k of 200k · $0.31')
    expect(settled[2]).toContain('42% used')
    expect(settled[2]?.startsWith('━'.repeat(CLAWD_AT_42 + 2))).toBe(true)

    await ui.unmount()
  }
})

test('Clawd scuttles while Claude works', async ($, on) => {
  watchToasts(on)
  await $.session.measure(measured(42, 0.31))
  const ui = await $.ui.mount({
    plugin: 'context-meter',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, isWorking: true },
  })
  await ui.resize({ columns: 80, rows: 3, in: 'clawd' })
  await ui.advance(10_000)

  const before = rows(await ui.drawn({ in: 'clawd' }))
  await ui.advance(240)
  const after = rows(await ui.drawn({ in: 'clawd' }))

  expect(before[0]).toContain('…')
  expect(new Set([before[1]?.includes('▝▜'), after[1]?.includes('▝▜')]).size).toBe(2)
})

test('clicking Clawd shows a heart for a moment', async ($, on) => {
  watchToasts(on)
  await $.session.measure(measured(42, 0.31))
  const ui = await $.ui.mount({ plugin: 'context-meter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.resize({ columns: 80, rows: 3, in: 'clawd' })
  await ui.advance(10_000)

  await ui.pointer({ type: 'down', x: CLAWD_AT_42 + 3, y: 1, button: 'left', in: 'clawd' })
  expect(rows(await ui.drawn({ in: 'clawd' }))[0]).toContain('♥')

  await ui.advance(3000)
  expect(rows(await ui.drawn({ in: 'clawd' }))[0]).not.toContain('♥')
})

test('past warnAt the band says it is time to compact', async ($, on) => {
  watchToasts(on)
  await $.session.measure(measured(86, 1.94))
  const ui = await $.ui.mount({ plugin: 'context-meter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.resize({ columns: 80, rows: 3, in: 'clawd' })

  const band = rows(await ui.drawn({ in: 'clawd' }))
  expect(band[0]).toContain('Time to /compact')
  expect(band[2]).toContain('86% used')
})

test('a survey keeps the band', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', children: ['How is Claude doing?'] }))
  const ui = await $.ui.mount({
    plugin: 'context-meter',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, hasSurvey: true },
  })

  expect(await ui.find({ text: 'How is Claude doing?' })).toBeDefined()
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
})

test('session start registers /meter, and /clear takes the reading away', async ($, on) => {
  watchToasts(on)
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

  await $.session.measure(measured(42, 0.3))
  await $.session.end({ reason: 'clear', sessionId: 'one', resume: { id: 'one' } })

  const ui = await $.ui.mount({ plugin: 'context-meter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.resize({ columns: 80, rows: 3, in: 'clawd' })
  const band = rows(await ui.drawn({ in: 'clawd' }))
  expect(band[1]).toContain('No reading yet')
  expect(band[2]).toContain('– used')
})
