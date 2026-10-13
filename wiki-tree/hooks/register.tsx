import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Filter, Pending, ReportRead, TreeNode } from '../types'
import {
  flatten,
  ORANGE,
  readKey,
  severityColor,
  filterTree,
  formatDate,
  formatTime,
  fixInstruction,
  parseFlags,
  summarize,
  symbol,
  findReport,
  treeFiles,
} from './logic'

const REFRESH_MS = 15_000
const PANEL = 'wiki-tree'
// Maximum scan depth per top-level folder (wiki: category/page).
const DEPTH: Record<string, number> = { wiki: 3 }

const rootAtom = atom({ plugin: 'wiki-tree', key: 'root' } as const, '')
const treeAtom = atom({ plugin: 'wiki-tree', key: 'tree' } as const, [])
const expandedAtom = atom({ plugin: 'wiki-tree', key: 'expanded' } as const, {})
const seenAtom = atom({ plugin: 'wiki-tree', key: 'seen' } as const, {})
const selectionAtom = atom({ plugin: 'wiki-tree', key: 'selection' } as const, null)
const filterAtom = atom({ plugin: 'wiki-tree', key: 'filter' } as const, 'all')
const reportAtom = atom({ plugin: 'wiki-tree', key: 'report' } as const, null)
const errorAtom = atom({ plugin: 'wiki-tree', key: 'error' } as const, '')
const tabAtom = atom({ plugin: 'wiki-tree', key: 'tab' } as const, 'panel')
const pendingAtom = atom({ plugin: 'wiki-tree', key: 'pending' } as const, null)

// The panel has been drawn at least once: from now on it is worth refreshing.
let active = false

async function scan(
  $: EngineInterface,
  base: string,
  rel: string,
  depth: number,
): Promise<TreeNode[]> {
  const entries = await $.fs.list(rel === '' ? base : `${base}/${rel}`)
  const nodes: TreeNode[] = []
  for (const v of entries) {
    const path = rel === '' ? v.name : `${rel}/${v.name}`
    const dir = v.kind === 'dir'
    const top = path.split('/')[0] ?? ''
    const limit = DEPTH[top] ?? 1
    const children = dir && depth < limit ? await scan($, base, path, depth + 1) : []
    nodes.push({ name: v.name, path, dir, mtime: dir ? 0 : v.mtimeMs, children })
  }

  return nodes.sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
  )
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    // infowiki.md lives in the project root. A relative path depends on the working directory,
    // which a shell `cd` moves (it happened inside wiki-root): start from the project root.
    const projectRoot = await $.session.root()
    const info = await $.fs.read(`${projectRoot}/infowiki.md`)
    const text = typeof info === 'string' ? info : ''
    const candidates = [readKey(text, 'path'), readKey(text, 'path_alt')].filter(p => p !== '')
    let root = ''
    for (const c of candidates) {
      try {
        await $.fs.list(c)
        root = c
        break
      } catch {
        // try the alternative path
      }
    }
    if (root === '') {
      await update($, errorAtom, () => 'infowiki.md has no reachable root (path / path_alt)')
      return
    }

    const tree = await scan($, root, '', 0)
    await update($, rootAtom, () => root)
    await update($, treeAtom, () => tree)

    // "Seen": the first time everything counts as already seen, then it is marked on each click.
    const seenKey = `seen:${root}`
    const stored = await $.store.get(seenKey)
    let seen: Record<string, number>
    if (stored !== null && typeof stored === 'object') {
      seen = stored as Record<string, number>
    } else {
      seen = {}
      for (const f of treeFiles(tree)) seen[f.path] = f.mtime
      await $.store.set(seenKey, seen)
    }
    await update($, seenAtom, () => seen)

    // Status colours: only from the most recent check / audit / status result in the chat.
    const messages = await $.session.messages()
    const found = Array.isArray(messages) ? findReport(messages) : null
    let report: ReportRead | null = null
    if (found !== null) {
      const signature = `${found.kind}:${found.text.length}:${found.text.slice(0, 80)}`
      const known = await $.store.get('report-signature')
      let seenAt = await $.clock.now()
      if (known !== null && typeof known === 'object') {
        const k = known as { signature?: string; at?: number }
        if (k.signature === signature && typeof k.at === 'number') seenAt = k.at
      }
      await $.store.set('report-signature', { signature, at: seenAt })
      report = {
        kind: found.kind,
        seen: seenAt,
        flags: parseFlags(
          found.text,
          treeFiles(tree).map(f => f.path),
        ),
      }
    }
    await update($, reportAtom, () => report)
    await update($, errorAtom, () => '')
  } catch (error) {
    await update($, errorAtom, () => `Cannot read the wiki: ${String(error)}`)
  }
}

