/** The usage figures the band draws from, as the last measurement left them. */
export type Meter = {
  percent: number | null
  tokens: number | null
  window: number
  usd: number | null
}

/** What the hooks module hands Clawd's surface module on every redraw. */
export type ClawdProps = {
  percent: number | null
  usage: string
  cost: string | null
  isWorking: boolean
  isHigh: boolean
  columns: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { meter: Meter | null }
  }
}
