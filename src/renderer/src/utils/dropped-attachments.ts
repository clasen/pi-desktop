import { t } from '../../../shared/i18n'
import type { AttachmentReadResult, PathKindResult } from '../../../shared/ipc-contracts'
import type { FileDragTransfer } from '../../../shared/folder-drop'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}

type DroppedComposerItem =
  | { kind: 'folder'; path: string }
  | { kind: 'file'; file: File; path: string }

/** Snapshot during drop: DataTransfer is no longer readable after an await. */
export async function droppedComposerItems(
  transfer: FileDragTransfer & { files?: ArrayLike<File> },
  getPathForFile: (file: File) => string,
  pathKind: (path: string) => Promise<PathKindResult>
): Promise<DroppedComposerItem[]> {
  const candidates = transfer.items?.length
    ? Array.from(transfer.items).flatMap((item) => {
      if (item.kind !== 'file') return []
      const entry = item.webkitGetAsEntry?.()
      const file = item.getAsFile()
      return file ? [{ file, isDirectory: entry?.isDirectory }] : []
    })
    : Array.from(transfer.files ?? []).map((file) => ({ file, isDirectory: undefined }))
  const snapshot = candidates.map((candidate) => ({
    ...candidate,
    path: getPathForFile(candidate.file),
  }))

  return Promise.all(snapshot.map(async ({ file, path, isDirectory }): Promise<DroppedComposerItem> => {
    if (isDirectory === undefined && path) {
      const kind = await pathKind(path)
      isDirectory = kind.exists && kind.isDirectory
    }
    if (isDirectory) {
      if (!path) throw new Error(t('chat.attach.attachFailed'))
      return { kind: 'folder', path }
    }
    return { kind: 'file', file, path }
  }))
}

/** Insert references without joining them to adjacent words or losing selected text boundaries. */
export function insertFolderReferences(
  value: string, start: number, end: number, paths: string[]
): { value: string; caret: number } {
  const before = value.slice(0, start)
  const tokens = paths.map((path) => `@${/[\s"]/u.test(path) ? JSON.stringify(path) : path}`).join(' ')
  const text = `${before && !/\s$/u.test(before) ? ' ' : ''}${tokens} `
  return { value: before + text + value.slice(end), caret: start + text.length }
}

/** Read only the browser-granted File, never authorize an arbitrary disk path. */
export async function readDroppedAttachment(file: File): Promise<AttachmentReadResult> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(t('errors.attachments.tooLarge', { limit: MAX_ATTACHMENT_BYTES / (1024 * 1024) }))
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mimeType = (Object.hasOwn(IMAGE_TYPES, extension) ? IMAGE_TYPES[extension] : undefined)
    ?? Object.values(IMAGE_TYPES).find((mime) => mime === file.type)
  if (mimeType) {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
    }
    return { kind: 'image', name: file.name, image: { type: 'image', mimeType, data: btoa(binary) } }
  }

  // PDFs/Office files and other binary formats cannot be sent as UTF-8 text.
  // Fail visibly instead of attaching corrupted content that the model cannot read.
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (content.includes('\0') || content.startsWith('%PDF-') ||
        (file.type.startsWith('image/') && file.type !== 'image/svg+xml')) {
      throw new Error('Not a text attachment')
    }
  } catch {
    throw new Error(t('chat.attach.unsupportedFile'))
  }
  return { kind: 'text', name: file.name, content }
}
