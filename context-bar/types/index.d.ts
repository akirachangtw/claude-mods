export type BarCategory = {
  name: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type Snapshot = {
  categories: BarCategory[]
  totalTokens: number
  maxTokens: number
  percentage: number
  threshold: number | null
}

export type StepProgress = {
  source: 'skill' | 'ticket' | 'report'
  label: string
  sections: string[]
  step: string | null
  mech: number
  reported: number
  done: number
  total: number
  paused: boolean
  calls: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: Snapshot | null
      diag: string | null
      detailsOpen: boolean
      steps: StepProgress | null
    }
  }
}
