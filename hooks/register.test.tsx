import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { clockOf, groupOf } from './pane'
import type { Facts } from './pane'

type On = Parameters<TestBody>[1]

type Dollar = Parameters<TestBody>[0]
type Wt = { path: string; branch: string; lock?: string; head?: string }
type Answers = {
  status: string
  revList: string
  unpushed: string
  shortstat: string
  nameStatus: string
  log: string
  age: string
  committed: string
  fail: string
}

const PANE = {
  plugin: 'agent-worktree',
  component: 'Pane',
  requestId: 'agent-worktree',
  props: {
    title: 'Worktrees',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'agent-worktree',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

const NOW = 3 * 60000
const AT = clockOf(NOW, NOW)
const MAIN = { path: '/repo', branch: 'main' }
const WT = { path: '/repo/.claude/worktrees/fix-auth', branch: 'worktree-fix-auth' }
const AGENT_WT = { path: '/repo/.claude/worktrees/agent-1', branch: 'worktree-agent-1' }

type World = {
  repos: Record<string, Wt[]>
  cwd: string
  now: number
  agents: never[]
  per: Record<string, Partial<Answers>>
  pid?: { pid: number; start: string }
  processes?: Record<number, string> | null
  lsof?: string | null
  isLsofCut?: boolean
  gone: Set<string>
  files: Record<string, string>
  mtimes: Record<string, number>
  unreadable: Set<string>
  pulls?: Record<
    string,
    { number: number; state: string; title: string; headRefOid?: string; author?: { login: string } }[]
  >
  pidReads: number
  gitDirs: string[]
  sent: string[]
  toasts: string[]
  views: string[]
  status: (string | undefined)[]
}

const gitAnswer = (w: World, argv: readonly string[], dir: string) => {
  if ([...w.gone].some(path => dir === path || dir.startsWith(`${path}/`))) return undefined
  let best: { repo: string; wt: Wt } | undefined
  for (const [repo, list] of Object.entries(w.repos))
    for (const wt of list)
      if ((dir === wt.path || dir.startsWith(`${wt.path}/`)) && (!best || wt.path.length > best.wt.path.length))
        best = { repo, wt }
  if (!best) return undefined
  const args = argv.slice(1).filter(arg => arg !== '--no-optional-locks')
  const per = w.per[best.wt.path] ?? {}
  if (per.fail === args[0]) return undefined
  if (args[0] === 'worktree')
    return (w.repos[best.repo] ?? [])
      .map(
        one =>
          `worktree ${one.path}\nHEAD ${one.head ?? 'a'}\nbranch refs/heads/${one.branch}${one.lock ? `\nlocked ${one.lock}` : ''}`,
      )
      .join('\n\n')
  if (args[0] === 'rev-parse') return best.wt.branch
  if (args[0] === 'status') return per.status ?? ''
  if (args[0] === 'rev-list') return args.includes('--not') ? (per.unpushed ?? '0') : (per.revList ?? '0\t0')
  if (args[0] === 'diff') return args[1] === '--shortstat' ? (per.shortstat ?? '') : (per.nameStatus ?? '')
  if (args[0] === 'log' && args.includes('--format=%ct')) return per.committed ?? String(NOW / 1000 - 60)
  if (args[0] === 'log')
    return args.includes('--format=%cr') ? (per.age ?? '1 minute ago') : (per.log ?? 'init\u00001 minute ago')

  return undefined
}

const ghAnswer = (w: World, argv: readonly string[]) => {
  if (!w.pulls || !argv.includes('owner={owner}')) return undefined
  const query = argv.find(arg => arg.startsWith('query=')) ?? ''
  const fields = [...query.matchAll(/(b\d+): pullRequests\(headRefName: ("[^"]*")/g)]
  const nodesOf = (branch: string) => (w.pulls?.[branch] ?? []).map(node => ({ author: { login: 'me' }, ...node }))

  return JSON.stringify({
    data: {
      viewer: { login: 'me' },
      repository: Object.fromEntries(
        fields.map(([, alias, branch]) => [alias, { nodes: nodesOf(JSON.parse(branch ?? '""')) }]),
      ),
    },
  })
}

const world = (on: On, repos: Record<string, Wt[]>, cwd = '/repo'): World => {
  const w: World = {
    repos,
    cwd,
    now: NOW,
    agents: [],
    per: {},
    gone: new Set(),
    files: {},
    mtimes: {},
    unreadable: new Set(),
    pidReads: 0,
    gitDirs: [],
    sent: [],
    toasts: [],
    views: [],
    status: [],
  }
  on('command.register', () => ({ value: { command: 'worktrees' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('env.get', () => ({ value: '/home/u' }))
  on('clock.after', () => new Promise<never>(() => {}))
  on('clock.now', () => ({ value: w.now }))
  on('ui.status', (_, e) => {
    w.status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.view', (_, e) => {
    w.views.push(e.agentId ?? '')

    return { value: {} as never }
  })
  on('agent.list', () => ({ value: w.agents }))
  on('fs.exists', (_, e) => ({ value: !w.gone.has(e.path) }))
  on('session.info', () => ({ value: { transcriptPath: '/t/s.jsonl' } as never }))
  on('fs.stat', (_, e) => {
    if (w.files[e.path] === undefined && w.mtimes[e.path] === undefined) throw new Error(`no file ${e.path}`)

    return { value: { kind: 'file', size: (w.files[e.path] ?? '').length, mtimeMs: w.mtimes[e.path] ?? 0 } as never }
  })
  on('fs.read', (_, e) => {
    const text = w.files[e.path]
    if (text === undefined || w.unreadable.has(e.path)) throw new Error(`no file ${e.path}`)
    const offset = e.offset ?? 0

    return { value: text.slice(offset, e.length === undefined ? undefined : offset + e.length) }
  })
  on('fs.list', (_, e) => {
    const names = Object.keys(w.files)
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => path.slice(e.path.length + 1).split('/'))

    return {
      value: [...new Map(names.map(parts => [parts[0], parts.length > 1 ? 'dir' : 'file'])).entries()].map(
        ([name, kind]) => ({ name, kind }) as never,
      ),
    }
  })
  on('process.run', (_, e) => {
    const [command] = e.argv
    if (command === 'ps' && e.argv.includes('pid=,lstart=') && w.processes === null) throw new Error('no ps')
    if (command === 'sh') w.pidReads++
    if (command === 'git') w.gitDirs.push(e.init?.cwd ?? w.cwd)
    const out =
      command === 'sh'
        ? w.pid && String(w.pid.pid)
        : command === 'ps'
          ? e.argv.includes('pid=,lstart=')
            ? Object.entries(w.processes ?? {})
                .map(([pid, start]) => `${pid} ${start}`)
                .join('\n')
            : w.pid?.start
          : command === 'lsof'
            ? w.lsof === undefined
              ? 'p1\ncnode\nn/'
              : (w.lsof ?? undefined)
            : command === 'gh'
              ? ghAnswer(w, e.argv)
              : gitAnswer(w, e.argv, e.init?.cwd ?? w.cwd)

    return {
      value: {
        exitCode: out === undefined ? 128 : 0,
        stdout: out ?? '',
        stderr: '',
        isStdoutTruncated: command === 'lsof' && !!w.isLsofCut,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.submit', (_, e) => {
    w.sent.push(e.text)

    return { text: e.text }
  })

  return w
}

const agentRow = (id: string, description: string, cwd: string, status = 'running', extra: object = {}) =>
  ({
    id,
    description,
    label: description,
    type: 'general-purpose',
    status,
    model: 'opus',
    tokenCount: 45000,
    tokenSamples: [1000, 20000, 45000],
    startTime: 0,
    cwd,
    kind: 'local_agent',
    taskStatus: status,
    hasRow: true,
    ...extra,
  }) as never

const enters = (on: On, wt: Wt) =>
  on('tool.call', { tool: 'EnterWorktree' }, () => ({
    result: { worktreePath: wt.path, worktreeBranch: wt.branch, message: 'ok' },
  }))

const start = ($: Dollar, cwd = '/repo') => $.session.start({ cwd, surface: 'terminal', isInteractive: true })

const texts = async (
  $: Dollar,
  props: Omit<typeof PANE.props, 'bodyColumns'> & { bodyColumns: number } = PANE.props,
) => {
  const ui = await $.ui.mount({ ...PANE, props, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const found = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()

  return found
}

test('EnterWorktree is tracked, drawn, and Investigate sends a read-only prompt', async ($, on) => {
  const w = world(on, {})
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /⎇ fix-auth/ }))?.text).toContain('★ here')
    expect((await ui.find({ type: 'Text', text: /^made by/ }))?.text).toBe(
      `made by this session at ${AT} · EnterWorktree`,
    )
    await ui.press({ key: `${WT.path}:Investigate` })
    await ui.unmount()
  }

  expect(w.sent.length).toBe(2)
  expect(w.sent[0]).toContain(WT.path)
  expect(w.sent[0]).toContain('Read-only')
  expect(w.sent[0]).toContain('its upstream or default branch')
  expect(w.status).toEqual(['⎇ worktree-fix-auth'])
})

test('git output becomes the card numbers and the file list', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, WT] })
  w.per[WT.path] = {
    status: '?? b.txt',
    revList: '0\t1',
    shortstat: ' 1 file changed, 1 insertion(+)',
    nameStatus: 'A\ta.txt',
    log: 'Add a\u00000 seconds ago',
  }
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /↑/ }))?.text).toBe('worktree-fix-auth  ↑1 ↓0 main · 1 dirty')
  expect((await ui.find({ type: 'Text', text: /█/ }))?.text).toMatch(/^█+ \+1 −0 · 1 files$/)
  expect(await ui.find({ type: 'Text', text: /a\.txt/ })).toBeUndefined()
  await ui.press({ key: `${WT.path}:files` })
  expect((await ui.find({ type: 'Text', text: /a\.txt/ }))?.text).toBe('  A  a.txt')
  expect((await ui.find({ type: 'Text', text: /b\.txt/ }))?.text).toBe('  ?? b.txt (uncommitted)')
  await ui.press({ key: `${WT.path}:Review diff` })
  await ui.unmount()

  expect(w.sent[0]).toContain('git diff main...worktree-fix-auth')
})

