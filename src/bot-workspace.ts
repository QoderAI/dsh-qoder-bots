/**
 * Standalone Bot / Super-Agent Workspace Engine (`BotWorkspaceRunner`).
 *
 * Powers the standalone `Bots` application in DeepSeek Harness WITHOUT creating
 * or polluting regular workspace conversations (`默认工作区` session list) and
 * WITHOUT injecting switches into the regular chat composer!
 *
 * Inspired by:
 *   - **DeepSeek Super Agent**: Solving the human attention bottleneck via a
 *     persistent Router / Chief-of-Staff Bot + isolated Multi-Worker sub-bot
 *     threads + Proactive Attention Inbox (`Needs Approval` & 7×24 Routine runs).
 *   - **Always-On Cloud Computer**: Each Bot owns a persistent Cloud Computer
 *     (`Session` on Qoder Cloud Managed API `/api/v1/cloud`) with live Chromium
 *     viewport, 1-click Take Control, persistent Memory Store + CoW Dream, and
 *     autonomous background execution that continues even if the UI tab switches.
 *
 * @module dsh-qoder-bots/bot-workspace
 */

import { API_BASE_PATH } from './bot-constants.ts'
import type { BotManager, BotProfile } from './bot-manager.ts'
import type { CustomToolHandler } from './bot-mode.ts'
import { delay, type QoderCloudClient, type SessionEvent } from './client.ts'
import { isImageFilename, type ApprovalDecision, type DeliveredArtifactItem, type LiveSessionTracker } from './live-tracker.ts'

export interface BotWorkspaceStep {
  readonly id: string
  readonly kind: 'thinking' | 'tool' | 'browser' | 'bash' | 'file' | 'thread' | 'artifact' | 'approval' | 'error'
  readonly title: string
  readonly detail?: string | undefined
  readonly status?: 'running' | 'done' | 'error' | undefined
}

export interface BotWorkspaceArtifact {
  readonly fileId: string
  readonly filename: string
  readonly size?: number | undefined
  readonly contentType?: string | undefined
  readonly downloadUrl: string
  readonly inlineUrl?: string | undefined
  readonly isImage: boolean
}

export interface BotWorkspaceMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly steps: BotWorkspaceStep[]
  readonly artifacts: BotWorkspaceArtifact[]
  readonly streaming?: boolean | undefined
  readonly error?: string | undefined
  readonly timestamp?: string | undefined
}

export interface BotWorkspaceRunnerDeps {
  readonly client: () => Promise<QoderCloudClient | string>
  readonly manager: BotManager
  readonly tracker: LiveSessionTracker
  readonly toolConfirmation: 'allow' | 'deny'
  readonly customToolHandler?: CustomToolHandler | undefined
}

interface ActiveWorkspaceRun {
  readonly remoteSessionId: string
  readonly botId: string
  readonly botName: string
  readonly botAvatar: string
  readonly controller: AbortController
  readonly startedAt: string
  userMessageId?: string | undefined
  userText: string
  assistantText: string
  steps: BotWorkspaceStep[]
  artifacts: BotWorkspaceArtifact[]
  error?: string | undefined
  done: boolean
}

const MAX_STREAM_FAILURES = 6

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } =>
      typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
}

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['url', 'command', 'file_path', 'path', 'pattern', 'query', 'action', 'name']) {
    const val = record[key]
    if (typeof val === 'string' && val.length > 0) {
      return val.length > 160 ? `${val.slice(0, 157)}…` : val
    }
  }
  const json = JSON.stringify(record)
  return json.length > 160 ? `${json.slice(0, 157)}…` : json
}

function classifyToolKind(toolName: string): BotWorkspaceStep['kind'] {
  const lower = toolName.toLowerCase()
  if (lower.startsWith('browser_')) return 'browser'
  if (lower === 'bash') return 'bash'
  if (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'glob' || lower === 'grep') return 'file'
  return 'tool'
}

