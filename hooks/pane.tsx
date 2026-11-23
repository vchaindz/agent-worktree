import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface } from 'claude-code'

import type { Problem, Pull, Row, Snap, Tracked } from '../types'
import { ACTIVE, PANE, liveTracked, nameOf, notePaneDrawn, refresh } from './scan'

const tracked = atom({ plugin: 'agent-worktree', key: 'tracked' } as const, [], { shape: 'tracked-2' })
const grove = atom(
  { plugin: 'agent-worktree', key: 'grove' } as const,
  { repoOf: {}, others: [], rowsAt: 0, snaps: {}, agents: {}, usedAt: {} },
  { shape: 'grove-9' },
)
const pulls = atom(
  { plugin: 'agent-worktree', key: 'pulls' } as const,
  { byPath: {}, unknown: [], at: 0 },
  { shape: 'pulls-3' },
)
const problems = atom({ plugin: 'agent-worktree', key: 'problems' } as const, [], { shape: 'problems-1' })
const expanded = atom({ plugin: 'agent-worktree', key: 'expanded' } as const, [], { shape: 'expanded-1' })

const READ_ONLY = 'Read-only: do not modify, switch into, merge or remove the worktree.'
const SPARK = '▁▂▃▄▅▆▇█'
const BAR_WIDTH = 24
const PROBLEMS_SHOWN = 5
const PULLS_SHOWN = 3

export function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Worktrees' })
}

const pullColor = (state: Pull['state']) => (state === 'open' ? 'success' : state === 'merged' ? 'merged' : 'subtle')

// the worktree the session is in first, then the newest; one found by its lock has no time and counts as new
const byRecent = (a: Tracked, b: Tracked) =>
  Number(b.isHere) - Number(a.isHere) || (b.at ?? Number.MAX_SAFE_INTEGER) - (a.at ?? Number.MAX_SAFE_INTEGER)

const isAgentMade = (one: Tracked) => one.agentId !== undefined || one.how === 'agent'

const overlapsOf = (snaps: Record<string, Snap>, paths: string[], repoOf: Record<string, string>) =>
  Object.fromEntries(
    paths.map(path => {
      const mine = new Set(snaps[path]?.files.map(file => file.path))
      const hits = paths
        .filter(other => other !== path && repoOf[other] === repoOf[path])
        .map(other => ({
          other,
          files: (snaps[other]?.files ?? []).map(file => file.path).filter(file => mine.has(file)),
        }))
        .filter(hit => hit.files.length > 0)

      return [path, hits] as const
    }),
  )

const prompts = (path: string, branch: string, base?: string) => {
  const against = base ?? 'its upstream or default branch'
  const diff = base ? ` (git diff ${base}...${branch})` : ''

  return {
    Investigate: `Investigate the git worktree at ${path} (branch ${branch}): summarize what was done there, how it stands against ${against}, and any uncommitted work. ${READ_ONLY}`,
    'Review diff': `Review the changes on branch ${branch} against ${against}${diff} in the worktree at ${path} for correctness bugs. ${READ_ONLY}`,
    'Cleanup check': `Check whether the worktree at ${path} (branch ${branch}) is safe to remove: is it merged into ${against}, does it hold uncommitted files, is an agent still working in it? Report only, change nothing. ${READ_ONLY}`,
  }
}

const diffOf = (snap?: Snap) => {
  const stat = snap?.shortstat?.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)

  return stat ? { files: Number(stat[1]), add: Number(stat[2] ?? 0), del: Number(stat[3] ?? 0) } : undefined
}

const barOf = (add: number, del: number, scale: number, width: number) => {
  const cells = (n: number) => (n > 0 ? Math.max(1, Math.round((n / scale) * width)) : 0)
  const green = cells(add)
  const red = Math.min(cells(del), width - green)

  return { green: '█'.repeat(green), red: '█'.repeat(red), rest: '░'.repeat(Math.max(0, width - green - red)) }
}

const sparkOf = (samples: number[]) => {
  if (samples.length < 2) return ''
  const low = Math.min(...samples)
  const high = Math.max(...samples)

  return samples.map(n => SPARK[high === low ? 0 : Math.round(((n - low) / (high - low)) * 7)]).join('')
}

