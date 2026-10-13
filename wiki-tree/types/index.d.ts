export type TreeNode = {
  name: string
  /** Path relative to the wiki root, with "/" (e.g. "wiki/mod/page.md"). */
  path: string
  dir: boolean
  mtime: number
  children: TreeNode[]
}

export type Flag = {
  severity: 'warning' | 'error'
  reasons: string[]
}

export type Filter = 'all' | 'flagged' | 'recent'

export type ReportRead = {
  kind: 'check' | 'status' | 'audit'
  /** Time (ms) when the mod first read this report: chat messages carry no timestamps. */
  seen: number
  flags: Record<string, Flag>
}

/** A confirmation waiting in the panel: either a command to prepare, or what to do with a draft already in the message box. */
export type Pending =
  | { kind: 'command'; command: string; effect: string }
  | { kind: 'draft'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'wiki-tree': {
      root: string
      tree: TreeNode[]
      expanded: Record<string, boolean>
      seen: Record<string, number>
      selection: string | null
      filter: Filter
      report: ReportRead | null
      error: string
      tab: string
      pending: Pending | null
    }
  }
}
