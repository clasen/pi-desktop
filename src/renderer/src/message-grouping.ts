import type { DisplayMessage } from './store'
// Aliased: every helper below takes its translator as a parameter named `t`
// (shadowing this import inside the function body) so `i18next-cli`'s
// static extractor — which looks for calls on an identifier named `t` —
// still finds and keeps these keys.
import { t as sharedT, type Translate } from '../../shared/i18n'

export type ToolCall = NonNullable<DisplayMessage['toolCalls']>[number]

/** A tool result paired to the step that produced it. */
export interface ToolOutput {
  content: string
  isError?: boolean
  toolFile?: string
}

/** One row in an agent turn's activity timeline. */
export type TurnStep =
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'narration'; id: string; message: DisplayMessage }
  | { kind: 'tool'; id: string; call: ToolCall; output?: ToolOutput }

/**
 * Everything the agent did between two user (or system) messages: one shared
 * header, an activity timeline, and the closing answer. While live, every prose
 * message stays in the timeline as narration; once finished, the trailing prose
 * is promoted to `answer` so it can sit below a collapsed activity summary.
 */
export interface AgentTurn {
  id: string
  steps: TurnStep[]
  answer: DisplayMessage[]
  /** "Ran 3 commands, read a file"; empty when the turn used no tools. */
  summary: string
  failedSteps: number
  model?: string
  provider?: string
  cost?: number
  timestamp?: number
  live: boolean
}

export type ChatRenderItem =
  | { kind: 'message'; message: DisplayMessage }
  | { kind: 'turn'; turn: AgentTurn }

/** What a tool call does, independent of the display language. */
export type ToolKind = 'fetch' | 'read' | 'run' | 'edit' | 'write' | 'search' | 'list'
type TargetToolKind = Exclude<ToolKind, 'run'>
// Unknown tools bucket together in group titles.
type SummaryKind = ToolKind | 'other'

// Keyword matching is shared by toolCallLabel() and toolCallIconFor() so the label
// and icon stay in sync.
export function toolKind(name: string): ToolKind | null {
  const n = name.toLowerCase()
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('terminal')) return 'run'
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'search'
  if (n.includes('web') || n.includes('fetch') || n.includes('http') || n.includes('url')) return 'fetch'
  if (n.includes('edit') || n.includes('replace') || n.includes('patch')) return 'edit'
  if (n.includes('write') || n.includes('create')) return 'write'
  if (n.includes('list') || n.startsWith('ls') || n.includes('tree') || n.includes('dir')) return 'list'
  if (n.includes('read') || n.includes('view') || n.includes('cat') || n.includes('file')) return 'read'
  return null
}

const PATH_ARG_KEYS = ['path', 'file', 'filename', 'file_path', 'filepath']

// Argument fields a single-op label pulls its shown value from. Commands
// ('run') read RUN_ARG_KEYS and show the command itself instead of a verb.
const TOOL_ARG_KEYS: Record<TargetToolKind, readonly string[]> = {
  fetch: ['url', 'uri', 'href', 'link'],
  read: PATH_ARG_KEYS,
  edit: PATH_ARG_KEYS,
  write: PATH_ARG_KEYS,
  search: ['query', 'pattern', 'text', 'search', 'q', 'regex'],
  list: ['path', 'dir', 'directory', 'location', 'folder'],
}

const TOOL_DONE_KEYS = {
  fetch: 'tools.fetch.done',
  read: 'tools.read.done',
  edit: 'tools.edit.done',
  write: 'tools.write.done',
  search: 'tools.search.done',
  list: 'tools.list.done',
} as const satisfies Record<TargetToolKind, string>

const PATH_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(['read', 'edit', 'write', 'list'])

const MAX_ARG_LEN = 60

function hasTarget(kind: ToolKind): kind is TargetToolKind {
  return kind !== 'run'
}

function shorten(s: string): string {
  return s.length > MAX_ARG_LEN ? s.slice(0, MAX_ARG_LEN - 1) + '…' : s
}

const RUN_ARG_KEYS = ['command', 'cmd', 'script']

