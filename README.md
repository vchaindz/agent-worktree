<img src=".claude-plugin/icon.png" alt="" width="96" align="right">

# agent-worktree

```
/plugin install agent-worktree --marketplace vchaindz/agent-worktree
```

A Claude Code mod that shows the git worktrees of the current session in a pane
beside the chat, as cards in the style of [forestui](https://github.com/flipbit03/forestui).

The mod is read-only. It never creates, switches, merges or removes a worktree.
Its buttons send investigate prompts to the running Claude session or open an
agent's transcript, and Claude does the work.

## What it shows

Open the pane with `/worktrees`. It also opens by itself when the session makes
its first worktree.

```
THIS SESSION  2 worktrees                                        Refresh
╭──────────────────────────────────────────────────────────────╮
│ ◆ agent-1  [general-purpose]                                 │
│ made by subagent «fix auth» at 14:02 · background            │
│ worktree-agent-1  ↑3 ↓0 main · 2 dirty                       │
│ █████████████████████░ +120 −14 · 5 files                    │
│ Add login form · 12 minutes ago                              │
│ ● running · opus · 45k tok · 3m ▁▂▃▅▆▇█                      │
│ ⚠ overlaps side: src/auth.ts, src/login.ts (+1)              │
│ [ Investigate ] [ Review diff ] [ Cleanup check ] [ Files (5) ] [ View agent ] │
╰──────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────╮
│ ⎇ side                                                       │
│ made by this session at 13:58 · git worktree add             │
│ side  ↑1 ↓0 main · clean                                     │
╰──────────────────────────────────────────────────────────────╯

EARLIER IN THIS SESSION  1 worktree not used in the last day
  ⎇ cache-spike  spike/cache  PR #41 merged      12 d
    1 uncommitted file

PROBLEMS IN THIS SESSION  1 failed worktree call
✗ 14:05  subagent «fix auth»  add ../tmp-x  invalid reference: .

OTHER WORKTREES IN app  3 in 1 repository
  Needs a look · 2
    ● docs-update  docs/install-steps  no PR              6 d
      1 commit on no remote
    ────────────────────────────────────────────────────────────
    ● fix-login    fix/login-timeout   PR #52 merged      4 d
      3 uncommitted files

  Can be removed · 1
    ● old-spike    spike/cache         PR #41 merged     98 d

REMOVED  1 worktree this session made
  ⎇ try-cache  PR #48 merged  made by this session at 11:20 · git worktree add
```

Each of this session's worktrees is a framed card: accent border for the one
the session is in, green while its agent runs. Numbers are
coloured (`↑` green, `↓` and `dirty` yellow, `+` green, `−` red), the bar shows
lines added and removed scaled across all cards, and the sparkline traces the
agent's token use over its last 16 readings. Below 60 columns a card drops the
bar, last commit and sparkline, and shortens its buttons.

- **This session**: every worktree the session or any of its subagents made,
  in any folder or repository: with the `EnterWorktree` tool, an agent started
  with `isolation: "worktree"`, or `git worktree add` run through Bash. A
  worktree made before the mod loaded is found in the session's transcript and
  its subagents' (read once, when the mod loads), or by its lock, which names
  this session's process; one an agent works in is claimed for the session. Each
  card says who made it and when, and lists the PRs your `gh` account opened
  from the branches made in its worktree or checked out there now
  (`PR #180 merged · title`, the newest three, the rest under `+N more PRs`), read from GitHub once
  a minute while the pane is open; when `gh` cannot answer, the card says
  `PR unknown`. The newest worktree comes first. A worktree stays here after its
  agent ends. The worktree the session is in is marked `★ here`.
- **Earlier in this session**: this session's worktrees it has not made or
  worked in for a day, one row each: the branch, its newest PR and the days
  since the session last worked there. A tool call counts as work in a worktree
  when it runs inside it or names its folder in its input; the worktree the
  session is in, and one its agent runs in, stay above. Press a row to open its
  card under it.
- **Problems in this session**: one line per failed worktree call (a refused
  `EnterWorktree`, a `git worktree add` that failed), the last five.
- **Other worktrees**: the rest of the worktrees of the same repositories,
  folded by repository when there are several, in the groups the worktrees mod
  used, in this order: **Needs a look** (uncommitted files, commits on no
  remote, no PR, or a fact that could not be read), **Can be removed** (nothing
  uncommitted, every commit on a remote, and its PR merged or closed, or no
  branch), **PR open** and **In use**. Each row shows the branch, the PR opened
  from its last commit (else the newest PR if it is open) and the days since
  that commit; the reasons go on the line below. Rows sit under their group
  heading, a thin line separates rows of one group, and an empty line separates
  the groups. In use means a lock held by a running session, or a process whose
  current folder is inside the worktree; a running session that made the
  worktree but is not standing in it does not count. The pane removes nothing.
  Read once a minute while the pane is open, at once when a worktree appears or
  moves to another branch or commit, and on `Refresh`. Press a row to open a
  tile under it with what a card shows: commits ahead and behind, uncommitted
  files, the diff bar, the last commit, every PR from its branch, and the
  `Investigate`, `Review diff`, `Cleanup check` and `Files` buttons; an open
  tile is read every 5 seconds. Press the row again to close it.
- **Removed**: this session's worktrees whose folders are gone, at the bottom
  of the pane, one line each: the PR as last read before removal (an open one by
  its number alone, since it is not read again) and who made it and when.
- **Each card**: branch, commits ahead and behind the main worktree's branch,
  uncommitted file count, diff size, last commit and its age.
- **Live agent**: the agent working in the worktree, matched by its directory:
  status, model, tokens, minutes since it started and a token sparkline. `View agent` opens its
  transcript. A background agent's card finds its worktree this way too.
- **Overlap warning**: files changed in two worktrees at once, the early sign
  of a merge conflict between parallel agents.
- **Clean badge**: `clean · nothing unmerged` when the branch has no commits
  beyond the base and no uncommitted files, a hint that it can be cleaned up.
- **File list**: `Files (n)` lists the changed files, uncommitted ones marked.
- **Band above the prompt**: `⎇ 3 worktrees (◆ 1 agent) · 1 dirty · 2 running · 1 overlap · 1 failed call`
  with an `Open` button, while the session has a worktree or a failed call.
- **Done toast**: when a worktree agent finishes, for example
  `agent "fix auth" done: ↑3 · 5 files`.
- **Status line**: `⎇ <branch>` while the session is inside a worktree.

Everything refreshes every 5 s, and on `Refresh`.

## Buttons

Each button submits a prompt to the session. Every prompt ends with
"Read-only: do not modify, switch into, merge or remove the worktree."

| Button | Asks Claude to |
|---|---|
| Investigate | Summarize what was done in the worktree, how it stands against the base branch, and any uncommitted work |
| Review diff | Review `<base>...<branch>` for correctness bugs |
| Cleanup check | Report whether the worktree is merged, holds uncommitted files, or still has an agent working in it |

## Requirements

- Claude Code with function-hook mods (built against 2.1.326)
- `git` on `PATH`

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-worktree --marketplace vchaindz/agent-worktree
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install agent-worktree --marketplace vchaindz/agent-worktree
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace
with `vchaindz/agent-worktree`, then Add plugin.

To run a local checkout instead:

```bash
claude --plugin-dir /path/to/agent-worktree
```

## Development

`claude plugin validate .` reports what the engine will load and what it would
refuse; `claude plugin test .` runs `hooks/*.test.tsx` against the engine.

```bash
claude plugin validate .
claude plugin test .
```

Claude Code writes the API types to `.claude-plugin/types/` when it loads the
mod; `tsconfig.json` extends them, so `npx -p typescript tsc -p .` type-checks
the mod.

| Path | Holds |
|---|---|
| `.claude-plugin/plugin.json` | Manifest |
| `hooks/hooks.json` | Names the hooks module |
| `hooks/register.tsx` | The hooks: tool-call recording, command, drawing |
| `hooks/scan.ts` | Reading git and `$.agent.list()` every 5 s, PRs with `gh` once a minute |
| `hooks/pane.tsx` | The pane and the band above the prompt |
| `hooks/detect.ts` | Reading `git worktree add` commands, worktree lists, locks and transcript lines |
| `hooks/history.ts` | Reading the session's transcripts for worktrees and branches made before the mod loaded |
| `hooks/*.test.ts(x)` | Tests |
| `types/index.d.ts` | The mod's `$.state` contract |

## Thanks

To [forestui](https://github.com/flipbit03/forestui) by
[@flipbit03](https://github.com/flipbit03): its worktree cards and Claude
session integration are the model for this mod. forestui is itself inspired by
[forest](https://github.com/ricwo/forest) by [@ricwo](https://github.com/ricwo).

## License

MIT, see [LICENSE](LICENSE).
