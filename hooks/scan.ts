import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface } from 'claude-code'

import type { AgentBadge, FileChange, Problem, Pull, Row, Snap, Tracked } from '../types'
import { deepest, isInside, jsonOf, parseLock, parseWorktreeList, processFolders, startsOf } from './detect'
import type { Listed, Made } from './detect'
import { lastUses, madeBefore } from './history'

export const PANE = 'agent-worktree'
export const ACTIVE = ['pending', 'running', 'waiting']
export const ENDED = ['completed', 'failed', 'killed']
const ROWS_EVERY = 60_000
const PANE_SEEN = 120_000

const tracked = atom({ plugin: 'agent-worktree', key: 'tracked' } as const, [], {
  shape: 'tracked-2',
})
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
const expanded = atom({ plugin: 'agent-worktree', key: 'expanded' } as const, [], { shape: 'expanded-1' })
const problems = atom({ plugin: 'agent-worktree', key: 'problems' } as const, [], {
  shape: 'problems-1',
})

async function output($: EngineInterface, argv: string[], cwd: string, timeoutMs = 30_000) {
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs })

    // trimEnd only: `status --porcelain` lines start with a meaningful space
    return ran.exitCode === 0 ? ran.stdout.trimEnd() : undefined
  } catch {
    return undefined
  }
}

export async function git($: EngineInterface, cwd: string, ...args: string[]) {
  return output($, ['git', ...args], cwd)
}

const lines = (text?: string) => (text ? text.split('\n') : [])
export const nameOf = (path: string) => path.split('/').pop() || path

export const liveTracked = (list: Tracked[]) => list.filter(one => one.path && !one.isRemoved)
export const labelOf = (agent: AgentInfo) => agent.description || agent.label

export async function listAt($: EngineInterface, dir: string) {
  const porcelain = await git($, dir, 'worktree', 'list', '--porcelain')

  return porcelain === undefined ? undefined : parseWorktreeList(porcelain)
}

function status($: EngineInterface, path: string) {
  return git($, path, '--no-optional-locks', 'status', '--porcelain')
}

async function countsOf($: EngineInterface, path: string, base?: string) {
  const counts = base ? await git($, path, 'rev-list', '--left-right', '--count', `${base}...HEAD`) : undefined
  const [behind, ahead] = (counts ?? '').trim().split(/\s+/).map(Number)

  return counts !== undefined && Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : {}
}

