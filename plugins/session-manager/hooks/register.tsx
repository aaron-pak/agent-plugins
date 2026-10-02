import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Spawned } from '../types'

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
// Sessions in different permission modes hold each other's messages for the
// person's approval, so a new session takes its parent's mode when it is one
// of these. Plan and bypass stay the new session's own choice.
const SHARED_MODES = new Set(['acceptEdits', 'auto'])

type Launcher = 'bg' | 'tmux' | 'headless'

// One row of `claude agents --json`, the registry ListAgents reads. A
// background session has a short `id`; `--all` adds stopped ones, with no pid.
type Peer = {
  sessionId: string
  id?: string
  name?: string
  kind?: string
  pid?: number | null
  status?: string | null
  state?: string | null
}

type Launch = {
  name: string
  cwd?: string
  model?: string
  mode?: string
  worktree: boolean
  forkOf?: string
}

const run = async ($: EngineInterface, argv: readonly string[], cwd?: string) => {
  const ran = await $.process.run(argv, { cwd, timeoutMs: 60_000 })
  if (ran.exitCode !== 0) throw new Error((ran.stderr || ran.stdout).trim())

  return ran.stdout
}

const peers = async ($: EngineInterface, { all = false } = {}): Promise<Peer[]> => {
  const ran = await $.process.run(['claude', 'agents', '--json', ...(all ? ['--all'] : [])])
  if (ran.exitCode !== 0) return []
  try {
    return JSON.parse(ran.stdout) as Peer[]
  } catch {
    return []
  }
}

// Waits for a session to register under its name, so a SendMessage to it
// lands. process.run waits are off the calling hook's budget; clock sleeps are not.
const waitFor = async ($: EngineInterface, name: string): Promise<Peer | undefined> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = (await peers($)).find(peer => peer.name === name)
    if (found) return found
    await $.process.run(['sleep', '1'])
  }

  return undefined
}

const inGitRepo = async ($: EngineInterface, dir: string) =>
  (await $.process.run(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'])).exitCode === 0

const launch = async ($: EngineInterface, launcher: Launcher, spec: Launch, brief: string): Promise<string> => {
  const { name, cwd, model, mode } = spec
  const sessionArgs = [
    ...(model ? ['--model', model] : []),
    ...(mode && SHARED_MODES.has(mode) ? ['--permission-mode', mode] : []),
  ]
  const worktreeArgs = spec.worktree ? ['-w', name] : []

  if (launcher === 'bg') {
    const fork = spec.forkOf ? ['--resume', spec.forkOf, '--fork-session'] : []
    const out = await run($, [...CLEAN_ENV, 'claude', '--bg', ...fork, '-n', name, ...worktreeArgs, ...sessionArgs, brief], cwd)
    const id = /backgrounded · (\S+)/.exec(out)?.[1]

    return id ? `background session ${id}, open it with: claude attach ${id}` : out.trim()
  }

  if (launcher === 'tmux') {
    const command = [...CLEAN_ENV, 'claude', '-n', name, ...worktreeArgs, ...sessionArgs, brief]
    const dir = cwd ?? (await $.session.cwd())
    const inWindow = await $.process.run(['tmux', 'new-window', '-d', '-c', dir, '-n', name, ...command])
    if (inWindow.exitCode === 0) return `tmux window "${name}"`
    await run($, ['tmux', 'new-session', '-d', '-s', 'claude-sessions', '-c', dir, '-n', name, ...command])

    return `tmux session "claude-sessions", window "${name}" (tmux attach -t claude-sessions)`
  }

  // headless: a claude -p session that keeps reading stream-json from a stdin
  // that never closes, so it stays alive and reachable between messages.
  const log = `${(await $.env.get('TMPDIR')) ?? '/tmp'}/claude-session-${name}.jsonl`.replace('//', '/')
  const first = JSON.stringify({ type: 'user', message: { role: 'user', content: brief } })
  const command = [
    ...CLEAN_ENV, 'claude', '-p', '-n', name, ...sessionArgs,
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ]
  const script = [
    'log="$1"; first="$2"; shift 2',
    'detach=; command -v setsid >/dev/null 2>&1 && detach=setsid',
    `$detach nohup sh -c '{ printf "%s\\n" "$0"; exec tail -f /dev/null; } | "$@"' "$first" "$@" > "$log" 2>&1 < /dev/null &`,
  ].join('\n')
  await run($, ['sh', '-c', script, 'sh', log, first, ...command], cwd)

  return `headless, log at ${log}`
}

// A headless session runs under an sh whose other child, tail -f /dev/null,
// never gets SIGPIPE; ending both children ends the sh too. The pattern check
// keeps it from touching the children of any other parent.
const HEADLESS_STOP = [
  'parent=$(ps -o ppid= -p "$1" | tr -d " ")',
  'case "$(ps -o args= -p "$parent")" in',
  '  *"tail -f /dev/null"*) pkill -P "$parent" ;;',
  '  *) kill "$1" ;;',
  'esac',
].join('\n')

// Ends the process. A background session keeps its conversation and wakes
// with `wake`; any other kind is ended by its pid.
const stop = async ($: EngineInterface, peer: Peer, launcher?: string) => {
  if (peer.kind === 'background' && peer.id) await run($, ['claude', 'stop', peer.id])
  else if (peer.pid && launcher === 'headless') await run($, ['sh', '-c', HEADLESS_STOP, 'sh', String(peer.pid)])
  else if (peer.pid) await run($, ['kill', String(peer.pid)])
}

// Deletes a background session and any worktree it has. claude rm refuses while the
// worktree holds commits that exist nowhere else, and that refusal is thrown.
const remove = async ($: EngineInterface, peer: Peer) => {
  if (peer.kind !== 'background' || !peer.id) throw new Error('only background sessions can be removed')
  if (peer.pid) await stop($, peer)

  return (await run($, ['claude', 'rm', peer.id])).trim()
}

// Restarts a stopped background session in place: the same id, conversation,
// worktree and flags. (`claude --bg --resume` would start a copy in this cwd.)
const wake = async ($: EngineInterface, peer: Peer) => {
  if (!peer.id) throw new Error('only background sessions can be woken')
  await run($, [...CLEAN_ENV, 'claude', 'respawn', peer.id])
}

const PANE = 'session-manager'
const spawned = atom({ plugin: 'session-manager', key: 'spawned' } as const, [])
const live = atom({ plugin: 'session-manager', key: 'live' } as const, {})
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
// The opening line of every brief. A session started by this mod finds its
// parent by it, in its own transcript, whichever way it was launched.
const STARTED_BY = /You were started by the Claude Code session "([^"]+)" \(id ([0-9a-f-]{36})\) as "([^"]+)"/g
const REPORT = /Report from session "([^"]+)":\n\n([\s\S]*?)(?:<\/cross-session-message>|$)/

