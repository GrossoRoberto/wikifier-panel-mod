import { expect, test } from 'claude-code/testing'

import type { TreeNode } from '../types'
import {
  detectReport,
  filterTree,
  findReport,
  fixInstruction,
  flatten,
  isRecent,
  namedPaths,
  parseFlags,
  readKey,
  resolvePath,
  splitSentences,
  summarize,
  worse,
} from './logic'

const f = (path: string, mtime = 100): TreeNode => ({
  name: path.split('/').pop() ?? path,
  path,
  dir: false,
  mtime,
  children: [],
})
const d = (path: string, children: TreeNode[]): TreeNode => ({
  name: path.split('/').pop() ?? path,
  path,
  dir: true,
  mtime: 0,
  children,
})

const TREE: TreeNode[] = [
  f('index.md'),
  f('log.md'),
  d('wiki', [
    d('wiki/mod', [f('wiki/mod/a.md'), f('wiki/mod/b.md', 500)]),
    d('wiki/skill', [f('wiki/skill/a.md')]),
  ]),
  d('raw', []),
]
const PATHS = ['index.md', 'log.md', 'wiki/mod/a.md', 'wiki/mod/b.md', 'wiki/skill/a.md']

const CHECK_EN = `State: S3 — wiki out of sync
Root: Z:\\wiki-root
✅ checks 1-4
⚠️ 5 pages not in index:
  - wiki/mod/b.md
❌ 6 broken link in index: wiki/skill/a.md
✅ checks 7-10
Next step: wiki-check err`

const CHECK_IT = `Stato: S3 — wiki da riallineare
Radice: Z:\\wiki-root
✅ controlli 1-4
⚠️ 5 pagine non in index:
  - wiki/mod/b.md
❌ 6 link rotto in index: wiki/skill/a.md
✅ controlli 7-10
Prossimo passo: wiki-check err`

test('readKey: reads the infowiki.md frontmatter', async () => {
  const t = '---\nproject_name: X\npath: Z:\\a b\\wiki-root\npath_alt:\n---\n'
  expect(readKey(t, 'path')).toBe('Z:\\a b\\wiki-root')
  expect(readKey(t, 'path_alt')).toBe('')
  expect(readKey(t, 'missing')).toBe('')
})

test('detectReport: check, status, audit (English and Italian); not a sentence that names the command', async () => {
  expect(detectReport(CHECK_EN)).toBe('check')
  expect(detectReport(CHECK_IT)).toBe('check')
  expect(detectReport('MyProject — state S4\nPages: 7 (skill: 4)\nOperations: x')).toBe('status')
  expect(detectReport('CondivisionePC — stato S4\nPagine: 7 (skill: 4)\nOperazioni: x')).toBe('status')
  expect(detectReport('Audit 2026-10-11 — scope: all — 7 pages')).toBe('audit')
  expect(detectReport('I suggest running wiki-check, then wiki-audit.')).toBe(null)
  expect(detectReport('Ti consiglio di lanciare wiki-check, poi wiki-audit.')).toBe(null)
  expect(detectReport('')).toBe(null)
})

test('findReport: takes the most recent, ignores the user and generic sentences', async () => {
  const messages = [
    { role: 'assistant' as const, text: 'Audit 2026-10-01 — scope: all' },
    { role: 'user' as const, text: 'wiki-check' },
    { role: 'assistant' as const, text: CHECK_EN },
    { role: 'assistant' as const, text: 'Done, shall I fix it?' },
  ]
  expect(findReport(messages)?.kind).toBe('check')
  expect(findReport([{ role: 'user' as const, text: CHECK_EN }])).toBe(null)
  expect(findReport([])).toBe(null)
})

test('resolvePath: exact path, with prefix, bare name if unique', async () => {
  expect(resolvePath('wiki/mod/a.md', PATHS)).toBe('wiki/mod/a.md')
  expect(resolvePath('wiki-root/wiki/mod/b.md', PATHS)).toBe('wiki/mod/b.md')
  expect(resolvePath('b.md', PATHS)).toBe('wiki/mod/b.md')
  expect(resolvePath('a.md', PATHS)).toBe(null)
  expect(resolvePath('index.md', PATHS)).toBe('index.md')
  expect(resolvePath('does-not-exist.md', PATHS)).toBe(null)
})

test('parseFlags: warning and error, indented lines inherit, ✅ resets (English and Italian)', async () => {
  for (const check of [CHECK_EN, CHECK_IT]) {
    const s = parseFlags(check, PATHS)
    expect(s['wiki/mod/b.md']?.severity).toBe('warning')
    expect(s['wiki/skill/a.md']?.severity).toBe('error')
    expect(s['index.md']).toBe(undefined)
  }
})

