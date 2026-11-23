import { expect, test } from 'claude-code/testing'

import {
  deepest,
  firstLine,
  branchesIn,
  branchesMade,
  isMadeLine,
  keptLines,
  madeIn,
  parseLock,
  parseWorktreeList,
  processFolders,
  startsOf,
  resolvePath,
  usesIn,
  utf8Length,
  wholeLines,
  worktreeAdds,
} from './detect'

test('worktreeAdds finds the folder git runs in and the path word', async () => {
  expect(worktreeAdds('git worktree add -q ../side -b side')).toEqual([{ dir: null, path: '../side' }])
  expect(worktreeAdds('git -C /other worktree add .claude/worktrees/z -b z')).toEqual([
    { dir: '/other', path: '.claude/worktrees/z' },
  ])
  expect(worktreeAdds('cd sub && git worktree add -b x ../x main')).toEqual([{ dir: 'sub', path: '../x' }])
  expect(worktreeAdds('git worktree add -- "my tree"')).toEqual([{ dir: null, path: 'my tree' }])
  expect(worktreeAdds('git worktree add "$DIR"')).toEqual([{ dir: null, path: null }])
  expect(worktreeAdds('cd "$REPO" && git worktree add ../wt')).toEqual([])
  expect(worktreeAdds('cd /tmp && cd ~/repo && git worktree add x')).toEqual([{ dir: '~/repo', path: 'x' }])
  expect(worktreeAdds('cd "$REPO" && cd /abs && git worktree add x')).toEqual([{ dir: '/abs', path: 'x' }])
  expect(worktreeAdds('git worktree list && git status')).toEqual([])
})

test('a for loop over listed words is read once per word', async () => {
  const loop =
    'for r in app api; do cd ~/src/$r || exit 1; echo "== $r"; ' +
    'git worktree add -q -b feat/x .claude/worktrees/x origin/main && ' +
    'git -C .claude/worktrees/x log --oneline -1; done'
  expect(worktreeAdds(loop)).toEqual([
    { dir: '~/src/app', path: '.claude/worktrees/x' },
    { dir: '~/src/api', path: '.claude/worktrees/x' },
  ])
  expect(branchesMade(loop)).toEqual([
    {
      dir: '~/src/app/.claude/worktrees/x',
      branch: 'feat/x',
    },
    {
      dir: '~/src/api/.claude/worktrees/x',
      branch: 'feat/x',
    },
  ])
  expect(worktreeAdds('for r in one\ndo\n  git -C "/x/${r}" worktree add y\ndone')).toEqual([
    { dir: '/x/one', path: 'y' },
  ])
  expect(worktreeAdds('for r in $REPOS; do cd /x/$r && git worktree add y; done')).toEqual([])
  expect(worktreeAdds('for r in a; do cd /x/$rest && git worktree add y; done')).toEqual([])
  expect(worktreeAdds('for r in a b; do cd /r/$r; for x in 1; do :; done; git worktree add c; done')).toEqual([
    { dir: '/r/a', path: 'c' },
    { dir: '/r/b', path: 'c' },
  ])
  expect(worktreeAdds('for r in a b; do for w in x y; do git -C /r/$r worktree add $w; done; done')).toEqual([
    { dir: '/r/a', path: 'x' },
    { dir: '/r/a', path: 'y' },
    { dir: '/r/b', path: 'x' },
    { dir: '/r/b', path: 'y' },
  ])
  expect(worktreeAdds('for r in a b\ndo\n  if cd /r/$r; then git worktree add c; fi\ndone')).toEqual([
    { dir: '/r/a', path: 'c' },
    { dir: '/r/b', path: 'c' },
  ])
  expect(worktreeAdds('if git -C /r worktree add c; then echo ok; fi')).toEqual([{ dir: '/r', path: 'c' }])
  expect(worktreeAdds('while ! git -C /r worktree add c; do sleep 1; done')).toEqual([{ dir: '/r', path: 'c' }])
  expect(worktreeAdds('for d in */; do git -C "$d" worktree add c; done')).toEqual([])
  expect(worktreeAdds('for r in {a,b}; do git -C /r/$r worktree add c; done')).toEqual([])
  expect(worktreeAdds('for r in a b; do git -C /r worktree add c; done')).toEqual([{ dir: '/r', path: 'c' }])
  expect(worktreeAdds('for a in x y; do for b in $a-1 $a-2; do git -C /r worktree add $b; done; done')).toEqual([
    { dir: '/r', path: 'x-1' },
    { dir: '/r', path: 'x-2' },
    { dir: '/r', path: 'y-1' },
    { dir: '/r', path: 'y-2' },
  ])
  expect(worktreeAdds('for r in a b; do select s in one; do break; done; git -C /r/$r worktree add c; done')).toEqual([
    { dir: '/r/a', path: 'c' },
    { dir: '/r/b', path: 'c' },
  ])
})

