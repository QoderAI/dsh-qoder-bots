/**
 * Bot mode: a `qoder-bots` LLM route whose models are persistent Qoder Cloud
 * Bots (`active-bot` or `bot:<agent_id>`).
 *
 * Improvements over Phase-1 `dsh-qoder-cloud-agents/cloud-mode`:
 *   1. Automatically mounts the selected Bot's persistent `MemoryStore`
 *      (`read_write`) so the Bot remembers context across DSH sessions.
 *   2. Multimodal support: forwards DSH `ImageBlock`s as QCA `base64` / `file`
 *      image sources and uploads `FileBlock`s via the Files API + Session
 *      Resources API (both on first turn and on follow-up turns!).
 *   3. Renders `agent.artifact_delivered` events prominently in visible text
 *      and supports an extensible `customToolHandler` hook for client-side
 *      custom tools (used in Batch 2 for conversational Routine scheduling).
 *   4. Records `{ remoteSessionId, botId, botName }` in `replayState` so
 *      follow-ups and session forks seamlessly resume the exact cloud session.
 *
 * @module dsh-qoder-bots/bot-mode
 */

import { randomUUID } from 'node:crypto'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Asker, BotManager, BotProfile } from './bot-manager.ts'
import {
  API_BASE_PATH,
  BOT_ACTIVE_MODEL,
  BOT_MODEL_PREFIX,
  BOT_PROVIDER,
} from './bot-constants.ts'
import { delay, type QoderCloudClient, type SessionEvent, type SessionResource } from './client.ts'
import { detectRepository, type LocalRepository } from './git.ts'
import { checkGitHubAccess } from './github.ts'
import { isImageFilename, type ApprovalDecision, type LiveSessionTracker } from './live-tracker.ts'
import { prepareMultimodalContent, repositoryResource } from './run.ts'

export { BOT_ACTIVE_MODEL, BOT_MODEL_PREFIX, BOT_PRESET_ID, BOT_PROVIDER } from './bot-constants.ts'

const MAX_STREAM_FAILURES = 6

export interface BotReplay {
  readonly remoteSessionId: string
  readonly botId?: string
  readonly botName?: string
}

export interface BotTurnContext {
  readonly cwd: string | undefined
  readonly asker: Asker | undefined
}

export interface CustomToolCall {
  readonly eventId: string
  readonly name: string
  readonly input: unknown
  readonly remoteSessionId: string
  readonly dshSessionId?: string
  readonly botId?: string
}

/**
 * Extract an optional `[adopt-session:sess_...]` directive from the start of a
 * user message so a user can seamlessly attach a fresh DSH chat directly to a
 * background Routine Run's cloud `sess_...` and continue asking follow-ups!
 */
export function parseAdoptSessionDirective(raw: string): { adoptSessionId?: string; text: string } {
  const match = /^\s*\[adopt-session:(sess_[A-Za-z0-9_-]+)\]\s*([\s\S]*)$/.exec(raw)
  if (match === null) return { text: raw }
  const adoptSessionId = match[1]!
  const rest = match[2]!.trim()
  return {
    adoptSessionId,
    text: rest.length > 0 ? rest : 'Summarize your findings from this scheduled run and any action items.',
  }
}

export type CustomToolHandler = (
  call: CustomToolCall,
  signal: AbortSignal,
) => Promise<{ text: string; isError?: boolean } | undefined>

export interface BotModeOptions {
  readonly client: () => Promise<QoderCloudClient | string>
  readonly manager: BotManager
  readonly tracker?: LiveSessionTracker | undefined
  readonly attachments: () => AttachmentStore | undefined
  readonly turnContext: (sessionId: string | undefined) => BotTurnContext
  readonly repository: 'auto' | 'none'
  readonly gitToken: () => Promise<string | undefined>
  readonly gitTokenEnv: string
  readonly gitUsername: string | undefined
  readonly branchPrefix: string
  readonly toolConfirmation: 'allow' | 'deny'
  readonly environmentVariables: Readonly<Record<string, string>>
  readonly customToolHandler?: CustomToolHandler | undefined
}

