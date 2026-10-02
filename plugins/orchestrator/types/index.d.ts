export type Worker = {
  name: string
  launcher: string
  startedAt: number
  hint: string
}

declare module 'claude-code' {
  interface PluginState {
    orchestrator: { workers: Worker[]; live: Record<string, string> }
  }
}
