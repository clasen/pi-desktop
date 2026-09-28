import { workspaceRelativeGitPath } from './workspace-path'
import { pathGroupKey } from '../../../shared/path-compare'
import type { DisplayMessage } from '../message-parsing'
import { toolCallFile, toolKind } from '../message-grouping'

interface DiffPaths {
  oldPath: string
  newPath: string
}

function fileKey(path: string, workspacePath: string): string {
  const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(path)
    ? path
    : `${workspacePath}/${path}`
  const parts: string[] = []
  for (const part of absolute.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return pathGroupKey(parts.join('/'))
}

/**
 * Filters whole-file Git diffs, not individual edits owned by the session.
 * Diff paths start from the repository root; `gitPrefix` places the workspace
 * inside it, while tool paths are workspace-relative or absolute.
 * Observed paths are workspace-relative snapshots; history remains direct
 * evidence for edit/write calls from turns predating the recorder.
 */
export function filterSessionDiffFiles<T extends DiffPaths>(
  files: readonly T[],
  messages: readonly DisplayMessage[],
  workspacePath: string,
  gitPrefix: string,
  observedPaths: readonly string[] = [],
): T[] {
  const failedCalls = new Set(messages
    .filter((message) => message.role === 'toolResult' && message.isError)
    .map((message) => message.toolCallId))
  const touched = new Set(observedPaths.map((path) => fileKey(path, workspacePath)))
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls ?? []) {
      const kind = toolKind(call.name)
      if ((kind !== 'edit' && kind !== 'write') || call.isError || call.isExecuting || failedCalls.has(call.id)) continue
      const path = toolCallFile(call.name, call.arguments)
      if (path) touched.add(fileKey(path, workspacePath))
    }
  }
  const isTouched = (path: string): boolean => {
    const relativePath = workspaceRelativeGitPath(path, gitPrefix)
    return relativePath !== null && touched.has(fileKey(relativePath, workspacePath))
  }
  return files.filter((file) => isTouched(file.newPath) || isTouched(file.oldPath))
}
