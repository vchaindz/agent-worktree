import type { Tracked } from '../types'

export type Listed = { path: string; branch?: string; head?: string; lock?: string }

export const parseWorktreeList = (porcelain: string): Listed[] =>
  porcelain
    .split('\n\n')
    .filter(block => block.trim() !== '')
    .map(block => {
      const locked = block.match(/^locked(?: (.*))?$/m)

      return {
        path: block.match(/^worktree (.*)$/m)?.[1] ?? '',
        branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1],
        head: block.match(/^HEAD (.*)$/m)?.[1],
        lock: locked ? (locked[1] ?? '') : undefined,
      }
    })

export const parseLock = (text: string) => {
  const found = /^claude session .* \(pid (\d+) start ([^)]+)\)$/.exec(text.trim())

  return found ? { pid: Number(found[1]), startedAt: (found[2] ?? '').trim() } : null
}

// folders processes run in, from `lsof -Fpcn`; git and lsof are left out, as every session's scan runs them in worktrees
export const processFolders = (lsof: string) => {
  const folders = new Set<string>()
  let command = ''
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) command = ''
    else if (line.startsWith('c')) command = line.slice(1)
    else if (line.startsWith('n') && command !== 'git' && command !== 'lsof') folders.add(line.slice(1))
  }

  return [...folders]
}

export const startsOf = (ps: string) =>
  new Map(
    ps
      .split('\n')
      .map(line => /^\s*(\d+)\s+(.+?)\s*$/.exec(line))
      .flatMap(found => (found ? [[Number(found[1]), found[2] ?? ''] as const] : [])),
  )

export const isInside = (dir: string, path: string) => dir === path || dir.startsWith(`${path}/`)

export const deepest = (dir: string, paths: string[]) =>
  paths.filter(path => isInside(dir, path)).sort((a, b) => b.length - a.length)[0]

export const resolvePath = (folder: string, path: string, home: string) => {
  const full =
    path === '~' || path.startsWith('~/') ? home + path.slice(1) : path.startsWith('/') ? path : `${folder}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }

  return `/${parts.join('/')}`
}

export const firstLine = (text: string) => {
  const found = text
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^Exit code \d+$/.test(line))
  const line = found.find(one => /^(fatal|error): /.test(one)) ?? found[0] ?? ''

  return line.replace(/^(fatal|error): /, '').slice(0, 200)
}

// a heredoc's lines are input to the command, not commands
const withoutHeredocBodies = (command: string) => {
  const out: string[] = []
  const ends: string[] = []
  for (const line of command.split('\n')) {
    if (ends.length > 0) {
      if (line.replace(/^\t+/, '') === ends[0]) ends.shift()
      continue
    }
    out.push(line)
    for (const found of line.matchAll(/(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z0-9_]+)\1/g)) ends.push(found[2] as string)
  }

  return out.join('\n')
}

const tokenize = (command: string) => {
  const segments: string[][] = [[]]
  let word = ''
  let isStarted = false
  let quote: '"' | "'" | null = null
  const flush = () => {
    if (isStarted) segments[segments.length - 1]?.push(word)
    word = ''
    isStarted = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i)
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command.charAt(++i).replace('\n', '')
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      isStarted = true
    } else if (c === '\\' && command.charAt(i + 1) === '\n') {
      i++
    } else if (c === '\\' && i + 1 < command.length) {
      word += command.charAt(++i)
      isStarted = true
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      flush()
      segments.push([])
    } else if (/\s/.test(c)) {
      flush()
    } else {
      word += c
      isStarted = true
    }
  }
  flush()

  return segments
}

const isDynamic = (word: string) => /[$`]/.test(word) || word === '-'

// undefined: a folder the command names through a variable, which cannot be known
const joinDir = (dir: string | null | undefined, path: string) =>
  isDynamic(path)
    ? undefined
    : /^[/~]/.test(path) || dir === null
      ? path
      : dir === undefined
        ? undefined
        : `${dir.replace(/\/+$/, '')}/${path}`

// the `done` that closes the loop opened at segment i, past the loops opened inside it
const doneOf = (segments: string[][], i: number) => {
  let depth = 0
  for (let j = i; j < segments.length; j++) {
    const first = segments[j]?.[0] ?? ''
    if (['for', 'while', 'until', 'select'].includes(first)) depth++
    else if (first === 'done' && --depth === 0) return j
  }

  return -1
}