type Parent = { name: string; sessionId: string; self: string }

const argument = (args: Record<string, unknown>, key: string) =>
  typeof args[key] === 'string' ? (args[key] as string) : undefined

const brief = (parent: Omit<Parent, 'self'>, self: string, task: string, isAutoReport: boolean) =>
  [
    `You were started by the Claude Code session "${parent.name}" (id ${parent.sessionId}) as "${self}", to do the task below.`,
    '',
    task,
    '',
    isAutoReport
      ? `Your final message of each turn is sent to "${parent.name}" automatically, so end each turn with your result, or with the question you need answered. Do not also send it with SendMessage.`
      : `When you finish, or get blocked, send your result to "${parent.name}" with SendMessage, result first.`,
    `Later messages from "${parent.name}" are follow-ups to this task.`,
  ].join('\n')

// The brief is the first thing a started session reads, so once the
// transcript has anything in it the answer is settled; memo keeps it.
const parentOf = async ($: EngineInterface, memo: { parent?: Parent | null }): Promise<Parent | undefined> => {
  if (memo.parent !== undefined) return memo.parent ?? undefined
  const messages = await $.session.messages()
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  let found: Parent | undefined
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const [, name = '', sessionId = '', self = ''] of message.text.matchAll(STARTED_BY)) found = { name, sessionId, self }
  }
  memo.parent = found ?? null

  return found
}

// Whether the sessions this one starts load this mod too, so they can report
// back on their own: settings install it for every session. This process's
// own environment does not count, since a background session gets the
// daemon's and a tmux one the tmux server's.
const loadsEverywhere = async ($: EngineInterface) => {
  const settings = await $.settings.read()
  const env = (settings.env ?? {}) as Record<string, string | undefined>
  const dirs = env.CLAUDE_CODE_PLUGIN_DIRS ?? ''
  const root = $.plugin.root.replace(/\/+$/, '')
  const enabled = Object.entries((settings.enabledPlugins ?? {}) as Record<string, unknown>)

  return (
    dirs.split(':').some(dir => dir.replace(/\/+$/, '') === root) ||
    enabled.some(([id, isOn]) => isOn === true && id.split('@')[0] === $.plugin.name)
  )
}

const describe = (peer: Peer | undefined) =>
  peer === undefined ? 'stopped' : peer.state === 'blocked' ? 'waiting for input' : (peer.status ?? 'running')