test('parseFlags: audit statuses', async () => {
  const audit = `Audit 2026-10-11 — scope: all
Mechanical: OK 3 | NOT_FOUND 0

wiki/mod/a.md [^1] OVERREACH — the sentence says more
wiki/skill/a.md [^2] NOT_FOUND — quote missing`
  const s = parseFlags(audit, PATHS)
  expect(s['wiki/mod/a.md']?.severity).toBe('warning')
  expect(s['wiki/skill/a.md']?.severity).toBe('error')
})

test('severity: error > warning > recent > ok, folders take the worst', async () => {
  expect(worse('ok', 'recent')).toBe('recent')
  expect(worse('error', 'warning')).toBe('error')
  const seen = {
    'index.md': 100,
    'log.md': 100,
    'wiki/mod/a.md': 100,
    'wiki/mod/b.md': 100,
    'wiki/skill/a.md': 100,
  }
  // b.md was modified (500) after the last visit (100): recent.
  const totals = summarize(TREE, {}, seen)
  expect(totals).toEqual({ ok: 4, recent: 1, warning: 0, error: 0 })
  const flags = { 'wiki/skill/a.md': { severity: 'error' as const, reasons: ['x'] } }
  const rows = flatten(TREE, {}, flags, seen)
  expect(rows.find(r => r.node.path === 'wiki')?.severity).toBe('error')
  expect(rows.find(r => r.node.path === 'wiki/mod')?.severity).toBe('recent')
})

test('flatten: wiki open by default, raw closed, click on folders', async () => {
  const seen = {}
  const open = flatten(TREE, {}, {}, seen).map(r => r.node.path)
  expect(open).toContain('wiki/mod/a.md')
  const closed = flatten(TREE, { 'wiki/mod': false }, {}, seen).map(r => r.node.path)
  expect(closed).toContain('wiki/mod')
  expect(closed).not.toContain('wiki/mod/a.md')
  expect(closed).toContain('wiki/skill/a.md')
})

test('files never seen are recent', async () => {
  expect(summarize(TREE, {}, {}).recent).toBe(5)
})

test('isRecent: not seen, or changed after the last visit', async () => {
  expect(isRecent(f('x.md', 500), { 'x.md': 100 })).toBe(true)
  expect(isRecent(f('x.md', 100), { 'x.md': 100 })).toBe(false)
  expect(isRecent(f('x.md', 100), {})).toBe(true)
})

test('filterTree: all keeps the tree, recent and flagged prune files and empty folders', async () => {
  const seen = {
    'index.md': 100,
    'log.md': 100,
    'wiki/mod/a.md': 100,
    'wiki/mod/b.md': 100,
    'wiki/skill/a.md': 100,
  }
  expect(filterTree(TREE, 'all', {}, seen).length).toBe(TREE.length)

  const recent = filterTree(TREE, 'recent', {}, seen)
  expect(recent.map(n => n.path)).toEqual(['wiki'])
  const wiki = recent[0]
  expect(wiki?.children.map(n => n.path)).toEqual(['wiki/mod'])
  expect(wiki?.children[0]?.children.map(n => n.path)).toEqual(['wiki/mod/b.md'])

  const flags = { 'wiki/skill/a.md': { severity: 'warning' as const, reasons: ['x'] } }
  const flagged = filterTree(TREE, 'flagged', flags, seen)
  expect(flagged[0]?.children.map(n => n.path)).toEqual(['wiki/skill'])
  expect(filterTree(TREE, 'flagged', {}, seen)).toEqual([])
})

test('namedPaths: names with spaces, prefixed paths, no double counting', async () => {
  const paths = [...PATHS, 'wiki/mod/install-and-share mod.md']
  const line = '⚠️ 8 name with a space: `wiki/mod/install-and-share mod.md`'
  expect(namedPaths(line, paths)).toEqual(['wiki/mod/install-and-share mod.md'])
  // the broken link (with the hyphen) is not in the tree and "index.md" in the line is: only index.md
  const broken = '❌ 6 link of index.md that does not resolve: `wiki/mod/install-and-share-mod.md`'
  expect(namedPaths(broken, paths)).toEqual(['index.md'])
  // "index.md" inside a longer path does not count as the root file
  expect(namedPaths('⚠️ wiki/skill/index.md', [...paths, 'wiki/skill/index.md'])).toEqual([
    'wiki/skill/index.md',
  ])
  // punctuation after the name: valid
  expect(namedPaths('❌ log.md, wiki/mod/a.md.', paths)).toEqual(['wiki/mod/a.md', 'log.md'])
  // root prefix in front: resolves as before
  expect(namedPaths('⚠️ wiki-root/wiki/mod/b.md', paths)).toEqual(['wiki/mod/b.md'])
})

