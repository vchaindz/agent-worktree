import type { EngineInterface } from 'claude-code'

import { branchesIn, jsonOf, keptLines, madeIn, timeOf, usesIn, utf8Length, wholeLines } from './detect'
import type { Found, Kept, Made } from './detect'

// under the 4 MiB read cap, with room for a character cut at either edge
const RANGE = 4 * 1024 * 1024 - 64

// when the session last worked in each worktree, from its transcript read up to usedEnd
const usedAt: Record<string, number> = {}
let usedEnd: number | undefined

// a line longer than one range is skipped; the session's own transcript is also read for uses of the watched paths
async function madeLines($: EngineInterface, path: string, watched?: Set<string>, home = '') {
  const { size } = await $.fs.stat(path)
  const lines: Kept[] = []
  let shell: string | undefined
  for (let offset = 0; offset < size; ) {
    const isLast = offset + RANGE >= size
    const text = await $.fs.read(path, { offset, length: RANGE })
    const range = wholeLines(text, isLast)
    const next = keptLines(range.lines, shell)
    lines.push(...next.kept)
    shell = next.shell
    if (watched) {
      for (const one of madeIn(next.kept, home)) watched.add(one.path)
      usesIn(range.lines, [...watched], usedAt)
      // a last line still being written is read again on the next refresh
      if (isLast) usedEnd = offset + utf8Length(text.slice(0, text.lastIndexOf('\n') + 1))
    }
    offset += isLast ? RANGE : range.bytes || RANGE
  }

  return lines
}

// when the session last worked in each of these paths, reading on from where its transcript was left
export async function lastUses($: EngineInterface, paths: string[]) {
  const { transcriptPath } = await $.session.info()
  const { size } = await $.fs.stat(transcriptPath)
  if (usedEnd === undefined || size < usedEnd) usedEnd = size
  while (usedEnd < size) {
    const range = wholeLines(await $.fs.read(transcriptPath, { offset: usedEnd, length: RANGE }), false)
    if (range.bytes === 0 && size - usedEnd < RANGE) break
    usesIn(range.lines, paths, usedAt)
    usedEnd += range.bytes || RANGE
  }

  return usedAt
}

// subagents' transcripts, and those of the agents their workflows ran
async function transcriptsIn($: EngineInterface, folder: string, depth = 2): Promise<string[]> {
  const entries = await $.fs.list(folder).catch(() => [])
  const files = entries
    .filter(entry => entry.kind === 'file' && /^agent-.+\.jsonl$/.test(entry.name))
    .map(entry => `${folder}/${entry.name}`)
  const dirs = depth > 0 ? entries.filter(entry => entry.kind === 'dir') : []
  const nested = await Promise.all(dirs.map(entry => transcriptsIn($, `${folder}/${entry.name}`, depth - 1)))

  return [...files, ...nested.flat()]
}

// a worktree whose .git file is older than the Bash add was there already, so that add failed
async function isMadeThen($: EngineInterface, one: Found) {
  if (one.how !== 'bash') return true
  const stat = await $.fs.stat(`${one.path}/.git`).catch(() => undefined)

  return !!stat && one.at !== undefined && stat.mtimeMs >= one.at - 60_000
}

async function madeInFile($: EngineInterface, file: string, home: string, watched?: Set<string>) {
  const lines = await madeLines($, file, watched, home)
  const agentId = watched ? undefined : /agent-([^/]+)\.jsonl$/.exec(file)?.[1]
  if (!agentId) return { worktrees: madeIn(lines, home), branches: branchesIn(lines, home) }
  const meta = jsonOf<Record<string, unknown>>(await $.fs.read(file.replace(/\.jsonl$/, '.meta.json')).catch(() => ''))
  const who = { agentId, label: typeof meta?.description === 'string' ? meta.description : agentId }
  const worktrees = madeIn(lines, home, who)
  const first = jsonOf<Record<string, unknown>>((await $.fs.read(file, { length: 1024 * 1024 })).split('\n')[0] ?? '')
  // an agent started with isolation runs in a worktree named after it
  if (typeof first?.cwd === 'string' && first.cwd.endsWith(`/agent-${agentId}`))
    worktrees.push({
      path: first.cwd,
      how: 'agent',
      ...who,
      at: timeOf(first.timestamp),
      isBackground: meta?.requestShape === 'background',
    })

  return { worktrees, branches: branchesIn(lines, home) }
}

// worktrees and branches the session and its subagents made before the plugin loaded, from their transcripts
export async function madeBefore(
  $: EngineInterface,
  known: string[],
): Promise<{ worktrees: Found[]; branches: Made[] }> {
  const { transcriptPath } = await $.session.info()
  const home = (await $.env.get('HOME')) ?? ''
  // subagents first, so the worktrees they made are watched for uses in the session's own transcript
  const files = [...(await transcriptsIn($, `${transcriptPath.replace(/\.jsonl$/, '')}/subagents`)), transcriptPath]
  const watched = new Set(known)
  const read = []
  for (const file of files) {
    const one = await madeInFile($, file, home, file === transcriptPath ? watched : undefined).catch(() => undefined)
    for (const made of one?.worktrees ?? []) watched.add(made.path)
    read.push(one)
  }
  const worktrees = read.flatMap(one => one?.worktrees ?? [])
  const kept = await Promise.all(worktrees.map(async one => ((await isMadeThen($, one)) ? [one] : [])))

  return {
    worktrees: kept.flat().sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    branches: read.flatMap(one => one?.branches ?? []),
  }
}