function toArtifactView(ev: {
  fileId: string
  filename: string
  size?: number | undefined
  contentType?: string | undefined
}): BotWorkspaceArtifact {
  const qs = `id=${encodeURIComponent(ev.fileId)}&name=${encodeURIComponent(ev.filename)}`
  const downloadUrl = `${API_BASE_PATH}/file?${qs}`
  const isImage = isImageFilename(ev.filename, ev.contentType)
  return {
    fileId: ev.fileId,
    filename: ev.filename,
    size: ev.size,
    contentType: ev.contentType,
    downloadUrl,
    ...isImage ? { inlineUrl: `${downloadUrl}&inline=1` } : {},
    isImage,
  }
}

/**
 * Reconstruct clean conversation messages (`user` & `assistant` turns with tool/worker/artifact steps)
 * directly from Qoder Cloud Managed Session events (`GET /sessions/{id}/events`), and synchronize
 * any historical browser screenshots / URLs into `LiveSessionTracker` so even after a page reload
 * or server restart, the Bot's Cloud Computer viewport and conversation stream are 100% intact!
 */
export function projectSessionEventsToMessages(
  events: readonly SessionEvent[],
  remoteSessionId?: string,
  tracker?: LiveSessionTracker,
): BotWorkspaceMessage[] {
  const messages: BotWorkspaceMessage[] = []
  let currentAssistant: {
    id: string
    textParts: string[]
    steps: BotWorkspaceStep[]
    artifacts: BotWorkspaceArtifact[]
    error?: string | undefined
    timestamp?: string | undefined
    streaming: boolean
  } | null = null

  const ensureAssistant = (fallbackId: string, ts?: string) => {
    if (currentAssistant === null) {
      currentAssistant = {
        id: `asst_${fallbackId}`,
        textParts: [],
        steps: [],
        artifacts: [],
        timestamp: ts,
        streaming: true,
      }
    }
    return currentAssistant
  }

  const flushAssistant = (streaming = false) => {
    if (currentAssistant === null) return
    const text = currentAssistant.textParts.join('\n\n').trim()
    if (
      text.length > 0
      || currentAssistant.steps.length > 0
      || currentAssistant.artifacts.length > 0
      || currentAssistant.error !== undefined
    ) {
      messages.push({
        id: currentAssistant.id,
        role: 'assistant',
        text,
        steps: currentAssistant.steps,
        artifacts: currentAssistant.artifacts,
        ...streaming ? { streaming: true } : {},
        ...currentAssistant.error !== undefined ? { error: currentAssistant.error } : {},
        ...currentAssistant.timestamp !== undefined ? { timestamp: currentAssistant.timestamp } : {},
      })
    }
    currentAssistant = null
  }

  for (const ev of events) {
    const ts = typeof ev.processed_at === 'string'
      ? ev.processed_at
      : (typeof ev.created_at === 'string' ? ev.created_at : undefined)

    switch (ev.type) {
      case 'user.message': {
        flushAssistant(false)
        let rawText = extractText(ev.content).trim()
        // Strip legacy preamble separator if an older session had one
        const sepIdx = rawText.indexOf('\n\n---\n\n')
        if (sepIdx >= 0 && rawText.startsWith('You are "')) {
          rawText = rawText.slice(sepIdx + 7).trim()
        }
        if (rawText.length > 0) {
          messages.push({
            id: ev.id,
            role: 'user',
            text: rawText,
            steps: [],
            artifacts: [],
            ...ts !== undefined ? { timestamp: ts } : {},
          })
        }
        break
      }

      case 'agent.thinking': {
        const thinking = typeof ev.thinking === 'string'
          ? ev.thinking
          : (typeof ev.text === 'string' ? ev.text : '')
        if (thinking.trim().length > 0) {
          const cur = ensureAssistant(ev.id, ts)
          cur.steps.push({
            id: ev.id,
            kind: 'thinking',
            title: '思考与规划',
            detail: thinking.trim().slice(0, 240),
            status: 'done',
          })
        }
        break
      }

      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
      case 'agent.custom_tool_use': {
        const cur = ensureAssistant(ev.id, ts)
        const server = typeof ev.mcp_server_name === 'string' ? `${ev.mcp_server_name}/` : ''
        const toolName = `${server}${ev.name ?? 'tool'}`
        const detail = summarizeInput(ev.input)
        cur.steps.push({
          id: ev.id,
          kind: classifyToolKind(ev.name ?? 'tool'),
          title: toolName,
          ...detail.length > 0 ? { detail } : {},
          status: 'done',
        })
        if (remoteSessionId && tracker) {
          const rec = (ev.input !== null && typeof ev.input === 'object' ? ev.input : {}) as Record<string, unknown>
          if ((ev.name ?? '').toLowerCase() === 'browser_navigate' && typeof rec.url === 'string' && rec.url.length > 0) {
            const comp = tracker.ensureComputer({ remoteSessionId })
            comp.currentBrowserUrl = rec.url
          }
        }
        break
      }

      case 'agent.artifact_delivered': {
        const fileId = ev.file_id ?? ''
        const filename = ev.original_filename ?? fileId
        if (fileId.length > 0) {
          const cur = ensureAssistant(ev.id, ts)
          const art = toArtifactView({
            fileId,
            filename,
            size: ev.size,
            contentType: ev.content_type,
          })
          if (!cur.artifacts.some(a => a.fileId === art.fileId)) {
            cur.artifacts.push(art)
          }
          cur.steps.push({
            id: ev.id,
            kind: 'artifact',
            title: art.isImage ? `📸 画面同步: ${filename}` : `📦 交付产物: ${filename}`,
            detail: fileId,
            status: 'done',
          })
          if (remoteSessionId && tracker) {
            const comp = tracker.ensureComputer({ remoteSessionId })
            if (!comp.artifacts.some(a => a.fileId === fileId)) {
              const item: DeliveredArtifactItem = {
                fileId,
                filename,
                size: ev.size,
                contentType: ev.content_type,
                isBrowserFrame: art.isImage,
                timestamp: ts ?? new Date().toISOString(),
              }
              comp.artifacts.push(item)
              if (art.isImage && comp.latestBrowserFrame === undefined) {
                comp.latestBrowserFrame = item
              }
            }
          }
        }
        break
      }

      case 'session.thread_created': {
        const cur = ensureAssistant(ev.id, ts)
        cur.steps.push({
          id: ev.id,
          kind: 'thread',
          title: `🧵 派生 Worker 子智能体: ${ev.agent_name ?? 'worker'}`,
          detail: typeof ev.session_thread_id === 'string' ? ev.session_thread_id : undefined,
          status: 'done',
        })
        break
      }

      case 'agent.thread_message_sent': {
        const cur = ensureAssistant(ev.id, ts)
        const preview = extractText(ev.content).replace(/\s+/g, ' ').trim().slice(0, 140)
        cur.steps.push({
          id: ev.id,
          kind: 'thread',
          title: `↗ 委派任务 → ${ev.to_agent_name ?? ev.to_session_thread_id ?? 'worker'}`,
          ...preview ? { detail: preview } : {},
          status: 'done',
        })
        break
      }

      case 'agent.thread_message_received': {
        const cur = ensureAssistant(ev.id, ts)
        const preview = extractText(ev.content).replace(/\s+/g, ' ').trim().slice(0, 140)
        cur.steps.push({
          id: ev.id,
          kind: 'thread',
          title: `↙ 收到 Worker 汇报 ← ${ev.from_agent_name ?? ev.from_session_thread_id ?? 'worker'}`,
          ...preview ? { detail: preview } : {},
          status: 'done',
        })
        break
      }

      case 'session.thread_status_idle': {
        const cur = ensureAssistant(ev.id, ts)
        cur.steps.push({
          id: ev.id,
          kind: 'thread',
          title: `✓ Worker 子线程已完成 (${ev.agent_name ?? ev.session_thread_id ?? 'worker'})`,
          status: 'done',
        })
        break
      }

      case 'agent.message': {
        const text = extractText(ev.content).trim()
        if (text.length > 0) {
          const cur = ensureAssistant(ev.id, ts)
          cur.textParts.push(text)
        }
        break
      }

      case 'session.error': {
        const msg = ev.error?.message
        if (typeof msg === 'string' && msg.length > 0 && ev.error?.retry_status?.type !== 'retrying') {
          const cur = ensureAssistant(ev.id, ts)
          cur.error = msg
        }
        break
      }

      case 'session.status_idle': {
        const reason = ev.stop_reason?.type ?? 'end_turn'
        if (reason !== 'requires_action') {
          flushAssistant(false)
        }
        break
      }

      default:
        break
    }
  }

  flushAssistant(true)
  return messages
}

