import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Row = { sessionId: string; id?: string; name: string; kind: string; pid: number | null; status: string | null; state?: string }
type Message = { role: 'user' | 'assistant'; text: string; toolUses: [] }

const ok = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const SPAWN = 'mcp__sessions__spawn_session'
const STOP = 'mcp__sessions__stop_session'
const LIST = 'mcp__sessions__list_sessions'
const BRIEF = 'You were started by the Claude Code session "lead" (id 0b0c3f7e-1d2a-4c5b-9e8f-7a6b5c4d3e2f) as "w1", to do the task below.\n\nCount the TODOs.'

// A machine with one interactive session, "lead", in a git repository: the
// session registry `claude agents` reads, and the claude commands that change it.
const host = (on: On, { settings = {}, isGitRepo = true }: { settings?: Record<string, unknown>; isGitRepo?: boolean } = {}) => {
  const world = {
    clock: mock.clock(on),
    rows: [{ sessionId: 'parent-id', name: 'lead', kind: 'interactive', pid: 1, status: 'busy' }] as Row[],
    ran: [] as string[][],
    sent: [] as { to: unknown; text: string }[],
    messages: [] as Message[],
    // The claude command of each run, from `claude` on, without the env prefix.
    claude: () => world.ran.flatMap(argv => (argv.includes('claude') ? [argv.slice(argv.indexOf('claude'))] : [])),
  }
  mock.env(on, {})
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'parent-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: world.messages }))
  on('settings.read', () => ({ value: settings }))
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.receive', ($, e) => ({ text: e.text }))
  on('session.send', ($, e) => {
    world.sent.push({ to: e.to, text: e.text })

    return { isDelivered: true }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    world.ran.push(argv)
    if (argv[0] === 'git') return ok(isGitRepo ? 'true\n' : '', isGitRepo ? 0 : 128)
    if (!argv.includes('claude')) return ok('')
    const [verb = '', ...rest] = argv.slice(argv.indexOf('claude') + 1)
    const row = (id?: string) => world.rows.find(one => one.id === id || one.sessionId === id)
    if (verb === 'agents') return ok(JSON.stringify(world.rows.filter(one => rest.includes('--all') || one.pid !== null)))
    if (verb === 'stop') Object.assign(row(rest[0]) ?? {}, { pid: null, status: null })
    if (verb === 'rm') world.rows = world.rows.filter(one => one !== row(rest[0]))
    if (verb === '--bg' && rest.includes('-n')) {
      const name = rest[rest.indexOf('-n') + 1] ?? ''
      world.rows.push({ sessionId: `${name}-id`, id: 'b7f2c1', name, kind: 'background', pid: 2, status: 'busy' })

      return ok(`backgrounded · b7f2c1 · ${name}\n`)
    }
    if (verb === 'respawn') Object.assign(row(rest[0]) ?? {}, { pid: 3, status: 'idle' })

    return ok('')
  })

  return world
}

test('spawns a background session in this checkout that knows whom to report to', { options: { launcher: 'bg' } }, async ($, on) => {
  const world = host(on)
  const answer = await $.tool.call({ tool: SPAWN, name: 'w1', task: 'Count the TODOs.' })

  const launched = world.claude().filter(argv => argv.includes('--bg'))
  expect(launched).toHaveLength(1)
  const argv = launched[0] ?? []
  expect(argv.slice(0, 4)).toEqual(['claude', '--bg', '-n', 'w1'])
  expect(argv).not.toContain('-w')
  expect(world.ran.find(one => one.includes('--bg'))).toContain('CLAUDE_CODE_SESSION_ID')
  expect(argv.at(-1)).toContain('send your result to "lead" with SendMessage')
  expect(argv.at(-1)).toContain('Count the TODOs.')
  expect(String(answer.result)).toContain('reachable')
  expect(String(answer.result)).not.toContain('worktree')
})

