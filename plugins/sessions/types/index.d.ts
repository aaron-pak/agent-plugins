export type Spawned = {
  name: string
  launcher: string
  startedAt: number
  hint: string
  worktree?: string
  lastReport?: string
  reportedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    sessions: { spawned: Spawned[]; live: Record<string, string> }
  }
}