// Pull the value a single-op label should show from the tool call's arguments.
function extractArg(kind: ToolKind, argumentsJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  for (const key of hasTarget(kind) ? TOOL_ARG_KEYS[kind] : RUN_ARG_KEYS) {
    const val = obj[key]
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return null
}

// Path-like args show just the basename; URLs/queries show in full (shortened).
function displayArg(kind: TargetToolKind, raw: string): string {
  if (PATH_KINDS.has(kind)) {
    const base = raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    return shorten(base || raw)
  }
  return shorten(raw)
}

// Canonical target of a tool call, for counting distinct operands in a group
// title — the same file read twice, or the same URL fetched twice, is one
// target. Path args normalize separators + case (so `C:\a\b.ts` and `c:/a/b.ts`
// match) and compare on the full path, so a same-named file in two dirs stays
// two targets; other args compare trimmed. A target-less call (a command, an
// unknown tool, or a tool whose arg can't be read) has no shared identity: it
// returns null and the caller counts it on its own.
function toolTarget(kind: ToolKind | null, argumentsJson: string): string | null {
  if (!kind || !hasTarget(kind)) return null
  const arg = extractArg(kind, argumentsJson)
  if (arg === null) return null
  if (PATH_KINDS.has(kind)) return arg.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return arg.trim()
}

/**
 * Label for a single tool-call row: past-tense verb plus the operated-on value,
 * e.g. "Fetched https://…", "Read config.ts". A command shows itself (first
 * line only; the row truncates it). Falls back to a value-less "<Verb> a <noun>"
 * when the argument can't be read, and to the raw name for unknown tools.
 */
export function toolCallLabel(name: string, argumentsJson: string, t: Translate = sharedT): string {
  const kind = toolKind(name)
  if (!kind) return name || t('tools.other.summaryFirst', { count: 1 })
  const arg = extractArg(kind, argumentsJson)
  if (arg === null) return t(`tools.${kind}.doneWithoutTarget`)
  if (!hasTarget(kind)) return arg.split('\n')[0]
  return t(TOOL_DONE_KEYS[kind], { target: displayArg(kind, arg) })
}

// Combine the per-tool verbs across a turn into one title, e.g.
// "Fetched 4 URLs, read 2 files, edited a file". Counts are bucketed by kind in
// first-appearance order and count *distinct* targets, so re-reading one file
// or re-fetching one URL reads "Read a file" / "Fetched a URL", not "2".
// Target-less calls (commands, unresolved args) each count on their own.
// Unknown tools bucket together under 'other'.
function turnSummary(calls: ToolCall[], t: Translate): string {
  const order: SummaryKind[] = []
  const targets = new Map<SummaryKind, Set<string>>()
  let uniqueSeq = 0 // gives each target-less call its own bucket entry
  for (const tc of calls) {
    const kind = toolKind(tc.name)
    const bucket: SummaryKind = kind ?? 'other'
    if (!targets.has(bucket)) {
      order.push(bucket)
      targets.set(bucket, new Set())
    }
    targets.get(bucket)!.add(toolTarget(kind, tc.arguments) ?? `\0${uniqueSeq++}`)
  }

  return order
    .map((bucket, i) => {
      const count = targets.get(bucket)!.size
      return i === 0
        ? t(`tools.${bucket}.summaryFirst`, { count })
        : t(`tools.${bucket}.summaryNext`, { count })
    })
    .join(t('tools.summarySeparator'))
}

function buildTurn(id: string, messages: DisplayMessage[], live: boolean, t: Translate): AgentTurn {
  const steps: TurnStep[] = []
  const toolSteps = new Map<string, Extract<TurnStep, { kind: 'tool' }>>()
  let model: string | undefined
  let provider: string | undefined
  let cost: number | undefined

  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.model && model === undefined) {
        model = m.model
        provider = m.provider
      }
      if (m.cost !== undefined) cost = (cost ?? 0) + m.cost
      if (m.thinking?.trim()) steps.push({ kind: 'thinking', id: `${m.id}:thinking`, text: m.thinking })
      if (m.content.trim()) steps.push({ kind: 'narration', id: m.id, message: m })
      for (const call of m.toolCalls ?? []) {
        // Edit/write results are folded onto the call; marker calls carry their own.
        const step: Extract<TurnStep, { kind: 'tool' }> = {
          kind: 'tool',
          id: call.id,
          call,
          output: call.result !== undefined ? { content: call.result, isError: call.isError } : undefined,
        }
        toolSteps.set(call.id, step)
        steps.push(step)
      }
    } else if (m.role === 'toolResult') {
      const output: ToolOutput = { content: m.content, isError: m.isError, toolFile: m.toolFile }
      const step = m.toolCallId ? toolSteps.get(m.toolCallId) : undefined
      if (step) step.output = output
      else steps.push({ kind: 'tool', id: m.id, call: { id: m.id, name: m.toolName ?? '', arguments: '{}' }, output })
    }
  }

  // A finished turn's trailing prose is its answer; reasoning stays in the activity.
  const answer: DisplayMessage[] = []
  if (!live) {
    let lastTool = -1
    steps.forEach((step, index) => {
      if (step.kind === 'tool') lastTool = index
    })
    for (let i = steps.length - 1; i > lastTool; i--) {
      const step = steps[i]
      if (step.kind !== 'narration') continue
      answer.unshift(step.message)
      steps.splice(i, 1)
    }
  }

  const tools = steps.filter((step): step is Extract<TurnStep, { kind: 'tool' }> => step.kind === 'tool')
  return {
    id,
    steps,
    answer,
    summary: tools.length > 0 ? turnSummary(tools.map((step) => step.call), t) : '',
    failedSteps: tools.filter((step) => step.call.isError ?? step.output?.isError).length,
    model,
    provider,
    cost,
    timestamp: messages.at(-1)?.timestamp,
    live,
  }
}

