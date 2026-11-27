/**
 * One-shot or @bot-targeted Qoder Cloud Bot run:
 *   1. Parses an optional `@<bot-or-template>` leading directive (or `label`
 *      prefix `[bot:<name>]`) so the parent model can route subtasks to a
 *      specific specialist bot (e.g. `@deep-researcher`, `@code-reviewer`).
 *   2. Attaches the chosen Bot's persistent `MemoryStore` (`read_write`) plus
 *      the workspace's git repository (when in `auto` mode).
 *   3. Streams multimodal user blocks (text + base64 images + file uploads)
 *      and follows the SSE stream until `session.status_idle`.
 *
 * @module dsh-qoder-bots/run
 */

import { randomUUID } from 'node:crypto'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { ResolvedBotTarget } from './bot-manager.ts'
import {
  delay,
  type QoderCloudClient,
  type SessionEvent,
  type SessionResource,
} from './client.ts'
import { detectRepository, type LocalRepository } from './git.ts'
import { checkGitHubAccess } from './github.ts'

/** Default ceiling for one delegated bot turn (2 hours). */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000

/** Max inline base64 encoded length accepted by QCA user.message image blocks (10 MiB). */
export const MAX_INLINE_BASE64_BYTES = 10 * 1024 * 1024

const MAX_STREAM_FAILURES = 6

export interface QoderBotRunSpec {
  readonly client: QoderCloudClient
  readonly resolveTarget: (signal: AbortSignal, explicitBot?: string) => Promise<ResolvedBotTarget>
  readonly attachments?: AttachmentStore | undefined
  readonly repository: 'auto' | 'none'
  readonly gitToken?: string | undefined
  readonly gitTokenEnv?: string | undefined
  readonly gitUsername?: string | undefined
  readonly branchPrefix: string
  readonly toolConfirmation: 'allow' | 'deny'
  readonly environmentVariables: Readonly<Record<string, string>>
  readonly archiveOnFinish: boolean
  readonly timeoutMs: number
  readonly onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
}

export interface QoderBotRunRequest {
  readonly cwd: string
  readonly prompt: readonly ContentBlock[]
  readonly label?: string | undefined
  /** Explicit bot id, name, or built-in template slug. */
  readonly bot?: string | undefined
  readonly signal: AbortSignal
}

/**
 * Extract an optional leading `@<bot>` mention from task text, e.g.
 * `@deep-researcher Compare Raft and Paxos` -> `{ bot: 'deep-researcher', text: 'Compare Raft and Paxos' }`.
 */