async function snapOf($: EngineInterface, path: string, base?: string): Promise<Snap> {
  if (!(await $.fs.exists(path))) return { isGone: true, ahead: 0, behind: 0, dirty: 0, files: [] }

  const [branch, changes, counts, shortstat, nameStatus, last] = await Promise.all([
    git($, path, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status($, path),
    countsOf($, path, base),
    base ? git($, path, 'diff', '--shortstat', `${base}...HEAD`) : undefined,
    base ? git($, path, 'diff', '--name-status', `${base}...HEAD`) : undefined,
    git($, path, 'log', '-1', '--format=%s%x00%cr'),
  ])
  const [lastSubject, lastAge] = (last ?? '').split('\0')
  const committed: FileChange[] = lines(nameStatus).map(line => {
    const parts = line.split('\t')

    return { status: parts[0]?.[0] ?? '?', path: parts[parts.length - 1] ?? '', isUncommitted: false }
  })
  const seen = new Set(committed.map(file => file.path))
  const uncommitted: FileChange[] = lines(changes)
    .map(line => ({
      status: line.slice(0, 2).trim() || '?',
      path: line.slice(3).split(' -> ').pop() ?? '',
      isUncommitted: true,
    }))
    .filter(file => !seen.has(file.path))

  return {
    isGone: false,
    branch,
    base,
    ahead: counts.ahead ?? 0,
    behind: counts.behind ?? 0,
    dirty: lines(changes).length,
    shortstat: shortstat?.trim() || undefined,
    lastSubject: lastSubject || undefined,
    lastAge,
    files: [...committed, ...uncommitted],
  }
}

type InUse = { folders?: string[]; starts?: Map<number, string> }

const countOf = (text?: string) => {
  const n = Number(text?.trim() || Number.NaN)

  return Number.isInteger(n) ? n : undefined
}

// an unreadable lock, or one whose process cannot be checked, counts as live
const lockOf = (text: string, starts?: Map<number, string>): Row['lock'] => {
  const lock = parseLock(text)

  return !lock || !starts || sameText(starts.get(lock.pid) ?? '', lock.startedAt) ? 'live' : 'stale'
}

async function rowOf($: EngineInterface, one: Listed & { repo: string }, use: InUse) {
  const shared = {
    path: one.path,
    repo: one.repo,
    branch: one.branch,
    head: one.head,
    lock: one.lock === undefined ? undefined : lockOf(one.lock, use.starts),
  }
  if (!(await $.fs.exists(one.path))) {
    const unpushed = one.head
      ? countOf(await git($, one.repo, 'rev-list', '--count', one.head, '--not', '--remotes'))
      : 0

    return { ...shared, isGone: true, unpushed, isUnread: unpushed === undefined }
  }
  const [changes, committed, unpushed] = await Promise.all([
    status($, one.path),
    git($, one.path, 'log', '-1', '--format=%ct'),
    git($, one.path, 'rev-list', '--count', 'HEAD', '--not', '--remotes').then(countOf),
  ])
  const seconds = countOf(committed)

  return {
    ...shared,
    isGone: false,
    dirty: changes === undefined ? undefined : lines(changes).length,
    unpushed,
    hasProcess: use.folders?.some(folder => isInside(folder, one.path)),
    isUnread: changes === undefined || unpushed === undefined || use.folders === undefined,
    committedAt: seconds === undefined ? undefined : seconds * 1000,
  }
}

async function startsAt($: EngineInterface, pids: number[]) {
  if (pids.length === 0) return new Map<number, string>()
  try {
    const argv = ['ps', '-o', 'pid=,lstart=', '-p', [...new Set(pids)].join(',')]
    const ps = await $.process.run(argv, { env: { TZ: 'UTC', LC_ALL: 'C' } })

    return startsOf(ps.stdout)
  } catch {
    return undefined
  }
}

// what holds a worktree another session may be using: a process standing inside it, or a lock of a running session
async function inUseOf($: EngineInterface, listed: Listed[]): Promise<InUse> {
  const lsof = await $.process.run(['lsof', '-a', '-d', 'cwd', '-Fpcn']).catch(() => undefined)
  const folders = lsof?.stdout && !lsof.isStdoutTruncated ? processFolders(lsof.stdout) : undefined
  const locks = listed.flatMap(one => (one.lock ? [parseLock(one.lock)?.pid ?? 0] : []))

  return {
    folders,
    starts: await startsAt(
      $,
      locks.filter(pid => pid > 0),
    ),
  }
}

let own: { pid: number; startedAt: string } | null | undefined
let isHistoryRead = false
const madeBranches: Made[] = []
let isLooking = false

let paneDrawnAt = 0

export const noteBranches = (made: Made[]) => void madeBranches.push(...made)
export const notePaneDrawn = (at: number) => void (paneDrawnAt = at)

// Claude Code locks a worktree it makes with `claude session <name> (pid <its pid> start <its start, UTC>)`
async function ownProcess($: EngineInterface) {
  try {
    const sh = await $.process.run(['sh', '-c', 'echo $PPID'])
    const pid = Number.parseInt(sh.stdout.trim(), 10)
    if (sh.exitCode !== 0 || !Number.isInteger(pid)) return undefined
    const ps = await $.process.run(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { TZ: 'UTC', LC_ALL: 'C' } })
    const startedAt = ps.stdout.trim()

    return ps.exitCode === 0 && startedAt !== '' ? { pid, startedAt } : undefined
  } catch {
    return undefined
  }
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

const lineageOf = (agent: AgentInfo, agents: AgentInfo[]) => {
  const chain: string[] = []
  // the cap guards against a parentId cycle
  for (let up = agents.find(one => one.id === agent.parentId); up && chain.length < 8; ) {
    chain.unshift(labelOf(up))
    const parentId = up.parentId
    up = agents.find(one => one.id === parentId)
  }

  return chain
}

const badgeOf = (agent: AgentInfo, agents: AgentInfo[]): AgentBadge => ({
  id: agent.id,
  label: labelOf(agent),
  type: agent.type,
  lineage: lineageOf(agent, agents),
  status: agent.status,
  model: agent.model,
  tokenCount: agent.tokenCount,
  samples: agent.tokenSamples,
  startTime: agent.startTime,
})

export const isGuess = (one: Tracked) => one.toolUseId.startsWith('seen:') || one.toolUseId.startsWith('lock:')

// what a tool call recorded wins over what a refresh guessed for the same folder
export const withoutGuesses = (list: Tracked[]) => {
  const known = new Set(list.filter(one => one.path && !isGuess(one)).map(one => one.path))

  return list.filter(one => !isGuess(one) || !known.has(one.path))
}

export function remember($: EngineInterface, entry: Tracked) {
  return update($, tracked, list =>
    entry.path !== '' && list.some(one => one.path === entry.path && !isGuess(one) && !one.isRemoved)
      ? list
      : withoutGuesses([...list.filter(one => one.path !== entry.path || !one.isRemoved), entry]),
  )
}

export function complain($: EngineInterface, problem: Problem) {
  return update($, problems, list => [...list, problem].slice(-50))
}

export async function agentOf($: EngineInterface, agentId?: string) {
  return agentId === undefined ? undefined : (await $.agent.list()).find(one => one.id === agentId)
}

export async function agentLabel($: EngineInterface, agentId?: string) {
  const agent = await agentOf($, agentId)

  return agent ? labelOf(agent) : agentId
}

let queue: Promise<void> = Promise.resolve()

// one run at a time, so two runs never both see an agent finish and both toast
export function refresh($: EngineInterface, isFull = false) {
  queue = queue.catch(() => undefined).then(() => refreshNow($, isFull))

  return queue
}

async function refreshNow($: EngineInterface, isFull: boolean) {
  const known = liveTracked(await read($, tracked)).map(one => one.path)
  const history = isHistoryRead ? undefined : await madeBefore($, known).catch(() => undefined)
  isHistoryRead = true
  if (history) madeBranches.push(...history.branches)
  const found = history?.worktrees ?? []
  const now = await $.clock.now()
  const before = await read($, tracked)
  const sessionDir = before.find(one => one.isHere)?.path ?? (await $.session.cwd())
  const agents = await $.agent.list()

  const lists = new Map<string, Listed[]>()
  const seeds = [
    sessionDir,
    ...liveTracked(before).map(one => one.path),
    ...found.map(one => one.path),
    ...agents
      .filter(agent => ACTIVE.includes(agent.status) || before.some(one => one.path === '' && one.agentId === agent.id))
      .map(agent => agent.cwd),
  ]
  for (const seed of seeds) {
    if ([...lists.values()].some(list => list.some(one => isInside(seed, one.path)))) continue
    const list = await listAt($, seed)
    if (list?.[0]) lists.set(list[0].path, list)
  }
  const bases: Record<string, string | undefined> = {}
  const listed: (Listed & { repo: string })[] = []
  for (const [repo, list] of lists) {
    bases[repo] = list[0]?.branch
    listed.push(...list.slice(1).map(one => ({ ...one, repo })))
  }
  const paths = listed.map(one => one.path)
  const repoOf: Record<string, string> = Object.fromEntries(listed.map(one => [one.path, one.repo]))
  const branchOf = (path: string) => listed.find(one => one.path === path)?.branch
  // an agent without its own folder runs in the session's, which is no worktree of its own
  const agentFolder = (agent: AgentInfo) => {
    const path = deepest(agent.cwd, paths)

    return path && !isInside(sessionDir, path) ? path : undefined
  }
  const folderOf = (agentId: string) => {
    const agent = agents.find(one => one.id === agentId)

    return paths.find(path => nameOf(path) === `agent-${agentId}`) ?? (agent && agentFolder(agent))
  }

  const fills: Record<string, string> = {}
  const drops = new Set<string>()
  for (const one of before.filter(entry => entry.path === '' && entry.agentId)) {
    const agentId = one.agentId as string
    const path = folderOf(agentId)
    if (path) fills[one.toolUseId] = path
    else if (!one.isRunning && !ACTIVE.includes(agents.find(agent => agent.id === agentId)?.status ?? ''))
      drops.add(one.toolUseId)
  }

  const mine = new Set([...before.map(one => one.path), ...Object.values(fills)])
  const adds: Tracked[] = []
  const add = (entry: Omit<Tracked, 'isRunning' | 'isHere' | 'isRemoved'>) => {
    adds.push({ ...entry, isRunning: false, isHere: false, isRemoved: false })
    mine.add(entry.path)
  }
  for (const one of found)
    if (paths.includes(one.path) && !mine.has(one.path))
      add({ ...one, branch: branchOf(one.path), toolUseId: `history:${one.path}` })
  const lockedHere = listed.filter(one => !mine.has(one.path) && one.lock && parseLock(one.lock))
  if (lockedHere.length > 0 && own === undefined) own = (await ownProcess($)) ?? null
  for (const one of lockedHere) {
    const lock = parseLock(one.lock as string)
    if (!own || lock?.pid !== own.pid || !sameText(lock.startedAt, own.startedAt)) continue
    const agentId = /^agent-(.+)$/.exec(nameOf(one.path))?.[1]
    const agent = agents.find(entry => entry.id === agentId)
    add({
      path: one.path,
      branch: one.branch,
      how: 'lock',
      agentId,
      label: agent && labelOf(agent),
      toolUseId: `lock:${one.path}`,
    })
  }
  for (const agent of agents) {
    const path = agentFolder(agent)
    if (!path || mine.has(path)) continue
    add({
      path,
      branch: branchOf(path),
      how: 'agent',
      agentId: agent.id,
      label: labelOf(agent),
      at: agent.startTime,
      toolUseId: `seen:${path}`,
    })
  }
  if (Object.keys(fills).length > 0 || drops.size > 0 || adds.length > 0) {
    await update($, tracked, list =>
      withoutGuesses([
        ...list
          .filter(one => !drops.has(one.toolUseId))
          .map(one => {
            const path = fills[one.toolUseId]

            return path ? { ...one, path, branch: branchOf(path) ?? one.branch } : one
          }),
        ...adds.filter(entry => !list.some(one => one.path === entry.path)),
      ]),
    )
  }

  const live = liveTracked(await read($, tracked))
  const snaps = Object.fromEntries(
    await Promise.all(
      live.map(async one => [one.path, await snapOf($, one.path, bases[repoOf[one.path] ?? ''])] as const),
    ),
  )
  const gone = live.filter(
    one => snaps[one.path]?.isGone && !ACTIVE.includes(agents.find(agent => agent.id === one.agentId)?.status ?? ''),
  )
  // Claude Code deletes an agent's worktree when the agent ends with no changes; any other gone folder was removed
  const deleted = new Set(gone.filter(one => one.how === 'agent').map(one => one.toolUseId))
  const removed = new Set(gone.filter(one => one.how !== 'agent').map(one => one.toolUseId))
  if (gone.length > 0)
    await update($, tracked, list =>
      list
        .filter(one => !deleted.has(one.toolUseId))
        .map(one => (removed.has(one.toolUseId) ? { ...one, isRemoved: true } : one)),
    )
  const ownPaths = live.filter(one => !gone.includes(one)).map(one => one.path)
  const livePaths = live.map(one => one.path)
  const used = await lastUses($, livePaths).catch(() => ({}) as Record<string, number>)
  // the worktree the session is in counts as worked in now
  const usedAt = Object.fromEntries(
    livePaths.map(path => [path, isInside(sessionDir, path) ? now : (used[path] ?? 0)] as const),
  )
  const badgePaths = [...new Set([...paths, ...livePaths])]
  const badges: Record<string, AgentBadge> = {}
  for (const agent of [...agents].sort((a, b) => a.startTime - b.startTime)) {
    const path = deepest(agent.cwd, badgePaths)
    if (path && livePaths.includes(path) && !isInside(sessionDir, path)) badges[path] = badgeOf(agent, agents)
  }
  // the agent that made a worktree keeps its line over a helper it started there
  for (const one of live) {
    const owner = agents.find(agent => agent.id === one.agentId)
    if (owner && isInside(owner.cwd, one.path) && !isInside(sessionDir, one.path))
      badges[one.path] = badgeOf(owner, agents)
  }

  const previous = await read($, grove)
  const base = (path: string) => bases[repoOf[path] ?? '']
  const branches = Object.fromEntries(
    ownPaths.map(path => {
      const made = madeBranches.filter(one => deepest(one.dir, ownPaths) === path).map(one => one.branch)
      const now = [...new Set([...made, snaps[path]?.branch ?? ''])]

      return [path, now.filter(branch => branch && branch !== 'HEAD' && branch !== base(path))]
    }),
  )
  for (const [path, badge] of Object.entries(badges)) {
    const was = previous.agents[path]
    if (was?.id !== badge.id || !ACTIVE.includes(was.status) || !ENDED.includes(badge.status)) continue
    const snap = snaps[path]
    const word = badge.status === 'completed' ? 'done' : badge.status
    $.ui.toast(`agent "${badge.label}" ${word}: ↑${snap?.ahead ?? 0} · ${snap?.files.length ?? 0} files`)
  }

  const repoOfDir = (dir: string) => [...lists].find(([, entries]) => entries.some(one => isInside(dir, one.path)))?.[0]
  const shown = new Set([repoOfDir(sessionDir), ...ownPaths.map(path => repoOf[path])])
  const others = listed.filter(one => shown.has(one.repo) && !ownPaths.includes(one.path))
  const isPaneSeen = now - paneDrawnAt < PANE_SEEN
  const isStale = isFull || (isPaneSeen && now - previous.rowsAt >= ROWS_EVERY)
  const cached = new Map(previous.others.map(row => [row.path, row]))
  // between the minute reads a row is kept only while its branch, commit and lock stay as they were
  const kept = (one: Listed) => {
    const row = cached.get(one.path)
    const isSame =
      !!row &&
      row.branch === one.branch &&
      row.head === one.head &&
      (row.lock === undefined) === (one.lock === undefined)

    return !isStale && isSame ? row : undefined
  }
  const use = others.every(kept) ? {} : await inUseOf($, others)
  const rows = await Promise.all(others.map(async one => kept(one) ?? rowOf($, one, use)))

  const opened = await read($, expanded)
  const tiles = await Promise.all(
    others
      .filter(one => opened.includes(`other:${one.path}`))
      .map(async one => [one.path, await snapOf($, one.path, bases[one.repo])] as const),
  )

  await update($, grove, () => ({
    repoOf,
    others: rows,
    rowsAt: isStale ? now : previous.rowsAt,
    snaps: { ...snaps, ...Object.fromEntries(tiles) },
    agents: Object.fromEntries(Object.entries(badges).filter(([path]) => ownPaths.includes(path))),
    usedAt,
  }))
  // PR rows are only drawn in the pane, so GitHub is asked once a minute only while it is open
  const isPullsStale = isPaneSeen && now - (await read($, pulls)).at >= ROWS_EVERY
  const rowBranches = Object.fromEntries(
    rows
      .filter(row => !row.isGone)
      .map(row => [row.path, row.branch && row.branch !== bases[row.repo] ? [row.branch] : []]),
  )
  if (isFull || isPullsStale) void lookUpPulls($, { ...rowBranches, ...branches }, repoOf, now)
}

const stateOf = (state: string): Pull['state'] => (state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : 'closed')

// PRs from the branches, newest first, marked when this gh account opened them; undefined when gh cannot answer
async function pullsOf($: EngineInterface, repo: string, branches: string[]) {
  const fields = branches.map(
    (branch, i) =>
      `b${i}: pullRequests(headRefName: ${JSON.stringify(branch)}, first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number state title headRefOid author { login } } }`,
  )
  const query = `query($owner: String!, $name: String!) { viewer { login } repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`
  const argv = ['gh', 'api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${query}`]
  type Node = { number: number; state: string; title: string; headRefOid: string; author?: { login?: string } | null }
  type Answer = { data?: { viewer?: { login?: string }; repository?: Record<string, { nodes?: Node[] } | null> } }
  const data = jsonOf<Answer>((await output($, argv, repo, 10_000)) ?? '')?.data
  const me = data?.viewer?.login
  if (!data?.repository || !me) return undefined

  return Object.fromEntries(
    branches.map((branch, i) => [
      branch,
      (data.repository?.[`b${i}`]?.nodes ?? []).map(node => ({
        number: node.number,
        state: stateOf(node.state),
        title: node.title,
        head: node.headRefOid,
        isMine: node.author?.login === me,
      })),
    ]),
  )
}

// runs beside the refresh queue, so a slow network never holds up the pane
async function lookUpPulls(
  $: EngineInterface,
  branches: Record<string, string[]>,
  repoOf: Record<string, string>,
  now: number,
) {
  if (isLooking) return
  isLooking = true
  try {
    const byPath: Record<string, Pull[]> = {}
    const unknown: string[] = []
    const paths = Object.keys(branches)
    for (const repo of new Set(paths.map(path => repoOf[path] ?? ''))) {
      const mine = paths.filter(path => (repoOf[path] ?? '') === repo)
      const asked = [...new Set(mine.flatMap(path => branches[path] ?? []))]
      const found = asked.length === 0 ? {} : repo ? await pullsOf($, repo, asked) : undefined
      for (const path of mine)
        if (!found) unknown.push(path)
        else
          byPath[path] = (branches[path] ?? [])
            .flatMap(branch => found[branch] ?? [])
            .sort((a, b) => b.number - a.number)
    }
    // a removed worktree, or one gh could not answer for, keeps the PRs last read
    await update($, pulls, was => ({ byPath: { ...was.byPath, ...byPath }, unknown, at: now }))
  } catch {
    // no PR rows this time; the next lookup tries again
  } finally {
    isLooking = false
  }
}
