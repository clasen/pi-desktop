import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { isImeComposing } from '../utils/ime-composing'

const source = ts.createSourceFile(
  'file-tree.tsx',
  readFileSync(new URL('./file-tree.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
)
const component = source.statements.find(
  (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'FileSearch',
)!

// Execute the component's real callbacks without loading CodeMirror or Electron.
function callback<T = void>(name: string, bindings: Record<string, unknown>): (...args: unknown[]) => T {
  let expression: string | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = node.initializer?.getText(source)
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
      if (name === node.arguments[1]?.getText(source)) expression = node.arguments[0].getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(expression, `Missing callback: ${name}`)
  const code = ts.transpile(`const callback = ${expression}`, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(bindings), `${code}; return callback`)(...Object.values(bindings))
}

const results = ['first.ts', 'second.ts', 'third.ts'].map((name) => ({
  name, path: `/project/${name}`, relativePath: name, matchType: 'name',
}))

function navigation() {
  let activeIndex = 0
  let loading = false
  let items = results
  let confirmRequest: object | null = null
  let allowOpen = true
  let closed = 0
  const opened: unknown[] = []
  const useAppStore = { getState: () => ({
    confirmRequest,
    fileSearchOpen: true,
    setPreviewTarget: async (target: unknown) => { opened.push(target); return allowOpen },
  }) }
  const handleSelect = callback('handleSelect', {
    useAppStore, isImagePath: () => false, onClose: () => { closed++ },
  })
  return {
    get activeIndex() { return activeIndex },
    get closed() { return closed },
    opened,
    setLoading(value: boolean) { loading = value },
    setResults(value: typeof results) { items = value },
    setConfirm(value: object | null) { confirmRequest = value },
    declineOpen() { allowOpen = false },
    async press(key: string, nativeEvent = {}) {
      let prevented = false
      let stopped = false
      callback('handleKeyDown', {
        isImeComposing, useAppStore, loading, results: items, activeIndex, handleSelect,
        setActiveIndex: (update: (index: number) => number) => { activeIndex = update(activeIndex) },
      })({
        key, nativeEvent,
        preventDefault() { prevented = true },
        stopPropagation() { stopped = true },
      })
      await Promise.resolve()
      return { prevented, stopped }
    },
  }
}

test('arrows select within the list bounds and Enter opens the highlighted file', async () => {
  const nav = navigation()
  await nav.press('ArrowUp')
  assert.equal(nav.activeIndex, 0)
  assert.deepEqual(await nav.press('ArrowDown'), { prevented: true, stopped: true })
  assert.equal(nav.activeIndex, 1)
  await nav.press('ArrowDown')
  await nav.press('ArrowDown')
  assert.equal(nav.activeIndex, 2)
  await nav.press('ArrowUp')
  await nav.press('Enter')
  assert.deepEqual(nav.opened, [{
    kind: 'code', name: 'second.ts', path: '/project/second.ts', relativePath: 'second.ts',
  }])
  assert.equal(nav.closed, 1)
})

test('Enter opens the first result by default and preserves a declined discard dialog', async () => {
  const nav = navigation()
  nav.declineOpen()
  await nav.press('Enter')
  assert.equal((nav.opened[0] as { path: string }).path, results[0].path)
  assert.equal(nav.closed, 0)
})

test('empty and loading results cannot be opened or move the selection', async () => {
  const nav = navigation()
  nav.setLoading(true)
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) await nav.press(key)
  nav.setLoading(false)
  nav.setResults([])
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) await nav.press(key)
  assert.equal(nav.activeIndex, 0)
  assert.deepEqual(nav.opened, [])
  assert.equal(nav.closed, 0)
})

test('IME composition, stacked confirms and ordinary typing retain their keyboard events', async () => {
  const nav = navigation()
  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
      assert.deepEqual(await nav.press(key, nativeEvent), { prevented: false, stopped: false })
    }
  }
  assert.deepEqual(await nav.press('a'), { prevented: false, stopped: false })
  nav.setConfirm({})
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
    assert.deepEqual(await nav.press(key), { prevented: false, stopped: false })
  }
  assert.equal(nav.activeIndex, 0)
  assert.deepEqual(nav.opened, [])
})

test('search changes reset selection and ignore late responses after cleanup', async () => {
  let items = results
  let activeIndex = 2
  let loading = false
  let runTimer!: () => Promise<void>
  let finish!: (value: typeof results) => void
  const pending = new Promise<typeof results>((resolve) => { finish = resolve })
  const cleanup = callback<() => void>('[query, contentMode, isOpen]', {
    query: 'first', contentMode: false, isOpen: true,
    setResults: (value: typeof results) => { items = value },
    setActiveIndex: (value: number) => { activeIndex = value },
    setLoading: (value: boolean) => { loading = value },
    setTimeout: (fn: () => Promise<void>) => { runTimer = fn; return 1 },
    clearTimeout: () => {},
    window: { piDesktop: { files: { search: () => pending } } },
  })()
  assert.equal(activeIndex, 0)
  assert.deepEqual(items, [])
  assert.equal(loading, true)
  const running = runTimer()
  cleanup()
  finish(results)
  await running
  assert.deepEqual(items, [])
  assert.equal(loading, true)
})

test('both search modes publish fresh results and finish loading', async () => {
  for (const contentMode of [false, true]) {
    let items: typeof results = []
    let loading = false
    let runTimer!: () => Promise<void>
    const calls: string[] = []
    callback('[query, contentMode, isOpen]', {
      query: 'first', contentMode, isOpen: true,
      setResults: (value: typeof results) => { items = value },
      setActiveIndex: () => {},
      setLoading: (value: boolean) => { loading = value },
      setTimeout: (fn: () => Promise<void>) => { runTimer = fn; return 1 },
      clearTimeout: () => {},
      window: { piDesktop: { files: {
        search: async () => { calls.push('name'); return results },
        searchContent: async () => { calls.push('content'); return results },
      } } },
    })()
    await runTimer()
    assert.deepEqual(calls, [contentMode ? 'content' : 'name'])
    assert.deepEqual(items, results)
    assert.equal(loading, false)
  }
})

test('the active result is scrolled into view without moving input focus', () => {
  const calls: unknown[] = []
  callback('[activeIndex, results, loading, isOpen]', {
    activeResultRef: { current: { scrollIntoView: (options: unknown) => calls.push(options) } },
  })()
  assert.deepEqual(calls, [{ block: 'nearest' }])
})