test('an agent and ExitWorktree', async ($, on) => {
  world(on, { '/repo': [MAIN, WT, AGENT_WT] })
  enters(on, WT)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: {
      status: 'completed',
      agentId: 'ag1',
      worktreePath: AGENT_WT.path,
      worktreeBranch: AGENT_WT.branch,
    } as never,
  }))
  on('tool.call', { tool: 'ExitWorktree' }, () => ({
    result: { action: 'remove', originalCwd: '/repo', worktreePath: WT.path } as never,
  }))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'Agent', prompt: 'fix it', description: 'fix auth', isolation: 'worktree' })
  await $.tool.call({ tool: 'ExitWorktree', action: 'remove' })

  const found = await texts($)
  expect(found).toContain(`made by subagent «fix auth» at ${AT}`)
  expect(found.find(one => one.startsWith('◆ agent-1'))).not.toContain('running')
  expect(found.some(one => one.startsWith('⎇ fix-auth'))).toBe(false)
  expect(found).toContain(`  ⎇ fix-auth  made by this session at ${AT} · EnterWorktree`)
})

test('a background agent gets its worktree by id, live badge, View, and a done toast', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, AGENT_WT] })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } as never }))
  w.agents = [agentRow('ag1', 'fix auth', AGENT_WT.path)]
  w.per[AGENT_WT.path] = { revList: '0\t1', nameStatus: 'A\ta.txt', status: '?? b.txt' }
  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'fix it', description: 'fix auth', isolation: 'worktree' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /◆ agent-1/ }))?.text).toBe('◆ agent-1  [general-purpose]')
  expect((await ui.find({ type: 'Text', text: /^made by/ }))?.text).toBe(
    `made by subagent «fix auth» at ${AT} · background`,
  )
  expect((await ui.find({ type: 'Text', text: /●/ }))?.text).toBe('● running · opus · 45k tok · 3m ▁▄█')
  expect(await ui.find({ type: 'Text', text: /OTHER WORKTREES/ })).toBeUndefined()
  await ui.press({ key: `${AGENT_WT.path}:view` })
  expect(w.views).toEqual(['ag1'])

  await ui.press({ key: 'refresh' })
  expect(w.toasts).toEqual([])
  w.agents = [agentRow('ag1', 'fix auth', AGENT_WT.path, 'completed')]
  await Promise.all([ui.press({ key: 'refresh' }), $.command.run({ command: 'worktrees' } as never)])
  expect(w.toasts).toEqual(['agent "fix auth" done: ↑1 · 2 files'])
  w.agents = [agentRow('ag1', 'fix auth', AGENT_WT.path, 'completed', { tokenCount: 1_234_567 })]
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /●/ }))?.text).toBe('● completed · opus · 1.2M tok ▁▄█')
  await ui.unmount()
})

test('two worktrees touching one file warn on both cards and in the band', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, WT, AGENT_WT] })
  for (const one of [WT, AGENT_WT]) w.per[one.path] = { nameStatus: 'M\tsrc/a.ts', status: '?? b.txt', revList: '0\t1' }
  enters(on, WT)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: {
      status: 'completed',
      agentId: 'ag1',
      worktreePath: AGENT_WT.path,
      worktreeBranch: AGENT_WT.branch,
    } as never,
  }))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'Agent', prompt: 'fix it', description: 'fix auth', isolation: 'worktree' })

  const found = await texts($)
  expect(found.find(one => one.startsWith('⚠ overlaps agent-1'))).toContain('src/a.ts')
  expect(found.find(one => one.startsWith('⚠ overlaps fix-auth'))).toContain('src/a.ts')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /worktrees/ }))?.text).toBe(
    '⎇ 2 worktrees (◆ 1 agent) · 2 dirty · 0 running · 2 overlap',
  )
  await band.unmount()
})

test('a branch with nothing unmerged and no edits says so', async ($, on) => {
  world(on, { '/repo': [MAIN, WT] })
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  expect(await texts($)).toContain('worktree-fix-auth  ↑0 ↓0 main · clean · nothing unmerged')
})

test('outside a git repo the pane says there is nothing yet and the band stays out', async ($, on) => {
  world(on, {}, '/tmp')
  await start($, '/tmp')

  const found = await texts($)
  expect(found).toContain('No worktrees in this session yet.')
  expect(found.some(one => one.includes('OTHER WORKTREES'))).toBe(false)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /worktree/ })).toBeUndefined()
  await band.unmount()
})

test('a narrow pane drops the bar and shortens the buttons', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, WT] })
  w.per[WT.path] = { status: '?? b.txt', revList: '0\t1', shortstat: ' 1 file changed, 1 insertion(+)' }
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 50 }, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /↑/ }))?.text).toBe('worktree-fix-auth  ↑1 ↓0 main · 1 dirty +1 −0')
  expect(await ui.find({ type: 'Text', text: /█/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: `${WT.path}:Investigate` }))?.text).toBe('Inv')
  await ui.unmount()
})

test('the diff bar scales each card against the largest diff', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, WT, AGENT_WT] })
  w.per[WT.path] = { shortstat: ' 1 file changed, 1 insertion(+), 1 deletion(-)' }
  w.per[AGENT_WT.path] = { shortstat: ' 1 file changed, 4 insertions(+)' }
  enters(on, WT)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: {
      status: 'completed',
      agentId: 'ag1',
      worktreePath: AGENT_WT.path,
      worktreeBranch: AGENT_WT.branch,
    } as never,
  }))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'Agent', prompt: 'fix it', description: 'fix auth', isolation: 'worktree' })

  const found = await texts($)
  expect(found).toContain(`${'█'.repeat(12)}${'░'.repeat(12)} +1 −1 · 1 files`)
  expect(found).toContain(`${'█'.repeat(24)} +4 −0 · 1 files`)
})

test('worktrees of agents and nested subagents no hook saw become this session’s', async ($, on) => {
  const NESTED = { path: '/elsewhere/scan-callers', branch: 'scan-callers' }
  const w = world(on, { '/repo': [MAIN, AGENT_WT, NESTED] })
  w.agents = [
    agentRow('ag1', 'plan auth', AGENT_WT.path),
    agentRow('ag2', 'scan callers', NESTED.path, 'running', { type: 'Explore', parentId: 'ag1' }),
  ]
  await start($)

  const found = await texts($)
  expect(found).toContain('◆ agent-1  [general-purpose]')
  expect(found).toContain('◆ scan-callers  [Explore]')
  expect(found).toContain(`made by subagent «plan auth» at ${clockOf(0, NOW)}`)
  expect(found).toContain('session ▸ "plan auth" ▸ ◆ "scan callers"')
  expect(found.some(one => one.includes('OTHER WORKTREES'))).toBe(false)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /worktrees/ }))?.text).toMatch(/^⎇ 2 worktrees \(◆ 2 agents\) · /)
  await band.unmount()
})

test('the session’s own worktree made before the plugin loaded is found by its lock', async ($, on) => {
  const BUILD = {
    path: '/repo/.claude/worktrees/build',
    branch: 'worktree-build',
    lock: 'claude session build (pid 4242 start Tue Nov 17 07:25:46 2026)',
  }
  const OLD = {
    path: '/repo/.claude/worktrees/old',
    branch: 'worktree-old',
    lock: 'claude session old (pid 4242 start Mon Nov 16 09:00:00 2026)',
  }
  const OTHER = {
    path: '/repo/.claude/worktrees/someone',
    branch: 'worktree-someone',
    lock: 'claude session someone (pid 77 start Tue Nov 17 07:00:00 2026)',
  }
  const w = world(on, { '/repo': [MAIN, BUILD, OLD, OTHER] }, BUILD.path)
  w.pid = { pid: 4242, start: 'Tue Nov 17  07:25:46 2026' }
  await start($, BUILD.path)

  const found = await texts($)
  expect(found).toContain('THIS SESSION  1 worktree')
  expect(found).toContain('made by this session · EnterWorktree')
  expect(found).toContain('OTHER WORKTREES IN repo  2 in 1 repository')
  expect(found.some(one => one.startsWith('    ● old'))).toBe(true)
  expect(found.some(one => one.startsWith('    ● someone'))).toBe(true)
  const reads = w.pidReads
  await texts($)
  expect(w.pidReads).toBe(reads)
})

