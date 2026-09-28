import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, writeFile, rename, rm, readFile, readdir, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionChanges, snapshotSessionFiles } from './session-changes'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-session-diff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const records = join(root, 'records')
  await mkdir(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'Test')
  await writeFile(join(repo, 'code.ts'), 'original\n')
  await writeFile(join(repo, 'untouched.ts'), 'original\n')
  await writeFile(join(repo, 'deleted.ts'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  return { repo, records, git, tracker: new SessionChanges(repo, '/sessions/one.jsonl', records) }
}

test('records real content changes, binary additions, renames and deletions; excludes existing dirt', async (t) => {
  const { repo, records, tracker, git } = await fixture(t)
  await writeFile(join(repo, 'code.ts'), 'dirty before turn\n')
  await writeFile(join(repo, 'untouched.ts'), 'unrelated dirt\n')
  await writeFile(join(repo, 'preexisting.png'), Buffer.from([0, 1, 2]))
  await tracker.begin()
  // Simulates cp/python/subagent output: there are no edit/write messages.
  await writeFile(join(repo, 'image 新.png'), Buffer.from([137, 80, 78, 71, 0, 255]))
  await writeFile(join(repo, 'code.ts'), 'dirty after turn\n')
  await rename(join(repo, 'deleted.ts'), join(repo, 'renamed.ts'))
  git('add', 'renamed.ts', 'image 新.png')
  await tracker.finish()
  const expected = ['code.ts', 'deleted.ts', 'image 新.png', 'renamed.ts']
  assert.deepEqual(await tracker.getPaths(), expected)
  const reopened = new SessionChanges(repo, '/sessions/one.jsonl', records)
  assert.deepEqual(await reopened.getPaths(), expected)
  assert.deepEqual(await new SessionChanges(repo, '/sessions/two.jsonl', records).getPaths(), [])
  const [record] = await readdir(records)
  assert.deepEqual(JSON.parse(await readFile(join(records, record), 'utf8')), { version: 1, paths: expected })
})

test('serializes the end snapshot before the next baseline and accumulates turns', async (t) => {
  const { repo, tracker } = await fixture(t)
  const first = await tracker.begin()
  await writeFile(join(repo, 'code.ts'), 'turn one\n')
  assert.equal(await tracker.begin(), first, 'steering must not replace the baseline')
  const finishing = tracker.finish()
  const next = tracker.begin()
  await finishing
  const second = await next
  assert.notEqual(second, first)
  await tracker.finish(first) // A delayed response from the previous turn.
  await writeFile(join(repo, 'turn-two.png'), Buffer.from([0, 255]))
  const pending = tracker.finish(second)
  assert.deepEqual(await tracker.getPaths(), ['code.ts', 'turn-two.png'], 'reads await persistence')
  await pending
  await tracker.finish() // Duplicate agent_end / status-change must be harmless.
  assert.deepEqual(await tracker.getPaths(), ['code.ts', 'turn-two.png'])
})

test('scopes snapshots to the workspace, excludes ignored output, and reads tracked ignored files', async (t) => {
  const { repo, records, git } = await fixture(t)
  await mkdir(join(repo, 'app'))
  await writeFile(join(repo, '.gitignore'), '*.ignored\n')
  await writeFile(join(repo, 'app', 'tracked.ignored'), 'before')
  git('add', '-f', 'app/tracked.ignored')
  const tracker = new SessionChanges(join(repo, 'app'), '/sessions/one.jsonl', records)
  await tracker.begin()
  await writeFile(join(repo, 'code.ts'), 'outside workspace')
  await writeFile(join(repo, 'app', 'output.ignored'), 'ignored')
  await writeFile(join(repo, 'app', 'tracked.ignored'), 'after')
  await writeFile(join(repo, 'app', 'new.png'), Buffer.from([0, 2]))
  await tracker.finish()
  assert.deepEqual(await tracker.getPaths(), ['new.png', 'tracked.ignored'])
})

test('does not follow symlinks when hashing file content', { skip: process.platform === 'win32' }, async (t) => {
  const { repo, tracker } = await fixture(t)
  const outside = join(repo, '..', 'outside')
  await writeFile(outside, 'before')
  await symlink(outside, join(repo, 'link'))
  await tracker.begin()
  await writeFile(outside, 'after')
  await tracker.finish()
  assert.deepEqual(await tracker.getPaths(), [])
  await tracker.begin()
  await rm(join(repo, 'link'))
  await symlink('code.ts', join(repo, 'link'))
  await tracker.finish()
  assert.deepEqual(await tracker.getPaths(), ['link'])
})

test('reports corrupt records and persistence failures instead of claiming an empty diff', async (t) => {
  const { repo, records, tracker } = await fixture(t)
  await tracker.begin()
  await tracker.finish()
  const [record] = await readdir(records)
  await writeFile(join(records, record), '{"version":9,"paths":[]}')
  await assert.rejects(tracker.getPaths(), /Invalid session change record/)
  const blocked = join(repo, '..', 'not-a-directory')
  await writeFile(blocked, '')
  const failed = new SessionChanges(repo, '/sessions/fail.jsonl', blocked)
  await failed.begin()
  await writeFile(join(repo, 'code.ts'), 'changed')
  await assert.rejects(failed.finish())
  await assert.rejects(failed.getPaths())
})

test('non-repositories do not block prompts or fabricate tracked paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-non-git-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await snapshotSessionFiles(root), null)
  const tracker = new SessionChanges(root, '/session', join(root, 'records'))
  await tracker.begin()
  await writeFile(join(root, 'new.txt'), 'new')
  await tracker.finish()
  assert.deepEqual(await tracker.getPaths(), [])
})
