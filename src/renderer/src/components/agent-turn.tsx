import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { Bot, Brain, ChevronRight, CircleAlert, Copy, Check, Download, LoaderCircle } from 'lucide-react'
import { useAppStore, type DisplayMessage } from '../store'
import { modelDisplayName } from '../../../shared/models-config'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import {
  toolCallLabel,
  toolCallCommand,
  toolKind,
  toolCallFile,
  parseEdits,
  editStats,
  splitReadTruncationNote,
  type AgentTurn,
  type EditBlock,
  type ToolCall,
  type ToolOutput,
} from '../message-grouping'
import { toolCallIconFor } from './tool-call-icon'
import { getCodeEditorLanguageName } from './code-editor-language'
import { highlightCodeToHtml } from './chat-code-highlight'
import { LineNumberedCode } from './line-numbered-code'
import { MarkdownRenderer } from './markdown-renderer'
import { CopyButton } from './copy-button'
import { ActionButton, exportMessage } from './message-bubble'
import { useContextMenu, buildMessageContextMenu } from './context-menu'
import { RelativeTime } from '../utils/relative-time'

// ─── Turn ────────────────────────────────────────────────────────────────────

// One agent turn: a single header, the activity timeline, and the answer. A
// finished turn that used tools folds its activity into a one-line summary so
// the answer leads; a live turn keeps every step visible, with `tail` (the
// streaming steps) appended at the end of the timeline.
function AgentTurnViewImpl({ turn, tail }: { turn: AgentTurn; tail?: React.ReactNode }): React.JSX.Element | null {
  const { t } = useTranslation()
  const customModels = useAppStore((state) => state.customModels)
  const thinkingEnabled = useAppStore(
    (state) => state.settingsDraft.showThinking ?? state.settings?.showThinking ?? DEFAULT_SETTINGS.showThinking
  )
  const [expanded, setExpanded] = useState(false)

  const steps = thinkingEnabled ? turn.steps : turn.steps.filter((step) => step.kind !== 'thinking')
  if (!turn.live && steps.length === 0 && turn.answer.length === 0) return null

  // Collapsing starts once the turn ends: a live turn has no summary row, so the
  // `expanded` state is still false when it finishes and the activity folds.
  const collapsible = !turn.live && turn.summary !== ''
  const showActivity = (steps.length > 0 || tail !== undefined) && (!collapsible || expanded)

  return (
    <div className="group mb-6 animate-fade-in">
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            turn.live ? 'bg-accent-bg' : 'bg-card'
          )}
        >
          <Bot size={14} className={turn.live ? 'text-accent-fg animate-pulse' : 'text-muted'} />
        </div>
        <div className="min-w-0 flex-1">
          {turn.model && (
            <div className="flex min-h-7 flex-wrap items-center gap-x-2 whitespace-nowrap text-sm text-dim">
              <span className="max-w-full truncate">{turn.provider}</span>
              <span className="text-ghost">·</span>
              <span className="max-w-full truncate">{modelDisplayName(turn.model, customModels)}</span>
              {turn.cost !== undefined && (
                <>
                  <span className="text-ghost">·</span>
                  <span>${turn.cost.toFixed(4)}</span>
                </>
              )}
              {turn.timestamp !== undefined && (
                <>
                  <span className="text-ghost">·</span>
                  <RelativeTime timestamp={turn.timestamp} />
                </>
              )}
            </div>
          )}

          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="flex min-h-7 max-w-full items-center gap-1.5 text-left text-sm text-dim transition-colors hover:text-secondary"
            >
              <ChevronRight size={14} className={clsx('shrink-0 transition-transform', expanded && 'rotate-90')} />
              <span className="min-w-0 truncate">{turn.summary}</span>
              {turn.failedSteps > 0 && (
                <span className="shrink-0 text-error">
                  · {t('chat.turn.failedSteps', { count: turn.failedSteps })}
                </span>
              )}
            </button>
          )}

          {showActivity && (
            <div className="mt-1 ml-[7px] border-l border-border pl-4">
              {steps.map((step) =>
                step.kind === 'thinking' ? (
                  <ThinkingStep key={step.id} text={step.text} />
                ) : step.kind === 'narration' ? (
                  <NarrationStep key={step.id} message={step.message} />
                ) : (
                  <ToolStepRow key={step.id} call={step.call} output={step.output} />
                )
              )}
              {tail}
            </div>
          )}

          {turn.answer.map((message) => (
            <AnswerBody key={message.id} message={message} spaced={turn.model !== undefined || collapsible || showActivity} />
          ))}
        </div>
      </div>
    </div>
  )
}

