import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf, SessionMeasureInput } from 'claude-code'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

// The engine beneath the plugin: a session in agent-plugins on branch main with two changed files.
function world(on: On): { toasts: string[] } {
  const toasts: string[] = []
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: 1_000_000 - 12 * 60_000, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.repo', () => ({ value: { root: '/work/agent-plugins', remote: null, internal: false, name: null } }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('rev-parse') ? 'main\n' : ' M README.md\n?? notes.md\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { toasts }
}

function measured(percent: number, usd: number): SessionMeasureInput {
  return {
    context: { tokens: percent * 2000, window: 200_000, percent },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: new Date(1_000_000 + 130 * 60_000).toISOString() }],
    cost: { usd },
    changed: ['context', 'cost', 'rateLimits'],
  }
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work/agent-plugins', surface: 'terminal', isInteractive: true })
  await $.session.measure(measured(42, 0.31))
}

function rows(tree: RenderElement): string[] {
  const text = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(text).join('')

  return ((tree as { children?: unknown[] }).children ?? []).map(text)
}

async function band($: Engine, surface: (typeof SURFACES)[number] = 'terminal', props = BAND) {
  const ui = await $.ui.mount({ plugin: 'session-band', surface, component: 'AbovePrompt', props })
  await ui.resize({ columns: props.bodyColumns, rows: 3, in: 'band' })

  return { ui, read: async () => rows(await ui.drawn({ in: 'band' })) }
}

async function run($: Engine, command: string, args = '') {
  return $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
}

test('cozy shows Clawd beside the model, branch, meters and last turn, on terminal and desktop', async ($, on) => {
  world(on)
  await start($)

  for (const surface of SURFACES) {
    const { ui, read } = await band($, surface)
    const [title, meters, doing] = await read()

    expect(title).toContain('▐▛███▜▌')
    expect(title).toContain('Opus 5.5')
    expect(title).toContain('agent-plugins ⎇ main ●2')
    expect(title).toContain('◷ 12m')
    expect(meters).toContain('42%')
    expect(meters).toContain('5h')
    expect(meters).toContain('↻2h 10m')
    expect(meters).toContain('$0.31')
    expect(doing).toContain('Ready when you are')

    await ui.unmount()
  }
})

test('/band cycles the styles, takes a name, and remembers the pick', async ($, on) => {
  world(on)
  await start($)

  expect((await run($, 'band')).text).toContain('Band style: trail')
  const trail = await band($)
  expect((await trail.read()).length).toBe(3)
  expect((await trail.read())[2]).toContain('42% used')
  await trail.ui.unmount()

  expect((await run($, 'band', 'peek')).text).toContain('Band style: peek')
  const peek = await band($)
  expect((await peek.read()).length).toBe(2)
  expect((await peek.read())[1]).toContain('│ $0.31 │')
  await peek.ui.unmount()

  expect((await run($, 'band', 'sparkly')).text).toContain('No band style "sparkly"')
  expect((await run($, 'band')).text).toContain('Band style: cozy')
})

test('a running tool shows what Claude is doing, and todos count up', async ($, on) => {
  world(on)
  let read: (() => Promise<string[]>) | undefined
  let during: string[] = []
  let created = 0
  on('tool.call', async ($, e) => {
    if (e.tool === 'Edit') {
      during = (await read?.()) ?? []
    }

    return e.tool === 'TaskCreate'
      ? { result: { task: { id: String((created += 1)), subject: String(e.subject) } } }
      : { result: { ok: true } }
  })
  await start($)
  read = (await band($, 'terminal', { ...BAND, isWorking: true })).read

  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the band tests', description: '', activeForm: 'Writing the band tests' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/agent-plugins/hooks/band.tsx', old_string: 'a', new_string: 'b' })

  expect(during[2]).toContain('Editing band.tsx…')
  const after = (await read?.()) ?? []
  expect(after[2]).not.toContain('Editing')
  expect(after[2]).toContain('☐ 1/2')
})

test('a finished turn reports what it did, and Clawd cheers', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { ok: true } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await start($)
  const { ui, read } = await band($)

  await $.prompt.submit({ text: 'tidy up', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: '/work/b.ts' })
  await $.turn.complete({ answer: 'Done.', durationMs: 41_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const [head, , doing] = await read()
  expect(doing).toContain('Last turn 41s · 2 tools · 1 file changed')
  expect(head).toMatch(/[✦✧]/)

  await ui.advance(5000)
  expect((await read())[0]).not.toMatch(/[✦✧]/)
})

test('past warnAt the bar turns red, Clawd sweats and a toast suggests /compact', async ($, on) => {
  const { toasts } = world(on)
  await start($)
  await $.session.measure(measured(86, 1.94))
  const { ui, read } = await band($)
  await ui.advance(120)

  expect(toasts).toEqual(['Context is 86% full. Run /compact soon.'])
  expect((await read())[1]).toContain('86%')
  const frames = [(await read())[0], ...(await Promise.all([ui.advance(600).then(read)])).map(r => r[0])]
  expect(frames.some(head => head?.includes('°'))).toBe(true)
})

test('clicking Clawd shows a heart', async ($, on) => {
  world(on)
  await start($)
  const { ui, read } = await band($)

  await ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'band' })
  expect((await read())[0]).toContain('♥')

  await ui.advance(3000)
  expect((await read())[0]).not.toContain('♥')
})

test('a survey keeps the band', async ($, on) => {
  world(on)
  on('ui.render', () => ({ type: 'Text', children: ['How is Claude doing?'] }))
  const ui = await $.ui.mount({ plugin: 'session-band', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })

  expect(await ui.find({ text: 'How is Claude doing?' })).toBeDefined()
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
})
