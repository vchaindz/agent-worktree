export type Tracked = {
  path: string
  branch?: string
  how: 'enter' | 'entered' | 'agent' | 'bash' | 'lock'
  agentId?: string
  label?: string
  isBackground?: boolean
  at?: number
  isRunning: boolean
  isHere: boolean
  isRemoved: boolean
  toolUseId: string
}

export type Problem = { at: number; who?: string; what: string; cause: string }

export type FileChange = { status: string; path: string; isUncommitted: boolean }

export type Snap = {
  isGone: boolean
  branch?: string
  base?: string
  ahead: number
  behind: number
  dirty: number
  shortstat?: string
  lastSubject?: string
  lastAge?: string
  files: FileChange[]
}

export type Row = {
  path: string
  repo: string
  branch?: string
  head?: string
  isGone: boolean
  dirty?: number
  unpushed?: number
  lock?: 'live' | 'stale'
  hasProcess?: boolean
  isUnread?: boolean
  committedAt?: number
}

export type AgentBadge = {
  id: string
  label: string
  type: string
  lineage: string[]
  status: string
  model?: string
  tokenCount: number
  samples: number[]
  startTime: number
}

export type Grove = {
  repoOf: Record<string, string>
  others: Row[]
  rowsAt: number
  snaps: Record<string, Snap>
  agents: Record<string, AgentBadge>
  usedAt: Record<string, number>
}

export type Pull = { number: number; state: 'open' | 'merged' | 'closed'; title: string; head: string; isMine: boolean }
export type Pulls = { byPath: Record<string, Pull[]>; unknown: string[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-worktree': {
      tracked: Shaped<Tracked[]>
      grove: Shaped<Grove>
      problems: Shaped<Problem[]>
      expanded: Shaped<string[]>
      pulls: Shaped<Pulls>
    }
  }
}