export const AgentTurnView = memo(AgentTurnViewImpl)

// ─── Steps ───────────────────────────────────────────────────────────────────

// First readable line of the reasoning, shown next to the collapsed label.
function thinkingPreview(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/[*_`#>]/g, '').trim()
}

/** A reasoning row: collapsed to a one-line preview, expandable to the full text. */
export const ThinkingStep = memo(function ThinkingStep({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking-hover min-w-0">
      <div className="flex h-7 items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-dim transition-colors hover:text-muted"
        >
          <Brain size={13} className="shrink-0" />
          <span className="shrink-0">{t('common.thinking')}</span>
          {!open && <span className="min-w-0 truncate text-faint">{thinkingPreview(text)}</span>}
        </button>
        <CopyButton text={text} className="thinking-copy-btn shrink-0" />
      </div>
      {open && (
        <div className="markdown-body mb-2 ml-[21px] min-w-0 text-sm text-muted break-words [overflow-wrap:anywhere]">
          <MarkdownRenderer content={text} />
        </div>
      )}
    </div>
  )
})

/** Prose the agent writes between steps: it narrates the progress. */
export const NarrationStep = memo(function NarrationStep({ message }: { message: DisplayMessage }): React.JSX.Element {
  return (
    <div data-scroll-anchor={message.id} className="markdown-body my-1.5 min-w-0 text-sm break-words [overflow-wrap:anywhere]">
      <MarkdownRenderer content={message.content} />
    </div>
  )
})

// ─── Tool step ───────────────────────────────────────────────────────────────

// Guard against re-parsing a whole huge file for highlighting; the source is
// already truncated by Pi, this is just a ceiling.
const MAX_CODE_RESULT_CHARS = 20000
// Plain output is capped in the row; the copy button still yields all of it.
const MAX_PLAIN_OUTPUT_CHARS = 4000

/**
 * One tool call with its result: icon · what it did · duration. Success is the
 * silent default; only a running spinner or a failure is called out. Expanding
 * shows the command (or arguments) and its output in one place.
 */
function ToolStepRowImpl({ call, output }: { call: ToolCall; output?: ToolOutput }): React.JSX.Element {
  const { t } = useTranslation()
  const kind = toolKind(call.name)
  const edits = kind === 'edit' ? parseEdits(call.arguments) : null
  const stats = edits ? editStats(edits) : null
  // Edit diffs open expanded so the change is visible at a glance.
  const [expanded, setExpanded] = useState(() => Boolean(edits))

  const running = call.isExecuting === true
  const failed = !running && (call.isError ?? output?.isError) === true
  const Icon = toolCallIconFor(call.name)
  const label = toolCallLabel(call.name, call.arguments, t)
  const command = kind === 'run' ? toolCallCommand(call.arguments) : null

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title={command ?? undefined}
        className="group/step -mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs text-muted transition-colors hover:bg-surface-hover hover:text-secondary"
      >
        {running ? (
          <LoaderCircle size={13} className="shrink-0 animate-spin text-accent-fg" aria-label={t('chat.toolCall.status.running')} />
        ) : failed ? (
          <CircleAlert size={13} className="shrink-0 text-error" />
        ) : (
          <Icon size={13} className="shrink-0 text-dim" />
        )}
        <span className="min-w-0 truncate font-jetbrains">{label}</span>
        {stats && (
          <span className="shrink-0 font-jetbrains">
            <span className="text-success">+{stats.added}</span> <span className="text-error">-{stats.removed}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {failed && <span className="text-error">{t('chat.toolCall.status.error')}</span>}
          {call.durationMs !== undefined && !running && (
            <span className="text-faint">{formatDuration(call.durationMs)}</span>
          )}
          <ChevronRight
            size={12}
            className={clsx(
              'transition-transform',
              expanded ? 'rotate-90' : 'opacity-0 group-hover/step:opacity-100'
            )}
          />
        </span>
      </button>
      {expanded && (
        <ToolStepDetail
          call={call}
          output={output}
          edits={edits}
          command={command}
          failed={failed}
          onCollapse={() => setExpanded(false)}
        />
      )}
    </div>
  )
}

function sameOutput(a?: ToolOutput, b?: ToolOutput): boolean {
  return a === b || (!!a && !!b && a.content === b.content && a.isError === b.isError &&
    a.toolFile === b.toolFile)
}

// prepareChatMessages rebuilds call objects whenever messages change; compare
// by value so finished rows (and their highlighted diffs) are not redone.
export const ToolStepRow = memo(ToolStepRowImpl, (prev, next) =>
  prev.call.id === next.call.id &&
  prev.call.name === next.call.name &&
  prev.call.arguments === next.call.arguments &&
  prev.call.isExecuting === next.call.isExecuting &&
  prev.call.isError === next.call.isError &&
  prev.call.durationMs === next.call.durationMs &&
  prev.call.result === next.call.result &&
  sameOutput(prev.output, next.output)
)

function ToolStepDetail({
  call,
  output,
  edits,
  command,
  failed,
  onCollapse,
}: {
  call: ToolCall
  output?: ToolOutput
  edits: EditBlock[] | null
  command: string | null
  failed: boolean
  onCollapse: () => void
}): React.JSX.Element {
  const input = command ?? formatToolCallArgs(call.arguments)
  const showInput = !edits && input !== '{}'
  // An edit's result is a success line; only a failure is worth showing under the diff.
  const showOutput = !!output?.content && (!edits || failed)
  const editFile = edits ? toolCallFile(call.name, call.arguments) : null

  // Only a file-read result is the file's content, so only it renders as code.
  const readFile = toolKind(call.name) === 'read' ? (output?.toolFile ?? toolCallFile(call.name, call.arguments)) : null
  const codeLang = readFile ? getCodeEditorLanguageName(readFile) : 'plain text'

  return (
    <div className="mb-1.5 mt-0.5 ml-[21px] min-w-0 overflow-hidden rounded-md border border-border bg-surface/50">
      {edits && (
        <div className="px-3 py-2">
          <EditDiff blocks={edits} lang={editFile ? getCodeEditorLanguageName(editFile) : 'plain text'} />
        </div>
      )}
      {showInput && (
        <div className="relative">
          <CopyButton text={input} className="absolute right-1.5 top-1.5" />
          <pre className="font-jetbrains whitespace-pre-wrap break-words px-3 py-2 pr-9 text-xs text-secondary">
            {command ? `$ ${command}` : input}
          </pre>
        </div>
      )}
      {showOutput && (
        <div className={clsx('relative', (showInput || edits) && 'border-t border-border')}>
          <CopyButton text={output!.content} className="absolute right-1.5 top-1.5" />
          {codeLang !== 'plain text' ? (
            <div className="max-h-96 overflow-auto px-3 py-2 pr-9">
              <CodeResultView content={output!.content} lang={codeLang} onCollapse={onCollapse} />
            </div>
          ) : (
            <pre
              className={clsx(
                'font-jetbrains max-h-96 overflow-auto whitespace-pre-wrap break-words px-3 py-2 pr-9 text-xs',
                failed ? 'text-error' : 'text-muted'
              )}
            >
              {output!.content.slice(0, MAX_PLAIN_OUTPUT_CHARS)}
              {output!.content.length > MAX_PLAIN_OUTPUT_CHARS && '\n…'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// Renders an edit call's blocks as a diff: each block shows its old lines removed
// (red) then its new lines added (green), with the code syntax-highlighted. A
// block replacement, not a line-level diff — enough to read the change at a glance.
function EditDiff({ blocks, lang }: { blocks: EditBlock[]; lang: string }): React.JSX.Element {
  return (
    <div className="overflow-x-auto font-jetbrains text-xs leading-relaxed text-secondary">
      {blocks.map((b, i) => (
        <div key={i} className={i > 0 ? 'mt-2 border-t border-border pt-2' : ''}>
          <DiffLines text={b.oldText} lang={lang} kind="remove" />
          <DiffLines text={b.newText} lang={lang} kind="add" />
        </div>
      ))}
    </div>
  )
}

// One side of a diff block (all removed, or all added), syntax-highlighted.
// highlightCodeToHtml emits newlines separately, so its output splits cleanly
// into per-line HTML; falls back to plain text when no parser matches.
function DiffLines({
  text,
  lang,
  kind,
}: {
  text: string
  lang: string
  kind: 'add' | 'remove'
}): React.JSX.Element | null {
  if (text === '') return null
  const html = highlightCodeToHtml(text, lang)
  const lines = (html ?? text).split('\n')
  const rowBg = kind === 'add' ? 'bg-success-bg' : 'bg-error-bg'
  const markColor = kind === 'add' ? 'text-success' : 'text-error'
  const sign = kind === 'add' ? '+ ' : '- '
  return (
    <>
      {lines.map((line, j) => (
        <div key={j} className={clsx('whitespace-pre', rowBg)}>
          <span className={clsx('select-none', markColor)}>{sign}</span>
          {html !== null ? (
            <span dangerouslySetInnerHTML={{ __html: line || ' ' }} />
          ) : (
            <span>{line || ' '}</span>
          )}
        </div>
      ))}
    </>
  )
}

// Renders file content as line-numbered, syntax-highlighted code. highlightCodeToHtml
// emits newlines separately from its <span> runs, so splitting on '\n' yields
// self-contained per-line HTML; when no parser exists it falls back to plain text.
function CodeResultView({
  content,
  lang,
  onCollapse,
}: {
  content: string
  lang: string
  onCollapse: () => void
}): React.JSX.Element {
  const clipped = content.length > MAX_CODE_RESULT_CHARS
  const clippedContent = clipped ? content.slice(0, MAX_CODE_RESULT_CHARS) : content
  // Peel off Pi's "[N more lines in file…]" footer so it renders as a note, not code.
  const { code, note } = splitReadTruncationNote(clippedContent)

  return (
    // The first line doubles as a collapse trigger. A drag to select text isn't
    // a click, so selection works.
    <div className="overflow-x-auto font-jetbrains text-xs leading-relaxed text-secondary">
      <LineNumberedCode content={code} lang={lang} onFirstLineClick={onCollapse} />
      {note && <div className="mt-2 italic text-dim">{note}</div>}
      {clipped && <div className="mt-1 text-faint">…</div>}
    </div>
  )
}

// ─── Answer ──────────────────────────────────────────────────────────────────

// The turn's closing prose, with copy/export on hover.
const AnswerBody = memo(function AnswerBody({
  message,
  spaced,
}: {
  message: DisplayMessage
  spaced: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const { show: showContextMenu, ContextMenuComponent } = useContextMenu()
  const startNoteFromText = useAppStore((state) => state.startNoteFromText)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div onContextMenu={(e) => showContextMenu(e, buildMessageContextMenu(message.content, startNoteFromText))}>
      <div data-scroll-anchor={message.id} className={clsx('markdown-body text-sm', spaced && 'mt-2')}>
        <MarkdownRenderer content={message.content} />
      </div>
      <div className="mt-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <ActionButton
          icon={copied ? <Check size={11} /> : <Copy size={11} />}
          onClick={handleCopy}
          title={copied ? t('common.copied') : t('common.copy')}
          label={copied ? t('common.copied') : t('common.copy')}
        />
        <ActionButton icon={<Download size={11} />} onClick={() => exportMessage(message)} title={t('common.export')} />
      </div>
      {ContextMenuComponent}
    </div>
  )
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
}

function formatToolCallArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}