test('git worktree add through Bash, by the session or a subagent, in any folder or repository', async ($, on) => {
  const w = world(on, { '/repo': [MAIN], '/other': [{ path: '/other', branch: 'main' }] })
  w.agents = [agentRow('ag1', 'build feature', '/repo')]
  const made: Record<string, [string, Wt]> = {
    'git worktree add -q ../work/side -b side': ['/repo', { path: '/work/side', branch: 'side' }],
    'mkdir -p /repo/tmp/build && cd /repo/tmp/build && git worktree add ../../wt-x -b x': [
      '/repo',
      { path: '/repo/wt-x', branch: 'x' },
    ],
    'git worktree add /tmp/y -b y': ['/repo', { path: '/tmp/y', branch: 'y' }],
    'git -C /other worktree add .claude/worktrees/z -b z': [
      '/other',
      { path: '/other/.claude/worktrees/z', branch: 'z' },
    ],
  }
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    const [repo, wt] = made[e.command] ?? []
    if (repo && wt) w.repos[repo]?.push(wt)
    if (wt?.branch === 'side') w.repos['/repo']?.push({ path: '/repo/.claude/worktrees/agent-zz', branch: 'agent-zz' })
    w.gone.delete('/repo/tmp/build')

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git worktree add -q ../work/side -b side' })
  await $.tool.call({ tool: 'Bash', command: 'git worktree add /tmp/y -b y', agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git -C /other worktree add .claude/worktrees/z -b z' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  w.gone.add('/repo/tmp/build')
  await $.tool.call({
    tool: 'Bash',
    command: 'mkdir -p /repo/tmp/build && cd /repo/tmp/build && git worktree add ../../wt-x -b x',
  })

  const found = await texts($)
  expect(found).toContain('THIS SESSION  4 worktrees')
  expect(found).toContain('◆ y')
  expect(found.some(one => one.startsWith('    ● agent-zz'))).toBe(true)
  expect(found.filter(one => one === `made by this session at ${AT} · git worktree add`).length).toBe(3)
  expect(found).toContain(`made by subagent «build feature» at ${AT} · git worktree add`)
  expect(found).toContain('other · z  ↑0 ↓0 main · clean · nothing unmerged')
})

test('failed worktree calls are listed one line each', async ($, on) => {
  const w = world(on, { '/repo': [MAIN] })
  w.agents = [agentRow('ag1', 'probe subagent calls', '/repo')]
  on('tool.call', { tool: 'Bash' }, () => ({
    isError: true,
    result: undefined,
    text: 'Exit code 128\nfatal: invalid reference: .',
  }))
  on('tool.call', { tool: 'EnterWorktree' }, () => ({
    isError: true,
    result: undefined,
    text: '<tool_use_error>EnterWorktree cannot create a worktree from a subagent</tool_use_error>',
  }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git worktree add -q ../sub-side -b sub-side .', agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'EnterWorktree', name: 'sub-enter', agentId: 'ag1' } as never)

  const found = await texts($)
  expect(found).toContain('PROBLEMS IN THIS SESSION  2 failed worktree calls')
  expect(found).toContain(`✗ ${AT}  subagent «probe subagent calls»  add ../sub-side  invalid reference: .`)
  const refused = found.find(one =>
    one.startsWith(`✗ ${AT}  subagent «probe subagent calls»  enter sub-enter  EnterWorktree cannot`),
  )
  expect(refused?.length).toBeLessThanOrEqual(100)
  expect(refused?.endsWith('…')).toBe(true)
  expect(w.status).toEqual([])

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /worktree/ }))?.text).toContain('· 2 failed calls')
  await band.unmount()
})

test('two background agents with one description each get their own folder; one that left nothing goes', async ($, on) => {
  const A = { path: '/repo/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1' }
  const B = { path: '/repo/.claude/worktrees/agent-b2', branch: 'worktree-agent-b2' }
  const w = world(on, { '/repo': [MAIN, A, B] })
  w.agents = [
    agentRow('a1', 'fix tests', A.path),
    agentRow('b2', 'fix tests', B.path),
    agentRow('c3', 'quick look', '/repo/.claude/worktrees/agent-c3', 'completed'),
  ]
  const ids = ['a1', 'b2', 'c3']
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: ids.shift() } as never }))
  await start($)
  for (const description of ['fix tests', 'fix tests', 'quick look'])
    await $.tool.call({ tool: 'Agent', prompt: 'p', description, isolation: 'worktree' })

  const found = await texts($)
  expect(found).toContain('THIS SESSION  2 worktrees')
  expect(found.filter(one => one.startsWith('◆ agent-')).sort()).toEqual([
    '◆ agent-a1  [general-purpose]',
    '◆ agent-b2  [general-purpose]',
  ])
  expect(found.some(one => one.includes('creating'))).toBe(false)
})

test('an agent’s worktree stays this session’s after the agent ends; the line is drawn on the innermost one', async ($, on) => {
  const BUILD = { path: '/repo/.claude/worktrees/build', branch: 'worktree-build' }
  const INNER = { path: '/repo/.claude/worktrees/build/.worktrees/inner', branch: 'inner' }
  const OUT = { path: '/work/agent-made', branch: 'agent-made' }
  const w = world(on, { '/repo': [MAIN, BUILD, INNER, OUT] })
  w.agents = [agentRow('a1', 'inner work', INNER.path), agentRow('b2', 'outside work', OUT.path)]
  enters(on, BUILD)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'build' })

  const running = await texts($)
  expect(running).toContain('THIS SESSION  3 worktrees')
  expect(running.filter(one => one.startsWith('● running')).length).toBe(2)
  const buildCard = running.slice(running.indexOf('⎇ build  ★ here'), running.indexOf('◆ inner  [general-purpose]'))
  expect(buildCard.some(one => one.startsWith('● running'))).toBe(false)

  w.agents = []
  const ended = await texts($)
  expect(ended).toContain('THIS SESSION  3 worktrees')
  expect(ended).toContain(`made by subagent «outside work» at ${clockOf(0, NOW)}`)
  expect(ended.some(one => one.includes('OTHER WORKTREES'))).toBe(false)
})

test('other worktrees are one line each, folded by repository, within the pane width', async ($, on) => {
  const O1 = { path: '/repo/.claude/worktrees/fix-login', branch: 'fix/login-timeout-handling' }
  const O2 = { path: '/repo/.claude/worktrees/docs-install-steps', branch: 'docs/install-steps-for-windows' }
  const O3 = { path: '/other/.claude/worktrees/spike', branch: 'spike-cache' }
  const w = world(on, { '/repo': [MAIN, WT, O1, O2], '/other': [{ path: '/other', branch: 'main' }, O3] })
  w.per[O1.path] = { status: ' M a\n M b\n M c\n M d', committed: String(NOW / 1000 - 4 * 86400) }
  w.per[O2.path] = { committed: String(NOW / 1000 - 6 * 86400) }
  enters(on, WT)
  on('tool.call', { tool: 'Bash' }, () => {
    w.repos['/other']?.push({ path: '/other/.claude/worktrees/mine', branch: 'mine' })

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'Bash', command: 'git -C /other worktree add .claude/worktrees/mine' })

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 55 }, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const lines = async () =>
    (await ui.findAll({ type: 'Text' }))
      .map(one => one.text)
      .filter(one => /^ {2}\S.* · \d+$|^ {4}● |^ {6}\S/.test(one))
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).toContain(
    'OTHER WORKTREES IN THE SESSION’S REPOS  3 in 2 repositories',
  )
  expect(await lines()).toEqual([
    '  Needs a look · 2',
    '    ● docs-instal…  docs/instal…  PR unknown        6 d',
    '    ● fix-login     fix/login-t…  PR unknown        4 d',
    '      4 uncommitted files',
  ])
  for (const line of await lines()) expect(line.length).toBeLessThanOrEqual(55)
  const counts = async () => (await ui.findAll({ type: 'Text' })).map(one => one.text).filter(one => / look$/.test(one))
  expect(await counts()).toEqual(['  1 needs a look', '1 needs a look'])
  const rules = (await ui.findAll({ type: 'Text' })).map(one => one.text).filter(one => /^ {4}─+$/.test(one))
  expect(rules).toEqual(['    ' + '─'.repeat(51)])
  await ui.press({ key: 'repo:/other' })
  expect(await counts()).toEqual([])
  expect(await lines()).toContain('    ● spike         spike-cache   PR unknown        0 d')
  await ui.unmount()
})

