import { memo, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore, type DisplayMessage } from '../store'
import { useContextMenu, buildMessageContextMenu } from './context-menu'
import { isImeComposing } from '../utils/ime-composing'
import { clsx } from 'clsx'
import { Copy, Edit3, GitBranch, RotateCcw, Download, Send, ImageOff } from 'lucide-react'

/** Download a message's text as a Markdown file. */
export function exportMessage(message: DisplayMessage): void {
  const blob = new Blob([message.content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const label = message.role === 'assistant' ? 'desktop' : message.role
  const d = new Date(message.timestamp ?? Date.now())
  const p = (n: number): string => String(n).padStart(2, '0')
  // Format: yyyy-mm-ddThh-mm-ss (local time)
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  a.download = `pi-${label}-${stamp}.md`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// User and system messages. Agent output renders as turns (agent-turn.tsx).
function MessageBubbleImpl({
  message,
  onRetry,
}: {
  message: DisplayMessage
  onRetry?: (messageId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
  }

  const handleEdit = () => {
    setEditContent(message.content)
    setIsEditing(true)
  }

  const handleSaveEdit = async () => {
    if (editContent.trim() !== message.content) {
      // Resend the edited message
      await useAppStore.getState().sendPrompt(editContent.trim())
    }
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
  }

  const handleBranch = () => {
    // Branch from this message's position
    const excerpt = message.content.slice(0, 100) + (message.content.length > 100 ? '...' : '')
    useAppStore.getState().addMessage({
      id: `branch-${Date.now()}`,
      role: 'system',
      content: t('chat.message.branchedFrom', { excerpt }),
      timestamp: Date.now(),
    })
  }

  // Context menu for message-specific actions
  const { show: showContextMenu, ContextMenuComponent: MessageContextMenu } = useContextMenu()

  const startNoteFromText = useAppStore((state) => state.startNoteFromText)

  const handleMessageContextMenu = (e: React.MouseEvent) => {
    showContextMenu(e, buildMessageContextMenu(message.content, startNoteFromText))
  }

  if (message.role === 'user') {
    return (
      <>
      <div data-scroll-anchor={message.id} onContextMenu={handleMessageContextMenu}>
      <UserMessage
        message={message}
        isEditing={isEditing}
        editContent={editContent}
        onEditContentChange={setEditContent}
        onCopy={handleCopy}
        onEdit={handleEdit}
        onSaveEdit={handleSaveEdit}
        onCancelEdit={handleCancelEdit}
        onBranch={handleBranch}
        onRetry={onRetry}
        onExport={() => exportMessage(message)}
      />
      </div>
      {MessageContextMenu}
      </>
    )
  }

  if (message.role === 'system') {
    return <SystemMessage message={message} />
  }

  return <></>
}

// Memoized so finalized messages don't re-parse markdown on every store update
// (e.g. during streaming of a later message). Relies on stable `message`
// references and a stable `onRetry` callback from the caller.
export const MessageBubble = memo(MessageBubbleImpl)

// ─── User Message ────────────────────────────────────────────────────────────

function UserMessage({
  message,
  isEditing,
  editContent,
  onEditContentChange,
  onCopy,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onBranch,
  onRetry,
  onExport,
}: {
  message: DisplayMessage
  isEditing: boolean
  editContent: string
  onEditContentChange: (v: string) => void
  onCopy: () => void
  onEdit: () => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onBranch: () => void
  onRetry?: (id: string) => void
  onExport: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const editRef = useRef<HTMLTextAreaElement>(null)

  if (isEditing) {
    return (
      <div className="group mb-4 flex justify-end animate-fade-in">
        <div className="w-full max-w-[80%]">
          <textarea
            ref={editRef}
            value={editContent}
            onChange={(e) => onEditContentChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e.nativeEvent)) {
                e.preventDefault()
                e.stopPropagation()
                onSaveEdit()
              }
            }}
            className="font-chat w-full rounded-2xl rounded-br-md bg-card px-4 py-2.5 text-sm text-primary resize-none min-h-[40px] max-h-48 outline-none"
            rows={1}
            onInput={(e) => {
              const t = e.currentTarget
              t.style.height = 'auto'
              t.style.height = `${Math.min(t.scrollHeight, 192)}px`
            }}
            autoFocus
          />
          <div className="flex items-center justify-end gap-1 mt-1">
            <button
              onClick={onCancelEdit}
              className="rounded px-2 py-1 text-xs text-muted hover:text-primary transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={onSaveEdit}
              className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-xs text-white hover:bg-accent-hover transition-colors"
            >
              <Send size={10} />
              {t('common.send')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group mb-4 flex justify-end animate-fade-in">
      <div className="relative max-w-[80%]">
        <div className="rounded-2xl rounded-br-md bg-card px-4 py-2.5 text-sm text-primary">
          {message.attachments && message.attachments.length > 0 && (
            <div className={clsx('flex flex-wrap gap-2', message.content && 'mb-2')}>
              {message.attachments.map((attachment, index) => (
                <div
                  key={`${attachment.name}-${index}`}
                  className="overflow-hidden rounded-md border border-white/20 bg-black/10"
                  title={attachment.name}
                >
                  {attachment.data ? (
                    <img
                      src={`data:${attachment.mimeType};base64,${attachment.data}`}
                      alt={attachment.name}
                      className="h-16 w-16 object-cover"
                    />
                  ) : (
                    // History reload omits large image payloads (get-messages-trim.ts).
                    <div className="flex h-16 w-16 items-center justify-center text-muted" aria-label={attachment.name}>
                      <ImageOff size={20} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="font-chat whitespace-pre-wrap break-words">{message.content}</div>
        </div>
        {/* Actions */}
        <div className="mt-1 flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <ActionButton icon={<Copy size={11} />} onClick={onCopy} title={t('common.copy')} />
          <ActionButton icon={<Edit3 size={11} />} onClick={onEdit} title={t('chat.message.editAndResend')} />
          <ActionButton icon={<GitBranch size={11} />} onClick={onBranch} title={t('chat.message.branchFromHere')} />
          {onRetry && (
            <ActionButton icon={<RotateCcw size={11} />} onClick={() => onRetry(message.id)} title={t('common.retry')} />
          )}
          <ActionButton icon={<Download size={11} />} onClick={onExport} title={t('common.export')} />
        </div>
      </div>
    </div>
  )
}

// ─── System Message ──────────────────────────────────────────────────────────

function SystemMessage({ message }: { message: DisplayMessage }): React.JSX.Element {
  return (
    <div className="mb-4 flex justify-center animate-fade-in">
      <div className="rounded-full bg-surface px-3 py-1 text-xs text-dim">
        {message.content}
      </div>
    </div>
  )
}

// ─── Action Button ───────────────────────────────────────────────────────────

export function ActionButton({
  icon,
  onClick,
  title,
  label,
}: {
  icon: React.ReactNode
  onClick: () => void
  title: string
  label?: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
      title={title}
      aria-label={title}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  )
}