// a for loop over listed words runs its body once per word, with the word put in for the variable
const withLoops = (segments: string[][]): string[][] => {
  const out: string[][] = []
  for (let i = 0; i < segments.length; i++) {
    const words = segments[i] ?? []
    const [keyword, name = '', inWord, ...values] = words
    const end = keyword === 'for' && inWord === 'in' ? doneOf(segments, i) : -1
    if (end < 0 || !/^[A-Za-z_]\w*$/.test(name) || values.some(value => isDynamic(value) || /[*?[{]/.test(value))) {
      out.push(words)
      continue
    }
    const body = segments.slice(i + 1, end)
    const variable = new RegExp(`\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`, 'g')
    const isUsed = body.some(one => one.some(word => word.search(variable) >= 0))
    for (const value of isUsed ? values : values.slice(0, 1))
      out.push(...withLoops(body.map(one => one.map(word => word.replace(variable, () => value)))))
    i = end
  }

  return out
}

// words that open a condition or a block before the command itself
const leading = (words: string[]) => {
  let i = 0
  while (/^(do|then|else|if|elif|!)$/.test(words[i] ?? '')) i++

  return words.slice(i)
}

export type WorktreeAdd = { dir: string | null; path: string | null }
type GitCall = { dir: string | null | undefined; args: string[] }

// dir: where git runs (`-C`, else a leading `cd`), relative to the shell's folder, null for that folder itself
const gitCalls = (command: string): GitCall[] => {
  const calls: GitCall[] = []
  let cdDir: string | null | undefined = null
  for (const words of withLoops(tokenize(withoutHeredocBodies(command)).map(leading))) {
    let i = 0
    while (/^[A-Za-z_][A-Za-z0-9_]*=|^(while|until|!)$/.test(words[i] ?? '')) i++
    const first = words[i] ?? ''
    if (first === 'cd') {
      cdDir = joinDir(cdDir, words[i + 1] ?? '~')
      continue
    }
    if (first !== 'git' && !first.endsWith('/git')) continue
    let dir = cdDir
    for (i++; i < words.length; i++) {
      const word = words[i] ?? ''
      if (word === '-C') dir = joinDir(dir, words[++i] ?? '')
      else if (word === '-c') i++
      else if (!word.startsWith('-')) break
    }
    calls.push({ dir, args: words.slice(i) })
  }

  return calls
}

const addPath = (args: string[]) => {
  let path: string | undefined
  for (let i = 2; i < args.length; i++) {
    const word = args[i] ?? ''
    if (word === '-b' || word === '-B' || word === '--reason') i++
    else if (word === '--') path ??= args[++i]
    else if (!word.startsWith('-')) path ??= word
  }

  return path
}

export const worktreeAdds = (command: string): WorktreeAdd[] =>
  gitCalls(command).flatMap(({ dir, args }) => {
    if (args[0] !== 'worktree' || args[1] !== 'add' || dir === undefined) return []
    const path = addPath(args)

    return [{ dir, path: path !== undefined && !isDynamic(path) ? path : null }]
  })

const branchFlags = (args: string[]) =>
  args[0] === 'switch'
    ? ['-c', '-C', '--create', '--force-create']
    : args[0] === 'checkout' || (args[0] === 'worktree' && args[1] === 'add')
      ? ['-b', '-B']
      : []

// branches a command creates, each with the folder it is made in: a new worktree's for `worktree add -b`
export const branchesMade = (command: string) =>
  gitCalls(command).flatMap(({ dir, args }) => {
    const flags = branchFlags(args)
    const at = args.findIndex(word => flags.includes(word))
    const branch = at < 0 ? undefined : args[at + 1]
    const where = args[0] === 'worktree' ? joinDir(dir, addPath(args) ?? '$') : dir

    return branch === undefined || isDynamic(branch) || where === undefined ? [] : [{ dir: where, branch }]
  })

// a range of text read from a file: the whole lines in it and their size in bytes
export const wholeLines = (text: string, isLast: boolean) => {
  const end = isLast ? text.length : text.lastIndexOf('\n') + 1
  const whole = text.slice(0, end)

  return { lines: whole.split('\n').filter(line => line !== ''), bytes: utf8Length(whole) }
}

export const utf8Length = (text: string) => {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes += code < 0x80 ? 1 : code < 0x800 || (code >= 0xd800 && code <= 0xdfff) ? 2 : 3
  }

  return bytes
}

export type Found = Pick<Tracked, 'path' | 'how' | 'agentId' | 'label' | 'at' | 'isBackground'>

type Block = { type?: string; name?: string; input?: { command?: unknown } }
type Line = {
  cwd?: string
  timestamp?: string
  message?: { content?: unknown }
  toolUseResult?: { worktreePath?: string; message?: string }
}

export const jsonOf = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export const timeOf = (text: unknown) => {
  const at = typeof text === 'string' ? Date.parse(text) : NaN

  return Number.isFinite(at) ? at : undefined
}

const MAKES = /worktree add|\bswitch\b|\bcheckout\b/

// only lines that can hold an EnterWorktree result, or a Bash command making a worktree or a branch, are parsed
export const isMadeLine = (text: string) =>
  text.includes('"toolUseResult":{"worktreePath"') || (text.includes('"name":"Bash"') && MAKES.test(text))

export type Kept = { text: string; shell?: string }

// the lines worth parsing, each with the previous line's folder: a line's own cwd can already be where its command moved
export const keptLines = (lines: string[], shell?: string) => {
  const kept: Kept[] = []
  for (const text of lines) {
    if (isMadeLine(text)) kept.push({ text, shell })
    shell = /"cwd":"([^"]*)"/.exec(text.slice(0, 4096))?.[1] ?? shell
  }

  return { kept, shell }
}

