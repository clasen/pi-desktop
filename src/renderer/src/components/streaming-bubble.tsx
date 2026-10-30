import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownRenderer } from './markdown-renderer'
import { splitClaudeCliMarkers } from '../claude-cli-markers'
import { ToolStepRow } from './agent-turn'
import { useAppStore } from '../store'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { Brain, LoaderCircle } from 'lucide-react'

interface StreamingStepsProps {
  content: string
  thinking: string
  toolCalls: Map<
    string,
    {
      name: string
      args: string
      result?: string
      isExecuting: boolean
      isError?: boolean
      startedAt?: number
      durationMs?: number
    }
  >
}

/** The not-yet-committed tail of a live turn, rendered as timeline steps. */
export function StreamingSteps({ content: rawContent, thinking, toolCalls }: StreamingStepsProps): React.JSX.Element {
  const { t } = useTranslation()
  const { content, toolCalls: markerCalls } = useMemo(() => splitClaudeCliMarkers(rawContent, true), [rawContent])
  const thinkingEnabled = useAppStore(
    (state) => state.settingsDraft.showThinking ?? state.settings?.showThinking ?? DEFAULT_SETTINGS.showThinking
  )
  const thinkingScrollRef = useRef<HTMLDivElement>(null)

  // Follow the thinking tail only when the user is already at/near the bottom,
  // so scrolling up mid-stream to re-read is not yanked back down.
  useEffect(() => {
    const el = thinkingScrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    if (distanceFromBottom <= 48) {
      el.scrollTop = el.scrollHeight
    }
  }, [thinking])

  return (
    <>
      {thinking && thinkingEnabled && (
        <div className="min-w-0">
          <div className="flex h-7 items-center gap-2 text-xs text-dim">
            <Brain size={13} className="shrink-0" />
            <span>{t('common.thinking')}</span>
            <LoaderCircle size={12} className="shrink-0 animate-spin text-special" />
          </div>
          <div ref={thinkingScrollRef} className="mb-1 ml-[21px] max-h-36 min-w-0 overflow-x-hidden overflow-y-auto">
            <div className="markdown-body min-w-0 text-sm text-muted break-words [overflow-wrap:anywhere]">
              <MarkdownRenderer content={thinking} />
            </div>
          </div>
        </div>
      )}

      {Array.from(toolCalls.entries()).map(([id, tc]) => (
        <ToolStepRow
          key={id}
          call={{ id, name: tc.name, arguments: tc.args, isExecuting: tc.isExecuting, isError: tc.isError, durationMs: tc.durationMs }}
          output={tc.result !== undefined ? { content: tc.result, isError: tc.isError } : undefined}
        />
      ))}

      {markerCalls.map((tc) => (
        <ToolStepRow
          key={tc.id}
          call={tc}
          output={tc.result !== undefined ? { content: tc.result, isError: tc.isError } : undefined}
        />
      ))}

      {content && (
        // streaming-md places the caret ::after the last markdown block so it
        // sits at the end of the current chunk (not on a line below it).
        <div className="markdown-body streaming-md my-1.5 min-w-0 text-sm break-words [overflow-wrap:anywhere]">
          <MarkdownRenderer content={content} />
        </div>
      )}

      {!content && (!thinking || !thinkingEnabled) && toolCalls.size === 0 && markerCalls.length === 0 && (
        <div className="flex h-7 items-center gap-2 text-xs text-dim">
          <LoaderCircle size={13} className="animate-spin" />
          {thinking ? t('common.thinking') : t('chat.waitingForResponse')}
        </div>
      )}
    </>
  )
}