async function markSeen($: EngineInterface, toMark: readonly TreeNode[]): Promise<void> {
  const root = await read($, rootAtom)
  const seen = { ...(await read($, seenAtom)) }
  for (const f of toMark) seen[f.path] = f.mtime
  await $.store.set(`seen:${root}`, seen)
  await update($, seenAtom, () => seen)
}

// Wikifier commands that only read: they run at once, as if typed by the user.
const READS: { label: string; command: string }[] = [
  { label: 'Check', command: 'wiki-check' },
  { label: 'Status', command: 'wiki-status' },
  { label: 'Audit', command: 'wiki-audit' },
]

// Commands that write to the wiki: confirm first, then the message box is filled without sending.
// "structure" touches the shape of the wiki, "pages" its content.
const WRITES: { group: 'structure' | 'pages'; label: string; command: string; effect: string }[] = [
  { group: 'structure', label: 'Init', command: 'wiki-init', effect: 'Creates the wiki structure (or prepares infowiki.md).' },
  { group: 'structure', label: 'Check err', command: 'wiki-check err', effect: 'Repairs the structure and writes to index.md and log.md.' },
  { group: 'pages', label: 'Ingest', command: 'wiki-ingest', effect: 'Turns a source in raw/ into pages.' },
  { group: 'pages', label: 'Update', command: 'wiki-update', effect: 'Brings the news of this chat into the wiki.' },
  { group: 'pages', label: 'Delete', command: 'wiki-delete', effect: 'Moves pages to trash/.' },
]

// Colours and glyphs of the folder-style panel. Glyphs are Unicode characters: no vector icons.
const COL = {
  background: '#161617',
  activeText: '#f2f2f2',
  dim: '#9a9a9f',
  border: '#343437',
  cardBackground: '#1d1d1f',
  active: '#262628',
  activeFull: '#4a4a50',
  hover: '#2f2f33',
  red: '#fca5a5',
  greenBackground: '#17261e',
  green: '#86efac',
  amberBackground: '#2a2210',
  amber: '#fcd34d',
}
const ICON_REFRESH = '↻'
const ICON_SEEN = '✓'
// Button padding: empty braille (U+2800). It is not a space, so it is not stripped like normal
// and non-breaking spaces (0.5.1 with U+00A0 left the text as narrow as before).
const FIXED_SPACE = '⠀'
// Column of the "Tree" and "Show" labels in the Panel tab.
const LABEL_WIDTH = 8

type Tab = 'panel' | 'read' | 'create' | 'update'
const TABS: { id: Tab; label: string }[] = [
  { id: 'panel', label: 'Panel' },
  { id: 'read', label: 'Read' },
  { id: 'create', label: 'Create/Fix' },
  { id: 'update', label: 'Update/Edit' },
]

type Item = { id: string; text: string; color?: string; active?: boolean; press: () => void }

const FILTERS: { filter: Filter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'flagged', label: 'Flagged' },
  { filter: 'recent', label: 'Recent' },
]

/** Writes `text` into the message box without sending it. */
async function write($: EngineInterface, text: string, mode: 'replace' | 'append'): Promise<void> {
  const r = await $.prompt.fill({ text, mode })
  $.ui.toast(
    r.isFilled
      ? `Ready in the message box: ${text.trim()}. Press enter to run it.`
      : `Cannot fill the message box (${r.refusal ?? 'unknown reason'}).`,
  )
}

