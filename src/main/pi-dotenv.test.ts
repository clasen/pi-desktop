import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readPiDotenv } from './pi-dotenv'

test('readPiDotenv returns file variables not already in the environment', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pi-dotenv-')), '.env')
  writeFileSync(path, '# keys\nOPENROUTER_API_KEY="sk-or-file"\nOTHER=from-file\n')
  assert.deepEqual(readPiDotenv(path, { OTHER: 'from-env' }), { OPENROUTER_API_KEY: 'sk-or-file' })
})

test('readPiDotenv yields nothing when the file is missing', () => {
  assert.deepEqual(readPiDotenv(join(tmpdir(), 'no-such-dir-pi-dotenv', '.env'), {}), {})
})