export function parseLeadingBotDirective(raw: string): { bot?: string; text: string } {
  const match = /^\s*@([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\s+|\s*:\s*)([\s\S]+)$/.exec(raw)
  if (match === null) return { text: raw }
  const bot = match[1]!
  const rest = match[2]!.trim()
  if (rest.length === 0) return { text: raw }
  return { bot, text: rest }
}

export interface PreparedCloudInput {
  readonly text: string
  readonly imageBlocks: readonly Record<string, unknown>[]
  readonly uploadedFileResources: readonly { fileId: string; filename: string; mountPath: string }[]
  readonly notes: readonly string[]
}

async function readStreamBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const chunk of chunks) {
    parts.push(chunk)
    total += chunk.byteLength
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

/**
 * Convert DSH `ContentBlock[]` (text, durable image attachments, durable file
 * attachments) into QCA-ready message content blocks + uploaded file resources.
 */
export async function prepareMultimodalContent(
  blocks: readonly ContentBlock[],
  deps: {
    client: QoderCloudClient
    attachments: AttachmentStore | undefined
    allowResources: boolean
    signal: AbortSignal
  },
): Promise<PreparedCloudInput> {
  const textParts: string[] = []
  const imageBlocks: Record<string, unknown>[] = []
  const uploadedFileResources: { fileId: string; filename: string; mountPath: string }[] = []
  const notes: string[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.trim().length > 0) textParts.push(block.text)
      continue
    }
    if (block.type === 'image') {
      const ref = block.attachment as ImageAttachmentRef | undefined
      if (block.offloaded === true || ref === undefined) {
        textParts.push(`[offloaded image${ref?.name ? `: ${ref.name}` : ''}]`)
        continue
      }
      if (deps.attachments === undefined) {
        textParts.push(`[attached image${ref.name ? `: ${ref.name}` : ''} — attachment store unavailable]`)
        continue
      }
      try {
        const stored = await deps.attachments.readImage(ref, deps.signal)
        const b64 = Buffer.from(stored.data).toString('base64')
        if (b64.length <= MAX_INLINE_BASE64_BYTES) {
          imageBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: stored.ref.mediaType,
              data: b64,
            },
          })
        } else {
          const uploaded = await deps.client.uploadFile({
            bytes: stored.data,
            filename: ref.name ?? `image.${stored.ref.mediaType.split('/')[1] ?? 'png'}`,
            mimeType: stored.ref.mediaType,
          }, deps.signal)
          imageBlocks.push({
            type: 'image',
            source: { type: 'file', file_id: uploaded.id },
          })
          notes.push(`Uploaded large image as Qoder File ${uploaded.id}`)
        }
      } catch (error: unknown) {
        if (deps.signal.aborted) throw error
        const msg = error instanceof Error ? error.message : String(error)
        notes.push(`Could not read/upload image ${ref.name ?? ref.attachmentId}: ${msg}`)
        textParts.push(`[attached image ${ref.name ?? ''} could not be transferred]`)
      }
      continue
    }
    if (block.type === 'file') {
      const ref = block.attachment as FileAttachmentRef | undefined
      if (ref === undefined) continue
      if (deps.attachments === undefined || !deps.allowResources) {
        textParts.push(`[attached file: ${ref.name} (${ref.bytes} bytes)]`)
        continue
      }
      try {
        const bytes = await readStreamBytes(deps.attachments.readFileStream(ref, deps.signal))
        const safeName = ref.name.replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment.txt'
        const uploaded = await deps.client.uploadFile({ bytes, filename: safeName }, deps.signal)
        const mountPath = `/mnt/session/uploads/${safeName}`
        uploadedFileResources.push({ fileId: uploaded.id, filename: ref.name, mountPath })
        textParts.push(`[Attached file "${ref.name}" is mounted at \`${mountPath}\`]` )
        notes.push(`Mounted file "${ref.name}" (${uploaded.id}) at ${mountPath}`)
      } catch (error: unknown) {
        if (deps.signal.aborted) throw error
        const msg = error instanceof Error ? error.message : String(error)
        notes.push(`Could not upload file "${ref.name}": ${msg}`)
        textParts.push(`[attached file "${ref.name}" could not be uploaded: ${msg}]`)
      }
    }
  }

  return {
    text: textParts.join('\n'),
    imageBlocks,
    uploadedFileResources,
    notes,
  }
}