test('a foreground agent leaves no card once it ends with nothing to keep', async ($, on) => {
  const w = world(on, { '/repo': [MAIN] })
  on('agent.spawn', () => ({ model: 'opus', agentId: 'ag1' }))
  on('tool.call', { tool: 'Agent' }, async (_, e) => {
    await $.agent.spawn({ tool_use_id: e.tool_use_id, prompt: 'p', description: 'fix auth' } as never)
    w.repos['/repo']?.push(AGENT_WT)
    w.agents = [agentRow('ag1', 'fix auth', AGENT_WT.path)]
    await $.command.run({ command: 'worktrees' } as never)
    w.repos['/repo'] = [MAIN]
    w.gone.add(AGENT_WT.path)
    w.agents = []

    return { result: { status: 'completed', agentId: 'ag1' } as never }
  })
  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'fix auth', isolation: 'worktree' })

  expect(await texts($)).toContain('No worktrees in this session yet.')
})

test('a background agent’s worktree goes once the agent ends and Claude Code deletes it', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, AGENT_WT] })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } as never }))
  w.agents = [agentRow('ag1', 'fix auth', AGENT_WT.path)]
  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'fix auth', isolation: 'worktree' })
  expect(await texts($)).toContain('THIS SESSION  1 worktree')

  w.agents = [agentRow('ag1', 'fix auth', AGENT_WT.path, 'completed')]
  w.repos['/repo'] = [MAIN]
  w.gone.add(AGENT_WT.path)
  expect(await texts($)).toContain('No worktrees in this session yet.')
  expect(w.toasts).toEqual(['agent "fix auth" done: ↑0 · 0 files'])
})

test('entering a removed worktree again shows it as here, not removed', async ($, on) => {
  world(on, { '/repo': [MAIN, WT] })
  enters(on, WT)
  on('tool.call', { tool: 'ExitWorktree' }, () => ({
    result: { action: 'remove', originalCwd: '/repo', worktreePath: WT.path } as never,
  }))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'ExitWorktree', action: 'remove' })
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  expect(await texts($)).toContain('⎇ fix-auth  ★ here')
})

test('an Agent call that fails part way leaves no card behind', async ($, on) => {
  world(on, { '/repo': [MAIN] })
  on('tool.call', { tool: 'Agent' }, () => {
    throw new Error('interrupted')
  })
  await start($)
  await $.tool
    .call({ tool: 'Agent', prompt: 'p', description: 'fix auth', isolation: 'worktree' })
    .catch(() => undefined)

  expect(await texts($)).toContain('No worktrees in this session yet.')
})

test('entering a worktree the refresh found by its lock says who entered it and when', async ($, on) => {
  const BUILD = {
    path: '/repo/.claude/worktrees/build',
    branch: 'worktree-build',
    lock: 'claude session build (pid 4242 start Tue Nov 17 07:25:46 2026)',
  }
  const w = world(on, { '/repo': [MAIN, BUILD] })
  w.pid = { pid: 4242, start: 'Tue Nov 17 07:25:46 2026' }
  enters(on, BUILD)
  await start($)
  expect(await texts($)).toContain('made by this session · EnterWorktree')
  await $.tool.call({ tool: 'EnterWorktree', path: BUILD.path } as never)

  expect(await texts($)).toContain(`entered by this session at ${AT} · EnterWorktree`)
})

test('a worktree made again where a removed one was shows as live', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, WT] })
  enters(on, WT)
  on('tool.call', { tool: 'ExitWorktree' }, () => {
    w.repos['/repo'] = [MAIN]

    return { result: { action: 'remove', originalCwd: '/repo', worktreePath: WT.path } as never }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    w.repos['/repo']?.push(WT)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'ExitWorktree', action: 'remove' })
  await $.tool.call({ tool: 'Bash', command: 'git worktree add .claude/worktrees/fix-auth' })

  const found = await texts($)
  expect(found).toContain('⎇ fix-auth')
  expect(found).toContain(`made by this session at ${AT} · git worktree add`)
})

test('a finished agent outside any repository costs no git run on each refresh', async ($, on) => {
  const w = world(on, { '/repo': [MAIN] })
  w.agents = [agentRow('ag1', 'scratch work', '/scratch', 'completed')]
  await start($)
  await texts($)
  await texts($)

  expect(w.gitDirs.filter(dir => dir === '/scratch')).toEqual([])
})

test('a subagent with no worktree of its own is not drawn on the session’s worktree', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, WT] })
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  w.agents = [agentRow('ex1', 'look around', WT.path, 'running', { type: 'Explore' })]

  expect((await texts($)).some(one => one.startsWith('● running'))).toBe(false)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /worktree/ }))?.text).toContain('0 running')
  await band.unmount()
})

test('a worktree a subagent removed and the session makes again is the session’s, and stays here', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, WT] })
  w.agents = [agentRow('ag1', 'try fix', '/repo')]
  enters(on, WT)
  on('tool.call', { tool: 'ExitWorktree' }, () => ({
    result: { action: 'remove', originalCwd: '/repo', worktreePath: WT.path } as never,
  }))
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth', agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'ExitWorktree', action: 'remove', agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth', agentId: 'ag1' } as never)

  const found = await texts($)
  expect(found).toContain(`made by this session at ${AT} · EnterWorktree`)
  expect(found).toContain('⎇ fix-auth  ★ here')
})

test('git worktree add in the main session runs where the session is', async ($, on) => {
  const OTHER_WT = { path: '/other/.claude/worktrees/w', branch: 'w' }
  const w = world(on, { '/repo': [MAIN], '/other': [{ path: '/other', branch: 'main' }, OTHER_WT] })
  enters(on, OTHER_WT)
  on('tool.call', { tool: 'Bash' }, () => {
    w.repos['/other']?.push({ path: '/other/.claude/worktrees/x', branch: 'x' })

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'w' })
  await $.tool.call({ tool: 'Bash', command: 'git worktree add ../x -b x' })

  expect(await texts($)).toContain('THIS SESSION  2 worktrees')
})

test('the same file changed in worktrees of two repositories is no overlap', async ($, on) => {
  const Z = { path: '/other/.claude/worktrees/z', branch: 'z' }
  const w = world(on, { '/repo': [MAIN, WT], '/other': [{ path: '/other', branch: 'main' }] })
  w.per[WT.path] = { nameStatus: 'M\tREADME.md' }
  w.per[Z.path] = { nameStatus: 'M\tREADME.md' }
  enters(on, WT)
  on('tool.call', { tool: 'Bash' }, () => {
    w.repos['/other']?.push(Z)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'Bash', command: 'git -C /other worktree add .claude/worktrees/z' })

  const found = await texts($)
  expect(found).toContain('THIS SESSION  2 worktrees')
  expect(found.some(one => one.startsWith('⚠ overlaps'))).toBe(false)
})

test('other worktrees show short branch names too', async ($, on) => {
  const X = { path: '/repo/.claude/worktrees/x', branch: 'fix-x' }
  world(on, { '/repo': [MAIN, WT, X] })
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  expect(await texts($)).toContain('    ● x  fix-x  PR unknown        0 d')
})

test('a helper an agent starts in its worktree does not take over the agent’s line', async ($, on) => {
  const w = world(on, { '/repo': [MAIN, AGENT_WT] })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } as never }))
  w.agents = [
    agentRow('ag1', 'fix auth', AGENT_WT.path),
    agentRow('h1', 'run tests', AGENT_WT.path, 'completed', { startTime: 60000, parentId: 'ag1' }),
  ]
  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'fix auth', isolation: 'worktree' })

  const found = await texts($)
  expect(found.some(one => one.startsWith('● running'))).toBe(true)
  expect(found.some(one => one.startsWith('● completed'))).toBe(false)
})

test('an agent call that fails after the agent made its worktree keeps the worktree', async ($, on) => {
  const w = world(on, { '/repo': [MAIN] })
  on('agent.spawn', () => ({ model: 'opus', agentId: 'ag1' }))
  on('tool.call', { tool: 'Agent' }, async (_, e) => {
    await $.agent.spawn({ tool_use_id: e.tool_use_id, prompt: 'p', description: 'fix auth' } as never)
    w.repos['/repo']?.push(AGENT_WT)
    w.agents = [agentRow('ag1', 'fix auth', AGENT_WT.path)]
    await $.command.run({ command: 'worktrees' } as never)
    w.agents = []
    throw new Error('interrupted')
  })
  await start($)
  await $.tool
    .call({ tool: 'Agent', prompt: 'p', description: 'fix auth', isolation: 'worktree' })
    .catch(() => undefined)

  const found = await texts($)
  expect(found).toContain('THIS SESSION  1 worktree')
  expect(found.some(one => one.startsWith('◆ agent-1'))).toBe(true)
})

test('a background agent that ends before a refresh, in a repository not listed yet, keeps its worktree', async ($, on) => {
  const B = { path: '/b/.claude/worktrees/agent-ag1', branch: 'worktree-agent-ag1' }
  const w = world(on, { '/repo': [MAIN], '/b': [{ path: '/b', branch: 'main' }, B] })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } as never }))
  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'p', description: 'fix auth', isolation: 'worktree' })
  w.agents = [agentRow('ag1', 'fix auth', B.path, 'completed')]

  const found = await texts($)
  expect(found).toContain('THIS SESSION  1 worktree')
  expect(found.some(one => one.startsWith('◆ agent-ag1'))).toBe(true)
})