test('worktree: true gives it its own worktree', { options: { launcher: 'bg' } }, async ($, on) => {
  const world = host(on)
  const answer = await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x', worktree: true })

  expect(world.claude().find(argv => argv.includes('--bg'))?.slice(0, 6)).toEqual(['claude', '--bg', '-n', 'w1', '-w', 'w1'])
  expect(String(answer.result)).toContain('branch worktree-w1')
})

test('worktree: true outside a git repository is refused', { options: { launcher: 'bg' } }, async ($, on) => {
  const world = host(on, { isGitRepo: false })
  const answer = await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x', worktree: true })

  expect(answer.deny).toContain('git repository')
  expect(world.claude().some(argv => argv.includes('--bg'))).toBe(false)
})

test('fork starts it as a copy of this conversation', { options: { launcher: 'bg' } }, async ($, on) => {
  const world = host(on)
  const answer = await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x', fork: true })

  const argv = world.claude().find(one => one.includes('--bg')) ?? []
  expect(argv.slice(0, 5)).toEqual(['claude', '--bg', '--resume', 'parent-id', '--fork-session'])
  expect(String(answer.result)).toContain('as a fork of this conversation')
})

test('fork needs the bg launcher', { options: { launcher: 'tmux' } }, async ($, on) => {
  host(on)
  const answer = await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x', fork: true })

  expect(answer.deny).toContain('bg launcher')
})

test('briefs it to end its turns with the result when the mod loads there too', { options: { launcher: 'bg' } }, async ($, on) => {
  const world = host(on, { settings: { enabledPlugins: { 'sessions@local': true } } })
  const answer = await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x' })

  expect(world.claude().find(argv => argv.includes('--bg'))?.at(-1)).toContain('sent to "lead" automatically')
  expect(String(answer.result)).toContain('Report from session')
})

test('refuses a name that cannot be an address', async ($, on) => {
  host(on)
  const answer = await $.tool.call({ tool: SPAWN, name: 'Bad Name', task: 'x' })

  expect(answer.deny).toContain('kebab-case')
})

test('refuses a name a running session already has', async ($, on) => {
  host(on)
  const answer = await $.tool.call({ tool: SPAWN, name: 'lead', task: 'x' })

  expect(answer.deny).toContain('already running')
})

test('a new session shares this one\'s acceptEdits mode', { options: { launcher: 'bg' } }, async ($, on) => {
  const world = host(on)
  await $.classic.UserPromptSubmit({ prompt: 'split this up', permission_mode: 'acceptEdits' })
  await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x' })

  const argv = world.claude().find(one => one.includes('--bg')) ?? []
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
})

test('a new session does not inherit plan mode', { options: { launcher: 'bg' } }, async ($, on) => {
  const world = host(on)
  await $.classic.UserPromptSubmit({ prompt: 'plan it', permission_mode: 'plan' })
  await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x' })

  expect(world.claude().find(argv => argv.includes('--bg'))).not.toContain('--permission-mode')
})

