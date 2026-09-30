import { useAppStore } from '../store'

/** Track pointer interactions too: clicking a panel's text need not move DOM focus. */
export function createFocusedCloser(document: Document): { close: () => Promise<void>; dispose: () => void } {
  let scope = document.activeElement?.closest('[data-close-target]') ?? null
  const track = (event: Event): void => {
    scope = event.target instanceof Element ? event.target.closest('[data-close-target]') : null
  }
  document.addEventListener('focusin', track, true)
  document.addEventListener('pointerdown', track, true)

  const close = async (): Promise<void> => {
    if (!scope?.isConnected || !scope.checkVisibility()) return
    const state = useAppStore.getState()
    if (state.confirmRequest) return

    switch (scope.getAttribute('data-close-target')) {
      case 'terminal':
        if (!state.terminalOpen) return
        state.toggleTerminal()
        break
      case 'preview':
        if (!(await state.setPreviewTarget(null))) return
        break
      case 'files':
        if (state.chatSidePanel !== 'files') return
        await state.setChatSidePanel(null)
        break
      case 'diff':
        if (state.chatSidePanel !== 'diff' && state.currentView !== 'diff') return
        await state.setChatSidePanel(null)
        if (state.currentView === 'diff') state.setCurrentView('chat')
        break
      case 'review':
        if (!state.reviewOpen) return
        state.toggleReview()
        break
      case 'workflows':
        state.setWorkflowPanelOpen(false)
        break
      case 'view':
        if (state.currentView === 'chat' || state.currentView === 'home') return
        state.setCurrentView('chat')
        break
      case 'session':
        if (state.activeSessionRuntimeId) await state.closeSessionTab(state.activeSessionRuntimeId)
        return
      default:
        return
    }
    useAppStore.setState({ composerFocusRequested: true })
  }

  return {
    close,
    dispose: () => {
      document.removeEventListener('focusin', track, true)
      document.removeEventListener('pointerdown', track, true)
    },
  }
}
