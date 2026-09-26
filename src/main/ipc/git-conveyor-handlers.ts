import { app, ipcMain } from 'electron'
import { realpath } from 'fs/promises'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type {
  GitConveyorCommitOptions,
  GitConveyorPullRequestOptions,
} from '../../shared/ipc-contracts'
import { assertTrustedSender, isObject, isOptionalBoolean, isOptionalString, isString } from './validation'
import { commitAll, createPullRequest, getGitConveyorStatus, pushBranch, readCommitDiff } from '../git-conveyor'
import { CommitMessageService } from '../commit-message-service'
import { wireCommitMessageTurns } from '../commit-message-wiring'
import type { IpcContext } from './context'
import { t } from '../../shared/i18n'

function activeCwd(ctx: IpcContext): string {
  const cwd = ctx.workspaceManager.getActiveWorkspace()?.path
  if (!cwd) throw new Error(t('errors.workspace.noneActive'))
  return cwd
}

export function registerGitConveyorHandlers(ctx: IpcContext): void {
  const messages = new CommitMessageService({
    resolvePath: realpath,
    readDiff: readCommitDiff,
    changed: () => ctx.broadcast(IPC_CHANNELS.EVENT_GIT_COMMIT_MESSAGE, null),
  })
  wireCommitMessageTurns(ctx.workspaceManager, messages)
  app.on('will-quit', () => messages.dispose())

  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT_MESSAGE, async (event) => {
    assertTrustedSender(event)
    return messages.get(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_STATUS, async (event) => {
    assertTrustedSender(event)
    return getGitConveyorStatus(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_COMMIT, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (!isObject(input) || !isString(input.message)) throw new Error('Commit message must be a string')
    const options: GitConveyorCommitOptions = { message: input.message }
    return commitAll(activeCwd(ctx), options)
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_PUSH, async (event) => {
    assertTrustedSender(event)
    return pushBranch(activeCwd(ctx))
  })

  ipcMain.handle(IPC_CHANNELS.GIT_CONVEYOR_CREATE_PR, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (
      !isObject(input) ||
      !isString(input.title) ||
      !isString(input.body) ||
      !isOptionalString(input.base) ||
      !isOptionalBoolean(input.draft)
    ) {
      throw new Error('Pull request title, body, optional base branch, and optional draft flag are required')
    }
    const options: GitConveyorPullRequestOptions = {
      title: input.title,
      body: input.body,
      ...(typeof input.base === 'string' ? { base: input.base } : {}),
      ...(typeof input.draft === 'boolean' ? { draft: input.draft } : {}),
    }
    return createPullRequest(activeCwd(ctx), options)
  })
}