// The registry rows that are this started session: by its session id once
// known, so a later session that takes the same name is never mistaken for it.
const isSame = (one: Spawned) => (peer: Peer) => (one.sessionId ? peer.sessionId === one.sessionId : peer.name === one.name)

const wakeIfStopped = async ($: EngineInterface, one: Spawned) => {
  if ((await peers($)).some(isSame(one))) return
  const stopped = (await peers($, { all: true })).find(peer => isSame(one)(peer) && peer.kind === 'background')
  if (stopped === undefined) return
  $.ui.toast(`Waking ${one.name}`)
  await wake($, stopped)
  await waitFor($, one.name)
}

// Stop or remove one session by name: a background session, or one this
// session started. Other people's interactive sessions are left alone.
const end = async ($: EngineInterface, name: string, isRemove: boolean): Promise<string> => {
  const ours = (await read($, spawned)).find(one => one.name === name)
  const named = (await peers($, { all: true })).filter(ours ? isSame(ours) : peer => peer.name === name)
  const peer = named.find(one => one.pid) ?? named[0]
  if (peer === undefined || (peer.kind !== 'background' && ours === undefined)) {
    throw new Error(`No background session or session started here is named "${name}".`)
  }
  if (isRemove) {
    const out = await remove($, peer)
    await update($, spawned, list => list.filter(one => one.name !== name))

    return `Removed "${name}". ${out}`.trim()
  }
  if (!peer.pid) return `"${name}" is already stopped.`
  await stop($, peer, ours?.launcher)

  return `Stopped "${name}". Its conversation is kept, and a SendMessage to it wakes it.`
}

// What the idle watch remembers between ticks, and its grace in minutes.
type Watch = { stopAfterMinutes: number; idleSince: Map<string, number>; waiting: Set<string> }