const tokensOf = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const two = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// the time alone for today, else the date before it, with the year when it is another year
export const clockOf = (at: number, now: number) => {
  const date = new Date(at)
  const today = new Date(now)
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`
  if (date.toDateString() === today.toDateString()) return time
  const year = date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`

  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year} ${time}`
}

const fit = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`)
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// widths of a row's name and branch columns in the room its fixed parts leave; no branch column when too narrow
const columnsOf = (names: string[], branches: string[], room: number) => {
  const longestName = Math.max(0, ...names.map(name => name.length))
  const longestBranch = Math.max(0, ...branches.map(branch => branch.length))
  const nameWidth = Math.min(longestName, Math.max(12, Math.ceil(room / 2)))

  return longestBranch > 0 && room - nameWidth >= 12
    ? { name: nameWidth, branch: Math.min(longestBranch, room - nameWidth) }
    : { name: Math.max(8, Math.min(longestName, room)), branch: 0 }
}

export const madeBy = (one: Tracked, now: number) => {
  const who = isAgentMade(one) ? `subagent «${one.label ?? one.agentId ?? ''}»` : 'this session'
  const how = {
    enter: 'EnterWorktree',
    entered: 'EnterWorktree',
    bash: 'git worktree add',
    lock: one.agentId === undefined ? 'EnterWorktree' : undefined,
    agent: one.isBackground ? 'background' : undefined,
  }[one.how]
  const at = one.at === undefined ? '' : ` at ${clockOf(one.at, now)}`

  return `${one.how === 'entered' ? 'entered by' : 'made by'} ${who}${at}${how ? ` · ${how}` : ''}`
}

type Group = 'in-use' | 'needs-a-look' | 'pr-open' | 'can-be-removed'
type Reason =
  | 'live-lock'
  | 'process-inside'
  | 'folder-gone'
  | 'unread'
  | 'uncommitted-files'
  | 'commits-on-no-remote'
  | 'no-pr'
  | 'pr-unknown'
  | 'detached-on-remote'
  | 'pr-merged'
  | 'pr-closed'
export type Facts = {
  exists: boolean
  branch: string | null
  lockIsLive: boolean
  hasProcessInside: boolean
  isUnread: boolean
  uncommittedFiles: number
  commitsOnNoRemote: number
  pr: 'open' | 'merged' | 'closed' | 'none' | 'unknown'
}

// the worktrees mod's rule: removable only when nothing holds the worktree and nothing in it would be lost
export function groupOf(facts: Facts): { group: Group; reasons: Reason[] } {
  const inUse: Reason[] = []
  if (facts.lockIsLive) inUse.push('live-lock')
  if (facts.hasProcessInside) inUse.push('process-inside')
  if (inUse.length > 0) return { group: 'in-use', reasons: inUse }

  if (!facts.exists) {
    const lost: Reason[] = facts.isUnread ? ['unread'] : facts.commitsOnNoRemote > 0 ? ['commits-on-no-remote'] : []
    return lost.length > 0
      ? { group: 'needs-a-look', reasons: ['folder-gone', ...lost] }
      : { group: 'can-be-removed', reasons: ['folder-gone'] }
  }

  const look: Reason[] = []
  if (facts.isUnread) look.push('unread')
  if (facts.uncommittedFiles > 0) look.push('uncommitted-files')
  if (facts.commitsOnNoRemote > 0) look.push('commits-on-no-remote')
  if (facts.branch !== null && facts.pr === 'none') look.push('no-pr')
  if (facts.branch !== null && facts.pr === 'unknown') look.push('pr-unknown')
  if (look.length > 0) return { group: 'needs-a-look', reasons: look }

  if (facts.branch === null) return { group: 'can-be-removed', reasons: ['detached-on-remote'] }
  if (facts.pr === 'open') return { group: 'pr-open', reasons: [] }
  return { group: 'can-be-removed', reasons: [facts.pr === 'merged' ? 'pr-merged' : 'pr-closed'] }
}

const GROUPS: { group: Group; label: string; color: string; one: string; many: string }[] = [
  { group: 'needs-a-look', label: 'Needs a look', color: 'warning', one: 'needs a look', many: 'need a look' },
  { group: 'can-be-removed', label: 'Can be removed', color: 'success', one: 'can be removed', many: 'can be removed' },
  { group: 'pr-open', label: 'PR open', color: 'suggestion', one: 'PR open', many: 'PR open' },
  { group: 'in-use', label: 'In use', color: 'subtle', one: 'in use', many: 'in use' },
]
const PR_REASONS: Reason[] = ['pr-merged', 'pr-closed', 'no-pr', 'pr-unknown']
const PR_WIDTH = 16
const DAY = 86_400_000