function blocksPlainSummary(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[image: ${block.attachment?.name ?? 'image'}]`)
    else if (block.type === 'file') parts.push(`[file: ${block.attachment?.name ?? 'file'}]`)
  }
  return parts.join('\n')
}

function isUserInput(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  return message.source === undefined || message.source.kind === 'user'
}

/**
 * Find the remote session of the latest Bot reply and collect all raw user
 * `ContentBlock`s (text, images, files) submitted since that reply.
 */
export function splitBotHistory(messages: readonly RequestMessage[]): {
  replay: BotReplay | undefined
  blocks: ContentBlock[]
  textPreview: string
} {
  let lastAssistant = -1
  let replay: BotReplay | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    if (lastAssistant < 0) lastAssistant = index
    const source = message.source
    const state = source.provider === BOT_PROVIDER
      ? (source.replayState as { response?: unknown } | undefined)
      : undefined
    const response = state?.response as Partial<BotReplay> | undefined
    if (typeof response?.remoteSessionId === 'string') {
      replay = {
        remoteSessionId: response.remoteSessionId,
        ...typeof response.botId === 'string' ? { botId: response.botId } : {},
        ...typeof response.botName === 'string' ? { botName: response.botName } : {},
      }
      break
    }
  }
  const userMessages = messages.slice(lastAssistant + 1).filter(isUserInput)
  const blocks: ContentBlock[] = []
  for (let i = 0; i < userMessages.length; i++) {
    if (i > 0 && blocks.length > 0) blocks.push({ type: 'text', text: '\n' })
    blocks.push(...userMessages[i]!.content)
  }
  const textPreview = userMessages
    .map(m => blocksPlainSummary(m.content))
    .filter(t => t.trim().length > 0)
    .join('\n\n')
  return { replay, blocks, textPreview }
}

export function botModePreamble(
  bot: BotProfile,
  repo: LocalRepository | undefined,
  resultBranch: string | undefined,
): string {
  const lines = [
    `You are "${bot.name}" (${bot.avatar}), a persistent Qoder Cloud Bot conversing with a user inside DeepSeek Harness.`,
    'Your messages are rendered directly to the user, and follow-up turns continue in this same sandbox.',
  ]
  if (bot.memoryStoreId !== undefined) {
    lines.push(
      `Your persistent Memory Store (${bot.memoryStoreId}) is mounted in this session — consult and update your awareness markdown files to preserve durable context across sessions.`,
    )
  }
  if (repo !== undefined && resultBranch !== undefined) {
    const at = repo.checkout.type === 'branch'
      ? `checked out at branch \`${repo.checkout.name}\``
      : `checked out at its default branch; before working, run \`git fetch origin ${repo.checkout.sha} && git checkout ${repo.checkout.sha}\` there`
    lines.push(
      `The user's git repository ${repo.url} is mounted at \`${repo.mountPath}\` (in a self-hosted environment: \`workspace/${repo.name}\` under your working directory), ${at}.`,
      'First verify that the mounted repository exists if the task touches repository files; if missing, report the mount failure and stop without cloning manually.',
      `When you modify repository files, commit on branch \`${resultBranch}\` and \`git push -u origin ${resultBranch}\`; keep using that branch for later turns.`,
    )
  }
  return lines.join('\n')
}

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value.length > 160 ? `${value.slice(0, 157)}…` : value
  }
  const json = JSON.stringify(record)
  return json.length > 160 ? `${json.slice(0, 157)}…` : json
}

function eventText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