/**
 * Puts `text` in the message box without sending it. If a draft is already there, the question
 * (replace, append or cancel) appears in the panel: no UI dialog.
 */
async function fill($: EngineInterface, text: string): Promise<void> {
  const box = await $.prompt.read()
  if (box.text.trim() !== '') {
    await update($, pendingAtom, () => ({ kind: 'draft', text }))
    return
  }
  await write($, text, 'replace')
}

/** Asks for confirmation in the panel; the click handler returns at once. */
async function askAndPrepare($: EngineInterface, command: string, effect: string): Promise<void> {
  await update($, pendingAtom, () => ({ kind: 'command', command, effect }))
}

async function sendNow($: EngineInterface, command: string): Promise<void> {
  const r = await $.prompt.submit({ text: command, asUser: true })
  $.ui.toast(r.drop === undefined ? `Sent: ${command}` : `Command not sent: ${String(r.drop)}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wiki-tree',
      description: 'Opens the panel with the wikifier wiki tree',
    })
    $.clock.every(REFRESH_MS, () => {
      if (active) void refresh($)
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (active && e.agentId === undefined) await refresh($)

    return next(e)
  })

  on('command.run', { command: 'wiki-tree' }, async $ => {
    active = true
    await update($, tabAtom, () => 'panel')
    await update($, pendingAtom, () => null)
    await refresh($)
    await $.ui.open({ id: PANEL, title: 'Wiki', columns: 60 })

    return { text: 'Wiki panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    active = true
    const { Box, Text, Button } = $.ui.resolve(e)
    const root = await read($, rootAtom)
    const tree = await read($, treeAtom)
    const expanded = await read($, expandedAtom)
    const seen = await read($, seenAtom)
    const selection = await read($, selectionAtom)
    const filter = await read($, filterAtom)
    const report = await read($, reportAtom)
    const error = await read($, errorAtom)
    const tab = await read($, tabAtom)
    const pending = (await read($, pendingAtom)) as Pending | null
    const flags = report?.flags ?? {}

    if (error !== '') {
      return (
        <Box flexDirection="column">
          <Text color="error">{error}</Text>
          <Button key="retry" label="Retry" onPress={() => void refresh($)} />
        </Box>
      )
    }
    if (root === '') return <Text dimColor>Loading the wiki...</Text>

    const totals = summarize(tree, flags, seen)
    const rows = flatten(filterTree(tree, filter, flags, seen), expanded, flags, seen, filter !== 'all')
    const files = treeFiles(tree)
    const chosen = selection === null ? undefined : files.find(f => f.path === selection)
    const reasons = selection === null ? undefined : flags[selection]?.reasons

    const press = (path: string, dir: boolean, open: boolean): void => {
      if (dir) {
        void update($, expandedAtom, m => ({ ...m, [path]: !open }))
        return
      }
      void update($, selectionAtom, () => path)
      const node = files.find(f => f.path === path)
      if (node !== undefined) void markSeen($, [node])
    }

    const width = Math.max(40, e.props.bodyColumns ?? 52)
    // Room for the panel content: minus the outer margin (2) and the panel padding (4).
    const inner = width - 6

    // Only the text of a Button is pressable, not the box around it: to make the whole area
    // clickable the text is padded to the width of the button with fixed spaces (not stripped).
    const center = (text: string, w: number): string => {
      const space = Math.max(0, w - text.length)
      const left = Math.floor(space / 2)

      return `${FIXED_SPACE.repeat(left)}${text}${FIXED_SPACE.repeat(space - left)}`
    }

    // Button: one line with background and a given width, so those on one row are equal and the
    // Button covers the whole surface. The active filter has a lighter background; the text
    // keeps the theme colour.
    const Pill = (props: { item: Item; width: number }) => {
      const v = props.item
      const isActive = v.active === true

      return (
        <Box
          key={`item:${v.id}`}
          width={props.width}
          justifyContent="center"
          backgroundColor={isActive ? COL.activeFull : COL.active}
          hover={isActive ? undefined : { backgroundColor: COL.hover }}
        >
          <Button key={`btn:${v.id}`} plain onPress={v.press}>
            <Text color={v.color} bold={isActive}>
              {center(v.text, props.width)}
            </Text>
          </Button>
        </Box>
      )
    }

    // Equal width for n buttons in `space` columns, with one column between them.
    const Strip = (props: { items: Item[]; space: number }) => {
      const n = props.items.length
      const w = Math.max(8, Math.floor((props.space - (n - 1)) / n))

      return (
        <Box flexDirection="row" columnGap={1}>
          {props.items.map(v => (
            <Pill key={`strip:${v.id}`} item={v} width={w} />
          ))}
        </Box>
      )
    }

    const Line = (props: { label: string; items: Item[] }) => (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box width={LABEL_WIDTH}>
          <Text color={COL.dim}>{props.label}</Text>
        </Box>
        <Strip items={props.items} space={inner - LABEL_WIDTH - 1} />
      </Box>
    )

    // A hint only: the behaviour of the commands does not depend on this text.
    const Hint = (props: { tag: string; background: string; color: string; sentence: string }) => (
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Text backgroundColor={props.background} color={props.color} bold>
          {` ${props.tag} `}
        </Text>
        <Text color={COL.dim}>{props.sentence}</Text>
      </Box>
    )

    const items = (group: 'structure' | 'pages'): Item[] =>
      WRITES.filter(c => c.group === group).map(c => ({
        id: `cmd:${c.command}`,
        text: c.label,
        color: c.label === 'Delete' ? COL.red : undefined,
        press: () => void askAndPrepare($, c.command, c.effect),
      }))

    const readItems: Item[] = [
      ...READS.map(c => ({
        id: `cmd:${c.command}`,
        text: c.label,
        press: () => void sendNow($, c.command),
      })),
      { id: 'cmd:wiki-query', text: 'Query', press: () => void fill($, 'wiki-query ') },
    ]

    const content =
      tab === 'panel' ? (
        <Box flexDirection="column" rowGap={1}>
          <Line
            label="Tree"
            items={[
              { id: 'refresh', text: `${ICON_REFRESH} Refresh`, press: () => void refresh($) },
              { id: 'seen', text: `${ICON_SEEN} Mark all seen`, press: () => void markSeen($, files) },
            ]}
          />
          <Line
            label="Show"
            items={FILTERS.map(f => ({
              id: `filter:${f.filter}`,
              text: f.label,
              active: filter === f.filter,
              press: () => void update($, filterAtom, () => f.filter),
            }))}
          />
        </Box>
      ) : tab === 'read' ? (
        <Box flexDirection="column">
          <Strip items={readItems} space={inner} />
          <Hint tag="runs now" background={COL.greenBackground} color={COL.green} sentence="Runs without asking." />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Strip items={items(tab === 'create' ? 'structure' : 'pages')} space={inner} />
          <Hint
            tag="asks first"
            background={COL.amberBackground}
            color={COL.amber}
            sentence="Asks for confirmation before running."
          />
        </Box>
      )

    // Confirmation inside the panel: it closes and acts, with no UI dialog that could stay open.
    const closePending = (): Promise<void> => update($, pendingAtom, () => null)
    const pendingItems: Item[] =
      pending === null
        ? []
        : pending.kind === 'command'
          ? [
              {
                id: 'pending:yes',
                text: 'Yes, prepare',
                press: () => {
                  void closePending().then(() => fill($, pending.command))
                },
              },
              { id: 'pending:no', text: 'No, cancel', press: () => void closePending() },
            ]
          : [
              {
                id: 'pending:replace',
                text: 'Replace',
                press: () => {
                  void closePending().then(() => write($, pending.text, 'replace'))
                },
              },
              {
                id: 'pending:append',
                text: 'Append',
                press: () => {
                  void closePending().then(() => write($, pending.text, 'append'))
                },
              },
              { id: 'pending:cancel', text: 'Cancel', press: () => void closePending() },
            ]
    const pendingQuestion =
      pending === null
        ? ''
        : pending.kind === 'command'
          ? `${pending.effect} I will put "${pending.command}" in the message box without sending it. Go ahead?`
          : 'The message box already has text. What should I do?'

    // Folder widths: the text plus two columns, plus the remainder split in equal parts.
    const tabSpace = width - 2 - (TABS.length - 1)
    const minimums = TABS.map(t => t.label.length + 2)
    const extra = Math.max(0, tabSpace - minimums.reduce((a, b) => a + b, 0))
    const tabWidth = minimums.map(
      (m, i) => m + Math.floor(extra / TABS.length) + (i === TABS.length - 1 ? extra % TABS.length : 0),
    )

    return (
      <Box flexDirection="column" backgroundColor={COL.background} paddingX={1}>
        {pending !== null && (
          <Box flexDirection="column" backgroundColor={COL.amberBackground} paddingX={1} marginBottom={1}>
            <Text color={COL.amber} bold>
              Confirm
            </Text>
            <Text>{pendingQuestion}</Text>
            <Box marginTop={1}>
              <Strip items={pendingItems} space={inner - 2} />
            </Box>
          </Box>
        )}
        <Box flexDirection="row" columnGap={1}>
          {TABS.map((t, i) => (
            <Box
              key={`tab:${t.id}`}
              width={tabWidth[i]}
              justifyContent="center"
              backgroundColor={tab === t.id ? COL.cardBackground : undefined}
            >
              <Button
                key={`tabbtn:${t.id}`}
                plain
                dimColor={tab !== t.id}
                onPress={() => void update($, tabAtom, () => t.id)}
              >
                <Text bold={tab === t.id}>{center(t.label, tabWidth[i] ?? t.label.length)}</Text>
              </Button>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" backgroundColor={COL.cardBackground} paddingX={2} paddingY={1}>
          {content}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Wiki tree</Text>
        </Box>
        <Text bold>{root.split(/[\\/]/).slice(-2).join('/')}</Text>
        <Text dimColor>
          {report === null
            ? 'No check/audit/status result in this chat: status not coloured.'
            : `Result of wiki-${report.kind}, read at ${formatTime(report.seen)} (snapshot: may be out of date).`}
        </Text>
        <Box flexDirection="row" columnGap={1}>
          <Text color="success">● {totals.recent}</Text>
          <Text color={ORANGE}>▲ {totals.warning}</Text>
          <Text color="error">✖ {totals.error}</Text>
          <Text dimColor>ok {totals.ok}</Text>
        </Box>
        {rows.length === 0 && <Text dimColor>No files for this filter.</Text>}
        {rows.map(r => {
          const color = severityColor(r.severity)
          const name = r.node.dir
            ? `${r.open ? '▾' : '▸'} ${r.node.name}/ (${r.count})`
            : r.node.name

          // Colour inside a Button is lost: the symbol sits outside, the name is the key.
          // Indentation is container padding (leading spaces would be stripped).
          return (
            <Box key={`row:${r.node.path}`} flexDirection="row" paddingLeft={r.level * 2}>
              <Text color={color} dimColor={color === undefined}>
                {`${symbol(r.severity)} `}
              </Text>
              <Button
                key={r.node.path}
                plain
                onPress={() => press(r.node.path, r.node.dir, r.open)}
              >
                {name}
              </Button>
            </Box>
          )
        })}
        {chosen !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{chosen.path}</Text>
            <Text dimColor>modified {formatDate(chosen.mtime)}</Text>
            {(reasons ?? []).map(m => (
              <Text color={flags[chosen.path]?.severity === 'error' ? 'error' : ORANGE}>
                {m}
              </Text>
            ))}
            {reasons === undefined && report !== null && <Text dimColor>No flags.</Text>}
            {reasons !== undefined && (
              <Button
                key="fix"
                label="Ask how to fix it"
                onPress={() => void fill($, fixInstruction(chosen.path, reasons))}
              />
            )}
          </Box>
        )}
      </Box>
    )
  })
}
