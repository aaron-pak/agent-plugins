import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PARENT = { sessionId: 'parent-id', name: 'lead', status: 'busy' }
const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Answers the host commands the mod runs: the session registry, and a
// `claude --bg` launch that makes the worker appear in it.
const host = (on: On) => {
  const launched: (readonly string[])[] = []
  mock.clock(on)
  on('session.id', () => ({ value: 'parent-id' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('process.run', ($, e) => {
    const { argv } = e
    if (argv.includes('agents')) {
      const listed = launched.length === 0 ? [PARENT] : [PARENT, { sessionId: 'w', name: 'w1', status: 'busy' }]

      return ran(JSON.stringify(listed))
    }
    if (argv.includes('--bg')) launched.push(argv)

    return ran(argv.includes('--bg') ? 'b7f2c1\n' : '')
  })

  return launched
}

test('spawns a background session that knows whom to report to', { options: { launcher: 'bg' } }, async ($, on) => {
  const launched = host(on)
  const answer = await $.tool.call({ tool: 'mcp__orchestrator__spawn_session', name: 'w1', task: 'Count the TODOs.' })

  expect(launched).toHaveLength(1)
  const argv = launched[0] ?? []
  expect(argv.slice(argv.indexOf('claude'), argv.indexOf('claude') + 4)).toEqual(['claude', '--bg', '-n', 'w1'])
  expect(argv).toContain('CLAUDE_CODE_SESSION_ID')
  expect(argv.at(-1)).toContain('send your result to "lead" with SendMessage')
  expect(argv.at(-1)).toContain('Count the TODOs.')
  expect(String(answer.result)).toContain('reachable')
})

test('refuses a name that cannot be an address', async ($, on) => {
  host(on)
  const answer = await $.tool.call({ tool: 'mcp__orchestrator__spawn_session', name: 'Bad Name', task: 'x' })

  expect(answer.deny).toContain('kebab-case')
})

test('refuses a name a running session already has', async ($, on) => {
  host(on)
  const answer = await $.tool.call({ tool: 'mcp__orchestrator__spawn_session', name: 'lead', task: 'x' })

  expect(answer.deny).toContain('already running')
})

test('a worker shares the orchestrator\'s acceptEdits mode', { options: { launcher: 'bg' } }, async ($, on) => {
  const launched = host(on)
  await $.classic.UserPromptSubmit({ prompt: 'split this up', permission_mode: 'acceptEdits' })
  await $.tool.call({ tool: 'mcp__orchestrator__spawn_session', name: 'w1', task: 'x' })

  const argv = launched[0] ?? []
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
})

test('a worker does not inherit plan mode', { options: { launcher: 'bg' } }, async ($, on) => {
  const launched = host(on)
  await $.classic.UserPromptSubmit({ prompt: 'plan it', permission_mode: 'plan' })
  await $.tool.call({ tool: 'mcp__orchestrator__spawn_session', name: 'w1', task: 'x' })

  expect(launched[0]).not.toContain('--permission-mode')
})