interface PendingToolRecord {
  readonly type: string
  readonly name: string
  readonly input: unknown
}

export class BotWorkspaceRunner {
  private readonly activeRuns = new Map<string, ActiveWorkspaceRun>()

  constructor(private readonly deps: BotWorkspaceRunnerDeps) {}

  isRunning(remoteSessionId: string | undefined): boolean {
    if (!remoteSessionId) return false
    const run = this.activeRuns.get(remoteSessionId)
    return run !== undefined && !run.done
  }

  /**
   * Send a user objective/message directly into a Bot's standalone Cloud Computer
   * (`primarySessionId` or an adopted routine `remoteSessionId`) and stream its
   * execution asynchronously in the background!
   */
  async sendMessage(
    params: {
      botId: string
      text: string
      remoteSessionId?: string | undefined
    },
    signal?: AbortSignal,
  ): Promise<{
    bot: BotProfile
    remoteSessionId: string
    userEventId?: string | undefined
  }> {
    const cleanText = params.text.trim()
    if (cleanText.length === 0) {
      throw new Error('qoder-bots: message text must not be empty')
    }
    const c = await this.deps.client()
    if (typeof c === 'string') {
      throw new Error(`qoder-bots: ${c}`)
    }

    const reqSignal = signal ?? AbortSignal.timeout(45_000)
    let bot: BotProfile
    let remoteSessionId: string

    if (params.remoteSessionId && params.remoteSessionId.trim().length > 0) {
      remoteSessionId = params.remoteSessionId.trim()
      const bots = await this.deps.manager.listBots(c, reqSignal)
      bot = bots.find(b => b.id === params.botId) ?? bots[0]!
      if (!bot) throw new Error(`qoder-bots: bot "${params.botId}" not found`)
    } else {
      const ensured = await this.deps.manager.ensurePrimaryComputerSession(c, params.botId, reqSignal)
      bot = ensured.bot
      remoteSessionId = ensured.session.id
    }

    // If a previous foreground stream loop was still open for this session, abort its follower cleanly
    const prev = this.activeRuns.get(remoteSessionId)
    if (prev && !prev.done) {
      prev.controller.abort()
      this.activeRuns.delete(remoteSessionId)
    }

    this.deps.tracker.ensureComputer({
      remoteSessionId,
      botId: bot.id,
      botName: bot.name,
      botAvatar: bot.avatar,
    })
    this.deps.tracker.setStatus(remoteSessionId, 'running')

    const posted = await c.sendEvents(remoteSessionId, [{
      type: 'user.message',
      content: [{ type: 'text', text: cleanText }],
    }], reqSignal)
    const userEventId = posted.data.at(-1)?.id

    const controller = new AbortController()
    const runState: ActiveWorkspaceRun = {
      remoteSessionId,
      botId: bot.id,
      botName: bot.name,
      botAvatar: bot.avatar,
      controller,
      startedAt: new Date().toISOString(),
      userMessageId: userEventId,
      userText: cleanText,
      assistantText: '',
      steps: [],
      artifacts: [],
      done: false,
    }
    this.activeRuns.set(remoteSessionId, runState)

    // Launch non-blocking background SSE follower so the Bot keeps working autonomously!
    void this.followInBackground(c, runState, userEventId).catch((err: unknown) => {
      runState.error = err instanceof Error ? err.message : String(err)
      runState.done = true
      this.deps.tracker.setStatus(remoteSessionId, 'idle')
    })

    return {
      bot,
      remoteSessionId,
      ...userEventId !== undefined ? { userEventId } : {},
    }
  }