test('a worktree removed with git shows as removed and leaves the counts', async ($, on) => {
  const SIDE = { path: '/repo/.claude/worktrees/side', branch: 'side' }
  const w = world(on, { '/repo': [MAIN] })
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    if (e.command.includes(' add ')) w.repos['/repo']?.push(SIDE)
    else {
      w.repos['/repo'] = [MAIN]
      w.gone.add(SIDE.path)
    }

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  await start($)
  w.pulls = { side: [{ number: 3, state: 'MERGED', title: 'Side' }] }
  await $.tool.call({ tool: 'Bash', command: 'git worktree add .claude/worktrees/side -b side' })
  await texts($)
  await $.tool.call({ tool: 'Bash', command: 'git worktree remove .claude/worktrees/side' })

  const found = await texts($)
  expect(found).toContain('No worktrees left; the removed ones are below.')
  expect(found[found.indexOf('REMOVED  1 worktree this session made') - 1]).toBe(' ')
  expect(found.at(-1)).toBe(`  ⎇ side  PR #3 merged  made by this session at ${AT} · git worktree add`)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /worktree/ })).toBeUndefined()
  await band.unmount()
})

test('a repository the person opened stays open when the order of repositories changes', async ($, on) => {
  const B1 = { path: '/other/.claude/worktrees/b1', branch: 'b1' }
  const B2 = { path: '/other/.claude/worktrees/b2', branch: 'b2' }
  const A1 = { path: '/repo/.claude/worktrees/a1', branch: 'a1' }
  const w = world(on, { '/repo': [MAIN, WT, A1], '/other': [{ path: '/other', branch: 'main' }, B2] })
  const entered = [WT, B1]
  on('tool.call', { tool: 'EnterWorktree' }, () => {
    const wt = entered.shift() ?? WT

    return { result: { worktreePath: wt.path, worktreeBranch: wt.branch, message: 'ok' } }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    w.repos['/other']?.push(B1)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  await $.tool.call({ tool: 'Bash', command: 'git -C /other worktree add .claude/worktrees/b1 -b b1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const rows = async () =>
    (await ui.findAll({ type: 'Text' })).map(one => one.text.trimStart()).filter(one => one.startsWith('● '))
  expect((await rows()).some(one => one.startsWith('● b2'))).toBe(false)
  await ui.press({ key: 'repo:/other' })
  expect((await rows()).some(one => one.startsWith('● b2'))).toBe(true)
  await $.tool.call({ tool: 'EnterWorktree', path: B1.path } as never)
  await ui.press({ key: 'refresh' })
  expect((await rows()).some(one => one.startsWith('● b2'))).toBe(true)
  await ui.unmount()
})

test('a failed check of the session’s process is not repeated on every refresh', async ($, on) => {
  const OTHER = {
    path: '/repo/.claude/worktrees/someone',
    branch: 'worktree-someone',
    lock: 'claude session someone (pid 77 start Tue Nov 17 07:00:00 2026)',
  }
  const w = world(on, { '/repo': [MAIN, OTHER] })
  await start($)
  await texts($)
  await texts($)

  expect(w.pidReads).toBe(1)
})

test('worktrees the session and its subagents made before the plugin loaded are read from their transcripts', async ($, on) => {
  const X = { path: '/other/.claude/worktrees/x', branch: 'x' }
  const Y = { path: '/repo/.claude/worktrees/y', branch: 'y' }
  const S1 = { path: '/repo/.claude/worktrees/agent-s1', branch: 'worktree-agent-s1' }
  const S2 = { path: '/repo/.claude/worktrees/side', branch: 'side' }
  const w = world(on, { '/repo': [MAIN, Y, S1, S2], '/other': [{ path: '/other', branch: 'main' }, X] }, '/home/u')
  const AT1 = '2026-11-12T08:38:41.000Z'
  w.files['/t/s.jsonl'] = [
    {
      type: 'assistant',
      cwd: '/repo',
      timestamp: AT1,
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'cd /other && git worktree add .claude/worktrees/x' } },
        ],
      },
    },
    {
      type: 'user',
      cwd: '/repo',
      timestamp: AT1,
      toolUseResult: { worktreePath: Y.path, message: 'Created worktree at y' },
    },
    {
      type: 'assistant',
      cwd: '/repo',
      timestamp: AT1,
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git worktree add .claude/worktrees/gone' } }],
      },
    },
  ]
    .map(line => JSON.stringify(line))
    .join('\n')
  w.files['/t/s/subagents/agent-s1.jsonl'] = [
    { type: 'user', cwd: S1.path, timestamp: AT1, agentId: 's1' },
    {
      type: 'assistant',
      cwd: S1.path,
      timestamp: AT1,
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git worktree add ../side -b side' } }],
      },
    },
  ]
    .map(line => JSON.stringify(line))
    .join('\n')
  w.files['/t/s/subagents/agent-s1.meta.json'] = JSON.stringify({
    description: 'old helper',
    requestShape: 'background',
  })
  w.mtimes[`${X.path}/.git`] = Date.parse(AT1) + 2000
  w.mtimes[`${S2.path}/.git`] = Date.parse(AT1) + 2000
  await start($, '/home/u')

  const found = await texts($)
  const at = clockOf(Date.parse(AT1), NOW)
  expect(found).toContain('THIS SESSION  4 worktrees')
  expect(at).toMatch(/^12 Nov 2026 \d\d:\d\d$/)
  expect(found).toContain(`made by this session at ${at} · git worktree add`)
  expect(found).toContain(`made by this session at ${at} · EnterWorktree`)
  expect(found).toContain(`made by subagent «old helper» at ${at} · background`)
  expect(found).toContain(`made by subagent «old helper» at ${at} · git worktree add`)
})