/**
 * Fold everything the agent did between two user/system messages into one
 * `turn` item. User and system messages render on their own. While streaming,
 * the turn after the last user message is live (it exists even before the agent
 * commits anything, so the streaming tail has a home). A turn's id derives from
 * the message before it so it stays stable as the live turn grows.
 */
export function groupAgentTurns(messages: DisplayMessage[], t: Translate = sharedT, isStreaming = false): ChatRenderItem[] {
  const items: ChatRenderItem[] = []
  let run: DisplayMessage[] = []
  let boundaryId: string | null = null

  const flush = (live: boolean): void => {
    if (run.length === 0 && !live) return
    const id = `turn-${boundaryId ?? run[0]?.id ?? 'live'}`
    items.push({ kind: 'turn', turn: buildTurn(id, run, live, t) })
    run = []
  }

  for (const m of messages) {
    if (m.role === 'assistant' || m.role === 'toolResult') {
      run.push(m)
    } else {
      flush(false)
      items.push({ kind: 'message', message: m })
      boundaryId = m.id
    }
  }
  flush(isStreaming)

  return items
}

/** The full command a shell-style tool call runs, or null. */
export function toolCallCommand(argumentsJson: string): string | null {
  return extractArg('run', argumentsJson)
}

/** The file/location a read/write/edit/list tool call operates on, or null. */
export function toolCallFile(name: string, argumentsJson: string): string | null {
  const kind = toolKind(name)
  if (!kind || !PATH_KINDS.has(kind) || !hasTarget(kind)) return null
  return extractArg(kind, argumentsJson)
}

/** Edit/write results fold onto the call badge instead of a separate row. */
function resultFoldsIntoBadge(name: string): boolean {
  const kind = toolKind(name)
  return kind === 'edit' || kind === 'write'
}

// One replacement in an edit tool call: old text swapped for new.
export interface EditBlock {
  oldText: string
  newText: string
}

/** The edit blocks from an edit tool call's arguments (`{ edits: [...] }`), or null. */
function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string') return v
  }
  return undefined
}

/** Edit blocks from tool args ({ edits: [...] } or old_string/new_string). */
export function parseEdits(argumentsJson: string): EditBlock[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  const edits = obj.edits
  if (Array.isArray(edits)) {
    const blocks: EditBlock[] = []
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue
      const block = e as Record<string, unknown>
      const oldText = stringField(block, ['oldText', 'old_text', 'old_string', 'oldString', 'old_str', 'before'])
      const newText = stringField(block, ['newText', 'new_text', 'new_string', 'newString', 'new_str', 'after'])
      if (oldText !== undefined && newText !== undefined) {
        blocks.push({ oldText, newText })
      }
    }
    if (blocks.length > 0) return blocks
  }

  const oldText = stringField(obj, ['oldText', 'old_text', 'old_string', 'oldString', 'old_str', 'before'])
  const newText = stringField(obj, ['newText', 'new_text', 'new_string', 'newString', 'new_str', 'after'])
  if (oldText !== undefined && newText !== undefined) {
    return [{ oldText, newText }]
  }
  return null
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length)