class ChunkWriter {
  private index = 0
  text(text: string): StreamChunk[] { return this.block('text', text) }
  reasoning(text: string): StreamChunk[] { return this.block('reasoning', text) }
  private block(type: 'text' | 'reasoning', text: string): StreamChunk[] {
    const index = this.index++
    return [
      { type: 'block-start', index, blockType: type },
      type === 'text' ? { type: 'text-delta', index, text } : { type: 'reasoning-delta', index, text },
      { type: 'block-end', index, block: { type, text } },
    ]
  }
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const

const BOT_GROUP_NAME = 'Qoder Cloud Bots'
const ACTIVE_BOT_MODEL_NAME = '当前激活 Bot（Qoder Cloud Bots）'
const ACTIVE_BOT_MODEL_DESC = '自动路由到当前选中的 Qoder Cloud Bot（含持久记忆与云端沙箱）'

function explicitBotFromModel(modelId: string): string | undefined {
  if (modelId.startsWith(BOT_MODEL_PREFIX)) {
    const id = modelId.slice(BOT_MODEL_PREFIX.length).trim()
    return id.length > 0 ? id : undefined
  }
  return undefined
}

interface PendingToolRecord {
  readonly type: string
  readonly name: string
  readonly input: unknown
}

export class QoderBotAdapter extends LlmAdapter {
  private readonly remoteByDshSession = new Map<string, BotReplay>()