test('a started session sends its final message to its parent', async ($, on) => {
  const world = host(on)
  world.messages = [{ role: 'user', text: BRIEF, toolUses: [] }]
  await $.turn.complete({ answer: '42 TODOs.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(world.sent).toHaveLength(1)
  expect(JSON.stringify(world.sent[0]?.to)).toContain('0b0c3f7e-1d2a-4c5b-9e8f-7a6b5c4d3e2f')
  expect(world.sent[0]?.text).toBe('Report from session "w1":\n\n42 TODOs.')
})

test('no second report when the model already messaged its parent', async ($, on) => {
  const world = host(on)
  world.messages = [{ role: 'user', text: BRIEF, toolUses: [] }]
  await $.session.send({ to: 'lead', text: '42 TODOs.', origin: { kind: 'model' } })
  await $.turn.complete({ answer: 'Sent.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.complete({ answer: 'Next result.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

  expect(world.sent.map(one => one.text)).toEqual(['42 TODOs.', 'Report from session "w1":\n\nNext result.'])
})

test('a session nobody started reports to no one', async ($, on) => {
  const world = host(on)
  world.messages = [{ role: 'user', text: 'Count the TODOs.', toolUses: [] }]
  await $.turn.complete({ answer: '42 TODOs.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(world.sent).toHaveLength(0)
})

test('a subagent\'s turn is not reported', async ($, on) => {
  const world = host(on)
  world.messages = [{ role: 'user', text: BRIEF, toolUses: [] }]
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })

  expect(world.sent).toHaveLength(0)
})

test('a message to a stopped background session wakes it first', async ($, on) => {
  const world = host(on)
  world.rows.push({ sessionId: 'w2-full-id', id: 'c3d4e5', name: 'w2', kind: 'background', pid: null, status: null })
  const sent = await $.session.send({ to: 'w2', text: 'One more thing.', origin: { kind: 'model' } })

  expect(world.claude()).toContainEqual(['claude', 'respawn', 'c3d4e5'])
  expect(sent.isDelivered).toBe(true)
  expect(world.sent.map(one => one.text)).toEqual(['One more thing.'])
})

test('a message to a running session wakes nothing', async ($, on) => {
  const world = host(on)
  await $.session.send({ to: 'lead', text: 'hi', origin: { kind: 'model' } })

  expect(world.claude().some(argv => argv.includes('respawn'))).toBe(false)
})

test('keeps the report a started session sent back', { options: { launcher: 'bg' } }, async ($, on) => {
  host(on)
  await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x' })
  await $.session.receive({
    origin: { kind: 'peer' },
    text: '<cross-session-message from="w1">\nReport from session "w1":\n\n42 TODOs.\n</cross-session-message>',
  })
  const answer = await $.tool.call({ tool: LIST })

  expect(String(answer.result)).toContain('last report: 42 TODOs.')
})

test('stops a background session idle past the grace, not before', { options: { launcher: 'bg', stopAfterMinutes: 15 } }, async ($, on) => {
  const world = host(on)
  await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x' })
  Object.assign(world.rows.find(one => one.name === 'w1') ?? {}, { status: 'idle' })
  await $.tool.call({ tool: LIST })
  await world.clock.advance(10 * 60_000)
  await $.tool.call({ tool: LIST })
  expect(world.claude()).not.toContainEqual(['claude', 'stop', 'b7f2c1'])

  await world.clock.advance(6 * 60_000)
  const answer = await $.tool.call({ tool: LIST })
  expect(world.claude()).toContainEqual(['claude', 'stop', 'b7f2c1'])
  expect(String(answer.result)).toContain('w1: stopped')
})

test('a session waiting for input is never stopped', { options: { launcher: 'bg', stopAfterMinutes: 15 } }, async ($, on) => {
  const world = host(on)
  await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x' })
  Object.assign(world.rows.find(one => one.name === 'w1') ?? {}, { status: 'idle', state: 'blocked' })
  await $.tool.call({ tool: LIST })
  await world.clock.advance(60 * 60_000)
  const answer = await $.tool.call({ tool: LIST })

  expect(world.claude()).not.toContainEqual(['claude', 'stop', 'b7f2c1'])
  expect(String(answer.result)).toContain('w1: waiting for input')
})

test('stop_session stops, and remove deletes', { options: { launcher: 'bg' } }, async ($, on) => {
  const world = host(on)
  await $.tool.call({ tool: SPAWN, name: 'w1', task: 'x' })
  const stopped = await $.tool.call({ tool: STOP, name: 'w1' })
  expect(world.claude()).toContainEqual(['claude', 'stop', 'b7f2c1'])
  expect(String(stopped.result)).toContain('wakes it')

  const removed = await $.tool.call({ tool: STOP, name: 'w1', remove: true })
  expect(world.claude()).toContainEqual(['claude', 'rm', 'b7f2c1'])
  expect(String(removed.result)).toContain('Removed "w1".')
  expect(String((await $.tool.call({ tool: LIST })).result)).toContain('has not started any sessions')
})

test('stop_session leaves other people\'s sessions alone', async ($, on) => {
  host(on)
  const answer = await $.tool.call({ tool: STOP, name: 'lead' })

  expect(answer.deny).toContain('No background session')
})
