/** The band's looks; `/band` switches between them. */
export type BandStyle = 'cozy' | 'trail' | 'peek'

/** One todo, from TodoWrite or the Task tools. */
export type Todo = { id: string; subject: string; activeForm: string | null; status: 'pending' | 'in_progress' | 'completed' }

/** What a running tool is doing, in a few words: `Editing` `register.tsx`. */
export type Activity = { id: string; verb: string; target: string }

export type LastTurn = { seconds: number; tools: number; files: number; isError: boolean }

export type Limit = { kind: string; percent: number; resetsAt: string | null }

/** Everything the band knows about the session, kept in `$.state`. */
export type Info = {
  model: string | null
  project: string | null
  branch: string | null
  dirty: number | null
  percent: number | null
  tokens: number | null
  window: number | null
  usd: number | null
  limit: Limit | null
  startedAt: number | null
  lastActiveAt: number | null
  activity: Activity | null
  lastTurn: LastTurn | null
  todos: Todo[]
  cheers: number
  oops: number
}

/** What the hooks module hands the band's surface module: text already formatted. */
export type BandProps = {
  style: BandStyle
  columns: number
  isWorking: boolean
  isHigh: boolean
  model: string | null
  place: string | null
  dirty: number | null
  percent: number | null
  usage: string | null
  cost: string | null
  limit: { label: string; percent: number; resets: string | null } | null
  elapsedMs: number | null
  idleMs: number | null
  activity: string | null
  lastTurn: LastTurn | null
  todos: { done: number; total: number; current: string | null } | null
  cheers: number
  oops: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-band': { info: Info; style: BandStyle }
  }
}
