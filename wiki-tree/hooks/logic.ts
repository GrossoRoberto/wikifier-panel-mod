import type { Filter, Flag, TreeNode } from '../types'

export type Severity = 'ok' | 'recent' | 'warning' | 'error'
export type Row = {
  node: TreeNode
  level: number
  severity: Severity
  open: boolean
  count: number
}
export type ReportKind = 'check' | 'status' | 'audit'
export type Message = { role: 'user' | 'assistant'; text: string }

export const ORANGE = '#ff8c00'
const ORDER: Record<Severity, number> = { ok: 0, recent: 1, warning: 2, error: 3 }

/** Value of a frontmatter key of infowiki.md ("key: value"). */
export function readKey(text: string, name: string): string {
  const line = text.split(/\r?\n/).find(l => l.startsWith(`${name}:`))
  return line === undefined ? '' : line.slice(name.length + 1).trim()
}

// --- Recognising a check / audit / status report in the chat ---------------------------
// The wikifier skill answers in the language set in infowiki.md, so every label is matched
// in English and Italian.

const RE_AUDIT = /^\W*Audit\s+\d{4}-\d{2}-\d{2}/mi
const RE_STATE = /^\W*(State|Stato)\s*:\s*S[0-4]\b/mi
const RE_ROOT = /^\W*(Root|Radice)\s*:/mi
const RE_STATUS_TITLE = /[—-]\s*(state|stato)\s*S[0-4]\b/i
const RE_PAGES = /^\W*(Pages|Pagine)\s*:/mi

/** Says which kind of report a text is, or null if it has the structure of none. */
export function detectReport(text: string): ReportKind | null {
  if (RE_AUDIT.test(text)) return 'audit'
  if (RE_STATE.test(text) && RE_ROOT.test(text)) return 'check'
  if (RE_STATUS_TITLE.test(text) && RE_PAGES.test(text)) return 'status'

  return null
}

/**
 * Walks the chat from the end and returns the text of the first (most recent) assistant
 * message that has the structure of a report. A sentence that merely names "wiki-check"
 * does not count: the structure of the report does.
 */
export function findReport(
  messages: readonly Message[],
): { kind: ReportKind; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined || m.role !== 'assistant' || m.text === '') continue
    const kind = detectReport(m.text)
    if (kind !== null) return { kind, text: m.text }
  }

  return null
}

// --- From the report lines to the flagged pages ---------------------------------------
// CONTRADDIZIONE and DA VERIFICARE are literal markers written by the wikifier skill into
// wiki pages (whatever the wiki language), so they are matched next to their English forms.

const RE_ERROR =
  /❌|NOT_FOUND|FILE_MISSING|POSSIBLE_CONTRADICTION|CONTRADICTION|CONTRADDIZIONE|MALFORMED|OUTSIDE_ROOT|WRONG_LINES|SYNTHESIS_UNSUPPORTED/
const RE_WARNING =
  /⚠|UNCITED|OVERREACH|UNRELATED|STALE\?|MISSING_LINK\?|GAP\?|SYNTHESIS_WEAK|DA VERIFICARE|TO BE VERIFIED|TO BE TESTED|TO BE CHECKED|TO VERIFY|[Oo]rfan|[Oo]rphan/
const RE_PATH = /[\w.\-/\\]+\.md/g

function classifyLine(line: string): 'error' | 'warning' | 'ok' | null {
  // A line starting with ✅ is ok even if it names a problem ("✅ 11 no orphan page").
  if (/^\W*✅/.test(line)) return 'ok'
  if (RE_ERROR.test(line)) return 'error'
  if (RE_WARNING.test(line)) return 'warning'

  return null
}

const REASON_MAX = 180
// A zero count ("NOT_FOUND 0") and a sentence that starts with a negation flag nothing.
const RE_ZERO_COUNT = /\b[A-Z][A-Z_]+\??\s+0\b/g
const RE_NEGATION = /^\W*(nessun[oa]?|nessuna|non|no|none|nothing)\b/i

/** Splits a line into sentences: after a period followed by a space, after ";", and on the " | " separator. */
export function splitSentences(line: string): string[] {
  return line
    .split(/\.\s+(?=\S)|;\s+|\s\|\s/)
    .map(s => s.trim())
    .filter(s => s !== '')
}