  /** Cancel an in-flight turn on a Bot's standalone Cloud Computer. */
  async interrupt(remoteSessionId: string, signal?: AbortSignal): Promise<void> {
    const c = await this.deps.client()
    const active = this.activeRuns.get(remoteSessionId)
    if (active) {
      active.done = true
      active.controller.abort()
      this.activeRuns.delete(remoteSessionId)
    }
    this.deps.tracker.setStatus(remoteSessionId, 'idle')
    if (typeof c !== 'string') {
      await c.cancelSession(remoteSessionId, signal ?? AbortSignal.timeout(10_000)).catch(() => {})
    }
  }

  /**
   * Hydrate the complete conversation message list for `remoteSessionId`, merging
   * persisted Qoder Cloud session events with any live in-memory streaming deltas.
   */
  async getMessages(
    client: QoderCloudClient,
    remoteSessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<BotWorkspaceMessage[]> {
    if (!remoteSessionId) return []
    const eventsRes = await client.listSessionEvents(remoteSessionId, signal).catch(() => ({ data: [] as SessionEvent[] }))
    const projected = projectSessionEventsToMessages(eventsRes.data, remoteSessionId, this.deps.tracker)
    const active = this.activeRuns.get(remoteSessionId)
    if (!active || active.done) {
      return projected
    }

    // Ensure the user message of the active turn is visible immediately even if listSessionEvents lags slightly
    const hasUserMsg = active.userMessageId
      ? projected.some(m => m.id === active.userMessageId)
      : projected.some(m => m.role === 'user' && m.text === active.userText)
    if (!hasUserMsg) {
      projected.push({
        id: active.userMessageId ?? `usr_live_${active.startedAt}`,
        role: 'user',
        text: active.userText,
        steps: [],
        artifacts: [],
        timestamp: active.startedAt,
      })
    }

    // Merge or append live streaming assistant turn
    const last = projected.at(-1)
    if (last && last.role === 'assistant') {
      projected[projected.length - 1] = {
        ...last,
        text: active.assistantText.trim() || last.text,
        steps: active.steps.length >= last.steps.length ? [...active.steps] : last.steps,
        artifacts: active.artifacts.length >= last.artifacts.length ? [...active.artifacts] : last.artifacts,
        streaming: true,
        ...active.error !== undefined ? { error: active.error } : {},
      }
    } else {
      projected.push({
        id: `asst_live_${active.startedAt}`,
        role: 'assistant',
        text: active.assistantText.trim(),
        steps: [...active.steps],
        artifacts: [...active.artifacts],
        streaming: true,
        timestamp: active.startedAt,
        ...active.error !== undefined ? { error: active.error } : {},
      })
    }
    return projected
  }

  private async followInBackground(
    client: QoderCloudClient,
    runState: ActiveWorkspaceRun,
    initialLastEventId: string | undefined,
  ): Promise<void> {
    const { remoteSessionId, controller } = runState
    const signal = controller.signal
    let lastEventId = initialLastEventId
    let failures = 0
    const pendingTools = new Map<string, PendingToolRecord>()

    try {
      for (;;) {
        try {
          for await (const event of client.streamEvents(remoteSessionId, lastEventId, signal)) {
            failures = 0
            if (event.id !== undefined) lastEventId = event.id
            this.consumeEvent(event, runState, pendingTools)

            if (event.type === 'session.status_idle') {
              const reason = event.stop_reason?.type ?? 'end_turn'
              if (reason === 'requires_action') {
                await this.handleRequiresAction(
                  client,
                  runState,
                  event.stop_reason?.event_ids ?? [],
                  pendingTools,
                  signal,
                )
                continue
              }
              this.deps.tracker.setStatus(remoteSessionId, 'idle')
              runState.done = true
              return
            }

            if (event.type === 'session.status_terminated' || event.type === 'session.deleted') {
              this.deps.tracker.setStatus(remoteSessionId, 'idle')
              runState.done = true
              return
            }
          }
        } catch (error: unknown) {
          if (signal.aborted) return
          if (++failures >= MAX_STREAM_FAILURES) {
            runState.error = error instanceof Error ? error.message : String(error)
            this.deps.tracker.setStatus(remoteSessionId, 'idle')
            runState.done = true
            return
          }
        }
        await delay(Math.min(1_000 * 2 ** failures, 10_000), signal)
      }
    } finally {
      runState.done = true
      if (this.activeRuns.get(remoteSessionId) === runState) {
        this.activeRuns.delete(remoteSessionId)
      }
    }
  }

  private consumeEvent(
    event: SessionEvent,
    runState: ActiveWorkspaceRun,
    pendingTools: Map<string, PendingToolRecord>,
  ): void {
    const { remoteSessionId } = runState
    switch (event.type) {
      case 'agent.message': {
        const text = extractText(event.content).trim()
        if (text.length > 0) {
          runState.assistantText = runState.assistantText.length > 0
            ? `${runState.assistantText}\n\n${text}`
            : text
        }
        break
      }

      case 'agent.thinking': {
        const thinking = typeof event.thinking === 'string'
          ? event.thinking
          : (typeof event.text === 'string' ? event.text : '')
        if (thinking.trim().length > 0) {
          runState.steps.push({
            id: event.id,
            kind: 'thinking',
            title: '思考与规划',
            detail: thinking.trim().slice(0, 240),
            status: 'done',
          })
        }
        break
      }

      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
      case 'agent.custom_tool_use': {
        const rawName = event.name ?? 'tool'
        pendingTools.set(event.id, {
          type: event.type,
          name: rawName,
          input: event.input,
        })
        const server = typeof event.mcp_server_name === 'string' ? `${event.mcp_server_name}/` : ''
        const toolName = `${server}${rawName}`
        const detail = summarizeInput(event.input)
        this.deps.tracker.recordToolUse(remoteSessionId, event.id, toolName, event.input, detail)
        runState.steps.push({
          id: event.id,
          kind: classifyToolKind(rawName),
          title: toolName,
          ...detail.length > 0 ? { detail } : {},
          status: 'done',
        })
        break
      }

      case 'agent.artifact_delivered': {
        const fileId = event.file_id ?? ''
        const filename = event.original_filename ?? fileId
        if (fileId.length > 0) {
          this.deps.tracker.recordArtifact(remoteSessionId, {
            fileId,
            filename,
            size: event.size,
            contentType: event.content_type,
          })
          const art = toArtifactView({
            fileId,
            filename,
            size: event.size,
            contentType: event.content_type,
          })
          if (!runState.artifacts.some(a => a.fileId === art.fileId)) {
            runState.artifacts.push(art)
          }
          runState.steps.push({
            id: event.id,
            kind: 'artifact',
            title: art.isImage ? `📸 实时画面已更新: ${filename}` : `📦 交付产物: ${filename}`,
            detail: fileId,
            status: 'done',
          })
        }
        break
      }

      case 'session.thread_created': {
        const title = `🧵 派生 Worker 子智能体: ${event.agent_name ?? 'worker'}`
        this.deps.tracker.recordThreadActivity(remoteSessionId, event.id, title, event.session_thread_id)
        runState.steps.push({
          id: event.id,
          kind: 'thread',
          title,
          detail: event.session_thread_id,
          status: 'done',
        })
        break
      }

      case 'agent.thread_message_sent': {
        const preview = extractText(event.content).replace(/\s+/g, ' ').trim().slice(0, 140)
        const title = `↗ 委派子任务 → ${event.to_agent_name ?? event.to_session_thread_id ?? 'worker'}`
        this.deps.tracker.recordThreadActivity(remoteSessionId, event.id, title, preview)
        runState.steps.push({
          id: event.id,
          kind: 'thread',
          title,
          ...preview ? { detail: preview } : {},
          status: 'done',
        })
        break
      }

      case 'agent.thread_message_received': {
        const preview = extractText(event.content).replace(/\s+/g, ' ').trim().slice(0, 140)
        const title = `↙ 收到 Worker 汇报 ← ${event.from_agent_name ?? event.from_session_thread_id ?? 'worker'}`
        this.deps.tracker.recordThreadActivity(remoteSessionId, event.id, title, preview)
        runState.steps.push({
          id: event.id,
          kind: 'thread',
          title,
          ...preview ? { detail: preview } : {},
          status: 'done',
        })
        break
      }

      case 'session.thread_status_idle': {
        const title = `✓ Worker 子线程已完成 (${event.agent_name ?? event.session_thread_id ?? 'worker'})`
        this.deps.tracker.recordThreadActivity(remoteSessionId, event.id, title)
        runState.steps.push({
          id: event.id,
          kind: 'thread',
          title,
          status: 'done',
        })
        break
      }

      case 'session.error': {
        const msg = event.error?.message
        if (typeof msg === 'string' && msg.length > 0 && event.error?.retry_status?.type !== 'retrying') {
          runState.error = msg
        }
        break
      }

      default:
        break
    }
  }

  private async handleRequiresAction(
    client: QoderCloudClient,
    runState: ActiveWorkspaceRun,
    eventIds: readonly string[],
    pendingTools: Map<string, PendingToolRecord>,
    signal: AbortSignal,
  ): Promise<void> {
    const { remoteSessionId, botId, botName, botAvatar } = runState
    for (const eventId of eventIds) {
      const pending = pendingTools.get(eventId)
      if (pending?.type === 'agent.custom_tool_use') {
        const outcome = this.deps.customToolHandler !== undefined
          ? await this.deps.customToolHandler({
              eventId,
              name: pending.name,
              input: pending.input,
              remoteSessionId,
              botId,
            }, signal)
          : undefined
        await client.sendEvents(remoteSessionId, [
          outcome !== undefined
            ? {
                type: 'user.custom_tool_result',
                custom_tool_use_id: eventId,
                content: [{ type: 'text', text: outcome.text }],
                is_error: outcome.isError ?? false,
              }
            : {
                type: 'user.custom_tool_result',
                custom_tool_use_id: eventId,
                content: [{ type: 'text', text: `Custom tool "${pending.name}" is not handled.` }],
                is_error: true,
              },
        ], signal)
        continue
      }

      const toolName = pending?.name ?? 'Tool'
      const inputSummary = summarizeInput(pending?.input) || JSON.stringify(pending?.input ?? {})
      runState.steps.push({
        id: `appr_${eventId}`,
        kind: 'approval',
        title: `🛡️ 等待人类审批: ${toolName}`,
        detail: inputSummary,
        status: 'running',
      })

      let decision: ApprovalDecision = { decision: this.deps.toolConfirmation }
      const waitPromise = this.deps.tracker.registerPendingApproval({
        toolUseId: eventId,
        remoteSessionId,
        botId,
        botName: `${botAvatar} ${botName}`,
        botAvatar,
        toolName,
        inputSummary,
        rawInput: pending?.input ?? {},
        createdAt: new Date().toISOString(),
      })

      const onAbort = () => this.deps.tracker.cancelPendingApproval(eventId)
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        decision = await waitPromise
      } finally {
        signal.removeEventListener('abort', onAbort)
      }

      const stepIdx = runState.steps.findIndex(s => s.id === `appr_${eventId}`)
      if (stepIdx >= 0) {
        runState.steps[stepIdx] = {
          ...runState.steps[stepIdx]!,
          title: decision.decision === 'allow' ? `✓ 已批准执行: ${toolName}` : `✕ 已拒绝执行: ${toolName}`,
          status: decision.decision === 'allow' ? 'done' : 'error',
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