  constructor(private readonly options: BotModeOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: BOT_GROUP_NAME }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const base: LlmModelInfo[] = [{
      provider,
      id: BOT_ACTIVE_MODEL,
      name: ACTIVE_BOT_MODEL_NAME,
      description: ACTIVE_BOT_MODEL_DESC,
      inputModalities: ['text', 'image'],
    }]
    const client = await this.options.client()
    if (typeof client === 'string') return base
    try {
      const bots = await this.options.manager.listBots(client, AbortSignal.timeout(5_000))
      for (const bot of bots.filter(b => b.isManagedBot)) {
        base.push({
          provider,
          id: `${BOT_MODEL_PREFIX}${bot.id}`,
          name: `${bot.avatar} ${bot.name}`,
          description: `${bot.description || 'Qoder Cloud Bot'}${bot.memoryStoreId ? ' · 持久记忆已挂载' : ''}`,
          inputModalities: ['text', 'image'],
        })
      }
    } catch {
      // Offline / bad token: keep static active-bot route available
    }
    return base
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: ACTIVE_BOT_MODEL_NAME,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_000_000 },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      yield* this.auxiliary(options)
      return
    }
    const signal = options.signal ?? new AbortController().signal
    const { replay, blocks, textPreview } = splitBotHistory(options.messages)
    if (textPreview.trim().length === 0 && blocks.length === 0) {
      throw new LlmError('Qoder Bot mode received no user content to send', 'EMPTY_REQUEST')
    }
    const client = await this.options.client()
    if (typeof client === 'string') throw new LlmError(`Qoder Bots: ${client}`, 'AUTH')

    const sessionKey = options.sessionId as string | undefined
    const prebound = this.options.tracker?.getBindingForDshSession(sessionKey)
    const cached = replay
      ?? (sessionKey === undefined ? undefined : this.remoteByDshSession.get(sessionKey))
      ?? (prebound === undefined ? undefined : {
        remoteSessionId: prebound.remoteSessionId,
        ...prebound.botId !== undefined ? { botId: prebound.botId } : {},
        ...prebound.botName !== undefined ? { botName: prebound.botName } : {},
      })
    let remoteSessionId = cached?.remoteSessionId
    let activeBotId = cached?.botId
    let activeBotName = cached?.botName

    const writer = new ChunkWriter()
    const explicitBot = explicitBotFromModel(options.model)

    const prepared = await prepareMultimodalContent(blocks, {
      client,
      attachments: this.options.attachments(),
      allowResources: true,
      signal,
    })

    let userText = prepared.text
    if (remoteSessionId === undefined) {
      const adopt = parseAdoptSessionDirective(userText)
      if (adopt.adoptSessionId !== undefined) {
        remoteSessionId = adopt.adoptSessionId
        userText = adopt.text
        for (const f of prepared.uploadedFileResources) {
          await client.addSessionFileResource(remoteSessionId, { fileId: f.fileId, mountPath: f.mountPath }, signal)
        }
        const adoptNotes = [`Adopted cloud routine session ${remoteSessionId}`, ...prepared.notes]
        yield* writer.reasoning(adoptNotes.join('\n'))
      } else {
        const created = await this.createRemoteBotSession(
          client,
          sessionKey,
          explicitBot,
          prepared.uploadedFileResources,
          signal,
        )
        remoteSessionId = created.id
        activeBotId = created.bot.id
        activeBotName = `${created.bot.avatar} ${created.bot.name}`
        const bodyText = userText.trim().length > 0 ? userText : 'Please inspect the attached image(s)/file(s).'
        userText = created.reusedPrimary
          ? bodyText
          : `${created.preamble}\n\n---\n\n${bodyText}`
        const allNotes = [...created.notes, ...prepared.notes]
        if (allNotes.length > 0) yield* writer.reasoning(allNotes.join('\n'))
      }
    } else {
      // Follow-up turn on an existing remote session: attach newly uploaded files via POST /sessions/{id}/resources
      for (const f of prepared.uploadedFileResources) {
        try {
          await client.addSessionFileResource(remoteSessionId, { fileId: f.fileId, mountPath: f.mountPath }, signal)
        } catch (error: unknown) {
          throw toLlmError(error, `Qoder Bots failed to mount file "${f.filename}"`)
        }
      }
      if (prepared.notes.length > 0) yield* writer.reasoning(prepared.notes.join('\n'))
      if (userText.trim().length === 0) userText = 'Please inspect the newly attached image(s)/file(s).'
    }

    const nextReplay: BotReplay = {
      remoteSessionId,
      ...activeBotId !== undefined ? { botId: activeBotId } : {},
      ...activeBotName !== undefined ? { botName: activeBotName } : {},
    }
    if (sessionKey !== undefined) this.remoteByDshSession.set(sessionKey, nextReplay)
    this.options.tracker?.ensureComputer({
      remoteSessionId,
      dshSessionId: sessionKey,
      botId: activeBotId,
      botName: activeBotName ?? 'Qoder Bot',
    })
    this.options.tracker?.setStatus(remoteSessionId, 'running')

    const contentBlocks: Record<string, unknown>[] = [
      { type: 'text', text: userText },
      ...prepared.imageBlocks,
    ]

    let posted
    try {
      posted = await client.sendEvents(remoteSessionId, [{ type: 'user.message', content: contentBlocks }], signal)
    } catch (error: unknown) {
      throw toLlmError(error, 'Qoder Bots refused the message')
    }

    const id = remoteSessionId
    const onAbort = (): void => { void client.cancelSession(id, AbortSignal.timeout(10_000)).catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      yield* this.follow(client, id, posted.data.at(-1)?.id, nextReplay, sessionKey, writer, signal)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async *auxiliary(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const writer = new ChunkWriter()
    const text = options.purpose === 'session-title'
      ? localTitle(options.messages)
      : 'The conversation continues in the same Qoder Cloud Bot session with its persistent Memory Store.'
    yield* writer.text(text)
    yield { type: 'usage', usage: ZERO_USAGE }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private async createRemoteBotSession(
    client: QoderCloudClient,
    sessionKey: string | undefined,
    explicitBot: string | undefined,
    uploadedFiles: readonly { fileId: string; filename: string; mountPath: string }[],
    signal: AbortSignal,
  ): Promise<{ id: string; bot: BotProfile; preamble: string; notes: string[]; reusedPrimary: boolean }> {
    const { options } = this
    const context = options.turnContext(sessionKey)
    const notes: string[] = []
    let repo: LocalRepository | undefined
    let resultBranch: string | undefined
    const resources: SessionResource[] = []

    let target
    try {
      target = await options.manager.resolve(client, context.asker, signal, explicitBot)
    } catch (error: unknown) {
      throw toLlmError(error, 'Qoder Bot target resolution')
    }

    // "A Computer of Its Own": reuse the Bot's persistent Cloud Computer (`primarySessionId`)
    // whenever it is alive (`idle` / `running` / `rescheduling`)!
    if (target.bot.primarySessionId !== undefined) {
      const existing = await client.getSession(target.bot.primarySessionId, signal).catch(() => null)
      if (existing !== null && existing.status !== 'terminated') {
        for (const f of uploadedFiles) {
          await client.addSessionFileResource(existing.id, { fileId: f.fileId, mountPath: f.mountPath }, signal)
        }
        options.tracker?.ensureComputer({
          remoteSessionId: existing.id,
          dshSessionId: sessionKey,
          botId: target.bot.id,
          botName: target.bot.name,
          botAvatar: target.bot.avatar,
          sessionMetadata: existing.metadata,
        })
        notes.unshift(
          `${target.bot.avatar} ${target.bot.name} · 已连接常驻云电脑 ${existing.id}`,
          ...target.notes,
        )
        return {
          id: existing.id,
          bot: target.bot,
          preamble: '',
          notes,
          reusedPrimary: true,
        }
      }
    }

    if (options.repository === 'auto' && context.cwd !== undefined) {
      repo = await detectRepository(context.cwd, signal)
    }
    if (repo !== undefined) {
      const gitToken = await options.gitToken()
      if (repo.github) {
        const access = await checkGitHubAccess(repo.url, gitToken, options.gitTokenEnv, signal)
        if (access.error !== undefined) throw new LlmError(`Qoder Bots: ${access.error}`, 'REPOSITORY_ACCESS')
        notes.push(...access.warnings)
      }
      try {
        resources.push(repositoryResource(repo, {
          gitToken,
          gitTokenEnv: options.gitTokenEnv,
          gitUsername: options.gitUsername,
        }))
      } catch (error: unknown) {
        throw toLlmError(error, 'Qoder Bots repository configuration')
      }
      resultBranch = `${options.branchPrefix}${randomUUID().slice(0, 8)}`
      notes.push(...repo.warnings)
    }

    if (target.memoryResource !== undefined) {
      resources.push(target.memoryResource)
    }
    for (const f of uploadedFiles) {
      resources.push({ type: 'file', file_id: f.fileId, mount_path: f.mountPath })
    }

    let session
    try {
      session = await client.createSession({
        agent: target.bot.id,
        environment_id: target.environmentId,
        title: `${target.bot.avatar} ${target.bot.name} · 常驻云端沙箱`,
        metadata: {
          mode: 'bot',
          bot_id: target.bot.id,
          bot_name: target.bot.name,
          ...resultBranch !== undefined ? { result_branch: resultBranch } : {},
        },
        ...resources.length === 0 ? {} : { resources },
        ...target.bot.vaultIds.length > 0 ? { vault_ids: [...target.bot.vaultIds] } : {},
        ...Object.keys(options.environmentVariables).length === 0
          ? {}
          : { environment_variables: { ...options.environmentVariables } },
      }, signal)
    } catch (error: unknown) {
      throw toLlmError(error, 'Qoder Bots could not create a session')
    }

    if (target.bot.isManagedBot && target.bot.primarySessionId === undefined) {
      void options.manager.updateBotConfig(client, target.bot.id, {
        primarySessionId: session.id,
      }, AbortSignal.timeout(10_000)).catch(() => {})
    }

    options.tracker?.ensureComputer({
      remoteSessionId: session.id,
      dshSessionId: sessionKey,
      botId: target.bot.id,
      botName: target.bot.name,
      botAvatar: target.bot.avatar,
      resultBranch,
      sessionMetadata: session.metadata,
    })

    const memSummary = target.bot.memoryStoreId ? ` · memory ${target.bot.memoryStoreId}` : ''
    const repoSummary = repo === undefined ? '' : ` · repo ${repo.url} → ${resultBranch}`
    notes.unshift(
      `${target.bot.avatar} ${target.bot.name} · session ${session.id}${memSummary}${repoSummary}`,
      ...target.notes,
    )
    return {
      id: session.id,
      bot: target.bot,
      preamble: botModePreamble(target.bot, repo, resultBranch),
      notes,
      reusedPrimary: false,
    }
  }

  private async *follow(
    client: QoderCloudClient,
    remoteSessionId: string,
    lastPosted: string | undefined,
    replay: BotReplay,
    dshSessionId: string | undefined,
    writer: ChunkWriter,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    let lastEventId = lastPosted
    let failures = 0
    let errorMessage: string | undefined
    let wroteText = false
    const pendingTools = new Map<string, PendingToolRecord>()
    const deliveredArtifacts: string[] = []

    for (;;) {
      try {
        for await (const event of client.streamEvents(remoteSessionId, lastEventId, signal)) {
          failures = 0
          if (event.id !== undefined) lastEventId = event.id
          const chunks = this.render(event, remoteSessionId, writer, pendingTools, deliveredArtifacts)
          if (event.type === 'agent.message' && chunks.length > 0) wroteText = true
          yield* chunks
          if (event.type === 'session.error') errorMessage = event.error?.message ?? errorMessage
          if (event.type === 'session.status_idle') {
            const reason = event.stop_reason?.type ?? 'end_turn'
            if (reason === 'requires_action') {
              await this.answerPause(
                client,
                remoteSessionId,
                dshSessionId,
                replay.botId,
                replay.botName,
                event.stop_reason?.event_ids ?? [],
                pendingTools,
                signal,
              )
              continue
            }
            this.options.tracker?.setStatus(remoteSessionId, 'idle')
            if (reason === 'end_turn' || reason === 'max_tokens') {
              if (deliveredArtifacts.length > 0) {
                yield* writer.text(`\n\n📦 **交付产物 (Delivered Artifacts)**：\n${deliveredArtifacts.map(a => `- ${a}`).join('\n')}`)
                wroteText = true
              }
              if (!wroteText) yield* writer.text('(the cloud bot ended the turn without a message)')
              yield { type: 'usage', usage: ZERO_USAGE }
              yield {
                type: 'finish',
                reason: reason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' },
                replayState: { response: replay },
              }
              return
            }
            throw new LlmError(
              errorMessage ?? `Qoder Bot turn ended with ${reason} (session ${remoteSessionId})`,
              reason === 'cancelled' ? 'REMOTE_CANCELLED' : 'REMOTE_AGENT_ERROR',
            )
          }
          if (event.type === 'session.status_terminated' || event.type === 'session.deleted') {
            this.options.tracker?.setStatus(remoteSessionId, 'idle')
            throw new LlmError(errorMessage ?? `Qoder Bot session ${remoteSessionId} was terminated`, 'REMOTE_TERMINATED')
          }
        }
      } catch (error: unknown) {
        if (error instanceof LlmError || signal.aborted) throw error
        if (++failures >= MAX_STREAM_FAILURES) throw toLlmError(error, 'Qoder Bots stream failed')
      }
      await delay(Math.min(1_000 * 2 ** failures, 15_000), signal)
    }
  }

  private render(
    event: SessionEvent,
    remoteSessionId: string,
    writer: ChunkWriter,
    pendingTools: Map<string, PendingToolRecord>,
    deliveredArtifacts: string[],
  ): StreamChunk[] {
    switch (event.type) {
      case 'agent.message': {
        const text = eventText(event.content)
        return text.trim().length > 0 ? writer.text(text) : []
      }
      case 'agent.thinking': {
        const text = typeof event.thinking === 'string' ? event.thinking : typeof event.text === 'string' ? event.text : ''
        return text.trim().length > 0 ? writer.reasoning(text) : []
      }
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
      case 'agent.custom_tool_use': {
        const toolName = event.name ?? 'tool'
        pendingTools.set(event.id, {
          type: event.type,
          name: toolName,
          input: event.input,
        })
        const server = typeof event.mcp_server_name === 'string' ? `${event.mcp_server_name}/` : ''
        const detail = summarizeInput(event.input)
        this.options.tracker?.recordToolUse(remoteSessionId, event.id, `${server}${toolName}`, event.input, detail)
        return writer.reasoning(`› ${server}${toolName}${detail.length > 0 ? `: ${detail}` : ''}`)
      }
      case 'agent.tool_result':
      case 'agent.mcp_tool_result':
        return event.is_error === true ? writer.reasoning(`  ✗ ${eventText(event.content).slice(0, 300) || 'tool failed'}`) : []
      case 'agent.artifact_delivered': {
        const fileId = event.file_id ?? ''
        const filename = event.original_filename ?? fileId
        if (fileId.length > 0) {
          this.options.tracker?.recordArtifact(remoteSessionId, {
            fileId,
            filename,
            size: event.size,
            contentType: event.content_type,
          })
        }
        const qs = `id=${encodeURIComponent(fileId)}&name=${encodeURIComponent(filename)}`
        const downloadUrl = `${API_BASE_PATH}/file?${qs}`
        const sizeNote = typeof event.size === 'number' ? ` (${(event.size / 1024).toFixed(1)} KB)` : ''
        const isImg = isImageFilename(filename, event.content_type)
        const mdLine = isImg
          ? `[📸 **${filename}** — 点击查看高清原图](${downloadUrl}&inline=1)${sizeNote}（已同步至右侧「云端工作台 → 实时画面 / 交付产物」）`
          : `[📥 **${filename}**](${downloadUrl})${sizeNote} · \`${fileId}\``
        deliveredArtifacts.push(mdLine)
        return writer.reasoning(`📦 Delivered artifact \`${filename}\` (${fileId})`)
      }
      case 'session.thread_created': {
        const msg = `🧵 Spawned sub-bot thread \`${event.agent_name ?? 'child'}\` (${event.session_thread_id ?? 'thread'})`
        this.options.tracker?.recordThreadActivity(remoteSessionId, event.id, msg)
        return writer.reasoning(msg)
      }
      case 'agent.thread_message_sent': {
        const preview = eventText(event.content).replace(/\s+/g, ' ').trim().slice(0, 140)
        const msg = `↗ Delegated to \`${event.to_agent_name ?? event.to_session_thread_id ?? 'thread'}\`${preview ? `: ${preview}${preview.length >= 140 ? '…' : ''}` : ''}`
        this.options.tracker?.recordThreadActivity(remoteSessionId, event.id, msg)
        return writer.reasoning(msg)
      }
      case 'agent.thread_message_received': {
        const preview = eventText(event.content).replace(/\s+/g, ' ').trim().slice(0, 140)
        const msg = `↙ Report from \`${event.from_agent_name ?? event.from_session_thread_id ?? 'thread'}\`${preview ? `: ${preview}${preview.length >= 140 ? '…' : ''}` : ''}`
        this.options.tracker?.recordThreadActivity(remoteSessionId, event.id, msg)
        return writer.reasoning(msg)
      }
      case 'session.thread_status_idle': {
        const msg = `✓ Sub-bot thread \`${event.agent_name ?? event.session_thread_id ?? 'thread'}\` settled (${event.stop_reason?.type ?? 'idle'})`
        this.options.tracker?.recordThreadActivity(remoteSessionId, event.id, msg)
        return writer.reasoning(msg)
      }
      case 'session.error':
        return event.error?.retry_status?.type === 'retrying'
          ? writer.reasoning(`Qoder Cloud is retrying: ${event.error.message ?? 'transient error'}`)
          : []
      default:
        return []
    }
  }

  private async answerPause(
    client: QoderCloudClient,
    remoteSessionId: string,
    dshSessionId: string | undefined,
    botId: string | undefined,
    botName: string | undefined,
    eventIds: readonly string[],
    pendingTools: Map<string, PendingToolRecord>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const eventId of eventIds) {
      const pending = pendingTools.get(eventId)
      if (pending?.type === 'agent.custom_tool_use') {
        const customOutcome = this.options.customToolHandler !== undefined
          ? await this.options.customToolHandler({
              eventId,
              name: pending.name,
              input: pending.input,
              remoteSessionId,
              ...dshSessionId !== undefined ? { dshSessionId } : {},
              ...botId !== undefined ? { botId } : {},
            }, signal)
          : undefined
        const event = customOutcome !== undefined
          ? {
              type: 'user.custom_tool_result',
              custom_tool_use_id: eventId,
              content: [{ type: 'text', text: customOutcome.text }],
              is_error: customOutcome.isError ?? false,
            }
          : {
              type: 'user.custom_tool_result',
              custom_tool_use_id: eventId,
              content: [{ type: 'text', text: `Custom tool "${pending.name}" is not handled by dsh-qoder-bots.` }],
              is_error: true,
            }
        await client.sendEvents(remoteSessionId, [event], signal)
        continue
      }

      // Human-in-the-loop `Needs Approval` gate (`always_ask` tool confirmation):
      // Register on `LiveSessionTracker` (so Studio Inbox + Right-Sidebar Cloud Computer
      // show interactive Approve/Deny buttons) AND prompt via `context.asker` in chat!
      const toolName = pending?.name ?? 'Tool'
      const inputSummary = summarizeInput(pending?.input) || JSON.stringify(pending?.input ?? {})
      const tracker = this.options.tracker
      const context = this.options.turnContext(dshSessionId)

      let decision: ApprovalDecision = { decision: this.options.toolConfirmation }
      if (tracker !== undefined || context.asker !== undefined) {
        const askAbort = new AbortController()
        const onOuterAbort = (): void => askAbort.abort(signal.reason)
        signal.addEventListener('abort', onOuterAbort, { once: true })
        try {
          const racers: Promise<ApprovalDecision>[] = []
          if (tracker !== undefined) {
            racers.push(tracker.registerPendingApproval({
              toolUseId: eventId,
              remoteSessionId,
              dshSessionId,
              botId,
              botName: botName ?? 'Qoder Bot',
              botAvatar: '🛡️',
              toolName,
              inputSummary,
              rawInput: pending?.input ?? {},
              createdAt: new Date().toISOString(),
            }))
          }
          if (context.asker !== undefined) {
            const allowLabel = '✓ 批准执行 (Approve)'
            const denyLabel = '✕ 拒绝操作 (Deny)'
            racers.push(
              context.asker([{
                id: `approve_${eventId}`,
                header: '🛡️ Needs Approval',
                question: `${botName ?? 'Qoder Bot'} 请求执行敏感操作 \`${toolName}\`，是否批准？`,
                detail: inputSummary,
                options: [
                  { label: allowLabel, description: '允许本次云端沙箱操作继续执行' },
                  { label: denyLabel, description: '拒绝本次操作并将原因反馈给 Bot' },
                ],
              }], askAbort.signal).then((ans): ApprovalDecision => {
                const entry = ans.answers[0]
                const picked = entry?.selected[0] ?? ''
                const custom = entry?.custom?.trim()
                if (picked === denyLabel || (picked === '' && custom !== undefined && custom.length > 0)) {
                  return { decision: 'deny', denyMessage: custom || '用户在对话中拒绝了该操作。' }
                }
                return { decision: 'allow' }
              }).catch((): Promise<ApprovalDecision> => {
                // If chat cannot prompt (e.g. background session) while tracker is active, keep waiting on tracker;
                // otherwise fall back to configured policy.
                if (tracker !== undefined && !signal.aborted) {
                  return new Promise<ApprovalDecision>(() => {})
                }
                return Promise.resolve({ decision: this.options.toolConfirmation })
              }),
            )
          }
          decision = await Promise.race(racers)
          askAbort.abort()
          tracker?.resolvePendingApproval(eventId, decision)
        } finally {
          signal.removeEventListener('abort', onOuterAbort)
          tracker?.cancelPendingApproval(eventId)
        }
      }

      await client.confirmSessionTool(
        remoteSessionId,
        eventId,
        decision.decision,
        decision.denyMessage,
        signal,
      )
    }
  }
}

export function localTitle(messages: readonly RequestMessage[]): string {
  const raw = messages
    .filter(message => message.role === 'user')
    .map(message => blocksPlainSummary(message.content))
    .join('\n')
  const framed = raw.indexOf('[')
  let candidate: string | undefined
  if (framed >= 0) {
    try {
      candidate = firstString(JSON.parse(raw.slice(framed)))
    } catch {
      // Not a framed JSON array
    }
  }
  const line = (candidate ?? raw).split(/\r?\n/).map(item => item.trim()).find(item => item.length > 0)
  return (line ?? 'Qoder Bot').slice(0, 40)
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim().length > 0) return record.text
    for (const item of Object.values(record)) {
      const found = firstString(item)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function toLlmError(error: unknown, context: string): LlmError {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message.replace(/^qoder-bots: /, '') : String(error)
  const status = (error as { status?: unknown }).status
  return new LlmError(`${context}: ${message}`, 'REMOTE_AGENT_ERROR', {
    cause: error,
    ...typeof status === 'number' && status >= 100 && status <= 599 ? { status } : {},
  })
}
