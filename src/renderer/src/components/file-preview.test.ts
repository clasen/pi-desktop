import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { createDebouncedBuffer } from '../utils/debounced-buffer'
import { isImeComposing } from '../utils/ime-composing'

const source = ts.createSourceFile(
  'file-tree.tsx',
  readFileSync(new URL('./file-tree.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
)
const component = source.statements.find(
  (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'FilePreview',
)!

// Exercise the real handlers without loading Electron or mounting CodeMirror.
function callback(name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<void> {
  let expression: string | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = node.initializer?.getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(expression, `Missing callback: ${name}`)
  const code = ts.transpile(`const callback = ${expression}`, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(bindings), `${code}; return callback`)(...Object.values(bindings))
}

function keyEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: 's', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    repeat: false, nativeEvent: {}, prevented: false, stopped: false,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
    ...overrides,
  }
}

test('Command+S and Ctrl+S save and consume the shortcut', () => {
  let saves = 0
  const handleKeyDown = callback('handleKeyDown', {
    isImeComposing, isPdf: false, handleSave: () => { saves++ },
  })
  for (const modifiers of [{}, { metaKey: false, ctrlKey: true }]) {
    const event = keyEvent(modifiers)
    handleKeyDown(event)
    assert.equal(event.prevented, true)
    assert.equal(event.stopped, true)
  }
  assert.equal(saves, 2)
})

test('typing, other shortcuts, composition and PDF previews do not trigger saving', () => {
  let saves = 0
  for (const overrides of [
    { metaKey: false }, { key: 'p' }, { altKey: true }, { shiftKey: true },
    { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } },
    { isPdf: true },
  ]) {
    const event = keyEvent(overrides)
    callback('handleKeyDown', {
      isImeComposing, isPdf: 'isPdf' in overrides, handleSave: () => { saves++ },
    })(event)
    assert.equal(event.prevented, false)
  }
  const repeated = keyEvent({ repeat: true })
  callback('handleKeyDown', {
    isImeComposing, isPdf: false, handleSave: () => { saves++ },
  })(repeated)
  assert.equal(repeated.prevented, true)
  assert.equal(saves, 0)
})

test('saving flushes the latest edit before debounce and skips unavailable or unchanged files', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes: unknown[][] = []
  let saved = 'original'
  const editBuffer = createDebouncedBuffer(150, () => {})
  const bindings = {
    editBuffer, content: 'original', savedContent: 'original', loading: false, saving: false, isPdf: false,
    path: '/project/file.ts',
    setSaving: () => {}, setError: () => {}, setSaveSuccess: () => {}, setReloadKey: () => {},
    setSavedContent: (text: string) => { saved = text }, setTimeout,
    window: { piDesktop: { files: { write: async (...args: unknown[]) => { writes.push(args) } } } },
  }
  for (const guard of [{ loading: true }, { saving: true }, { isPdf: true }, { content: null }, {}]) {
    await callback('handleSave', { ...bindings, ...guard })()
  }
  assert.deepEqual(writes, [])

  editBuffer.push('latest keystroke')
  const handleSave = callback('handleSave', bindings)
  callback('handleKeyDown', { isImeComposing, isPdf: false, handleSave })(keyEvent())
  await Promise.resolve()
  assert.deepEqual(writes, [['/project/file.ts', 'latest keystroke']])
  assert.equal(saved, 'latest keystroke')
  assert.equal(editBuffer.flush(), null)
})