test('a made-by time names the day when it is not today', async () => {
  const now = new Date(2026, 10, 17, 18, 5).getTime()
  expect(clockOf(new Date(2026, 10, 17, 9, 7).getTime(), now)).toBe('09:07')
  expect(clockOf(new Date(2026, 10, 12, 13, 1).getTime(), now)).toBe('12 Nov 13:01')
  expect(clockOf(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe('31 Dec 2025 23:59')
})

test('this session lists its newest worktree first', async ($, on) => {
  const OLD = { path: '/repo/.claude/worktrees/old', branch: 'old' }
  const NEW = { path: '/repo/.claude/worktrees/new', branch: 'new' }
  const w = world(on, { '/repo': [MAIN, OLD, NEW] })
  const made = (path: string, timestamp: string) =>
    JSON.stringify({
      type: 'user',
      cwd: '/repo',
      timestamp,
      toolUseResult: { worktreePath: path, message: 'Created worktree' },
    })
  w.files['/t/s.jsonl'] = [made(OLD.path, '2026-06-30T19:28:55.000Z'), made(NEW.path, '2026-10-28T12:30:00.000Z')].join(
    '\n',
  )
  await start($)

  const found = await texts($)
  const newer = found.findIndex(text => text.includes(`at ${clockOf(Date.parse('2026-10-28T12:30:00.000Z'), NOW)}`))
  const older = found.findIndex(text => text.includes(`at ${clockOf(Date.parse('2026-06-30T19:28:55.000Z'), NOW)}`))
  expect(newer).toBeGreaterThan(-1)
  expect(older).toBeGreaterThan(newer)
})

const bashLine = (cwd: string, timestamp: string, command: string) =>
  JSON.stringify({
    type: 'assistant',
    cwd,
    timestamp,
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  })

test('a Bash add in a transcript counts only when the worktree was made then', async ($, on) => {
  const OLD = { path: '/repo/.claude/worktrees/old', branch: 'old' }
  const MADE = { path: '/repo/.claude/worktrees/made', branch: 'made' }
  const w = world(on, { '/repo': [MAIN, OLD, MADE] })
  const at = '2026-11-10T09:42:00.000Z'
  w.files['/t/s.jsonl'] = [
    bashLine('/repo', at, 'git worktree add .claude/worktrees/old'),
    bashLine('/repo', at, 'git worktree add .claude/worktrees/made'),
  ].join('\n')
  w.mtimes[`${OLD.path}/.git`] = Date.parse('2026-10-08T10:08:51.000Z')
  w.mtimes[`${MADE.path}/.git`] = Date.parse(at) + 3000
  await start($)

  const found = await texts($)
  expect(found).toContain('THIS SESSION  1 worktree')
  expect(found.some(text => text.startsWith('⎇ made'))).toBe(true)
  expect(found.some(text => text.startsWith('⎇ old'))).toBe(false)
})

test('workflow agents are read, and an unreadable transcript skips only itself', async ($, on) => {
  const A = { path: '/repo/.claude/worktrees/from-workflow', branch: 'a' }
  const B = { path: '/repo/.claude/worktrees/from-main', branch: 'b' }
  const w = world(on, { '/repo': [MAIN, A, B] })
  const at = '2026-11-12T08:00:00.000Z'
  w.files['/t/s.jsonl'] = bashLine('/repo', at, 'git worktree add .claude/worktrees/from-main')
  w.files['/t/s/subagents/workflows/wf_1/agent-w1.jsonl'] = bashLine(
    '/repo',
    at,
    'git worktree add .claude/worktrees/from-workflow',
  )
  w.files['/t/s/subagents/agent-bad.jsonl'] = 'x'
  w.unreadable.add('/t/s/subagents/agent-bad.jsonl')
  w.mtimes[`${A.path}/.git`] = Date.parse(at)
  w.mtimes[`${B.path}/.git`] = Date.parse(at)
  await start($)

  const found = await texts($)
  expect(found).toContain('THIS SESSION  2 worktrees')
  expect(found.some(text => text.includes('made by subagent «w1»'))).toBe(true)
})

test('a card lists the PRs of the branches made in its worktree, newest first', async ($, on) => {
  const W = { path: '/repo/.claude/worktrees/setup', branch: 'fix/now' }
  const w = world(on, { '/repo': [MAIN, W] })
  const at = '2026-11-11T13:48:00.000Z'
  const moved = (cwd: string) => JSON.stringify({ type: 'user', cwd, message: { content: [{ type: 'tool_result' }] } })
  w.files['/t/s.jsonl'] = [
    bashLine('/repo', '2026-10-28T12:30:00.000Z', 'git worktree add -b fix/first .claude/worktrees/setup origin/main'),
    moved(W.path),
    bashLine(W.path, at, 'git fetch -q origin main && git switch -c fix/second origin/main'),
    bashLine(W.path, at, 'cd /repo/.claude/worktrees/setup && git checkout -b fix/third'),
    moved('/repo'),
    bashLine('/repo', at, 'git switch -c elsewhere'),
  ].join('\n')
  w.mtimes[`${W.path}/.git`] = Date.parse('2026-10-28T12:30:05.000Z')
  w.pulls = {
    'fix/first': [{ number: 170, state: 'MERGED', title: 'First change' }],
    'fix/second': [{ number: 175, state: 'CLOSED', title: 'Second change' }],
    'fix/now': [{ number: 180, state: 'OPEN', title: 'Current change' }],
    elsewhere: [{ number: 1, state: 'OPEN', title: 'Not from this worktree' }],
  }
  await start($)
  await texts($)

  const found = await texts($)
  const rows = found.filter(text => text.startsWith('PR #') && text.includes(' · '))
  expect(rows).toEqual([
    'PR #180 open · Current change',
    'PR #175 closed · Second change',
    'PR #170 merged · First change',
  ])
})

test('a card shows its three newest PRs, and its more-PRs button shows the rest', async ($, on) => {
  const W = { path: '/repo/.claude/worktrees/setup', branch: 'b6' }
  const w = world(on, { '/repo': [MAIN, W] })
  enters(on, W)
  w.pulls = Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map(n => [n === 6 ? 'b6' : `b${n}`, [{ number: n, state: 'MERGED', title: `change ${n}` }]]),
  )
  w.files['/t/s.jsonl'] = [1, 2, 3, 4, 5, 7]
    .map(n => bashLine(W.path, '2026-11-11T13:48:00.000Z', `git switch -c b${n}`))
    .join('\n')
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', input: {} } as never).catch(() => undefined)
  await texts($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const rows = async () =>
    (await ui.findAll({ type: 'Text' })).filter(one => one.text.startsWith('PR #') && one.text.includes(' · '))
  const more = async () => (await ui.find({ type: 'Button', key: `${W.path}:pulls` }))?.text
  expect((await rows()).map(one => one.text.split(' · ')[0])).toEqual(['PR #7 merged', 'PR #6 merged', 'PR #5 merged'])
  expect(await more()).toBe('+4 more PRs')
  await ui.press({ key: `${W.path}:pulls` })
  expect(await rows()).toHaveLength(7)
  expect(await more()).toBe('Fewer PRs')
  await ui.press({ key: `${W.path}:pulls` })
  expect(await rows()).toHaveLength(3)
  await ui.unmount()
})

test('without gh a card says PR unknown and nothing is reported', async ($, on) => {
  const W = { path: '/repo/.claude/worktrees/setup', branch: 'fix/now' }
  const w = world(on, { '/repo': [MAIN, W] })
  w.files['/t/s.jsonl'] = bashLine('/repo', '2026-10-28T12:30:00.000Z', 'git worktree add .claude/worktrees/setup')
  w.mtimes[`${W.path}/.git`] = Date.parse('2026-10-28T12:30:00.000Z')
  await start($)
  await texts($)

  const found = await texts($)
  expect(found).toContain('THIS SESSION  1 worktree')
  expect(found.some(text => text.startsWith('PR #'))).toBe(false)
  expect(found).toContain('PR unknown')
  expect(found.some(text => text.includes('PROBLEMS'))).toBe(false)
})

test('the worktree the session is in, and one found by its lock, come before older ones', async ($, on) => {
  const OLD = { path: '/repo/.claude/worktrees/fix-auth', branch: 'old' }
  const NEW = { path: '/repo/.claude/worktrees/new', branch: 'new' }
  const LOCKED = {
    path: '/repo/.claude/worktrees/locked',
    branch: 'locked',
    lock: 'claude session locked (pid 42 start Tue Nov 17 07:25:46 2026)',
  }
  const w = world(on, { '/repo': [MAIN, OLD, NEW, LOCKED] })
  w.pid = { pid: 42, start: 'Tue Nov 17 07:25:46 2026' }
  enters(on, OLD)
  const made = (path: string, timestamp: string) =>
    JSON.stringify({
      type: 'user',
      cwd: '/repo',
      timestamp,
      toolUseResult: { worktreePath: path, message: 'Created worktree' },
    })
  w.files['/t/s.jsonl'] = [
    made(OLD.path, '2026-06-30T19:28:55.000Z'),
    made(NEW.path, '2026-10-28T12:30:00.000Z'),
    made('/repo/x', 'bad'),
  ].join('\n')
  await start($)
  await texts($)
  let found = await texts($)
  const index = (name: string) => found.findIndex(text => text.startsWith(`⎇ ${name}`))
  expect(index('locked')).toBeGreaterThan(-1)
  expect(index('locked')).toBeLessThan(index('new'))
  expect(index('new')).toBeLessThan(index('fix-auth'))
  expect(found.some(text => text.includes('NaN'))).toBe(false)

  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })
  found = await texts($)
  expect(index('fix-auth')).toBeLessThan(index('locked'))
})

test('a card keeps PRs only of its branches opened by this gh account, and keeps them once removed', async ($, on) => {
  const W = { path: '/repo/.claude/worktrees/setup', branch: 'fix/now' }
  const w = world(on, { '/repo': [MAIN, W] })
  w.files['/t/s.jsonl'] = bashLine('/repo', '2026-10-28T12:30:00.000Z', 'git worktree add .claude/worktrees/setup')
  w.mtimes[`${W.path}/.git`] = Date.parse('2026-10-28T12:30:00.000Z')
  w.pulls = {
    'fix/now': [
      { number: 180, state: 'OPEN', title: 'Mine' },
      { number: 99, state: 'OPEN', title: 'From a fork', author: { login: 'someone' } },
    ],
    'feature/other': [{ number: 50, state: 'OPEN', title: 'Looked at only' }],
  }
  await start($)
  await texts($)
  const rows = async () => (await texts($)).filter(text => text.startsWith('PR #') && text.includes(' · '))
  expect(await rows()).toEqual(['PR #180 open · Mine'])

  W.branch = 'feature/other'
  await texts($)
  expect(await rows()).toEqual(['PR #50 open · Looked at only'])
  W.branch = 'main'
  await texts($)
  expect(await rows()).toEqual([])
  W.branch = 'fix/now'
  await texts($)
  expect(await rows()).toEqual(['PR #180 open · Mine'])

  w.gone.add(W.path)
  await texts($)
  expect(await rows()).toEqual([])
  expect((await texts($)).at(-1)).toMatch(/^  ⎇ setup  PR #180  made by this session at .+ · git worktree add$/)
})

test('a branch made by Bash after the plugin loaded counts for its worktree', async ($, on) => {
  const W = { path: '/repo/.claude/worktrees/setup', branch: 'fix/new' }
  const w = world(on, { '/repo': [MAIN, W] })
  enters(on, W)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } as never }))
  w.pulls = { 'fix/old': [{ number: 7, state: 'MERGED', title: 'Made here earlier' }] }
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'setup' })
  await $.tool.call({ tool: 'Bash', command: 'git switch -c fix/old' } as never)
  await texts($)

  const found = await texts($)
  expect(found.filter(text => text.startsWith('PR #') && text.includes(' · '))).toEqual([
    'PR #7 merged · Made here earlier',
  ])
})