// Keeps the pane and status line current, says when a session waits on a
// person, and stops background sessions that have sat idle past the grace.
// It never throws: the clock and every tool call run it.
const tick = async ($: EngineInterface, watch: Watch) => {
  const { stopAfterMinutes, idleSince, waiting } = watch
  const list = await read($, spawned)
  if (list.length === 0) {
    if (Object.keys(await read($, live)).length > 0) {
      await update($, live, () => ({}))
      $.ui.status(undefined)
    }
    return
  }
  const listed = await peers($)
  const now = await $.clock.now()
  const status: Record<string, string> = {}
  const learned = new Map<string, string>()

  for (const one of list) {
    const { name } = one
    let peer = listed.find(isSame(one))
    if (peer && !one.sessionId) learned.set(name, peer.sessionId)
    if (peer?.state === 'blocked' && !waiting.has(name)) {
      waiting.add(name)
      $.ui.toast(`${name} is waiting for input${peer.id ? `: claude attach ${peer.id}` : ''}`)
    }
    if (peer?.state !== 'blocked') waiting.delete(name)

    const isIdle = peer?.status === 'idle' && peer.state !== 'blocked'
    if (peer === undefined || !isIdle || peer.kind !== 'background' || stopAfterMinutes <= 0) {
      idleSince.delete(name)
    } else {
      const since = idleSince.get(name) ?? now
      idleSince.set(name, since)
      if (now - since >= stopAfterMinutes * 60_000) {
        idleSince.delete(name)
        try {
          await stop($, peer)
          peer = undefined
          $.ui.toast(`Stopped ${name} after ${stopAfterMinutes} idle minutes; a message to it wakes it`)
        } catch (error) {
          $.ui.log(`session-manager: could not stop ${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    status[name] = describe(peer)
  }

  if (learned.size > 0) {
    await update($, spawned, all => all.map(one => (learned.has(one.name) ? { ...one, sessionId: learned.get(one.name) } : one)))
  }
  await update($, live, () => status)
  const counts = new Map<string, number>()
  for (const one of Object.values(status)) counts.set(one, (counts.get(one) ?? 0) + 1)
  $.ui.status(`sessions: ${[...counts].map(([one, count]) => `${count} ${one}`).join(', ')}`)
}

export const register: Register = (on, options) => {
  const launcher = (options.launcher ?? 'bg') as Launcher
  const watch: Watch = { stopAfterMinutes: Number(options.stopAfterMinutes ?? 15), idleSince: new Map(), waiting: new Set() }
  const { stopAfterMinutes } = watch
  let mode: string | undefined
  // Set when this session's model sent its parent a message itself this turn.
  let hasReported = false
  const memo: { parent?: Parent | null } = {}

  on('classic.UserPromptSubmit', ($, e, next) => {
    mode = e.permission_mode

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'spawn_session',
      description: [
        'Start a new, separate Claude Code session and hand it a task. It is a full session with its own context, tools and transcript, not a subagent, and it keeps running after this call returns.',
        'Talk to it with SendMessage({ to: name }). Its result comes back to you as a message. A session idle for a while is stopped to free memory, and a SendMessage to it wakes it with its conversation intact.',
        'It works in this checkout unless worktree: true gives it its own git worktree, which keeps sessions that edit files in parallel from colliding.',
        'fork: true starts it as a copy of this conversation, so it already knows everything said here.',
        'Use it for long or independent work that deserves its own session; use the Agent tool for quick lookups.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short kebab-case name, which becomes its address for SendMessage' },
          task: { type: 'string', description: 'Everything the session needs to do the work' },
          cwd: { type: 'string', description: 'Directory to run in; this session\'s when left out' },
          model: { type: 'string', description: 'Model alias or name; the default when left out' },
          worktree: { type: 'boolean', description: 'Give it its own git worktree and branch; off by default' },
          fork: { type: 'boolean', description: 'Start it as a copy of this conversation' },
        },
        required: ['name', 'task'],
      },
    })
    await $.tool.register({
      name: 'stop_session',
      description: 'Stop a session this session started, or any background session, by name. Stopping keeps its conversation, and a SendMessage to it wakes it. remove: true also deletes it and any worktree it has, and is refused while that worktree has commits that exist nowhere else.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          remove: { type: 'boolean', description: 'Delete the session and any worktree it has instead of only stopping it' },
        },
        required: ['name'],
      },
    })
    await $.tool.register({
      name: 'list_sessions',
      description: 'List the sessions this session started, with whether each is busy, idle, waiting for input or stopped, its worktree, and its last report.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.command.register({ name: 'sessions', description: 'Show the sessions this session started' })
    $.clock.every(15_000, () => tick($, watch))

    return next(e)
  })

  on('tool.call', { tool: 'mcp__session-manager__spawn_session' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const name = argument(args, 'name') ?? ''
    const task = argument(args, 'task') ?? ''
    const cwd = argument(args, 'cwd')
    const isFork = args.fork === true
    if (!NAME.test(name)) return { deny: 'name must be kebab-case: lowercase letters, digits and dashes, up to 40.' }
    if (task.trim() === '') return { deny: 'task is empty.' }
    if (isFork && launcher !== 'bg') return { deny: 'fork needs the bg launcher.' }

    const sessionId = await $.session.id()
    const before = await peers($, { all: true })
    const taken = before.find(peer => peer.name === name)
    if (taken?.pid) return { deny: `A session named "${name}" is already running; pick another name or message it.` }
    if (taken) {
      return { deny: `A stopped session is named "${name}"; message it to wake it, remove it with stop_session, or pick another name.` }
    }
    const parentName = before.find(peer => peer.sessionId === sessionId)?.name
    if (parentName === undefined) return { deny: 'This session is not in the local session registry, so a new session could not reply to it.' }

    const worktree = args.worktree === true
    if (worktree && launcher === 'headless') return { deny: 'worktree needs the bg or tmux launcher.' }
    if (worktree && !(await inGitRepo($, cwd ?? (await $.session.cwd())))) {
      return { deny: 'worktree needs a git repository, and this directory is not in one.' }
    }
    const isAutoReport = await loadsEverywhere($)
    const text = brief({ name: parentName, sessionId }, name, task, isAutoReport)

    let hint: string
    try {
      hint = await launch($, launcher, { name, cwd, model: argument(args, 'model'), mode, worktree, forkOf: isFork ? sessionId : undefined }, text)
    } catch (error) {
      return { deny: `Could not start "${name}" (${launcher}): ${error instanceof Error ? error.message : String(error)}` }
    }
    const started: Spawned = {
      name,
      launcher,
      startedAt: await $.clock.now(),
      hint,
      ...(worktree ? { worktree: `.claude/worktrees/${name}, branch worktree-${name}` } : {}),
    }
    await update($, spawned, list => [...list.filter(one => one.name !== name), started])
    const peer = await waitFor($, name)
    if (peer) await update($, spawned, list => list.map(one => (one.name === name ? { ...one, sessionId: peer.sessionId } : one)))
    await tick($, watch)
    $.ui.toast(`Started session ${name}`)

    return {
      result: [
        `Started Claude Code session "${name}"${isFork ? ' as a fork of this conversation' : ''} (${hint}).`,
        ...(worktree ? [`It works in its own git worktree at .claude/worktrees/${name} in the repository, on branch worktree-${name}.`] : []),
        peer ? `It is reachable: SendMessage({ to: "${name}" }).` : 'It has not registered yet; check ListAgents before messaging it.',
        isAutoReport
          ? `Its final message of each turn comes back to you as a message starting "Report from session "${name}"".`
          : 'It will send you its result with SendMessage.',
        ...(launcher === 'bg' && stopAfterMinutes > 0
          ? [`After ${stopAfterMinutes} idle minutes it is stopped to free memory; a SendMessage to it wakes it.`]
          : []),
      ].join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__session-manager__stop_session' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    try {
      const result = await end($, argument(args, 'name') ?? '', args.remove === true)
      await tick($, watch)

      return { result }
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) }
    }
  })

  on('tool.call', { tool: 'mcp__session-manager__list_sessions' }, async $ => {
    await tick($, watch)
    const list = await read($, spawned)
    const status = await read($, live)
    if (list.length === 0) return { result: 'This session has not started any sessions.' }

    return {
      result: list
        .map(one =>
          [
            `${one.name}: ${status[one.name] ?? 'stopped'} (${one.hint})`,
            ...(one.worktree ? [`  worktree: ${one.worktree}`] : []),
            ...(one.lastReport ? [`  last report: ${one.lastReport.slice(0, 500)}`] : []),
          ].join('\n'),
        )
        .join('\n'),
    }
  })

  // In a session this mod started: hand the final message of each turn to the
  // parent, unless the model already messaged the parent itself.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const sentByModel = hasReported
    hasReported = false
    if (e.isAborted || sentByModel) return done
    const parent = await parentOf($, memo)
    if (parent === undefined) return done

    const answer = e.answer.trim() || (e.reason === 'error' ? '(The turn ended on an API error.)' : '(The turn ended without a final message.)')
    const sent = await $.session.send({ to: { sessionId: parent.sessionId }, text: `Report from session "${parent.self}":\n\n${answer}` })
    if (!sent.isDelivered) $.ui.log(`session-manager: could not report to ${parent.name}: ${sent.reason}`)

    return done
  })

  // A message to the parent marks the turn as already reported. A message to
  // a session started here restarts its idle time, and wakes it first if it
  // was stopped, so it lands. A reply by socket address is not counted as a
  // report: a duplicate report is better than a lost one.
  on('session.send', async ($, e, next) => {
    if (e.agentId !== undefined || (e.origin.kind === 'plugin' && e.origin.name === $.plugin.name)) return next(e)
    const target = e.to.replace(/ \[[^\]]+\]$/, '')
    const parent = await parentOf($, memo)
    if (parent && (target === parent.name || target === parent.sessionId)) {
      hasReported = true

      return next(e)
    }
    const ours = (await read($, spawned)).find(one => one.name === target)
    if (ours) {
      watch.idleSince.delete(target)
      await wakeIfStopped($, ours)
    }

    return next(e)
  })

  // A report from a session started here: keep it for the pane and say so.
  on('session.receive', async ($, e, next) => {
    const report = REPORT.exec(e.text)
    if (report) {
      const [, name = '', body = ''] = report
      const reportedAt = await $.clock.now()
      let isOurs = false
      await update($, spawned, list =>
        list.map(one => (one.name === name ? ((isOurs = true), { ...one, lastReport: body.trim(), reportedAt }) : one)),
      )
      if (isOurs) {
        watch.idleSince.delete(name)
        $.ui.toast(`${name} reported back`)
      }
    }

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await tick($, watch)
    await $.ui.open({ id: PANE, title: 'Sessions started here' })

    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, spawned)
    const status = await read($, live)
    const act = (name: string, isRemove: boolean) => async () => {
      try {
        $.ui.toast(await end($, name, isRemove))
      } catch (error) {
        $.ui.toast(error instanceof Error ? error.message : String(error))
      }
      await tick($, watch)
    }

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No sessions started yet.</Text>}
        {list.map(one => (
          <Box flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold>{one.name} </Text>
              <Text dimColor>{status[one.name] ?? 'stopped'} </Text>
              {status[one.name] !== 'stopped' && <Button key={`stop:${one.name}`} label="Stop" onPress={act(one.name, false)} />}
              {one.launcher === 'bg' && <Button key={`remove:${one.name}`} label="Remove" onPress={act(one.name, true)} />}
            </Box>
            <Text dimColor>{one.hint}</Text>
            {one.worktree && <Text dimColor>worktree: {one.worktree}</Text>}
            {one.lastReport && <Text>{one.lastReport.split('\n').slice(0, 4).join('\n')}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