test('parseFlags: a page with a space in its name is flagged', async () => {
  const paths = [...PATHS, 'wiki/mod/install-and-share mod.md']
  const report = `State: S3 — index out of sync
Root: Z:\\wiki-root
⚠️ 5 page not in index.md: \`wiki/mod/install-and-share mod.md\`
❌ 6 broken link: \`wiki/mod/install-and-share-mod.md\`
✅ 9 log ok`
  const s = parseFlags(report, paths)
  expect(s['wiki/mod/install-and-share mod.md']?.severity).toBe('warning')
  expect(s['index.md']?.severity).toBe('warning')
})

test('parseFlags: a ✅ line that names a problem flags nothing', async () => {
  const report = `State: S4 — healthy wiki
Root: Z:\\wiki-root
✅ 11 no orphan page, no error in wiki/mod/a.md
✅ 6 no broken link in index.md`
  expect(parseFlags(report, PATHS)).toEqual({})
})

test('parseFlags: "NOT_FOUND 0" and "No CONTRADICTION block" / "Nessun blocco CONTRADDIZIONE" flag nothing', async () => {
  const lastLine = '- wiki/skill/a.md POSSIBLE_CONTRADICTION: says something different'
  const audits = [
    `Audit 2026-10-11 — scope: whole wiki
Mechanical: OK 65 | NOT_FOUND 0 | FILE_MISSING 0 | MALFORMED 0
Pages with open items (\`DA VERIFICARE\`, 3 lines): \`wiki/mod/a.md\` 2, \`wiki/mod/b.md\` 1. No \`CONTRADDIZIONE\` block open.

${lastLine}`,
    `Audit 2026-10-11 — scope: tutta la wiki
Mechanical: OK 65 | NOT_FOUND 0 | FILE_MISSING 0 | MALFORMED 0
Pagine con elementi aperti (\`DA VERIFICARE\`, 3 righe): \`wiki/mod/a.md\` 2, \`wiki/mod/b.md\` 1. Nessun blocco \`CONTRADDIZIONE\` aperto.

${lastLine}`,
  ]
  for (const audit of audits) {
    const s = parseFlags(audit, PATHS)
    expect(s['wiki/mod/a.md']?.severity).toBe('warning')
    expect(s['wiki/mod/b.md']?.severity).toBe('warning')
    expect(s['wiki/skill/a.md']?.severity).toBe('error')
    expect(Object.keys(s).length).toBe(3)
  }
})

test('parseFlags: English orphan and "TO BE VERIFIED / TESTED / CHECKED" are warnings', async () => {
  const s = parseFlags(
    'Orphan page: wiki/mod/a.md\nTO BE VERIFIED in wiki/mod/b.md\nTO BE TESTED in wiki/skill/a.md\nTO BE CHECKED in log.md',
    PATHS,
  )
  expect(s['wiki/mod/a.md']?.severity).toBe('warning')
  expect(s['wiki/mod/b.md']?.severity).toBe('warning')
  expect(s['wiki/skill/a.md']?.severity).toBe('warning')
  expect(s['log.md']?.severity).toBe('warning')
})

test('parseFlags: a summary at zero does not pass severity to the following lines', async () => {
  const audit = `Mechanical: OK 3 | NOT_FOUND 0
  - wiki/mod/a.md [^1]: any text`
  expect(parseFlags(audit, PATHS)).toEqual({})
})

test('splitSentences: period+space, semicolon, vertical bar; not the dots in file names', async () => {
  expect(splitSentences('One. Two; three | four')).toEqual(['One', 'Two', 'three', 'four'])
  expect(splitSentences('see wiki/mod/a.md and index.md: ok')).toEqual(['see wiki/mod/a.md and index.md: ok'])
})

test('fixInstruction: numbered list without duplicates, at most 5, asks to propose first', async () => {
  const reasons = ['- one', 'one', 'two', 'three', 'four', 'five', 'six']
  const t = fixInstruction('wiki/mod/a.md', reasons)
  expect(t).toContain('without changing anything')
  expect(t).toContain('1. one')
  expect(t).toContain('5. five')
  expect(t).not.toContain('6. six')
  expect(t).toContain('1 more flags omitted')
})

test('flatten: with an active filter all folders are open', async () => {
  const seen = {}
  const pruned = filterTree(TREE, 'recent', {}, seen)
  const rows = flatten(pruned, { wiki: false }, {}, seen, true).map(r => r.node.path)
  expect(rows).toContain('wiki/mod/a.md')
})
