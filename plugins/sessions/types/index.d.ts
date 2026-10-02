export type Spawned = {
  name: string
  launcher: string
  startedAt: number
  hint: string
}

declare module 'claude-code' {
  interface PluginState {
    sessions: { spawned: Spawned[]; live: Record<string, string> }
  }
}