function classifySentence(sentence: string): 'error' | 'warning' | 'ok' | null {
  if (/^\W*✅/.test(sentence)) return 'ok'
  if (RE_NEGATION.test(sentence)) return null

  return classifyLine(sentence.replace(RE_ZERO_COUNT, ''))
}

/** Finds the tree file a path written in the report refers to, if it is only one. */
export function resolvePath(token: string, paths: readonly string[]): string | null {
  const t = token.replace(/\\/g, '/').replace(/^\.\//, '')
  if (paths.includes(t)) return t
  const candidates = paths.filter(p => t.endsWith(`/${p}`) || p.endsWith(`/${t}`))

  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

const BEFORE_PATH = /[\w./\\-]/
const AFTER_PATH = /[\w/\\-]/

/**
 * The tree files named in a line. It first looks for whole tree paths (also with spaces in
 * the name: a file called "a b.md" must not be read as "b.md"), then, on the rest of the
 * line, for partial paths or bare names, resolved only if unique.
 */
export function namedPaths(line: string, paths: readonly string[]): string[] {
  let rest = line.replace(/`/g, '').replace(/\\/g, '/')
  const found: string[] = []

  for (const p of [...paths].sort((a, b) => b.length - a.length)) {
    let from = 0
    for (;;) {
      const i = rest.indexOf(p, from)
      if (i < 0) break
      from = i + p.length
      const before = i === 0 ? '' : (rest[i - 1] ?? '')
      const after = rest[i + p.length] ?? ''
      if (BEFORE_PATH.test(before) || AFTER_PATH.test(after)) continue
      if (!found.includes(p)) found.push(p)
      rest = rest.slice(0, i) + ' '.repeat(p.length) + rest.slice(i + p.length)
    }
  }

  for (const token of rest.match(RE_PATH) ?? []) {
    const p = resolvePath(token, paths)
    if (p !== null && !found.includes(p)) found.push(p)
  }

  return found
}

/**
 * A line with a signal (❌, ⚠, audit status) = severity for the paths named on the line and
 * on the indented or bulleted lines that follow it, up to an empty line or a new heading.
 */
export function parseFlags(text: string, paths: readonly string[]): Record<string, Flag> {
  const result: Record<string, Flag> = {}
  let current: 'error' | 'warning' | null = null

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      current = null
      continue
    }
    // Each sentence of the line is judged on its own: "NOT_FOUND 0" or "No CONTRADDIZIONE block"
    // are not flags and must not colour the pages named in the sentences next to them.
    const segments = splitSentences(line)
    const verdicts = segments.map(classifySentence)
    if (verdicts[0] === 'ok') {
      current = null
      continue
    }
    const own = verdicts.filter((g): g is 'error' | 'warning' => g === 'error' || g === 'warning')
    let toApply: (('error' | 'warning') | null)[]
    if (own.length > 0) {
      current = own.includes('error') ? 'error' : 'warning'
      toApply = verdicts.map(g => (g === 'error' || g === 'warning' ? g : null))
    } else if (/^\s+|^\s*[-*•]/.test(line)) {
      toApply = segments.map(() => current)
    } else {
      current = null
      continue
    }

    segments.forEach((sentence, i) => {
      const severity = toApply[i]
      if (severity === null || severity === undefined) return
      for (const p of namedPaths(sentence, paths)) {
        const prev = result[p]
        const reason = sentence.trim().slice(0, REASON_MAX)
        if (prev === undefined) {
          result[p] = { severity, reasons: [reason] }
        } else {
          if (!prev.reasons.includes(reason)) prev.reasons.push(reason)
          if (severity === 'error') prev.severity = 'error'
        }
      }
    })
  }

  return result
}

/**
 * The text to put in the message box to ask how to fix a flagged page: reasons without
 * duplicates, at most 5, and the request to propose before changing anything.
 */
export function fixInstruction(path: string, reasons: readonly string[]): string {
  const unique = [...new Set(reasons.map(r => r.replace(/^[-*•\s]+/, '').trim()))]
  const list = unique.slice(0, 5).map((r, i) => `${i + 1}. ${r}`)
  const rest = unique.length > 5 ? [`(${unique.length - 5} more flags omitted)`] : []

  return [
    `Propose how to fix the flags on ${path}, without changing anything until I approve:`,
    ...list,
    ...rest,
  ].join('\n')
}

// --- Severity and tree rows ------------------------------------------------------------

export function worse(a: Severity, b: Severity): Severity {
  return ORDER[a] >= ORDER[b] ? a : b
}

/** A file is "recent" if you have not seen it yet or it changed after your last visit. */
export function fileSeverity(
  n: TreeNode,
  flags: Record<string, Flag>,
  seen: Record<string, number>,
): Severity {
  const f = flags[n.path]
  if (f !== undefined) return f.severity
  const last = seen[n.path]

  return last === undefined || n.mtime > last ? 'recent' : 'ok'
}

export function nodeSeverity(
  n: TreeNode,
  flags: Record<string, Flag>,
  seen: Record<string, number>,
): Severity {
  if (!n.dir) return fileSeverity(n, flags, seen)

  return n.children.reduce<Severity>((s, c) => worse(s, nodeSeverity(c, flags, seen)), 'ok')
}

export function countFiles(n: TreeNode): number {
  return n.dir ? n.children.reduce((sum, c) => sum + countFiles(c), 0) : 1
}

export function treeFiles(tree: readonly TreeNode[]): TreeNode[] {
  return tree.flatMap(n => (n.dir ? treeFiles(n.children) : [n]))
}

export function summarize(
  tree: readonly TreeNode[],
  flags: Record<string, Flag>,
  seen: Record<string, number>,
): Record<Severity, number> {
  const total: Record<Severity, number> = { ok: 0, recent: 0, warning: 0, error: 0 }
  for (const f of treeFiles(tree)) total[fileSeverity(f, flags, seen)]++

  return total
}

/** Not seen yet, or changed after the last visit (independent of the flags). */
export function isRecent(n: TreeNode, seen: Record<string, number>): boolean {
  const last = seen[n.path]

  return last === undefined || n.mtime > last
}

/** The tree reduced to the files that pass the filter; folders left empty disappear. */
export function filterTree(
  tree: readonly TreeNode[],
  filter: Filter,
  flags: Record<string, Flag>,
  seen: Record<string, number>,
): TreeNode[] {
  if (filter === 'all') return [...tree]
  const passes = (n: TreeNode): boolean =>
    filter === 'recent' ? isRecent(n, seen) : flags[n.path] !== undefined
  const prune = (nodes: readonly TreeNode[]): TreeNode[] =>
    nodes.flatMap(n => {
      if (!n.dir) return passes(n) ? [n] : []
      const children = prune(n.children)

      return children.length === 0 ? [] : [{ ...n, children }]
    })

  return prune(tree)
}

function openByDefault(n: TreeNode): boolean {
  return n.path === 'wiki' || n.path.startsWith('wiki/')
}

/** The rows to draw: closed folders hide their children. */
export function flatten(
  tree: readonly TreeNode[],
  expanded: Record<string, boolean>,
  flags: Record<string, Flag>,
  seen: Record<string, number>,
  allOpen = false,
): Row[] {
  const rows: Row[] = []
  const visit = (nodes: readonly TreeNode[], level: number): void => {
    for (const n of nodes) {
      const open = n.dir && (allOpen || (expanded[n.path] ?? openByDefault(n)))
      rows.push({
        node: n,
        level,
        severity: nodeSeverity(n, flags, seen),
        open,
        count: n.dir ? countFiles(n) : 0,
      })
      if (open) visit(n.children, level + 1)
    }
  }
  visit(tree, 0)

  return rows
}

export function symbol(s: Severity): string {
  return s === 'error' ? '✖' : s === 'warning' ? '▲' : s === 'recent' ? '●' : '·'
}

export function severityColor(s: Severity): string | undefined {
  return s === 'error'
    ? 'error'
    : s === 'warning'
      ? ORANGE
      : s === 'recent'
        ? 'success'
        : undefined
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatDate(ms: number): string {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function formatTime(ms: number): string {
  const d = new Date(ms)

  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