function reasonText(row: Row, reason: Reason): string {
  switch (reason) {
    case 'live-lock':
      return 'locked by a running session'
    case 'process-inside':
      return 'a process runs inside'
    case 'folder-gone':
      return 'folder is gone'
    case 'unread':
      return 'git or the process list could not be read'
    case 'uncommitted-files':
      return count(row.dirty ?? 0, 'uncommitted file', 'uncommitted files')
    case 'commits-on-no-remote':
      return count(row.unpushed ?? 0, 'commit on no remote', 'commits on no remote')
    case 'no-pr':
      return 'no PR for this branch'
    case 'pr-unknown':
      return 'PR state unknown'
    case 'detached-on-remote':
      return 'detached, every commit is on a remote'
    case 'pr-merged':
      return 'PR merged'
    case 'pr-closed':
      return 'PR closed'
  }
}

export async function drawPane($: EngineInterface, ui: ElementTable, width: number) {
  const { Box, Text, Button } = ui
  const list = await read($, tracked)
  const { repoOf, others, snaps, agents, usedAt } = await read($, grove)
  const failed = await read($, problems)
  const open = await read($, expanded)
  const { byPath, unknown } = await read($, pulls)
  const now = await $.clock.now()
  notePaneDrawn(now)
  const isNarrow = width < 60
  const live = liveTracked(list)
  const current = list.filter(one => !one.isRemoved)
  const removed = list.filter(one => one.isRemoved)
  const lastUsed = (one: Tracked) => Math.max(one.at ?? 0, usedAt[one.path] ?? 0)
  // made or worked in by the session in the last day, the worktree it is in, or one its agent runs in
  const isWorkedOn = (one: Tracked) =>
    one.path === '' ||
    one.isHere ||
    one.isRunning ||
    ACTIVE.includes(agents[one.path]?.status ?? '') ||
    now - lastUsed(one) < DAY
  const recent = current.filter(isWorkedOn)
  const earlier = current.filter(one => !isWorkedOn(one))
  const daysSince = (at: number) => `${Math.max(0, Math.floor((now - at) / DAY))} d`
  const overlaps = overlapsOf(
    snaps,
    live.map(one => one.path),
    repoOf,
  )
  const rowKey = (row: Row) => `other:${row.path}`
  const opened = others.filter(row => open.includes(rowKey(row)))
  const scale = Math.max(
    1,
    ...[...live, ...opened].map(one => diffOf(snaps[one.path])).map(diff => (diff?.add ?? 0) + (diff?.del ?? 0)),
  )
  const repos = [...new Set([...live.map(one => repoOf[one.path]), ...others.map(row => row.repo)].filter(Boolean))]
  const ask = (text: string) => () => void $.prompt.submit({ text })
  const flip = (key: string) =>
    update($, expanded, keys => (keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key]))
  const toggle = (key: string) => () => void flip(key)
  // an opened row reads its worktree like a card does, so the refresh starts at once
  const openRow = (row: Row) => () => void flip(rowKey(row)).then(() => refresh($))
  const short: Record<string, string> = { Investigate: 'Inv', 'Review diff': 'Diff', 'Cleanup check': 'Clean' }
  const fileColor = (status: string) =>
    status === 'A' ? 'success' : status === 'D' ? 'error' : status === '??' ? undefined : 'warning'
  const heading = (title: string, color: 'claude' | 'error' | 'subtle', note: string) => (
    <Text wrap="truncate-end">
      <Text bold color={color}>
        {title}
      </Text>
      <Text dimColor>{`  ${note}`}</Text>
    </Text>
  )

  type Parts = { branch: string; filesKey: string; pullsKey: string; pullList: Pull[]; canAct: boolean }
  // what a card shows below its heading, for this session's cards and for an other worktree opened from its row
  const details = (path: string, snap: Snap | undefined, parts: Parts) => {
    const { branch, filesKey, pullsKey, pullList, canAct } = parts
    const agent = agents[path]
    const isActive = !!agent && ACTIVE.includes(agent.status)
    const files = snap?.files ?? []
    const diff = diffOf(snap)
    const bar = diff && barOf(diff.add, diff.del, scale, BAR_WIDTH)
    const spark = agent ? sparkOf(agent.samples) : ''
    const isMerged = !!snap && !snap.isGone && !!snap.base && snap.ahead === 0 && snap.dirty === 0
    const repo = repos.length > 1 && repoOf[path] ? `${nameOf(repoOf[path])} · ` : ''
    const isOpen = open.includes(filesKey)
    const isPullsOpen = open.includes(pullsKey)

    return [
      snap?.isGone && <Text color="error">gone from disk</Text>,
      snap && !snap.isGone && (
        <Text wrap="truncate-end">
          <Text dimColor>
            {repo}
            {branch}
          </Text>
          {snap.base && (
            <Text>
              {'  '}
              <Text color={snap.ahead ? 'success' : undefined} dimColor={!snap.ahead}>
                ↑{snap.ahead}
              </Text>{' '}
              <Text color={snap.behind ? 'warning' : undefined} dimColor={!snap.behind}>
                ↓{snap.behind}
              </Text>
              <Text dimColor> {snap.base}</Text>
            </Text>
          )}
          <Text dimColor> · </Text>
          {snap.dirty ? <Text color="warning">{snap.dirty} dirty</Text> : <Text color="success">clean</Text>}
          {isMerged && <Text dimColor> · nothing unmerged</Text>}
          {isNarrow && diff && (
            <Text>
              {' '}
              <Text color="success">+{diff.add}</Text> <Text color="error">−{diff.del}</Text>
            </Text>
          )}
        </Text>
      ),
      !isNarrow && diff && bar && (
        <Text wrap="truncate-end">
          <Text color="success">{bar.green}</Text>
          <Text color="error">{bar.red}</Text>
          <Text dimColor>{bar.rest}</Text> <Text color="success">+{diff.add}</Text>{' '}
          <Text color="error">−{diff.del}</Text>
          <Text dimColor> · {diff.files} files</Text>
        </Text>
      ),
      !isNarrow && snap?.lastSubject && (
        <Text wrap="truncate-end" dimColor>
          {snap.lastSubject} · {snap.lastAge}
        </Text>
      ),
      ...(isPullsOpen ? pullList : pullList.slice(0, PULLS_SHOWN)).map(pull => (
        <Text wrap="truncate-end">
          <Text color={pullColor(pull.state)}>{`PR #${pull.number} ${pull.state}`}</Text>
          <Text dimColor>{` · ${pull.title}`}</Text>
        </Text>
      )),
      pullList.length > PULLS_SHOWN && (
        <Box>
          <Button key={`${path}:pulls`} onPress={toggle(pullsKey)}>
            {isPullsOpen ? 'Fewer PRs' : `+${pullList.length - PULLS_SHOWN} more PRs`}
          </Button>
        </Box>
      ),
      pullList.length === 0 && unknown.includes(path) && <Text dimColor>PR unknown</Text>,
      agent && (
        <Text wrap="truncate-end" dimColor={!isActive}>
          <Text color={isActive ? 'success' : undefined}>●</Text> {agent.status}
          {agent.model ? ` · ${agent.model}` : ''} · {tokensOf(agent.tokenCount)} tok
          {isActive ? ` · ${Math.max(0, Math.round((now - agent.startTime) / 60000))}m` : ''}
          {!isNarrow && spark && <Text color="claude"> {spark}</Text>}
        </Text>
      ),
      ...(overlaps[path] ?? []).map(hit => (
        <Text wrap="truncate-end" color="warning">
          ⚠ overlaps {nameOf(hit.other)}: {hit.files.slice(0, 2).join(', ')}
          {hit.files.length > 2 ? ` (+${hit.files.length - 2})` : ''}
        </Text>
      )),
      ...(isOpen
        ? files.slice(0, 20).map(file => (
            <Text wrap="truncate-end">
              {'  '}
              <Text color={fileColor(file.status)} dimColor={file.status === '??'}>
                {file.status.padEnd(2)}
              </Text>{' '}
              {file.path}
              {file.isUncommitted ? <Text dimColor> (uncommitted)</Text> : ''}
            </Text>
          ))
        : []),
      isOpen && files.length > 20 && <Text dimColor> +{files.length - 20} more</Text>,
      canAct && !snap?.isGone && (
        <Box flexDirection="row" gap={1}>
          {Object.entries(prompts(path, branch, snap?.base)).map(([label, text]) => (
            <Button key={`${path}:${label}`} onPress={ask(text)}>
              {isNarrow ? (short[label] ?? label) : label}
            </Button>
          ))}
          {files.length > 0 && (
            <Button key={`${path}:files`} onPress={toggle(filesKey)}>
              {isOpen ? 'Hide files' : `Files (${files.length})`}
            </Button>
          )}
          {agent && (
            <Button key={`${path}:view`} onPress={() => void $.ui.view({ agentId: agent.id })}>
              {isNarrow ? 'View' : 'View agent'}
            </Button>
          )}
        </Box>
      ),
    ]
  }

  const card = (one: Tracked) => {
    const path = one.path
    const snap = snaps[path]
    const agent = agents[path]
    const isActive = !!agent && ACTIVE.includes(agent.status)
    const isAgent = isAgentMade(one)
    const lineage = agent?.lineage ?? []

    return (
      <Box
        key={one.toolUseId}
        flexDirection="column"
        borderStyle="round"
        borderColor={one.isHere ? 'claude' : isActive ? 'success' : isAgent ? 'suggestion' : 'subtle'}
        paddingX={1}
        marginLeft={isAgent ? 2 * Math.min(lineage.length, 4) : 0}
      >
        <Text wrap="truncate-end" bold>
          {isAgent ? <Text color="suggestion">◆</Text> : '⎇'} {nameOf(path) || '(creating…)'}
          {one.isHere && <Text color="claude">{'  ★ here'}</Text>}
          {agent?.type && <Text color="suggestion">{`  [${agent.type}]`}</Text>}
          {one.isRunning && <Text dimColor>{'  running'}</Text>}
        </Text>
        <Text wrap="truncate-end" color="suggestion">
          {madeBy(one, now)}
        </Text>
        {agent && lineage.length > 0 && (
          <Text wrap="truncate-end" dimColor>
            session ▸ {lineage.map(label => `"${label}" ▸ `).join('')}
            <Text color="suggestion">◆ "{agent.label}"</Text>
          </Text>
        )}
        {!snap && path !== '' && <Text dimColor>scanning…</Text>}
        {details(path, snap, {
          branch: snap?.branch ?? one.branch ?? nameOf(path),
          filesKey: one.toolUseId,
          pullsKey: `${one.toolUseId}:pulls`,
          pullList: (byPath[path] ?? []).filter(pull => pull.isMine),
          canAct: path !== '',
        })}
      </Box>
    )
  }

  const tile = (row: Row) => {
    const snap = snaps[row.path]

    return (
      <Box
        key={`tile:${row.path}`}
        flexDirection="column"
        borderStyle="round"
        borderColor="subtle"
        paddingX={1}
        marginLeft={4}
      >
        {!snap && <Text dimColor>scanning…</Text>}
        {details(row.path, snap, {
          branch: snap?.branch ?? row.branch ?? nameOf(row.path),
          filesKey: `${rowKey(row)}:files`,
          pullsKey: `${rowKey(row)}:pulls`,
          pullList: byPath[row.path] ?? [],
          canAct: true,
        })}
      </Box>
    )
  }

  const earlierBranch = (one: Tracked) => snaps[one.path]?.branch ?? one.branch ?? ''
  const earlierAge = (one: Tracked) => (lastUsed(one) > 0 ? daysSince(lastUsed(one)) : '—')
  const earlierAgeWidth = Math.max(0, ...earlier.map(one => earlierAge(one).length))
  const earlierColumns = columnsOf(
    earlier.map(one => nameOf(one.path)),
    earlier.map(earlierBranch),
    width - 8 - PR_WIDTH - 2 - earlierAgeWidth,
  )
  // a worktree of this session not worked in for a day: one row, and its card under it once pressed
  const earlierRow = (one: Tracked, isLast: boolean) => {
    const key = `earlier:${one.toolUseId}`
    const pull = (byPath[one.path] ?? []).find(pull => pull.isMine)
    const pr = pull
      ? `PR #${pull.number} ${pull.state}`
      : unknown.includes(one.path)
        ? 'PR unknown'
        : byPath[one.path]
          ? 'no PR'
          : 'PR …'
    const dirty = snaps[one.path]?.dirty ?? 0
    const { name, branch } = earlierColumns

    return [
      <Button key={key} plain onPress={toggle(key)}>
        <Text wrap="truncate-end">
          {'  '}
          {isAgentMade(one) ? <Text color="suggestion">◆</Text> : '⎇'}
          {` ${fit(nameOf(one.path), name).padEnd(name)}  `}
          {branch > 0 && <Text dimColor>{`${fit(earlierBranch(one), branch).padEnd(branch)}  `}</Text>}
          <Text color={pull ? pullColor(pull.state) : undefined} dimColor={!pull}>
            {pr.padEnd(PR_WIDTH)}
          </Text>
          <Text dimColor>{`  ${earlierAge(one).padStart(earlierAgeWidth)}`}</Text>
        </Text>
      </Button>,
      ...(dirty > 0
        ? [
            <Text key={`${key}:note`} wrap="truncate-end" dimColor>
              {`    ${count(dirty, 'uncommitted file', 'uncommitted files')}`}
            </Text>,
          ]
        : []),
      ...(open.includes(key)
        ? [
            <Box key={`${key}:card`} flexDirection="column" marginLeft={2}>
              {card(one)}
            </Box>,
          ]
        : []),
      ...(isLast
        ? []
        : [
            <Text key={`${key}:line`} wrap="truncate-end" dimColor>
              {`  ${'─'.repeat(Math.max(0, width - 2))}`}
            </Text>,
          ]),
    ]
  }

  // a removed worktree's PRs are not read again, so an open one is shown by its number alone
  const removedLine = (one: Tracked) => {
    const pull = (byPath[one.path] ?? []).find(pull => pull.isMine)
    const pr = pull && `PR #${pull.number}${pull.state === 'open' ? '' : ` ${pull.state}`}`

    return (
      <Text key={`removed:${one.toolUseId}`} wrap="truncate-end" dimColor>
        {`  ${isAgentMade(one) ? '◆' : '⎇'} ${nameOf(one.path)}  ${pr ? `${pr}  ` : ''}${madeBy(one, now)}`}
      </Text>
    )
  }

  const problemLine = (problem: Problem) => {
    const who = problem.who === undefined ? 'this session' : `subagent «${problem.who}»`
    const lead = `✗ ${clockOf(problem.at, now)}  ${who}  ${problem.what}  `

    return (
      <Text wrap="truncate-end">
        <Text color="error">✗</Text>
        {` ${clockOf(problem.at, now)}  `}
        <Text color="suggestion">{who}</Text>
        {`  ${problem.what}  `}
        <Text color="error">{fit(problem.cause, Math.max(10, width - lead.length))}</Text>
      </Text>
    )
  }

  // the row's PR is one opened from its HEAD, an open one first, else the newest when it is open
  const prOf = (row: Row): { state: Facts['pr']; number?: number } => {
    if (!row.branch) return { state: 'none' }
    const pulls = byPath[row.path]
    if (unknown.includes(row.path) || !pulls) return { state: 'unknown' }
    const onHead = pulls.filter(one => one.head === row.head)
    const pull =
      onHead.find(one => one.state === 'open') ?? onHead[0] ?? (pulls[0]?.state === 'open' ? pulls[0] : undefined)

    return pull ? { state: pull.state, number: pull.number } : { state: 'none' }
  }
  const factsOf = (row: Row): Facts => ({
    exists: !row.isGone,
    branch: row.branch ?? null,
    lockIsLive: row.lock === 'live',
    hasProcessInside: !!row.hasProcess,
    isUnread: !!row.isUnread,
    uncommittedFiles: row.dirty ?? 0,
    commitsOnNoRemote: row.unpushed ?? 0,
    pr: prOf(row).state,
  })
  const prText = (row: Row) => {
    const pr = prOf(row)
    if (!row.branch) return '—'
    if (pr.state === 'unknown') return byPath[row.path] || unknown.includes(row.path) ? 'PR unknown' : 'PR …'

    return pr.state === 'none' ? 'no PR' : `PR #${pr.number} ${pr.state}`
  }
  const prTextColor = (row: Row) => {
    const { state } = prOf(row)

    return state === 'merged'
      ? 'merged'
      : state === 'open'
        ? 'success'
        : state === 'none' && row.branch
          ? 'warning'
          : 'subtle'
  }
  const groups = new Map(others.map(row => [row.path, groupOf(factsOf(row))]))
  const groupOfRow = (row: Row) => groups.get(row.path) ?? { group: 'needs-a-look' as const, reasons: [] }
  const ageOf = (row: Row) =>
    row.isGone ? 'folder gone' : row.committedAt === undefined ? '—' : daysSince(row.committedAt)
  const ageWidth = Math.max(0, ...others.map(row => ageOf(row).length))
  const tail = PR_WIDTH + 2 + ageWidth
  const columns = columnsOf(
    others.map(row => nameOf(row.path)),
    others.map(row => row.branch ?? 'detached'),
    width - 10 - tail,
  )
  const otherRow = (row: Row, isLast: boolean) => {
    const { group, reasons } = groupOfRow(row)
    const isAtRisk = !!row.dirty || !!row.unpushed || group === 'needs-a-look'
    const note = [
      ...reasons.filter(reason => !PR_REASONS.includes(reason)).map(reason => reasonText(row, reason)),
      ...(row.lock === 'stale' ? ['lock left by a stopped session'] : []),
    ].join(' · ')

    return [
      <Button key={rowKey(row)} plain onPress={openRow(row)}>
        <Text wrap="truncate-end">
          {'    '}
          <Text color={row.isGone ? 'subtle' : isAtRisk ? 'warning' : 'success'}>●</Text>
          {` ${fit(nameOf(row.path), columns.name).padEnd(columns.name)}  `}
          {columns.branch > 0 && (
            <Text dimColor>{`${fit(row.branch ?? 'detached', columns.branch).padEnd(columns.branch)}  `}</Text>
          )}
          <Text color={prTextColor(row)}>{prText(row).padEnd(PR_WIDTH)}</Text>
          <Text dimColor>{`  ${ageOf(row).padStart(ageWidth)}`}</Text>
        </Text>
      </Button>,
      ...(note
        ? [
            <Text key={`note:${row.path}`} wrap="truncate-end" dimColor>
              {`      ${note}`}
            </Text>,
          ]
        : []),
      ...(open.includes(rowKey(row)) ? [tile(row)] : []),
      ...(isLast
        ? []
        : [
            <Text key={`line:${row.path}`} wrap="truncate-end" dimColor>
              {`    ${'─'.repeat(Math.max(0, width - 4))}`}
            </Text>,
          ]),
    ]
  }
  const tally = (rows: Row[]) =>
    GROUPS.map(one => ({ ...one, n: rows.filter(row => groupOfRow(row).group === one.group).length }))
      .filter(one => one.n > 0)
      .map((one, i) => (
        <Text color={one.color}>{`${i > 0 ? ' · ' : ''}${one.n} ${one.n === 1 ? one.one : one.many}`}</Text>
      ))
  const groupLines = (rows: Row[]) =>
    GROUPS.map(one => ({
      ...one,
      mine: rows
        .filter(row => groupOfRow(row).group === one.group)
        .sort((a, b) => nameOf(a.path).localeCompare(nameOf(b.path))),
    }))
      .filter(({ mine }) => mine.length > 0)
      .flatMap(({ group, label, color, mine }, i) => [
        ...(i > 0 ? [<Text key={`gap:${rows[0]?.repo}:${group}`}> </Text>] : []),
        <Text key={`group:${rows[0]?.repo}:${group}`} bold color={color}>{`  ${label} · ${mine.length}`}</Text>,
        ...mine.flatMap((row, j) => otherRow(row, j === mine.length - 1)),
      ])
  const otherRepos = [...new Set(others.map(row => row.repo))]
  const otherLines = otherRepos.flatMap((repo, index) => {
    const rows = others.filter(row => row.repo === repo)
    const key = `repo:${repo}`
    const isFolding = otherRepos.length > 1
    // a choice is stored as open or closed, so it holds when the order of repositories changes
    const isShown =
      !isFolding || (open.includes(`${key}:open`) ? true : open.includes(`${key}:closed`) ? false : index === 0)
    const header = isFolding ? (
      <Box key={key} flexDirection="row">
        <Text dimColor>{isShown ? '▾ ' : '▸ '}</Text>
        <Button
          key={key}
          onPress={() =>
            void update($, expanded, keys => [
              ...keys.filter(one => one !== `${key}:open` && one !== `${key}:closed`),
              `${key}:${isShown ? 'closed' : 'open'}`,
            ])
          }
        >
          {nameOf(repo)}
        </Button>
        {!isShown && (
          <Text wrap="truncate-end">
            {'  '}
            {tally(rows)}
          </Text>
        )}
      </Box>
    ) : undefined

    return [...(header ? [header] : []), ...(isShown ? groupLines(rows) : [])]
  })

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        {heading('THIS SESSION', 'claude', count(live.filter(isWorkedOn).length, 'worktree', 'worktrees'))}
        <Button key="refresh" onPress={() => void refresh($, true)}>
          Refresh
        </Button>
      </Box>
      {list.length === 0 && <Text dimColor>No worktrees in this session yet.</Text>}
      {list.length > 0 && current.length === 0 && <Text dimColor>No worktrees left; the removed ones are below.</Text>}
      {recent.length === 0 && earlier.length > 0 && (
        <Text dimColor>No worktree used in the last day; the earlier ones are below.</Text>
      )}
      {[...recent].sort(byRecent).map(card)}
      {earlier.length > 0 && <Text> </Text>}
      {earlier.length > 0 &&
        heading(
          'EARLIER IN THIS SESSION',
          'claude',
          `${count(earlier.length, 'worktree', 'worktrees')} not used in the last day`,
        )}
      {[...earlier]
        .sort((a, b) => lastUsed(b) - lastUsed(a))
        .flatMap((one, i, all) => earlierRow(one, i === all.length - 1))}
      {failed.length > 0 && <Text> </Text>}
      {failed.length > 0 &&
        heading(
          'PROBLEMS IN THIS SESSION',
          'error',
          count(failed.length, 'failed worktree call', 'failed worktree calls'),
        )}
      {failed.length > PROBLEMS_SHOWN && <Text dimColor>{`${failed.length - PROBLEMS_SHOWN} earlier`}</Text>}
      {failed.slice(-PROBLEMS_SHOWN).map(problemLine)}
      {others.length > 0 && <Text> </Text>}
      {others.length > 0 &&
        heading(
          otherRepos.length === 1
            ? `OTHER WORKTREES IN ${nameOf(otherRepos[0] ?? '')}`
            : 'OTHER WORKTREES IN THE SESSION’S REPOS',
          'claude',
          `${others.length} in ${count(otherRepos.length, 'repository', 'repositories')}`,
        )}
      {otherLines}
      {removed.length > 0 && <Text> </Text>}
      {removed.length > 0 &&
        heading('REMOVED', 'subtle', `${count(removed.length, 'worktree', 'worktrees')} this session made`)}
      {[...removed].sort(byRecent).map(removedLine)}
    </Box>
  )
}

