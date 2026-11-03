import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  groupAgentTurns,
  toolKind,
  toolCallLabel,
  toolCallFile,
  parseEdits,
  editStats,
  prepareChatMessages,
  splitReadTruncationNote,
  type AgentTurn,
  type ChatRenderItem,
} from './message-grouping'
import type { DisplayMessage } from './message-parsing'
import { i18n, t } from '../../shared/i18n'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE } from '../../shared/i18n/languages'

let idCounter = 0
function assistant(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return { id: `a${++idCounter}`, role: 'assistant', content: '', timestamp: 0, ...over }
}
// Pi pairs every result to its call; result() answers the latest toolTurn().
let lastCallId: string | undefined
function toolTurn(name: string, args: Record<string, unknown> = {}): DisplayMessage {
  lastCallId = `tc${++idCounter}`
  return assistant({ toolCalls: [{ id: lastCallId, name, arguments: JSON.stringify(args) }] })
}
function result(toolCallId = lastCallId): DisplayMessage {
  return { id: `r${++idCounter}`, role: 'toolResult', content: 'output', timestamp: 0, toolCallId }
}
function prose(text = 'hello'): DisplayMessage {
  return assistant({ content: text })
}
function user(): DisplayMessage {
  return { id: `u${++idCounter}`, role: 'user', content: 'hi', timestamp: 0 }
}

function turns(items: ChatRenderItem[]): AgentTurn[] {
  return items.flatMap((item) => (item.kind === 'turn' ? [item.turn] : []))
}
function titles(items: ChatRenderItem[]): string[] {
  return turns(items).map((turn) => turn.summary).filter(Boolean)
}