/** Added/removed line totals across an edit's blocks (old lines out, new lines in). */
export function editStats(blocks: EditBlock[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const b of blocks) {
    removed += lineCount(b.oldText)
    added += lineCount(b.newText)
  }
  return { added, removed }
}

// Pi appends a footer to a truncated read, e.g.
// "[262 more lines in file. Use offset=21 to continue.]". Match it so it can be
// shown as a note rather than syntax-highlighted as code.
const READ_TRUNCATION_RE = /^\[\d+ more lines? in file\b.*\]$/

/**
 * Split a read result's trailing truncation footer (if any) from the file
 * content, so the footer isn't highlighted as code. Trailing blank lines between
 * the content and the footer are dropped with it.
 */
export function splitReadTruncationNote(content: string): { code: string; note: string | null } {
  const lines = content.split('\n')
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last--
  if (last < 0 || !READ_TRUNCATION_RE.test(lines[last].trim())) return { code: content, note: null }
  const note = lines[last].trim()
  let end = last - 1
  while (end >= 0 && lines[end].trim() === '') end--
  return { code: lines.slice(0, end + 1).join('\n'), note }
}

/**
 * Prepare the raw message list for rendering:
 *  - enrich each toolResult with the paired call's toolName + operated-on toolFile
 *  - fold edit/write results into the call badge (drop the separate success pill)
 *  - split prose+tools so tool calls can join an adjacent tool run for grouping
 *
 * Pure; reuses message objects when nothing changed so memoized bubbles stay stable.
 */
export function prepareChatMessages(messages: DisplayMessage[]): DisplayMessage[] {
  const calls = new Map<string, { name: string; file: string | null }>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        calls.set(tc.id, { name: tc.name, file: toolCallFile(tc.name, tc.arguments) })
      }
    }
  }

  const results = new Map<string, { content: string; isError?: boolean }>()
  for (const m of messages) {
    if (m.role === 'toolResult' && m.toolCallId && !results.has(m.toolCallId)) {
      results.set(m.toolCallId, { content: m.content, isError: m.isError })
    }
  }

  const out: DisplayMessage[] = []

  // Split prose+tools so tools can join a group; pure turns stay as-is.
  const pushAssistant = (m: DisplayMessage): void => {
    const hasProse = m.content.trim().length > 0
    const hasTools = (m.toolCalls?.length ?? 0) > 0

    // Fold result bodies onto edit/write calls only. Read/bash keep a standalone
    // result pill — putting the body on the badge as well would show it twice.
    let toolCalls = m.toolCalls
    if (toolCalls && results.size > 0) {
      let changed = false
      const next = toolCalls.map((tc) => {
        const r = results.get(tc.id)
        if (!r) return tc
        const foldIntoBadge = resultFoldsIntoBadge(tc.name)
        changed = true
        return {
          ...tc,
          result: foldIntoBadge ? (tc.result ?? r.content) : tc.result,
          isError: tc.isError ?? r.isError ?? false,
        }
      })
      if (changed) toolCalls = next
    }

    const base = toolCalls !== m.toolCalls ? { ...m, toolCalls } : m
    if (!hasProse || !hasTools) {
      out.push(base)
      return
    }
    out.push({ ...base, toolCalls: undefined })
    out.push({
      ...base,
      id: `${m.id}::tools`,
      content: '',
      thinking: undefined,
      cost: undefined,
      attachments: undefined,
    })
  }

  for (const m of messages) {
    if (m.role === 'assistant') {
      pushAssistant(m)
    } else if (m.role === 'toolResult' && m.toolCallId) {
      const paired = calls.get(m.toolCallId)
      // Edit/write: result lives on the call badge. Read/bash keep a result row.
      if (paired) {
        if (resultFoldsIntoBadge(paired.name)) continue
        out.push({ ...m, toolName: paired.name, toolFile: paired.file ?? undefined })
      } else {
        out.push(m)
      }
    } else {
      out.push(m)
    }
  }
  return out
}