const CLEAN: Facts = {
  exists: true,
  branch: 'b',
  lockIsLive: false,
  hasProcessInside: false,
  isUnread: false,
  uncommittedFiles: 0,
  commitsOnNoRemote: 0,
  pr: 'merged',
}
const ONE_REASON: [string, Partial<Facts>, string, string[]][] = [
  ['a live lock', { lockIsLive: true }, 'in-use', ['live-lock']],
  ['a process inside', { hasProcessInside: true }, 'in-use', ['process-inside']],
  ['a gone folder', { exists: false, pr: 'none' }, 'can-be-removed', ['folder-gone']],
  [
    'a gone folder with commits on no remote',
    { exists: false, commitsOnNoRemote: 1 },
    'needs-a-look',
    ['folder-gone', 'commits-on-no-remote'],
  ],
  ['a gone folder git could not read', { exists: false, isUnread: true }, 'needs-a-look', ['folder-gone', 'unread']],
  ['a fact that could not be read', { isUnread: true }, 'needs-a-look', ['unread']],
  ['uncommitted files', { uncommittedFiles: 2 }, 'needs-a-look', ['uncommitted-files']],
  ['commits on no remote', { commitsOnNoRemote: 1 }, 'needs-a-look', ['commits-on-no-remote']],
  ['a branch with no PR', { pr: 'none' }, 'needs-a-look', ['no-pr']],
  ['PR state unknown', { pr: 'unknown' }, 'needs-a-look', ['pr-unknown']],
  ['no branch, nothing to lose', { branch: null, pr: 'none' }, 'can-be-removed', ['detached-on-remote']],
  ['no branch, uncommitted files', { branch: null, uncommittedFiles: 1 }, 'needs-a-look', ['uncommitted-files']],
  ['an open PR', { pr: 'open' }, 'pr-open', []],
  ['a merged PR', { pr: 'merged' }, 'can-be-removed', ['pr-merged']],
  ['a closed PR', { pr: 'closed' }, 'can-be-removed', ['pr-closed']],
]

test('groupOf puts each fact in the worktrees mod group', () => {
  for (const [, facts, group, reasons] of ONE_REASON)
    expect(groupOf({ ...CLEAN, ...facts })).toEqual({ group, reasons })
  for (const sign of [{ lockIsLive: true }, { hasProcessInside: true }])
    expect(groupOf({ ...CLEAN, ...sign, uncommittedFiles: 3, isUnread: true }).group).toBe('in-use')
  const atRisk: Partial<Facts>[] = [
    { uncommittedFiles: 1 },
    { commitsOnNoRemote: 1 },
    { pr: 'none' },
    { pr: 'unknown' },
    { isUnread: true },
    { branch: null, commitsOnNoRemote: 1 },
  ]
  for (const facts of atRisk) expect(groupOf({ ...CLEAN, ...facts }).group).toBe('needs-a-look')
})

const otherLines = async ($: Dollar) =>
  (await texts($, { ...PANE.props, bodyColumns: 80 })).filter(one => /^ {2}\S.* · \d+$|^ {4}● |^ {6}\S/.test(one))

test('other worktrees are grouped as the worktrees mod grouped them, each row with its PR', async ($, on) => {
  const at = (name: string, branch: string) => ({ path: `/repo/.claude/worktrees/${name}`, branch })
  const [A, B, C, D, E, F, G] = [
    at('merged-clean', 'feat-a'),
    at('open-pr', 'feat-b'),
    at('dirty', 'feat-c'),
    at('unpushed', 'feat-d'),
    at('busy', 'feat-e'),
    at('moved-on', 'feat-f'),
    at('colleague', 'feat-g'),
  ]
  const w = world(on, { '/repo': [MAIN, WT, A, B, C, D, E, F, G] })
  w.per[C.path] = { status: ' M x' }
  w.per[D.path] = { unpushed: '2' }
  w.lsof = `p1\ncnode\nn/\np2\nczsh\nn${E.path}/src`
  w.pulls = {
    'feat-a': [{ number: 11, state: 'MERGED', title: 'a', headRefOid: 'a' }],
    'feat-b': [{ number: 12, state: 'OPEN', title: 'b', headRefOid: 'old' }],
    'feat-c': [{ number: 13, state: 'MERGED', title: 'c', headRefOid: 'a' }],
    'feat-f': [{ number: 14, state: 'MERGED', title: 'f', headRefOid: 'before' }],
    'feat-g': [{ number: 15, state: 'OPEN', title: 'g', headRefOid: 'a', author: { login: 'someone-else' } }],
  }
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const found = await texts($, { ...PANE.props, bodyColumns: 80 })
  expect(found.some(one => one.includes('need a look ·'))).toBe(false)
  expect(found.filter(one => /^ {4}─+$/.test(one)).length).toBe(3)
  expect(found[found.indexOf('  Can be removed · 1') - 1]).toBe(' ')
  expect(found[found.indexOf('  Needs a look · 3') - 1]).not.toBe(' ')
  expect(await otherLines($)).toEqual([
    '  Needs a look · 3',
    '    ● dirty         feat-c  PR #13 merged     0 d',
    '      1 uncommitted file',
    '    ● moved-on      feat-f  no PR             0 d',
    '    ● unpushed      feat-d  no PR             0 d',
    '      2 commits on no remote',
    '  Can be removed · 1',
    '    ● merged-clean  feat-a  PR #11 merged     0 d',
    '  PR open · 2',
    '    ● colleague     feat-g  PR #15 open       0 d',
    '    ● open-pr       feat-b  PR #12 open       0 d',
    '  In use · 1',
    '    ● busy          feat-e  no PR             0 d',
    '      a process runs inside',
  ])
})

test('an open PR from the row’s HEAD wins over a merged one from the same commit', async ($, on) => {
  const B = { path: '/repo/.claude/worktrees/two-prs', branch: 'feat-two' }
  const w = world(on, { '/repo': [MAIN, WT, B] })
  w.pulls = {
    'feat-two': [
      { number: 12, state: 'MERGED', title: 'into release', headRefOid: 'a' },
      { number: 10, state: 'OPEN', title: 'into main', headRefOid: 'a' },
    ],
  }
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  expect(await otherLines($)).toEqual(['  PR open · 1', '    ● two-prs  feat-two  PR #10 open       0 d'])
})

test('a fact that cannot be read puts the row in Needs a look', async ($, on) => {
  const S = { path: '/repo/.claude/worktrees/no-status', branch: 'feat-s' }
  const R = { path: '/repo/.claude/worktrees/no-remotes', branch: 'feat-r' }
  const w = world(on, { '/repo': [MAIN, WT, S, R] })
  w.per[S.path] = { fail: 'status' }
  w.per[R.path] = { fail: 'rev-list' }
  w.pulls = {
    'feat-s': [{ number: 1, state: 'MERGED', title: 's', headRefOid: 'a' }],
    'feat-r': [{ number: 2, state: 'MERGED', title: 'r', headRefOid: 'a' }],
  }
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const unread = '      git or the process list could not be read'
  expect(await otherLines($)).toEqual([
    '  Needs a look · 2',
    '    ● no-remotes  feat-r  PR #2 merged      0 d',
    unread,
    '    ● no-status   feat-s  PR #1 merged      0 d',
    unread,
  ])
  w.per = {}
  w.lsof = null
  expect((await otherLines($)).filter(one => one === unread).length).toBe(2)
  w.lsof = undefined
  w.isLsofCut = true
  expect((await otherLines($)).filter(one => one === unread).length).toBe(2)
  w.isLsofCut = false
  expect(await otherLines($)).toContain('  Can be removed · 2')
})

test('a lock of a running session puts a row in use; a lock left by a stopped session does not', async ($, on) => {
  const LIVE = {
    path: '/repo/.claude/worktrees/live',
    branch: 'l',
    lock: 'claude session x (pid 500 start Tue Nov 17 07:00:00 2026)',
  }
  const LEFT = {
    path: '/repo/.claude/worktrees/left',
    branch: 'f',
    lock: 'claude session y (pid 501 start Tue Nov 17 07:00:00 2026)',
  }
  const HAND = { path: '/repo/.claude/worktrees/hand', branch: 'h', lock: 'kept for a demo' }
  const w = world(on, { '/repo': [MAIN, WT, LIVE, LEFT, HAND] })
  w.processes = { 500: 'Tue Nov 17  07:00:00 2026' }
  w.lsof = `p9\ncgit\nn${LEFT.path}\np10\nclsof\nn${LEFT.path}/x`
  w.pulls = Object.fromEntries(
    ['l', 'f', 'h'].map(b => [b, [{ number: 3, state: 'MERGED', title: b, headRefOid: 'a' }]]),
  )
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  expect(await otherLines($)).toEqual([
    '  Can be removed · 1',
    '    ● left  f  PR #3 merged      0 d',
    '      lock left by a stopped session',
    '  In use · 2',
    '    ● hand  h  PR #3 merged      0 d',
    '      locked by a running session',
    '    ● live  l  PR #3 merged      0 d',
    '      locked by a running session',
  ])
  w.processes = null
  expect(await otherLines($)).toContain('  In use · 3')
})

