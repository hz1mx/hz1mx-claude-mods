export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
/** The first reading of a rate-limit window, to measure its burn from. */
export type Burn = { resetsAt: string; percent: number; at: number }
/** US dollars spent per local day, `YYYY-MM-DD`, across every session. */
export type Ledger = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    'session-meter': {
      startedAt: number | null
      now: number
      model: string | null
      tokens: Tokens
      usd: number | null
      lastUsd: number | null
      ledger: Ledger
      contextPercent: number | null
      contextWarned: boolean
      limits: Limit[]
      burns: Record<string, Burn>
      warned: Record<string, number>
      hidden: boolean
      autoCompact: boolean
    }
  }
}
