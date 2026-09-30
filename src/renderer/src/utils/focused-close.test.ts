import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { i18n, t } from '../../../shared/i18n'
import { ChatToolRail } from '../components/chat-tool-rail'
import { useAppStore } from '../store'
import { createFocusedCloser } from './focused-close'

const initialState = useAppStore.getState()

class Target {
  isConnected = true
  visible = true
  constructor(private kind: string | null = null, private parent: Target | null = null) {}
  closest(): Target | null { return this.kind ? this : this.parent?.closest() ?? null }
  getAttribute(): string | null { return this.kind }
  checkVisibility(): boolean { return this.visible }
}

class FocusDocument {
  private listeners = new Map<string, EventListener>()
  constructor(public activeElement: Target | null = null) {}
  addEventListener(type: string, listener: EventListener): void { this.listeners.set(type, listener) }
  removeEventListener(type: string): void { this.listeners.delete(type) }
  interact(type: 'focusin' | 'pointerdown', target: Target): void {
    if (type === 'focusin') this.activeElement = target
    this.listeners.get(type)?.({ target } as unknown as Event)
  }
  get listenerCount(): number { return this.listeners.size }
}

let closedSessions: string[]
let document: FocusDocument
let closer: ReturnType<typeof createFocusedCloser>

beforeEach(() => {
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: Target })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { piDesktop: {
    ui: { setEditorDirty: () => {} }, system: { platform: 'darwin' },
  } } })
  useAppStore.setState(initialState, true)
  closedSessions = []
  useAppStore.setState({
    currentView: 'chat', activeSessionRuntimeId: 'active', chatSidePanel: 'diff',
    terminalOpen: true, reviewOpen: true, workflowPanelOpen: true,
    previewTarget: { kind: 'code', path: '/project/a.ts', relativePath: 'a.ts', name: 'a.ts' },
    closeSessionTab: async (id) => { closedSessions.push(id) },
  })
  document = new FocusDocument(new Target(null, new Target('session')))
  closer = createFocusedCloser(document as unknown as Document)
})

afterEach(() => {
  closer.dispose()
  useAppStore.setState(initialState, true)
})

test('composer focus closes the active session, not an open terminal, diff or editor', async () => {
  await closer.close()
  assert.deepEqual(closedSessions, ['active'])
  const state = useAppStore.getState()
  assert.equal(state.terminalOpen, true)
  assert.equal(state.chatSidePanel, 'diff')
  assert.equal(state.previewTarget?.path, '/project/a.ts')
})

test('terminal focus hides only the terminal without stopping its PTY or session', async () => {
  document.interact('focusin', new Target(null, new Target('terminal')))
  await closer.close()
  const state = useAppStore.getState()
  assert.equal(state.terminalOpen, false)
  assert.equal(state.chatSidePanel, 'diff')
  assert.ok(state.previewTarget)
  assert.equal(state.composerFocusRequested, true)
  assert.deepEqual(closedSessions, [])
})

test('clicking non-focusable diff text takes precedence over the composer DOM focus', async () => {
  const composer = document.activeElement
  document.interact('pointerdown', new Target(null, new Target('diff')))
  assert.equal(document.activeElement, composer)
  await closer.close()
  assert.equal(useAppStore.getState().chatSidePanel, null)
  assert.equal(useAppStore.getState().terminalOpen, true)
  assert.deepEqual(closedSessions, [])
  document.interact('focusin', new Target(null, new Target('session')))
  await closer.close()
  assert.deepEqual(closedSessions, ['active'])
})

test('opening files or diff from its rendered rail button lets close dismiss that panel', async () => {
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  const markup = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(ChatToolRail)))
  const buttons = markup.match(/<button\b[^>]*>/g) ?? []
  for (const [panel, label] of [['files', t('chat.toolbar.fileTree')], ['diff', t('chat.toolbar.diffViewer')]] as const) {
    const button = buttons.find((tag) => tag.includes(`aria-label="${label}`))
    assert.ok(button)
    const target = new Target(button.match(/data-close-target="([^"]+)"/)?.[1] ?? null)
    useAppStore.setState({ chatSidePanel: null })
    document.interact('pointerdown', target)
    document.interact('focusin', target)
    await useAppStore.getState().setChatSidePanel(panel)
    await closer.close()
    assert.equal(useAppStore.getState().chatSidePanel, null, `${panel} must close from its rail button`)
    assert.deepEqual(closedSessions, [])
  }
})

