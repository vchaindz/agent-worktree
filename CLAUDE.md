# agent-worktree

Claude Code mod (function-hook plugin): a pane listing the git worktrees the current session and its subagents made.

## Rules

- Read-only. The mod runs only read-only commands: git `worktree list`, `--no-optional-locks status`, `rev-list`,
  `diff --shortstat`, `diff --name-status`, `log`, `rev-parse`; `sh -c 'echo $PPID'` and `ps -o lstart= -p <pid>` to
  match a worktree's lock to this session's process; `ps -o pid=,lstart= -p <pids>` to tell whether other worktrees'
  locks belong to running processes; `lsof -a -d cwd -Fpcn` to find processes standing in a worktree; `gh api graphql`
  with a query, never a mutation, to read the PRs of worktree branches; and `$.agent.list()`. It reads files
  only to find worktrees and when the session last worked in them: the session's own transcript and its subagents'
  (`$.session.info().transcriptPath`). Never add a git mutation, tmux call, or worktree switch/remove. Actions are
  prompts sent with `$.prompt.submit` or `$.ui.view`; Claude does the work.
- Every prompt ends with the `READ_ONLY` sentence in `hooks/pane.tsx`.
- State the pane draws lives in `$.state` atoms (`tracked`, `grove`, `problems`, `expanded`, `pulls`), declared in
  `types/index.d.ts`. Each file that reads an atom declares it itself (the engine requires it); change a stored
  value's fields, bump its `shape` tag in every file.
- A function that takes `$` from another file is a `function` declaration, not an arrow (the engine requires it).
- No DOM, no Node: reach the host through `$` (`$.process.run`, `$.fs`, `$.clock`).

## Layout

- `hooks/register.tsx`: `tool.call` hooks record worktrees when they are made, in the main loop or a subagent's
  (`e.agentId`): `EnterWorktree`, `Agent` (`isolation: "worktree"`, its folder found by the `agentId` that
  `agent.spawn` gives the call), and Bash `git worktree add` (worktree list before and after the call); failed calls
  go to `problems`; `/worktrees` opens the pane.
- `hooks/scan.ts`: `refresh` (every 5 s from `session.start`) lists the worktrees of every repository the session
  touches, matches locks to this session's process, claims worktrees its agents work in (innermost folder wins),
  snapshots this session's worktrees and notes when the session last worked in each (the worktree it is in counts
  as now), snapshots the other worktrees opened in the pane, toasts finished agents. It reads other worktrees
  (uncommitted files, commits on no remote, lock, processes inside) once a minute while the pane is open, and at once
  for one that appears or changes branch, commit or lock; once a minute while the pane is open it also reads, beside
  the refresh queue, the PRs of every worktree's branches with `gh`.
- `hooks/pane.tsx`: the pane (THIS SESSION cards for worktrees worked in during the last day, EARLIER IN THIS SESSION
  rows each opening its card, PROBLEMS IN THIS SESSION, OTHER WORKTREES rows in the worktrees mod's groups, `groupOf`,
  each opening a tile drawn by the cards' `details`, REMOVED lines) and the band.
- `hooks/detect.ts`: pure parsing: `git worktree add` in a Bash command (a `for` loop over listed words read once per
  word), `worktree list --porcelain`, lock text, transcript lines, tool calls that run inside a worktree or name it in
  their input.
- `hooks/history.ts`: on the first refresh, reads the session's and its subagents' transcripts (workflow agents' too)
  for worktrees and branches made before the plugin loaded; a Bash `git worktree add` counts only when the worktree's
  `.git` file was written then; `refresh` keeps worktrees that still exist. The same pass over the session's own
  transcript notes when the session last worked in each worktree; `lastUses` reads on from there on every refresh.
- `hooks/*.test.ts(x)`: tests; each hook in a test stands for the engine.
- `.claude-plugin/types/`: written by Claude Code on load, not edited, not committed.

## Checks

Run all three before calling a change done:

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```
