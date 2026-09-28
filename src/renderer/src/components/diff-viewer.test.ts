import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { useAppStore } from '../store'
import { openDiffFile, parseDiff, subscribeDiffRefresh } from './diff-viewer'

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { piDesktop: { ui: { setEditorDirty: () => {} } } },
  })
  useAppStore.setState({
    activeWorkspace: {
      id: 'project', name: 'Project', path: '/project',
      createdAt: 0, lastActiveAt: 0, color: '',
    },
    currentView: 'diff',
    chatSidePanel: 'diff',
    previewTarget: null,
    editorDirty: false,
  })
})

test('opens the diff path in the editor and reveals the chat preview', async () => {
  await openDiffFile({ newPath: 'src/new name.ts', isDeleted: false }, '')
  const state = useAppStore.getState()
  assert.deepEqual(state.previewTarget, {
    kind: 'code', name: 'new name.ts', path: '/project/src/new name.ts', relativePath: 'src/new name.ts',
  })
  assert.equal(state.currentView, 'chat')
  assert.equal(state.chatSidePanel, null)
})

test('opens monorepo diff paths relative to the workspace and skips files outside it', async () => {
  const workspace = useAppStore.getState().activeWorkspace!
  useAppStore.setState({ activeWorkspace: { ...workspace, path: '/repo/pkg/app' } })
  await openDiffFile({ newPath: 'pkg/app2/a.ts', isDeleted: false }, 'pkg/app/')
  assert.equal(useAppStore.getState().previewTarget, null)
  await openDiffFile({ newPath: 'pkg/app/src/a.ts', isDeleted: false }, 'pkg/app/')
  assert.deepEqual(useAppStore.getState().previewTarget, {
    kind: 'code', name: 'a.ts', path: '/repo/pkg/app/src/a.ts', relativePath: 'src/a.ts',
  })
})

test('refreshes on agent completion, stop and branch change and removes subscriptions', () => {
  let listener: Parameters<typeof window.piDesktop.onEvent>[0] | undefined
  let fileListener: Parameters<typeof window.piDesktop.onFileChange>[0] | undefined
  window.piDesktop.onEvent = (callback) => {
    listener = callback
    return () => { listener = undefined }
  }
  window.piDesktop.onFileChange = (callback) => {
    fileListener = callback
    return () => { fileListener = undefined }
  }
  let refreshes = 0
  const close = subscribeDiffRefresh(async () => { refreshes++ })
  listener?.({ type: 'agent_start' })
  assert.equal(refreshes, 0)
  listener?.({ type: 'agent_end', messages: [] })
  listener?.({ type: 'status_change', status: 'stopped', pid: null, error: null })
  fileListener?.({ changeType: 'change', relativePath: 'code.ts' })
  assert.equal(refreshes, 2)
  fileListener?.({ changeType: 'change', relativePath: '.' })
  assert.equal(refreshes, 3)
  close()
  assert.equal(listener, undefined)
  assert.equal(fileListener, undefined)
})

test('binary additions remain NEW with no text hunks and open in the image preview', async () => {
  const [file] = parseDiff('diff --git a/assets/image.png b/assets/image.png\nnew file mode 100644\nBinary files /dev/null and b/assets/image.png differ\n')
  assert.equal(file.isNew, true)
  assert.equal(file.isBinary, true)
  assert.deepEqual(file.hunks, [])
  await openDiffFile(file, '')
  assert.equal(useAppStore.getState().previewTarget?.kind, 'image')
  const [tracked] = parseDiff('diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n')
  assert.equal(tracked.isBinary, true)
  assert.equal(tracked.isNew, false)
})

test('routes images to the image viewer and preserves Windows paths', async () => {
  const workspace = useAppStore.getState().activeWorkspace!
  useAppStore.setState({ activeWorkspace: { ...workspace, path: 'C:\\project\\' } })
  await openDiffFile({ newPath: 'assets/image.png', isDeleted: false }, '')
  assert.equal(useAppStore.getState().previewTarget?.kind, 'image')
  assert.equal(useAppStore.getState().previewTarget?.path, 'C:\\project\\assets\\image.png')
})

test('canceling the unsaved-editor confirmation keeps the diff open', async () => {
  useAppStore.setState({ editorDirty: true })
  const opening = openDiffFile({ newPath: 'other.ts', isDeleted: false }, '')
  assert.ok(useAppStore.getState().confirmRequest)
  useAppStore.getState().resolveConfirm(false)
  await opening
  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().currentView, 'diff')
  assert.equal(useAppStore.getState().chatSidePanel, 'diff')
  assert.equal(useAppStore.getState().editorDirty, true)
})

test('does not open deleted files or files without an active workspace', async () => {
  await openDiffFile({ newPath: 'deleted.ts', isDeleted: true }, '')
  assert.equal(useAppStore.getState().previewTarget, null)
  useAppStore.setState({ activeWorkspace: null })
  await openDiffFile({ newPath: 'file.ts', isDeleted: false }, '')
  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().currentView, 'diff')
})