test('a closed panel rail button never dismisses another open panel', async () => {
  useAppStore.setState({ chatSidePanel: 'files', composerFocusRequested: false })
  document.interact('focusin', new Target('diff'))
  await closer.close()
  assert.equal(useAppStore.getState().chatSidePanel, 'files')
  assert.equal(useAppStore.getState().composerFocusRequested, false)
  assert.deepEqual(closedSessions, [])
})

test('refreshing panel contents does not lose its close target', async () => {
  const panel = new Target('diff')
  const content = new Target(null, panel)
  document.interact('pointerdown', content)
  content.isConnected = false
  await closer.close()
  assert.equal(useAppStore.getState().chatSidePanel, null)
  assert.deepEqual(closedSessions, [])
})

test('full-page diff closes to chat without leaving a second diff open', async () => {
  useAppStore.setState({ currentView: 'diff' })
  document.interact('focusin', new Target('diff'))
  await closer.close()
  assert.equal(useAppStore.getState().currentView, 'chat')
  assert.equal(useAppStore.getState().chatSidePanel, null)
  assert.deepEqual(closedSessions, [])
})

test('file preview close preserves the file tree and respects unsaved-edit cancellation', async () => {
  useAppStore.setState({ chatSidePanel: 'files', editorDirty: true })
  const editor = new Target(null, new Target('preview'))
  document.interact('focusin', editor)
  const cancelled = closer.close()
  assert.ok(useAppStore.getState().confirmRequest)
  useAppStore.getState().resolveConfirm(false)
  await cancelled
  assert.equal(useAppStore.getState().editorDirty, true)
  assert.ok(useAppStore.getState().previewTarget)
  assert.equal(useAppStore.getState().composerFocusRequested, false)

  const accepted = closer.close()
  useAppStore.getState().resolveConfirm(true)
  await accepted
  assert.equal(useAppStore.getState().previewTarget, null)
  assert.equal(useAppStore.getState().editorDirty, false)
  assert.equal(useAppStore.getState().chatSidePanel, 'files')
  assert.deepEqual(closedSessions, [])
})

test('file tree close preserves even a dirty file preview', async () => {
  useAppStore.setState({ chatSidePanel: 'files', editorDirty: true })
  document.interact('pointerdown', new Target('files'))
  await closer.close()
  assert.equal(useAppStore.getState().chatSidePanel, null)
  assert.ok(useAppStore.getState().previewTarget)
  assert.equal(useAppStore.getState().editorDirty, true)
  assert.equal(useAppStore.getState().confirmRequest, null)
  assert.deepEqual(closedSessions, [])
})

test('image previews, review and workflow panels close independently', async () => {
  useAppStore.setState({ previewTarget: { kind: 'image', path: '/project/a.png', relativePath: 'a.png', name: 'a.png' } })
  document.interact('pointerdown', new Target('preview'))
  await closer.close()
  assert.equal(useAppStore.getState().previewTarget, null)
  document.interact('focusin', new Target('review'))
  await closer.close()
  assert.equal(useAppStore.getState().reviewOpen, false)
  assert.equal(useAppStore.getState().workflowPanelOpen, true)
  document.interact('focusin', new Target('workflows'))
  await closer.close()
  assert.equal(useAppStore.getState().workflowPanelOpen, false)
  assert.deepEqual(closedSessions, [])
})

test('other main views return to chat rather than closing a background session', async () => {
  useAppStore.setState({ currentView: 'settings' })
  document.interact('focusin', new Target('view'))
  await closer.close()
  assert.equal(useAppStore.getState().currentView, 'chat')
  assert.deepEqual(closedSessions, [])
})

test('hidden, detached or unscoped targets and pending confirms cannot close a session', async () => {
  const hidden = new Target('session')
  hidden.visible = false
  const detached = new Target('session')
  detached.isConnected = false
  for (const target of [hidden, detached, new Target()]) {
    document.interact('focusin', target)
    await closer.close()
  }
  document.interact('focusin', new Target('session'))
  const confirmation = useAppStore.getState().requestConfirm({ title: 'Confirm', message: 'Continue?' })
  await closer.close()
  useAppStore.getState().resolveConfirm(false)
  await confirmation
  assert.deepEqual(closedSessions, [])
})

test('disposing removes focus and pointer listeners', () => {
  assert.equal(document.listenerCount, 2)
  closer.dispose()
  assert.equal(document.listenerCount, 0)
})
