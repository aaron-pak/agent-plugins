import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Spawned } from '../types'

const TOOL = 'spawn_session'
const PANE = 'sessions-spawned'
const spawned = atom({ plugin: 'sessions', key: 'spawned' } as const, [])
const live = atom({ plugin: 'sessions', key: 'live' } as const, {})

// Variables a session sets for itself. A child that inherits them would
// claim the parent's identity instead of registering as a peer of its own.
const PARENT_ONLY_ENV = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_PROJECTS_SESSION',
]
const CLEAN_ENV = ['env', ...PARENT_ONLY_ENV.flatMap(name => ['-u', name])]
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
// Sessions in different permission modes hold each other's messages for the
// person's approval, so a new session takes its parent's mode when it is one
// of these. Plan and bypass stay the new session's own choice.
const SHARED_MODES = new Set(['acceptEdits', 'auto'])

type Launcher = 'bg' | 'tmux' | 'headless'
type Peer = { sessionId: string; name?: string; status?: string }
type Spawn = { name: string; task: string; cwd?: string; model?: string; mode?: string }

// The same registry ListAgents reads, through the CLI's scripting output.
const peers = async ($: EngineInterface): Promise<Peer[]> => {
  const { exitCode, stdout } = await $.process.run(['claude', 'agents', '--json'])

  return exitCode === 0 ? (JSON.parse(stdout) as Peer[]) : []
}

const brief = (parent: string, task: string) =>
  [
    `You are a Claude Code session started by the session "${parent}" to do the task below.`,
    '',
    task,
    '',
    `When you finish, or get blocked, send your result to "${parent}" with SendMessage (one message, result first).`,
    `Later messages from "${parent}" are follow-ups to this task.`,
  ].join('\n')

