import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parseEnv } from 'util'

/** Optional user env file for agent processes, e.g. provider API keys. */
export function piDotenvPath(home: string = homedir()): string {
  return join(home, '.pi', '.env')
}

/**
 * Variables from the env file that the inherited environment does not already
 * set; a real environment variable always wins. A missing file yields none.
 */
export function readPiDotenv(path: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (inherited[key] === undefined) out[key] = value
  }
  return out
}
