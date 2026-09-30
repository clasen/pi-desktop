import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent, SessionState } from '../../shared/ipc-contracts'

let compactCalls = 0
const piDesktopStub = {
  pi: {
    getStatus: async () => ({ status: 'stopped' as const, pid: null, error: null }),
  },
  session: {
    compact: async () => {
      compactCalls++
      return { type: 'response', command: 'compact', success: true }
    },
  },
}

type AppStore = typeof import('./store')['useAppStore']
let useAppStore: AppStore

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: piDesktopStub }
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  compactCalls = 0
  useAppStore.setState({
    messages: [],
    timelineEvents: [],
    sessionState: { isCompacting: false } as SessionState,
  })
})

function systemMessages(): string[] {
  return useAppStore
    .getState()
    .messages.filter((m) => m.role === 'system')
    .map((m) => m.content)
}

function isCompacting(): boolean | undefined {
  return useAppStore.getState().sessionState?.isCompacting
}

// Pi reports a manual compaction it refuses (e.g. "Already compacted") only via
// compaction_end.errorMessage; without surfacing it the chat stays on
// "Compacting context..." forever.
test('failed compaction surfaces the error and clears the compacting state', () => {
  const { handlePiEvent } = useAppStore.getState()
  handlePiEvent({ type: 'compaction_start', reason: 'manual' } as PiRpcEvent)
  assert.equal(isCompacting(), true)

  handlePiEvent({
    type: 'compaction_end',
    reason: 'manual',
    result: undefined,
    aborted: false,
    willRetry: false,
    errorMessage: 'Compaction failed: Already compacted',
  } as PiRpcEvent)

  assert.equal(isCompacting(), false)
  assert.deepEqual(systemMessages(), [
    'Compacting context (manual)...',
    'Error: Compaction failed: Already compacted',
  ])
})

test('compactContext does not start a second compaction while one runs', async () => {
  const { compactContext } = useAppStore.getState()
  await Promise.all([compactContext(), compactContext()])
  assert.equal(compactCalls, 1)
  assert.equal(isCompacting(), true)
})