const launch = async (
  $: EngineInterface,
  launcher: Launcher,
  { name, cwd, model, mode }: Spawn,
  text: string,
): Promise<string> => {
  const sessionArgs = [
    ...(model ? ['--model', model] : []),
    ...(mode && SHARED_MODES.has(mode) ? ['--permission-mode', mode] : []),
  ]

  if (launcher === 'bg') {
    const argv = [...CLEAN_ENV, 'claude', '--bg', '-n', name, ...sessionArgs, text]
    const ran = await $.process.run(argv, { cwd, timeoutMs: 60_000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr || ran.stdout)

    return `${ran.stdout.trim()} (open it with: claude attach <id>)`
  }

  if (launcher === 'tmux') {
    const command = [...CLEAN_ENV, 'claude', '-n', name, ...sessionArgs, text]
    const dir = cwd ?? (await $.session.cwd())
    const inWindow = await $.process.run(['tmux', 'new-window', '-d', '-c', dir, '-n', name, ...command])
    if (inWindow.exitCode === 0) return `tmux window "${name}"`
    const inSession = await $.process.run(['tmux', 'new-session', '-d', '-s', 'claude-sessions', '-c', dir, '-n', name, ...command])
    if (inSession.exitCode !== 0) throw new Error(inSession.stderr)

    return `tmux session "claude-sessions", window "${name}" (tmux attach -t claude-sessions)`
  }

  // headless: a claude -p session that keeps reading stream-json from a stdin
  // that never closes, so it stays alive and reachable between messages.
  const log = `${(await $.env.get('TMPDIR')) ?? '/tmp'}/claude-session-${name}.jsonl`.replace('//', '/')
  const first = JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
  const command = [
    ...CLEAN_ENV, 'claude', '-p', '-n', name, ...sessionArgs,
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ]
  const script = [
    'log="$1"; first="$2"; shift 2',
    'detach=; command -v setsid >/dev/null 2>&1 && detach=setsid',
    `$detach nohup sh -c '{ printf "%s\\n" "$0"; exec tail -f /dev/null; } | "$@"' "$first" "$@" > "$log" 2>&1 < /dev/null &`,
  ].join('\n')
  const ran = await $.process.run(['sh', '-c', script, 'sh', log, first, ...command], { cwd })
  if (ran.exitCode !== 0) throw new Error(ran.stderr)

  return `headless, log at ${log}`
}

const refresh = async ($: EngineInterface) => {
  const listed = await peers($)
  await update($, live, () =>
    Object.fromEntries(listed.flatMap(peer => (peer.name ? [[peer.name, peer.status ?? 'running']] : []))),
  )

  return listed
}

export const register: Register = (on, options) => {
  const launcher = (options.launcher ?? 'bg') as Launcher
  let mode: string | undefined

  on('classic.UserPromptSubmit', ($, e, next) => {
    mode = e.permission_mode

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description: [
        'Start a new, separate Claude Code session and hand it a task. It is a full session with its own context, tools and transcript, not a subagent, and it keeps running after this call returns.',
        'It reports back to you with SendMessage. Talk to it with SendMessage({ to: name }); add notify_when_idle: true to hear when it finishes a turn. ListAgents shows it while it runs.',
        'Use it for long or independent pieces of work that deserve their own session; use the Agent tool for quick lookups.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short kebab-case name, which becomes its address for SendMessage' },
          task: { type: 'string', description: 'Everything the session needs to do the work' },
          cwd: { type: 'string', description: 'Directory to run in; this session\'s when left out' },
          model: { type: 'string', description: 'Model alias or name; the default when left out' },
        },
        required: ['name', 'task'],
      },
    })
    await $.command.register({ name: 'sessions', description: 'Show the sessions this session started' })
    $.clock.every(5_000, async () => {
      if ((await read($, spawned)).length > 0) await refresh($)
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__sessions__spawn_session' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const spawn: Spawn = {
      name: String(args.name ?? ''),
      task: String(args.task ?? ''),
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      model: typeof args.model === 'string' ? args.model : undefined,
      mode,
    }
    if (!NAME.test(spawn.name)) return { deny: 'name must be kebab-case: lowercase letters, digits and dashes, up to 40.' }
    if (spawn.task.trim() === '') return { deny: 'task is empty.' }

    const sessionId = await $.session.id()
    const before = await peers($)
    if (before.some(peer => peer.name === spawn.name)) {
      return { deny: `A session named "${spawn.name}" is already running; pick another name or message it.` }
    }
    const parent = before.find(peer => peer.sessionId === sessionId)?.name
    if (parent === undefined) return { deny: 'This session is not in the local session registry, so a new session could not reply to it.' }

    let hint: string
    try {
      hint = await launch($, launcher, spawn, brief(parent, spawn.task))
    } catch (error) {
      return { deny: `Could not start "${spawn.name}" (${launcher}): ${error instanceof Error ? error.message : String(error)}` }
    }
    const started: Spawned = { name: spawn.name, launcher, startedAt: await $.clock.now(), hint }
    await update($, spawned, list => [...list.filter(one => one.name !== spawn.name), started])

    // Wait for the new session to register its messaging socket, so the model's
    // first SendMessage to it lands. process.run waits are off the hook's budget.
    let isReachable = false
    for (let attempt = 0; attempt < 20 && !isReachable; attempt += 1) {
      isReachable = (await refresh($)).some(peer => peer.name === spawn.name)
      if (!isReachable) await $.process.run(['sleep', '1'])
    }
    $.ui.toast(`Started session ${spawn.name}`)

    return {
      result: [
        `Started Claude Code session "${spawn.name}" (${hint}).`,
        isReachable
          ? `It is registered and reachable: SendMessage({ to: "${spawn.name}" }). It will report back to "${parent}" when done.`
          : 'It has not registered yet; check ListAgents before messaging it.',
      ].join('\n'),
    }
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Sessions started here' })

    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, spawned)
    const status = await read($, live)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No sessions started yet.</Text>}
        {list.map(session => (
          <Box flexDirection="column">
            <Text bold>
              {session.name} <Text dimColor>{status[session.name] ?? 'exited'}</Text>
            </Text>
            <Text dimColor>{session.hint}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