export async function drawBand($: EngineInterface, ui: ElementTable) {
  const list = liveTracked(await read($, tracked))
  const failed = await read($, problems)
  if (list.length === 0 && failed.length === 0) return undefined
  const { snaps, agents, repoOf } = await read($, grove)
  const paths = list.map(one => one.path)
  const byAgents = list.filter(isAgentMade).length
  const overlaps = overlapsOf(snaps, paths, repoOf)
  const { Box, Text, Button } = ui
  const tally = (n: number, word: string, color: 'warning' | 'success') => (
    <Text color={n > 0 ? color : undefined} dimColor={n === 0}>
      {n} {word}
    </Text>
  )

  return (
    <Box flexDirection="row" gap={1}>
      <Text wrap="truncate-end">
        <Text color="claude">⎇ {count(paths.length, 'worktree', 'worktrees')}</Text>
        {byAgents > 0 && <Text color="suggestion"> (◆ {count(byAgents, 'agent', 'agents')})</Text>}
        <Text dimColor> · </Text>
        {tally(paths.filter(path => (snaps[path]?.dirty ?? 0) > 0).length, 'dirty', 'warning')}
        <Text dimColor> · </Text>
        {tally(paths.filter(path => ACTIVE.includes(agents[path]?.status ?? '')).length, 'running', 'success')}
        <Text dimColor> · </Text>
        {tally(paths.filter(path => (overlaps[path]?.length ?? 0) > 0).length, 'overlap', 'warning')}
        {failed.length > 0 && <Text dimColor> · </Text>}
        {failed.length > 0 && <Text color="error">{count(failed.length, 'failed call', 'failed calls')}</Text>}
      </Text>
      <Button key="open" onPress={() => void openPane($)}>
        Open
      </Button>
    </Box>
  )
}