test('a heredoc body is not read as a command', async () => {
  const command = 'cat > notes.md <<EOF\ngit worktree add ../nope\nEOF\ngit worktree add ../yes'
  expect(worktreeAdds(command)).toEqual([{ dir: null, path: '../yes' }])
})

test('resolvePath joins and normalises against the folder and home', async () => {
  expect(resolvePath('/repo', '../side', '/home/u')).toBe('/side')
  expect(resolvePath('/repo', '~/x', '/home/u')).toBe('/home/u/x')
  expect(resolvePath('/repo/a', './b/../c', '/home/u')).toBe('/repo/a/c')
})

test('parseWorktreeList reads paths, branches and lock text', async () => {
  const porcelain = [
    'worktree /repo\nHEAD a\nbranch refs/heads/main',
    'worktree /repo/.claude/worktrees/build\nHEAD b\nbranch refs/heads/worktree-build\nlocked claude session build (pid 88572 start Tue Nov 17 07:25:46 2026)',
    'worktree /side\nHEAD c\ndetached\nlocked',
  ].join('\n\n')
  expect(parseWorktreeList(porcelain)).toEqual([
    { path: '/repo', branch: 'main', head: 'a', lock: undefined },
    {
      path: '/repo/.claude/worktrees/build',
      branch: 'worktree-build',
      head: 'b',
      lock: 'claude session build (pid 88572 start Tue Nov 17 07:25:46 2026)',
    },
    { path: '/side', branch: undefined, head: 'c', lock: '' },
  ])
})

test('processFolders lists where processes stand, leaving out git and lsof', async () => {
  const lsof = ['p1', 'cnode', 'n/a', 'p2', 'cgit', 'n/b', 'p3', 'clsof', 'n/c', 'p4', 'n/d'].join('\n')
  expect(processFolders(lsof)).toEqual(['/a', '/d'])
})

test('startsOf reads each pid with its start time', async () => {
  expect(startsOf('  500 Tue Nov 17 07:00:00 2026\n 61 Mon Nov 16 22:16:49 2026\n')).toEqual(
    new Map([
      [500, 'Tue Nov 17 07:00:00 2026'],
      [61, 'Mon Nov 16 22:16:49 2026'],
    ]),
  )
})

test('parseLock reads the pid and start of a Claude Code lock', async () => {
  expect(parseLock('claude session build (pid 88572 start Tue Nov 17 07:25:46 2026)')).toEqual({
    pid: 88572,
    startedAt: 'Tue Nov 17 07:25:46 2026',
  })
  expect(parseLock('kept by hand')).toBeNull()
})

test('deepest picks the innermost worktree holding a folder', async () => {
  const paths = ['/repo/.claude/worktrees/build', '/repo/.claude/worktrees/build/.worktrees/inner', '/side']
  expect(deepest('/repo/.claude/worktrees/build/.worktrees/inner/src', paths)).toBe(
    '/repo/.claude/worktrees/build/.worktrees/inner',
  )
  expect(deepest('/repo/.claude/worktrees/build/src', paths)).toBe('/repo/.claude/worktrees/build')
  expect(deepest('/repo/.claude/worktrees/builder', paths)).toBeUndefined()
})

test('firstLine gives the cause of a failed call', async () => {
  expect(firstLine('Exit code 128\nfatal: invalid reference: .')).toBe('invalid reference: .')
  expect(firstLine('<tool_use_error>EnterWorktree cannot create a worktree</tool_use_error>')).toBe(
    'EnterWorktree cannot create a worktree',
  )
  expect(firstLine("Preparing worktree (checking out 'b')\nfatal: 'b' is already used by worktree at '/x'")).toBe(
    "'b' is already used by worktree at '/x'",
  )
})

test('wholeLines keeps only whole lines and counts their bytes', async () => {
  expect(wholeLines('a\nбв\nhalf', false)).toEqual({ lines: ['a', 'бв'], bytes: 7 })
  expect(wholeLines('a\nlast', true)).toEqual({ lines: ['a', 'last'], bytes: 6 })
  expect(wholeLines('no break at all', false)).toEqual({ lines: [], bytes: 0 })
  expect(utf8Length('aб€😀')).toBe(1 + 2 + 3 + 4)
})