const bashIn = ({ text, shell }: Kept) => {
  const line = jsonOf<Line>(text)
  const content = line?.message?.content
  const cwd = shell ?? line?.cwd ?? ''
  const commands =
    Array.isArray(content) && cwd
      ? (content as Block[])
          .filter(block => block.type === 'tool_use' && block.name === 'Bash')
          .map(block => String(block.input?.command ?? ''))
      : []

  return { line, cwd, at: timeOf(line?.timestamp), commands }
}

// worktrees a transcript's lines show being made or entered; a Bash path resolves against the shell's folder
export const madeIn = (lines: Kept[], home: string, who: Pick<Found, 'agentId' | 'label'> = {}): Found[] =>
  lines.flatMap((kept): Found[] => {
    const { line, cwd, at, commands } = bashIn(kept)
    const result = line?.toolUseResult
    const kind = /^(Created|Entered|Resumed) worktree/.exec(result?.message ?? '')?.[1]
    if (result?.worktreePath && kind)
      return [
        { path: result.worktreePath, how: kind === 'Created' ? ('enter' as const) : ('entered' as const), at, ...who },
      ]

    return commands.flatMap(worktreeAdds).flatMap(add =>
      add.path === null
        ? []
        : [
            {
              path: resolvePath(resolvePath(cwd, add.dir ?? '.', home), add.path, home),
              how: 'bash' as const,
              at,
              ...who,
            },
          ],
    )
  })

export type Made = { dir: string; branch: string; at?: number }

// branches a transcript's lines show being made, each with the folder it was made in
export const branchesIn = (lines: Kept[], home: string): Made[] =>
  lines.flatMap(kept => {
    const { cwd, at, commands } = bashIn(kept)

    return commands
      .flatMap(branchesMade)
      .map(made => ({ dir: resolvePath(cwd, made.dir ?? '.', home), branch: made.branch, at }))
  })

// a path named in a text, not as the start of a longer name
export const isNamed = (text: string, path: string) => {
  for (let i = text.indexOf(path); i >= 0; i = text.indexOf(path, i + 1))
    if (!/[\w.-]/.test(text[i + path.length] ?? '')) return true

  return false
}

// the last time a tool call on these lines ran inside each path or named it in its input
export const usesIn = (lines: string[], paths: string[], uses: Record<string, number> = {}) => {
  for (const text of lines) {
    if (!text.includes('"type":"tool_use"')) continue
    const cwd = /"cwd":"([^"]*)"/.exec(text.slice(0, 4096))?.[1] ?? ''
    const inside = paths.filter(path => isInside(cwd, path))
    const named = paths.filter(path => !inside.includes(path) && isNamed(text, path))
    if (inside.length === 0 && named.length === 0) continue
    const line = jsonOf<Line>(text)
    const at = timeOf(line?.timestamp)
    if (at === undefined) continue
    const content = line?.message?.content
    const inputs = Array.isArray(content)
      ? (content as Block[]).filter(block => block.type === 'tool_use').map(block => JSON.stringify(block.input ?? {}))
      : []
    for (const path of [...inside, ...named.filter(path => inputs.some(input => isNamed(input, path)))])
      uses[path] = Math.max(uses[path] ?? 0, at)
  }

  return uses
}
