import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SESSION_DIFF_CONFIG } from '../shared/default-settings'
import { pathGroupKey } from '../shared/path-compare'
import { isBenignGitError } from './file-service'
import { mapWithConcurrency } from './map-concurrent'

const execFileAsync = promisify(execFile)
type Snapshot = Map<string, string>

/** Actual worktree content, not Git's M/?? flags (which may already be dirty). */
export async function snapshotSessionFiles(workspacePath: string): Promise<Snapshot | null> {
  let stdout: string
  try {
    const result = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], {
      cwd: workspacePath,
      timeout: SESSION_DIFF_CONFIG.snapshotTimeoutMs,
      maxBuffer: SESSION_DIFF_CONFIG.maxGitOutputBytes,
    })
    stdout = result.stdout
  } catch (error) {
    if (isBenignGitError(error)) return null
    throw error
  }
  const paths = [...new Set(stdout.split('\0').filter(Boolean))]
  const entries = await mapWithConcurrency(paths, SESSION_DIFF_CONFIG.hashConcurrency, async (path) => {
    const absolute = join(workspacePath, path)
    try {
      const stat = await lstat(absolute)
      const hash = createHash('sha256')
      if (stat.isSymbolicLink()) hash.update(await readlink(absolute))
      else if (stat.isFile()) {
        for await (const chunk of createReadStream(absolute)) hash.update(chunk)
      } else return null // Gitlinks are directories, not files in this workspace.
      return [path, `${stat.mode}:${hash.digest('hex')}`] as const
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  })
  return new Map(entries.filter((entry) => entry !== null))
}

/** One tracker per session binding; serializes end snapshots, persistence and the next prompt. */
export class SessionChanges {
  private baseline: Snapshot | null | undefined
  private pending: Promise<void> = Promise.resolve()
  private failure: unknown = null
  private turn = 0
  private readonly filePath: string

  constructor(private workspacePath: string, sessionPath: string, private directory: string) {
    const key = createHash('sha256').update(JSON.stringify([
      pathGroupKey(workspacePath), pathGroupKey(sessionPath),
    ])).digest('hex')
    this.filePath = join(directory, `${key}.json`)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation)
    this.pending = result.catch((error) => { this.failure = error })
    return result
  }

  async begin(): Promise<number> {
    let turn = this.turn
    await this.enqueue(async () => {
      // Steering/follow-ups belong to the running turn, not a fresh baseline.
      if (this.baseline === undefined) {
        this.baseline = await snapshotSessionFiles(this.workspacePath)
        this.turn++
      }
      turn = this.turn
    })
    return turn
  }

  finish(turn?: number): Promise<void> {
    return this.enqueue(async () => {
      if (turn !== undefined && turn !== this.turn) return
      const before = this.baseline
      this.baseline = undefined
      if (!before) return
      const after = await snapshotSessionFiles(this.workspacePath)
      if (!after) throw new Error('Git repository disappeared during session change tracking')
      const paths = new Set(await this.readPaths())
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(path) !== after.get(path)) paths.add(path)
      }
      await mkdir(this.directory, { recursive: true })
      await writeFile(`${this.filePath}.tmp`, JSON.stringify({ version: 1, paths: [...paths].sort() }) + '\n')
      await rename(`${this.filePath}.tmp`, this.filePath)
    })
  }

  async getPaths(): Promise<string[]> {
    await this.pending
    if (this.failure) throw this.failure
    return this.readPaths()
  }

  private async readPaths(): Promise<string[]> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const data = JSON.parse(text)
    if (data?.version !== 1 || !Array.isArray(data.paths) || !data.paths.every((path: unknown) => typeof path === 'string')) {
      throw new Error('Invalid session change record')
    }
    return data.paths
  }
}