test('madeIn reads made and entered worktrees from transcript lines', async () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      cwd: '/repo',
      timestamp: '2026-11-12T08:38:41.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'cd /other && git worktree add -q -b x .claude/worktrees/x main' },
          },
          { type: 'tool_use', name: 'Bash', input: { command: 'git -C "$A" worktree add "$A/wt"' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      cwd: '/repo',
      timestamp: '2026-11-12T09:00:00.000Z',
      toolUseResult: {
        worktreePath: '/repo/.claude/worktrees/y',
        worktreeBranch: 'y',
        message: 'Created worktree at /repo',
      },
    }),
    JSON.stringify({
      type: 'user',
      toolUseResult: { worktreePath: '/repo/.claude/worktrees/y', message: 'Exited worktree. Your work is preserved' },
    }),
    'not json',
  ]
  expect(lines.filter(isMadeLine).length).toBe(3)
  expect(madeIn(keptLines(lines).kept, '/home/u', { agentId: 's1', label: 'helper' })).toEqual([
    {
      path: '/other/.claude/worktrees/x',
      how: 'bash',
      at: Date.parse('2026-11-12T08:38:41.000Z'),
      agentId: 's1',
      label: 'helper',
    },
    {
      path: '/repo/.claude/worktrees/y',
      how: 'enter',
      at: Date.parse('2026-11-12T09:00:00.000Z'),
      agentId: 's1',
      label: 'helper',
    },
  ])
})

test('branchesMade finds branches a command creates and where', async () => {
  expect(branchesMade('git fetch -q origin main && git switch -c fix/a origin/main')).toEqual([
    { dir: null, branch: 'fix/a' },
  ])
  expect(branchesMade('cd /w && git checkout -B fix/b')).toEqual([{ dir: '/w', branch: 'fix/b' }])
  expect(branchesMade('git -C /r worktree add -b fix/c .claude/worktrees/c main')).toEqual([
    { dir: '/r/.claude/worktrees/c', branch: 'fix/c' },
  ])
  expect(branchesMade('git switch main; git checkout -b "$B"; git branch fix/d')).toEqual([])
  expect(isMadeLine('{"name":"Bash","input":{"command":"git switch -c x"}}')).toBe(true)
  expect(isMadeLine('{"name":"Bash","input":{"command":"git checkout -q -b x"}}')).toBe(true)
  expect(isMadeLine('{"name":"Bash","input":{"command":"git status"}}')).toBe(false)
  expect(
    branchesIn(
      [
        {
          text: JSON.stringify({
            cwd: '/w',
            timestamp: '2026-11-11T13:48:00.000Z',
            message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git switch -c fix/e' } }] },
          }),
        },
      ],
      '/h',
    ),
  ).toEqual([{ dir: '/w', branch: 'fix/e', at: Date.parse('2026-11-11T13:48:00.000Z') }])
})

test('a Bash command resolves against the previous line folder, since its own line can hold where it moved', async () => {
  const add = 'git worktree add -b x .claude/worktrees/x'
  const lines = [
    JSON.stringify({ type: 'user', cwd: '/app', message: { content: [{ type: 'tool_result' }] } }),
    JSON.stringify({
      type: 'assistant',
      cwd: '/api',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `${add}; cd /api && ${add}` } }] },
    }),
  ]
  const { kept, shell } = keptLines(lines)
  expect(shell).toBe('/api')
  expect(madeIn(kept, '/h').map(one => one.path)).toEqual(['/app/.claude/worktrees/x', '/api/.claude/worktrees/x'])
  expect(branchesIn(kept, '/h').map(one => one.dir)).toEqual(['/app/.claude/worktrees/x', '/api/.claude/worktrees/x'])
})

test('a tool call is work in a worktree when it runs inside it or names it in its input', () => {
  const A = '/r/.claude/worktrees/a'
  const B = '/r/.claude/worktrees/a-1'
  const line = (cwd: string, timestamp: string, content: unknown[]) =>
    JSON.stringify({ type: 'assistant', cwd, timestamp, message: { content } })
  const bash = (command: string) => ({ type: 'tool_use', name: 'Bash', input: { command } })
  const lines = [
    line(`${A}/src`, '2026-11-01T10:00:00.000Z', [bash('ls')]),
    line('/r', '2026-11-02T10:00:00.000Z', [bash(`git -C ${B} status`)]),
    line('/r', '2026-11-03T10:00:00.000Z', [{ type: 'tool_result', content: `${A} [main]` }]),
    line('/r', '2026-11-04T10:00:00.000Z', [{ type: 'text', text: `see ${A}` }, bash('ls')]),
  ]

  expect(usesIn(lines, [A, B])).toEqual({
    [A]: Date.parse('2026-11-01T10:00:00.000Z'),
    [B]: Date.parse('2026-11-02T10:00:00.000Z'),
  })
})