test('folds everything the agent did after a prompt into one turn with its answer', () => {
  const items = groupAgentTurns([
    user(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    prose('Here are three stories'),
  ])
  assert.deepEqual(items.map((item) => item.kind), ['message', 'turn'])
  const [turn] = turns(items)
  assert.equal(turn.summary, 'Fetched 3 URLs')
  assert.equal(turn.steps.length, 3)
  assert.ok(turn.steps.every((step) => step.kind === 'tool'))
  assert.deepEqual(turn.answer.map((m) => m.content), ['Here are three stories'])
  assert.equal(turn.live, false)
})

test('a live turn keeps its prose in the timeline and exists before anything is committed', () => {
  const prompt = user()
  const waiting = groupAgentTurns([prompt], t, true)
  assert.equal(turns(waiting)[0]?.live, true)
  assert.deepEqual(turns(waiting)[0]?.steps, [])

  const working = [prompt, prose('Checking the config'), toolTurn('bash', { command: 'ls' }), result(), prose('Found it')]
  const live = turns(groupAgentTurns(working, t, true))[0]
  assert.equal(live.id, turns(waiting)[0].id, 'the live turn keeps its key as it grows')
  assert.deepEqual(live.answer, [])
  assert.deepEqual(live.steps.map((step) => step.kind), ['narration', 'tool', 'narration'])

  const done = turns(groupAgentTurns(working, t, false))[0]
  assert.equal(done.id, live.id, 'finishing keeps the key so the view folds in place')
  assert.deepEqual(done.steps.map((step) => step.kind), ['narration', 'tool'])
  assert.deepEqual(done.answer.map((m) => m.content), ['Found it'])
})

test('only the latest turn is live while streaming', () => {
  const items = groupAgentTurns([user(), toolTurn('bash'), result(), prose('a'), user(), toolTurn('read_file')], t, true)
  assert.deepEqual(turns(items).map((turn) => turn.live), [false, true])
})

test('tool results attach to their call step instead of rendering separately', () => {
  const items = groupAgentTurns(prepareChatMessages([
    callTurn('bash', 'c1', { command: 'wc -l p.txt' }),
    { ...resultFor('c1', '34 p.txt'), isError: true },
  ]))
  const [step] = turns(items)[0].steps
  assert.equal(step.kind, 'tool')
  assert.equal(step.kind === 'tool' && step.output?.content, '34 p.txt')
  assert.equal(turns(items)[0].failedSteps, 1)
})

test('a turn without tools has no summary and keeps its reasoning as a step', () => {
  const [turn] = turns(groupAgentTurns([user(), assistant({ thinking: 'hmm', content: 'Hi there' })]))
  assert.equal(turn.summary, '')
  assert.deepEqual(turn.steps.map((step) => step.kind), ['thinking'])
  assert.deepEqual(turn.answer.map((m) => m.content), ['Hi there'])
})

test('mixed tools combine their verbs (first capitalized, rest lower-cased)', () => {
  const items = groupAgentTurns([
    toolTurn('read_file'),
    result(),
    toolTurn('web_fetch'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Read a file, fetched a URL'])
})

test('mixed run combines counts per tool type in first-appearance order', () => {
  const items = groupAgentTurns([
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('web_fetch'),
    result(),
    toolTurn('read_file'),
    result(),
    toolTurn('read_file'),
    result(),
    toolTurn('edit_file'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Fetched 4 URLs, read 2 files, edited a file'])
})

test('unknown tools bucket together under the generic verb', () => {
  const items = groupAgentTurns([
    toolTurn('mystery_tool'),
    result(),
    toolTurn('another_weird_one'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Ran 2 tools'])
})

test('narration between steps stays inside the turn', () => {
  const items = groupAgentTurns([
    toolTurn('bash'),
    result(),
    toolTurn('bash'),
    result(),
    prose('done phase one'),
    toolTurn('read_file'),
    result(),
    toolTurn('read_file'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Ran 2 commands, read 2 files'])
  assert.equal(turns(items)[0].steps.filter((step) => step.kind === 'narration').length, 1)
})

test('thinking-only turns become steps without counting as tools', () => {
  const thinkingOnly = assistant({ thinking: 'let me think', content: '' })
  const items = groupAgentTurns([
    toolTurn('web_fetch'),
    result(),
    thinkingOnly,
    toolTurn('web_fetch'),
    result(),
  ])
  assert.deepEqual(titles(items), ['Fetched 2 URLs'])
  assert.deepEqual(turns(items)[0].steps.map((step) => step.kind), ['tool', 'thinking', 'tool'])
})

test('multiple tool calls in a single assistant turn count toward the threshold', () => {
  const twoCalls = assistant({
    toolCalls: [
      { id: 'x1', name: 'read_file', arguments: '{}' },
      { id: 'x2', name: 'read_file', arguments: '{}' },
    ],
  })
  const items = groupAgentTurns([twoCalls, result('x1'), result('x2')])
  assert.deepEqual(titles(items), ['Read 2 files'])
})

test('group title counts distinct targets: same file read twice reads as one', () => {
  const items = groupAgentTurns([
    toolTurn('read_file', { path: 'src/app/foo.ts' }),
    result(),
    toolTurn('read_file', { path: 'src/app/foo.ts' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Read a file'])
})

test('group title counts distinct targets: same URL fetched thrice reads as one', () => {
  const items = groupAgentTurns([
    toolTurn('web_fetch', { url: 'https://cnn.com' }),
    result(),
    toolTurn('web_fetch', { url: 'https://cnn.com' }),
    result(),
    toolTurn('web_fetch', { url: 'https://cnn.com' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Fetched a URL'])
})

test('group title counts same-named files in different dirs as distinct', () => {
  const items = groupAgentTurns([
    toolTurn('read_file', { path: 'a/foo.ts' }),
    result(),
    toolTurn('read_file', { path: 'b/foo.ts' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Read 2 files'])
})

test('group title dedupes paths across separators and case', () => {
  const items = groupAgentTurns([
    toolTurn('read_file', { path: 'C:\\work\\Foo.ts' }),
    result(),
    toolTurn('read_file', { path: 'c:/work/foo.ts' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Read a file'])
})

test('group title dedupes per target in a mixed run', () => {
  const items = groupAgentTurns([
    toolTurn('web_fetch', { url: 'https://x.com' }),
    result(),
    toolTurn('web_fetch', { url: 'https://x.com' }),
    result(),
    toolTurn('read_file', { path: 'a.ts' }),
    result(),
    toolTurn('read_file', { path: 'b.ts' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Fetched a URL, read 2 files'])
})

test('group title still counts target-less commands individually', () => {
  const items = groupAgentTurns([
    toolTurn('bash', { command: 'ls' }),
    result(),
    toolTurn('bash', { command: 'ls' }),
    result(),
  ])
  assert.deepEqual(titles(items), ['Ran 2 commands'])
})

test('toolCallLabel shows the operated-on value (path args as basename)', () => {
  assert.equal(toolCallLabel('web_fetch', '{"url":"https://x.com/a"}'), 'Fetched https://x.com/a')
  assert.equal(toolCallLabel('read_file', '{"path":"src/app/foo.ts"}'), 'Read foo.ts')
  assert.equal(toolCallLabel('write_file', '{"path":"a/b/new.ts"}'), 'Created new.ts')
  assert.equal(toolCallLabel('edit_file', '{"file":"lib/bar.ts"}'), 'Edited bar.ts')
  assert.equal(toolCallLabel('grep', '{"pattern":"TODO"}'), 'Searched TODO')
  assert.equal(toolCallLabel('list_dir', '{"path":"src/components"}'), 'Listed components')
})

test('toolCallLabel shows a command itself (first line) and omits a missing value', () => {
  assert.equal(toolCallLabel('bash', '{"command":"ls -la"}'), 'ls -la')
  assert.equal(toolCallLabel('bash', JSON.stringify({ command: 'cat <<EOF\nbody\nEOF' })), 'cat <<EOF')
  assert.equal(toolCallLabel('bash', '{}'), 'Ran a command')
  assert.equal(toolCallLabel('read_file', '{}'), 'Read a file')
  assert.equal(toolCallLabel('some_custom_tool', '{}'), 'some_custom_tool')
})

test('toolCallLabel truncates very long values', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(100)
  const label = toolCallLabel('web_fetch', JSON.stringify({ url: longUrl }))
  assert.ok(label.startsWith('Fetched https://example.com/'))
  assert.ok(label.endsWith('…'))
  assert.ok(label.length < longUrl.length)
})

test('toolCallFile resolves the operated-on path for file tools only', () => {
  assert.equal(toolCallFile('read_file', '{"path":"src/foo.ts"}'), 'src/foo.ts')
  assert.equal(toolCallFile('edit_file', '{"path":"a/b.py","edits":[]}'), 'a/b.py')
  assert.equal(toolCallFile('list_dir', '{"path":"src"}'), 'src')
  assert.equal(toolCallFile('web_fetch', '{"url":"https://x.com"}'), null)
  assert.equal(toolCallFile('bash', '{"command":"ls"}'), null)
})

test('parseEdits reads the edits array and editStats counts lines', () => {
  const args = JSON.stringify({
    path: 'x.py',
    edits: [
      { oldText: 'a\nb\nc', newText: 'A' },
      { oldText: '', newText: 'new1\nnew2' },
    ],
  })
  const blocks = parseEdits(args)
  assert.equal(blocks?.length, 2)
  assert.deepEqual(editStats(blocks!), { added: 3, removed: 3 })
  assert.equal(parseEdits('{"path":"x"}'), null)
  assert.equal(parseEdits('not json'), null)
})

// Helpers for prepareChatMessages: an assistant tool turn with a known call id,
// and a toolResult that pairs to it.
function callTurn(name: string, id: string, args: Record<string, unknown> = {}): DisplayMessage {
  return assistant({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] })
}
function resultFor(id: string, content = 'output'): DisplayMessage {
  return { id: `${id}-result`, role: 'toolResult', content, timestamp: 0, toolCallId: id }
}

test('prepareChatMessages enriches tool results with paired name and file', () => {
  const out = prepareChatMessages([
    callTurn('read_file', 'r1', { path: 'src/app/foo.ts' }),
    resultFor('r1', 'export const x = 1'),
  ])
  const res = out.find((m) => m.id === 'r1-result')
  assert.equal(res?.toolName, 'read_file')
  assert.equal(res?.toolFile, 'src/app/foo.ts')
})

test('splitReadTruncationNote peels off Pi read footer and trailing blanks', () => {
  const content = 'line1\nline2\n\n[262 more lines in file. Use offset=21 to continue.]'
  const { code, note } = splitReadTruncationNote(content)
  assert.equal(code, 'line1\nline2')
  assert.equal(note, '[262 more lines in file. Use offset=21 to continue.]')
})

test('splitReadTruncationNote leaves untruncated content untouched', () => {
  const content = 'line1\nline2\nline3'
  const { code, note } = splitReadTruncationNote(content)
  assert.equal(code, content)
  assert.equal(note, null)
})

test('prepareChatMessages keeps every read, including a re-read of the same file', () => {
  const out = prepareChatMessages([
    callTurn('edit_file', 'e1', { path: 'C:/work/btc.py', edits: [{ oldText: 'a', newText: 'b' }] }),
    resultFor('e1', 'Successfully replaced 1 block'),
    callTurn('read_file', 'r1', { path: 'btc.py' }), // same file re-read -> still shown
    resultFor('r1', 'file body'),
  ])
  assert.equal(out.length, 3)
  assert.ok(!out.some((m) => m.id === 'e1-result'), 'edit result pill dropped')
  assert.ok(out.some((m) => m.toolCalls?.some((tc) => tc.id === 'e1' && tc.result === 'Successfully replaced 1 block')))
  assert.ok(out.some((m) => m.id === 'r1-result'), 're-read result kept')
  assert.ok(out.some((m) => m.toolCalls?.some((tc) => tc.id === 'r1')), 're-read call kept')
})

test('prepareChatMessages splits a prose+tools turn so its tool call can group', () => {
  const mixed = assistant({
    id: 'm1',
    content: 'Now let me pick two articles',
    model: 'ornith',
    provider: 'lmstudio',
    cost: 0.01,
    thinking: 'reasoning',
    toolCalls: [{ id: 'c1', name: 'web_fetch', arguments: '{"url":"https://x.com/a"}' }],
  })
  const out = prepareChatMessages([
    mixed,
    resultFor('c1'),
    callTurn('web_fetch', 'c2', { url: 'https://x.com/b' }),
    resultFor('c2'),
  ])

  // The mixed turn becomes: prose-only (keeps id/content/thinking/cost) + a
  // tool-only half (derived id, no prose bits, keeps model for the group header).
  const prosePart = out[0]
  assert.equal(prosePart.id, 'm1')
  assert.equal(prosePart.content, 'Now let me pick two articles')
  assert.equal(prosePart.thinking, 'reasoning')
  assert.equal(prosePart.toolCalls, undefined)

  const toolPart = out[1]
  assert.equal(toolPart.id, 'm1::tools')
  assert.equal(toolPart.content, '')
  assert.equal(toolPart.thinking, undefined)
  assert.equal(toolPart.cost, undefined)
  assert.equal(toolPart.model, 'ornith')
  assert.equal(toolPart.toolCalls?.[0].id, 'c1')

  // In the turn, the prose narrates before both fetches.
  const [turn] = turns(groupAgentTurns(out))
  assert.equal(turn.summary, 'Fetched 2 URLs')
  assert.deepEqual(turn.steps.map((step) => step.kind), ['thinking', 'narration', 'tool', 'tool'])
})

test('prepareChatMessages leaves a pure-prose or pure-tool turn as the same object', () => {
  const p = prose('just text')
  const t = toolTurn('web_fetch', { url: 'https://x.com' })
  const out = prepareChatMessages([p, t])
  assert.equal(out[0], p) // same ref — nothing to split
  assert.equal(out[1], t)
})

test('parseEdits accepts top-level old_string/new_string aliases', () => {
  const blocks = parseEdits(JSON.stringify({
    path: 'a.ts',
    old_string: 'foo',
    new_string: 'bar',
  }))
  assert.deepEqual(blocks, [{ oldText: 'foo', newText: 'bar' }])
})

test('toolKind names the operation independent of language', () => {
  assert.equal(toolKind('web_fetch'), 'fetch')
  assert.equal(toolKind('bash'), 'run')
  assert.equal(toolKind('edit_file'), 'edit')
  assert.equal(toolKind('write_file'), 'write')
  assert.equal(toolKind('grep'), 'search')
  assert.equal(toolKind('list_dir'), 'list')
  assert.equal(toolKind('read_file'), 'read')
  assert.equal(toolKind('some_custom_tool'), null)
})

test('grouping and file lookups do not change with the interface language', async () => {
  await i18n.changeLanguage(PSEUDO_LANGUAGE)
  try {
    const items = groupAgentTurns([
      toolTurn('bash', { command: 'ls' }),
      result(),
      toolTurn('bash', { command: 'pwd' }),
      result(),
    ])
    assert.deepEqual(titles(items), [t('tools.run.summaryFirst', { count: 2 })])
    assert.equal(toolCallFile('read_file', '{"path":"src/foo.ts"}'), 'src/foo.ts')
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
  }
})

test('prepareChatMessages drops edit toolResult pills after folding', () => {
  const out = prepareChatMessages([
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 0,
      toolCalls: [{
        id: 't1',
        name: 'edit',
        arguments: JSON.stringify({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
      }],
    },
    {
      id: 'r1',
      role: 'toolResult',
      content: 'ok',
      timestamp: 0,
      toolCallId: 't1',
      isError: false,
    },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'assistant')
  assert.equal(out[0].toolCalls?.[0].result, 'ok')
  assert.equal(out[0].toolCalls?.[0].isError, false)
})