test('pressing an other worktree’s row opens a tile with a card’s details; pressing it again closes it', async ($, on) => {
  const O = { path: '/repo/.claude/worktrees/review', branch: 'feat-review' }
  const w = world(on, { '/repo': [MAIN, WT, O] })
  w.per[O.path] = {
    status: '?? notes.md',
    revList: '0\t2',
    shortstat: ' 1 file changed, 3 insertions(+), 1 deletion(-)',
    nameStatus: 'M\tsrc/a.ts',
    log: 'Fix the parser\u00002 days ago',
  }
  w.pulls = {
    'feat-review': [
      { number: 7, state: 'OPEN', title: 'Fix the parser', headRefOid: 'a', author: { login: 'someone-else' } },
    ],
  }
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const numbers = 'feat-review  ↑2 ↓0 main · 1 dirty'
  expect(await shown()).not.toContain(numbers)
  expect(await ui.find({ key: `${O.path}:Investigate` })).toBeUndefined()

  await ui.press({ key: `other:${O.path}` })
  const tile = await shown()
  expect(tile).toContain(numbers)
  expect(tile.some(one => /^█+ \+3 −1 · 1 files$/.test(one))).toBe(true)
  expect(tile).toContain('Fix the parser · 2 days ago')
  expect(tile).toContain('PR #7 open · Fix the parser')
  await ui.press({ key: `${O.path}:files` })
  expect(await shown()).toContain('  M  src/a.ts')
  expect(await shown()).toContain('  ?? notes.md (uncommitted)')
  await ui.press({ key: `${O.path}:Cleanup check` })
  expect(w.sent[0]).toContain(`worktree at ${O.path} (branch feat-review) is safe to remove: is it merged into main`)
  expect(w.sent[0]).toContain('Read-only: do not modify, switch into, merge or remove the worktree.')

  await ui.press({ key: `other:${O.path}` })
  expect(await shown()).not.toContain(numbers)
  expect(await ui.find({ key: `${O.path}:Investigate` })).toBeUndefined()
  await ui.unmount()
})

test('a failed or refused git switch -c records no branch for the worktree', async ($, on) => {
  const W = { path: '/repo/.claude/worktrees/setup', branch: 'fix/now' }
  const w = world(on, { '/repo': [MAIN, W] })
  enters(on, W)
  const answers: object[] = [
    { isError: true, result: undefined, text: 'Exit code 128\nfatal: a branch named fix/old already exists' },
    { deny: 'not allowed' },
  ]
  on('tool.call', { tool: 'Bash' }, () => answers.shift() as never)
  w.pulls = {
    'fix/old': [{ number: 7, state: 'MERGED', title: 'Someone else’s branch' }],
    'fix/denied': [{ number: 8, state: 'MERGED', title: 'Never made here' }],
  }
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'setup' })
  await $.tool.call({ tool: 'Bash', command: 'git switch -c fix/old' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git switch -c fix/denied' } as never)

  expect((await texts($)).filter(text => text.startsWith('PR #'))).toEqual([])
})

test('a row that appears or moves to a new commit between the minute reads is read at once', async ($, on) => {
  const A = { path: '/repo/.claude/worktrees/merged', branch: 'feat-a', head: 'a' }
  const N = { path: '/repo/.claude/worktrees/new', branch: 'feat-n' }
  const w = world(on, { '/repo': [MAIN, WT, A] })
  w.pulls = {
    'feat-a': [{ number: 5, state: 'MERGED', title: 'a', headRefOid: 'a' }],
    'feat-n': [{ number: 6, state: 'MERGED', title: 'n', headRefOid: 'a' }],
  }
  enters(on, WT)
  await start($)
  await $.tool.call({ tool: 'EnterWorktree', name: 'fix-auth' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const lines = async () =>
    (await ui.findAll({ type: 'Text' }))
      .map(one => one.text)
      .filter(one => /^ {2}\S.* · \d+$|^ {4}● |^ {6}\S/.test(one))
  expect(await lines()).toEqual(['  Can be removed · 1', '    ● merged  feat-a  PR #5 merged      0 d'])

  w.repos['/repo']?.push(N)
  A.head = 'b'
  w.per[A.path] = { unpushed: '1' }
  await ui.press({ key: `other:${A.path}` })
  expect(await lines()).toEqual([
    '  Needs a look · 2',
    '    ● merged  feat-a  no PR             0 d',
    '      1 commit on no remote',
    '    ● new     feat-n  PR …              0 d',
  ])
  await ui.unmount()
})

test('worktrees a Bash loop makes in several repositories are this session’s, live and in the transcript', async ($, on) => {
  const A = { path: '/r/a/.claude/worktrees/c', branch: 'feat/c' }
  const B = { path: '/r/b/.claude/worktrees/c', branch: 'feat/c' }
  const loop =
    'for r in a b; do cd /r/$r || exit 1; git worktree add -q -b feat/c .claude/worktrees/c origin/main; done'
  const w = world(on, { '/r/a': [{ path: '/r/a', branch: 'main' }], '/r/b': [{ path: '/r/b', branch: 'main' }] })
  on('tool.call', { tool: 'Bash' }, () => {
    w.repos['/r/a']?.push(A)
    w.repos['/r/b']?.push(B)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  await start($)
  await $.tool.call({ tool: 'Bash', command: loop } as never)

  const found = await texts($)
  expect(found).toContain('THIS SESSION  2 worktrees')
  expect(found.filter(one => one === `made by this session at ${AT} · git worktree add`).length).toBe(2)
})

test('worktrees a Bash loop made before the plugin loaded are found in the transcript', async ($, on) => {
  const A = { path: '/r/a/.claude/worktrees/c', branch: 'feat/c' }
  const B = { path: '/r/b/.claude/worktrees/c', branch: 'feat/c' }
  const w = world(on, {
    '/r/a': [{ path: '/r/a', branch: 'main' }, A],
    '/r/b': [{ path: '/r/b', branch: 'main' }, B],
  })
  const at = '2026-11-18T11:03:09.000Z'
  w.files['/t/s.jsonl'] = bashLine(
    '/somewhere',
    at,
    'for r in a b; do cd /r/$r || exit 1; git worktree add -q -b feat/c .claude/worktrees/c origin/main; done',
  )
  w.mtimes[`${A.path}/.git`] = Date.parse(at) + 2000
  w.mtimes[`${B.path}/.git`] = Date.parse(at) + 4000
  await start($, '/somewhere')

  const found = await texts($)
  expect(found).toContain('THIS SESSION  2 worktrees')
  expect(
    found.filter(one => one.startsWith('made by this session at ') && one.endsWith(' · git worktree add')).length,
  ).toBe(2)
})

test('a worktree the session has not worked in for a day is a row under EARLIER, and opens its card', async ($, on) => {
  const OLD = { path: '/repo/.claude/worktrees/old', branch: 'old' }
  const NEW = { path: '/repo/.claude/worktrees/new', branch: 'new' }
  const w = world(on, { '/repo': [MAIN, OLD, NEW] })
  w.now = Date.parse('2026-11-20T10:00:00.000Z')
  w.files['/t/s.jsonl'] = [
    bashLine('/repo', '2026-11-01T10:00:00.000Z', 'git worktree add .claude/worktrees/old'),
    bashLine('/repo', '2026-11-01T11:00:00.000Z', 'git worktree add .claude/worktrees/new'),
    bashLine(OLD.path, '2026-11-10T10:00:00.000Z', 'ls'),
    bashLine('/repo', '2026-11-20T09:00:00.000Z', `git -C ${NEW.path} status`),
  ].join('\n')
  w.mtimes[`${OLD.path}/.git`] = Date.parse('2026-11-01T10:00:00.000Z')
  w.mtimes[`${NEW.path}/.git`] = Date.parse('2026-11-01T11:00:00.000Z')
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const found = await shown()
  expect(found).toContain('THIS SESSION  1 worktree')
  expect(found.some(one => one.startsWith('⎇ new'))).toBe(true)
  expect(found).toContain('EARLIER IN THIS SESSION  1 worktree not used in the last day')
  expect(found.find(one => one.startsWith('  ⎇ old'))).toMatch(/^  ⎇ old  old  PR .+ 10 d$/)
  expect(found.some(one => one.startsWith('⎇ old'))).toBe(false)

  await ui.press({ key: `earlier:history:${OLD.path}` })
  expect((await shown()).some(one => one.startsWith('⎇ old'))).toBe(true)
  await ui.press({ key: `earlier:history:${OLD.path}` })
  expect((await shown()).some(one => one.startsWith('⎇ old'))).toBe(false)
  await ui.unmount()

  w.files['/t/s.jsonl'] += `\n${bashLine('/repo', '2026-11-20T09:30:00.000Z', `cat ${OLD.path}/README.md`)}\n`
  const later = await texts($)
  expect(later).toContain('THIS SESSION  2 worktrees')
  expect(later.some(one => one.startsWith('EARLIER IN THIS SESSION'))).toBe(false)
})

test('the worktree the session is in stays in THIS SESSION however long ago it was used', async ($, on) => {
  const OLD = { path: '/repo/.claude/worktrees/old', branch: 'old' }
  const w = world(on, { '/repo': [MAIN, OLD] }, OLD.path)
  w.now = Date.parse('2026-11-20T10:00:00.000Z')
  w.files['/t/s.jsonl'] = bashLine('/repo', '2026-11-01T10:00:00.000Z', 'git worktree add .claude/worktrees/old')
  w.mtimes[`${OLD.path}/.git`] = Date.parse('2026-11-01T10:00:00.000Z')
  await start($, OLD.path)

  const found = await texts($)
  expect(found).toContain('THIS SESSION  1 worktree')
  expect(found.some(one => one.startsWith('EARLIER IN THIS SESSION'))).toBe(false)
})