export function cloudPrompt(task: string, repo: LocalRepository | undefined, resultBranch: string | undefined): string {
  if (repo === undefined || resultBranch === undefined) return task
  const at = repo.checkout.type === 'branch'
    ? `checked out at branch \`${repo.checkout.name}\``
    : `checked out at its default branch; before working, run \`git fetch origin ${repo.checkout.sha} && git checkout ${repo.checkout.sha}\` there`
  return [
    task,
    '',
    '---',
    'Workspace handed over from DeepSeek Harness:',
    `- The git repository ${repo.url} is mounted in this sandbox at \`${repo.mountPath}\` (in a self-hosted environment: \`workspace/${repo.name}\` under your working directory), ${at}.`,
    '- First check that the mounted repository exists. If it does not, the platform failed to mount it (unreachable host or missing/invalid token): stop immediately and report that, without cloning it yourself.',
    `- If you change files, commit them on a new branch named \`${resultBranch}\` and \`git push -u origin ${resultBranch}\`. Do not push to any other branch.`,
    '- Your final message is returned verbatim to the delegating session: summarize what you did and state the pushed branch name (or that nothing was pushed).',
  ].join('\n')
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

export interface DeliveredArtifact {
  readonly name: string
  readonly fileId: string
  readonly contentType?: string
  readonly size?: number
}

class TurnFold {
  finalText: string | undefined
  errorMessage: string | undefined
  stopReason: string | undefined
  readonly artifacts: DeliveredArtifact[] = []
  readonly pendingTools = new Map<string, string>()

  push(event: SessionEvent): void {
    switch (event.type) {
      case 'agent.message': {
        const text = messageText(event.content)
        if (text.trim().length > 0) this.finalText = text
        break
      }
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
      case 'agent.custom_tool_use':
        this.pendingTools.set(event.id, event.type)
        break
      case 'agent.artifact_delivered':
        if (typeof event.file_id === 'string') {
          this.artifacts.push({
            name: event.original_filename ?? event.file_id,
            fileId: event.file_id,
            ...typeof event.content_type === 'string' ? { contentType: event.content_type } : {},
            ...typeof event.size === 'number' ? { size: event.size } : {},
          })
        }
        break
      case 'session.error':
        if (event.error?.message !== undefined) this.errorMessage = event.error.message
        break
      default:
        break
    }
  }
}

export function repositoryResource(
  repo: LocalRepository,
  spec: Pick<QoderBotRunSpec, 'gitToken' | 'gitTokenEnv' | 'gitUsername'>,
): SessionResource {
  const checkout = repo.checkout.type === 'branch' ? { checkout: repo.checkout } : {}
  if (repo.github) {
    return {
      type: 'github_repository',
      url: repo.url,
      mount_path: repo.mountPath,
      ...checkout,
      ...spec.gitToken === undefined ? {} : { authorization_token: spec.gitToken },
    }
  }
  if (spec.gitToken === undefined) {
    return { type: 'git_repository', url: repo.url, mount_path: repo.mountPath, ...checkout }
  }
  const username = spec.gitUsername ?? repo.remoteUsername
  if (username === undefined) {
    const host = new URL(repo.url).host
    throw new Error(
      `qoder-bots: ${host} needs an account name with ${spec.gitTokenEnv ?? 'the git token'}; `
      + 'set gitUsername in the plugin config '
      + `or use an origin like https://<account>@${host}/…`,
    )
  }
  const url = new URL(repo.url)
  url.username = encodeURIComponent(username)
  return { type: 'git_repository', url: url.toString(), password: spec.gitToken, mount_path: repo.mountPath, ...checkout }
}

const STOP_REASONS: Readonly<Record<string, SubagentStopReason>> = {
  end_turn: 'completed',
  cancelled: 'aborted',
  max_tokens: 'max-tokens',
  refusal: 'refusal',
  error: 'error',
  retries_exhausted: 'error',
  terminated: 'error',
}

export async function startQoderBotRun(
  request: QoderBotRunRequest,
  spec: QoderBotRunSpec,
): Promise<SubagentRun> {
  if (request.signal.aborted) throw new Error('qoder-bots: request was aborted before session start')

  // Check that there is non-empty input before contacting the gateway
  const hasAnyContent = request.prompt.some(b =>
    (b.type === 'text' && b.text.trim().length > 0) || b.type === 'image' || b.type === 'file',
  )
  if (!hasAnyContent) {
    throw new Error('qoder-bots: the delegated task must not be empty')
  }

  // Extract optional `@<bot>` prefix from the first text block when `request.bot` isn't explicitly set
  let explicitBot = request.bot
  let normalizedPrompt: readonly ContentBlock[] = request.prompt
  if (explicitBot === undefined) {
    const firstTextIdx = request.prompt.findIndex(b => b.type === 'text' && b.text.trim().length > 0)
    if (firstTextIdx >= 0) {
      const firstBlock = request.prompt[firstTextIdx] as Extract<ContentBlock, { type: 'text' }>
      const parsed = parseLeadingBotDirective(firstBlock.text)
      if (parsed.bot !== undefined) {
        explicitBot = parsed.bot
        const copy = [...request.prompt]
        copy[firstTextIdx] = { type: 'text', text: parsed.text }
        normalizedPrompt = copy
      }
    }
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('qoder-bots: run cancelled locally'))
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const { client } = spec

  let sessionId: string | undefined
  let lastEventId: string | undefined
  let repo: LocalRepository | undefined
  let resultBranch: string | undefined
  let target: ResolvedBotTarget | undefined
  const preflightNotes: string[] = []

  try {
    repo = spec.repository === 'auto' ? await detectRepository(request.cwd, controller.signal) : undefined
    if (repo?.github) {
      const access = await checkGitHubAccess(repo.url, spec.gitToken, spec.gitTokenEnv ?? 'QODER_GIT_TOKEN', controller.signal)
      if (access.error !== undefined) throw new Error(`qoder-bots: ${access.error}`)
      preflightNotes.push(...access.warnings)
    }

    const resources: SessionResource[] = []
    if (repo !== undefined) {
      resultBranch = `${spec.branchPrefix}${randomUUID().slice(0, 8)}`
      resources.push(repositoryResource(repo, spec))
    }

    target = await spec.resolveTarget(controller.signal, explicitBot)
    if (target.memoryResource !== undefined) {
      resources.push(target.memoryResource)
    }

    const multimodal = await prepareMultimodalContent(normalizedPrompt, {
      client,
      attachments: spec.attachments,
      allowResources: true,
      signal: controller.signal,
    })
    preflightNotes.push(...multimodal.notes)
    for (const f of multimodal.uploadedFileResources) {
      resources.push({ type: 'file', file_id: f.fileId, mount_path: f.mountPath })
    }

    const promptText = multimodal.text.trim().length > 0
      ? cloudPrompt(multimodal.text, repo, resultBranch)
      : cloudPrompt('Please inspect the attached image(s)/file(s).', repo, resultBranch)

    const title = (request.label ?? `${target.bot.avatar} ${target.bot.name}: ${promptText.split('\n')[0] ?? 'task'}`).slice(0, 120)
    const session = await client.createSession({
      agent: target.bot.id,
      environment_id: target.environmentId,
      title,
      metadata: {
        mode: 'bot-subagent',
        bot_id: target.bot.id,
        bot_name: target.bot.name,
      },
      ...resources.length === 0 ? {} : { resources },
      ...Object.keys(spec.environmentVariables).length === 0
        ? {}
        : { environment_variables: { ...spec.environmentVariables } },
    }, controller.signal)
    sessionId = session.id

    const messageContent: Record<string, unknown>[] = [
      { type: 'text', text: promptText },
      ...multimodal.imageBlocks,
    ]
    const posted = await client.sendEvents(session.id, [{
      type: 'user.message',
      content: messageContent,
    }], controller.signal)
    lastEventId = posted.data.at(-1)?.id
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    if (sessionId !== undefined) await bestEffort(() => client.archiveSession(sessionId!, AbortSignal.timeout(10_000)))
    if (controller.signal.aborted) throw new Error('qoder-bots: request was aborted before session start')
    throw error instanceof Error ? error : new Error(String(error))
  }

  const id = sessionId
  const resolvedTarget = target
  const fold = new TurnFold()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('qoder-bots: turn timed out'))
  }, spec.timeoutMs)

  const footer = (stopReason: string): string => {
    const memTag = resolvedTarget.bot.memoryStoreId ? ` · memory ${resolvedTarget.bot.memoryStoreId}` : ''
    const lines = [
      `[Qoder Bot ${resolvedTarget.bot.avatar} ${resolvedTarget.bot.name}] session ${id} · stop_reason ${stopReason}${memTag}`,
    ]
    if (repo !== undefined) {
      lines.push(`Repository: ${repo.url} (${repo.checkout.type === 'branch' ? repo.checkout.name : repo.checkout.sha.slice(0, 12)}); result branch: ${resultBranch}`)
    }
    if (fold.artifacts.length > 0) {
      lines.push(`Artifacts: ${fold.artifacts.map(a => `${a.name} (${a.fileId}${a.size === undefined ? '' : `, ${a.size} bytes`})`).join(', ')}`)
    }
    for (const note of resolvedTarget.notes) lines.push(note)
    for (const warning of [...repo?.warnings ?? [], ...preflightNotes]) lines.push(`Note: ${warning}`)
    return lines.join('\n')
  }

  const output = (stopReason: string): ContentBlock[] => {
    const body = fold.finalText ?? '(the cloud bot produced no final message)'
    return [{ type: 'text', text: `${body}\n\n${footer(stopReason)}` }]
  }

  const answerPause = async (eventIds: readonly string[]): Promise<void> => {
    for (const eventId of eventIds) {
      const kind = fold.pendingTools.get(eventId)
      const event = kind === 'agent.custom_tool_use'
        ? {
            type: 'user.custom_tool_result',
            custom_tool_use_id: eventId,
            content: [{ type: 'text', text: 'Custom client tools are unavailable in an unattended @bot delegation.' }],
            is_error: true,
          }
        : {
            type: 'user.tool_confirmation',
            tool_use_id: eventId,
            result: spec.toolConfirmation,
            ...spec.toolConfirmation === 'deny'
              ? { deny_message: 'Denied by the DeepSeek Harness @bot delegation policy.' }
              : {},
          }
      await client.sendEvents(id, [event], controller.signal)
    }
  }

  const follow = async (): Promise<SubagentResult> => {
    let failures = 0
    for (;;) {
      try {
        for await (const event of client.streamEvents(id, lastEventId, controller.signal)) {
          failures = 0
          if (event.id !== undefined) lastEventId = event.id
          fold.push(event)
          if (event.type === 'session.status_idle') {
            const reason = event.stop_reason?.type ?? 'end_turn'
            if (reason === 'requires_action') {
              await answerPause(event.stop_reason?.event_ids ?? [])
              continue
            }
            fold.stopReason = reason
            const stopReason = STOP_REASONS[reason] ?? 'completed'
            return {
              output: output(reason),
              ...stopReason === 'error' ? { diagnostic: fold.errorMessage ?? `Qoder Bot turn ended with ${reason}` } : {},
              stopReason,
            }
          }
          if (event.type === 'session.status_terminated' || event.type === 'session.deleted') {
            fold.stopReason = 'terminated'
            return {
              output: output('terminated'),
              diagnostic: fold.errorMessage ?? `Qoder Bot session ${id} was terminated`,
              stopReason: 'error',
            }
          }
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) throw error
        if (++failures >= MAX_STREAM_FAILURES) throw error
      }
      await delay(Math.min(1_000 * 2 ** failures, 15_000), controller.signal)
    }
  }

  const following = follow()
  const result = settleRunResult({
    attempt: async () => {
      try {
        return await following
      } catch (error: unknown) {
        if (timedOut) throw new Error(`qoder-bots: turn exceeded ${spec.timeoutMs} ms`)
        throw error
      } finally {
        clearTimeout(timer)
        if (fold.stopReason !== undefined && spec.archiveOnFinish) {
          await bestEffort(() => client.archiveSession(id, AbortSignal.timeout(10_000)))
        }
      }
    },
    collectOutput: () => fold.finalText === undefined ? [] : output('cancelled'),
    collectDiagnostic: () => timedOut
      ? `Qoder Bot session ${id} exceeded ${spec.timeoutMs} ms and was cancelled`
      : fold.errorMessage ?? `Qoder Bot session ${id}: stream failed`,
    cancelled: () => controller.signal.aborted && !timedOut,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  const remoteCleanup = result.then(async () => {
    if (fold.stopReason !== undefined) return
    await bestEffort(() => client.cancelSession(id, AbortSignal.timeout(10_000)))
    if (spec.archiveOnFinish) await bestEffort(() => client.archiveSession(id, AbortSignal.timeout(10_000)))
  })

  return subprocessRunHandle({
    id: randomUUID() as string as SessionId,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      clearTimeout(timer)
      await following.catch(() => {})
      await result
      await remoteCleanup
    },
  })
}

async function bestEffort(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch {
    // Advisory cleanup
  }
}
