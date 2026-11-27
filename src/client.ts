/**
 * Qoder Cloud Agents Managed API (`https://api.qoder.com/api/v1/cloud`) client
 * wrapper over `qca-sdk/managed`: environments, agents (create / retrieve /
 * OCC update / archive / multiagent coordinator), memory stores & entries
 * (create / update / delete), dreams (memory consolidation), files (upload /
 * metadata / download), deployments & deployment runs (24/7 cloud routines),
 * sessions, session threads, session resources, and events.
 *
 * Strictly uses Managed + Resources APIs (`/api/v1/cloud`) — zero Forward API
 * dependencies.
 *
 * @module dsh-qoder-bots/client
 */

import { randomUUID } from 'node:crypto'
import {
  APIError,
  ManagedClient,
  toFile,
  type AgentCreateParams,
  type AgentUpdateParams,
  type DeploymentCreateParams,
  type DeploymentUpdateParams,
  type DreamCreateParams,
  type ManagedAgentsEventParamsUnion,
  type SessionCreateParams,
  type SessionNewParamsResourceUnion,
} from 'qoder-cloud-agents-sdk/managed'
import { DEFAULT_QODER_BETA_HEADER } from './bot-constants.ts'

/** Default public gateway (Managed Mode). */
export const DEFAULT_BASE_URL = 'https://api.qoder.com/api/v1/cloud'

/** Built-in sandbox toolset (Bash, Read, Write, Edit, Glob, Grep, WebFetch, DeliverArtifacts, …). */
export const AGENT_TOOLSET = 'agent_toolset_20260401'

/** `{type, message}` from the platform error envelope, with HTTP status and request id. */
export class QoderCloudError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
    readonly requestId?: string,
    options?: ErrorOptions,
  ) {
    super(`Qoder Cloud ${status} ${errorType}: ${message}${requestId === undefined ? '' : ` (request_id ${requestId})`}`, options)
    this.name = 'QoderCloudError'
  }
}

export interface CursorPage<T> {
  readonly data: T[]
  readonly has_more?: boolean
}

export interface EnvironmentView {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly archived_at?: string | null
  readonly config?: {
    readonly type?: string
    readonly runtime_mode?: 'session' | 'shared' | string
    readonly idle_timeout_seconds?: number
    readonly networking?: { readonly type?: string }
    readonly [key: string]: unknown
  } | null
  readonly runtime?: {
    readonly status?: 'creating' | 'ready' | 'resetting' | 'deleting' | 'error' | string
    readonly power_state?: string
  } | null
  readonly usage?: {
    readonly credits?: number
    readonly runtime_credits?: number
    readonly storage_credits?: number
  } | null
  readonly metadata?: Readonly<Record<string, string>>
}

export interface AgentToolView {
  readonly type: string
  readonly name?: string
  readonly enabled_tools?: readonly string[]
  readonly [key: string]: unknown
}

export interface MultiagentView {
  readonly type: 'coordinator' | string
  readonly agents: readonly {
    readonly type: 'agent' | 'self' | 'advisor' | string
    readonly id?: string
    readonly name?: string
    readonly model?: unknown
    readonly version?: number
  }[]
}

export interface AgentSkillRefView {
  readonly type: 'qoder' | 'custom' | string
  readonly skill_id: string
  readonly version?: string
}

export interface AgentView {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly system?: string
  readonly model?: unknown
  readonly tools?: readonly AgentToolView[]
  readonly skills?: readonly AgentSkillRefView[]
  readonly multiagent?: MultiagentView | null
  readonly version?: number
  readonly metadata?: Readonly<Record<string, string>>
  readonly archived_at?: string | null
}

export interface SkillView {
  readonly id: string
  readonly display_title?: string
  readonly description?: string
  readonly latest_version?: string
  readonly created_at?: string
}

export interface VaultView {
  readonly id: string
  readonly display_name: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly archived_at?: string | null
  readonly created_at?: string
}

export interface MemoryStoreView {
  readonly id: string
  readonly name: string
  readonly description?: string | null
  readonly metadata?: Readonly<Record<string, string>>
  readonly entry_count?: number
  readonly total_size?: number
  readonly archived_at?: string | null
}

export interface MemoryEntryView {
  readonly id: string
  readonly path: string
  readonly content?: string
  readonly content_size_bytes?: number
  readonly content_sha256?: string
  readonly version?: number
  readonly updated_at?: string
}

export interface DreamOutputView {
  readonly type: 'memory_store' | string
  readonly memory_store_id: string
  readonly files_touched?: readonly string[]
}

export interface DreamView {
  readonly id: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | string
  readonly inputs: readonly Record<string, unknown>[]
  readonly outputs: readonly DreamOutputView[]
  readonly instructions?: string
  readonly session_id?: string | null
  readonly error?: { readonly type?: string; readonly message?: string } | null
  readonly created_at: string
  readonly ended_at?: string | null
  readonly archived_at?: string | null
}

export interface FileView {
  readonly id: string
  readonly filename: string
  readonly size_bytes?: number
  readonly mime_type?: string
  readonly downloadable?: boolean
}

export interface DeploymentScheduleView {
  readonly type: 'cron' | string
  readonly expression: string
  readonly timezone: string
  readonly last_run_at?: string | null
  readonly upcoming_runs_at?: readonly string[]
}

export interface DeploymentView {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly status: 'active' | 'paused' | string
  readonly agent: { readonly id: string; readonly version?: number }
  readonly environment_id: string
  readonly schedule?: DeploymentScheduleView | null
  readonly initial_events?: readonly { readonly type: string; readonly content?: unknown }[]
  readonly resources?: readonly Record<string, unknown>[]
  readonly metadata?: Readonly<Record<string, string>>
  readonly paused_reason?: { readonly type?: string } | null
  readonly archived_at?: string | null
  readonly created_at?: string
  readonly updated_at?: string
}

export interface DeploymentRunView {
  readonly id: string
  readonly deployment_id: string
  readonly agent: { readonly id: string; readonly version?: number }
  readonly session_id: string | null
  readonly error?: { readonly type?: string; readonly message?: string } | null
  readonly trigger_context?: { readonly type?: string; readonly scheduled_at?: string } | null
  readonly created_at: string
}

export interface SessionView {
  readonly id: string
  readonly status: 'idle' | 'running' | 'rescheduling' | 'terminated' | string
  readonly environment_id?: string
  readonly slot_id?: string
  readonly title?: string | null
  readonly metadata?: Readonly<Record<string, string>>
  readonly usage?: {
    readonly model_credits?: number
    readonly sandbox_runtime_credits?: number
    readonly total_credits?: number
  } | null
  readonly created_at?: string
  readonly updated_at?: string
}

export interface SessionThreadView {
  readonly id: string
  readonly session_id: string
  readonly parent_thread_id?: string | null
  readonly status?: string
  readonly agent?: {
    readonly type?: string
    readonly id?: string
    readonly name?: string
    readonly model?: unknown
  }
  readonly created_at?: string
}

/** One public session event; only the fields this plugin reads are typed. */
export interface SessionEvent {
  readonly id: string
  readonly type: string
  readonly content?: unknown
  readonly input?: unknown
  readonly stop_reason?: { readonly type?: string; readonly event_ids?: readonly string[] } | null
  readonly error?: { readonly type?: string; readonly message?: string; readonly retry_status?: { readonly type?: string } } | null
  readonly name?: string
  readonly file_id?: string
  readonly original_filename?: string
  readonly content_type?: string
  readonly size?: number
  // Multiagent thread collaboration fields:
  readonly session_thread_id?: string
  readonly agent_name?: string
  readonly to_session_thread_id?: string
  readonly to_agent_name?: string | null
  readonly from_session_thread_id?: string
  readonly from_agent_name?: string | null
  readonly [key: string]: unknown
}

export type SessionResource = SessionNewParamsResourceUnion
export type CreateSessionRequest = SessionCreateParams & {
  /** Named virtual desktop slot inside a `runtime_mode: "shared"` Cloud Computer (`x-qoder-beta: session-slot-2026-11-24`). */
  slot_id?: string | undefined
}
export type CreateAgentRequest = AgentCreateParams
export type UpdateAgentRequest = AgentUpdateParams
export type CreateDeploymentRequest = DeploymentCreateParams
export type UpdateDeploymentRequest = DeploymentUpdateParams
export type CreateDreamRequest = DreamCreateParams

export interface QoderCloudClientOptions {
  baseURL: string
  token: string
  headers?: Record<string, string>
  /** Injected for tests. */
  fetch?: typeof fetch
  /** Retries for 408 / 429 / 5xx and connection errors on GETs and idempotency-keyed POSTs. */
  maxRetries?: number
}

export class QoderCloudClient {
  private readonly sdk: ManagedClient

  constructor(options: QoderCloudClientOptions) {
    this.sdk = new ManagedClient({
      pat: options.token,
      baseURL: options.baseURL.replace(/\/+$/, ''),
      maxRetries: options.maxRetries ?? 3,
      defaultHeaders: {
        'x-qoder-beta': DEFAULT_QODER_BETA_HEADER,
        ...options.headers,
      },
      ...options.fetch === undefined ? {} : { fetch: options.fetch },
    })
  }

  // --- Skills & Vaults ---

  listSkills(signal?: AbortSignal): Promise<CursorPage<SkillView>> {
    return this.call(signal, async () => ({
      data: await collect(this.sdk.skills.list({ limit: 100 }, { signal: signal ?? null })) as unknown as SkillView[],
    }))
  }

  listVaults(signal?: AbortSignal): Promise<CursorPage<VaultView>> {
    return this.call(signal, async () => ({
      data: await collect(this.sdk.vaults.list({ limit: 100 }, { signal: signal ?? null })) as unknown as VaultView[],
    }))
  }

  // --- Environments & Persistent Cloud Computers (`runtime_mode: "shared"`) ---

  listEnvironments(signal?: AbortSignal): Promise<CursorPage<EnvironmentView>> {
    return this.call(signal, async () => ({
      data: await collect(this.sdk.environments.list({ limit: 100 }, { signal: signal ?? null })) as unknown as EnvironmentView[],
    }))
  }

  getEnvironment(id: string, signal?: AbortSignal): Promise<EnvironmentView> {
    return this.call(signal, () => this.sdk.environments.retrieve(id, {}, { signal: signal ?? null }) as Promise<unknown> as Promise<EnvironmentView>)
  }

  createEnvironment(
    name: string,
    signal?: AbortSignal,
    options?: {
      description?: string | undefined
      runtimeMode?: 'session' | 'shared' | undefined
      idleTimeoutSeconds?: number | undefined
      metadata?: Record<string, string> | undefined
    },
  ): Promise<EnvironmentView> {
    const runtimeMode = options?.runtimeMode ?? 'shared'
    const config: Record<string, unknown> = {
      type: 'cloud',
      networking: { type: 'unrestricted' },
      ...runtimeMode === 'shared'
        ? {
            runtime_mode: 'shared',
            idle_timeout_seconds: options?.idleTimeoutSeconds ?? 3600,
          }
        : {},
    }
    return this.call(signal, () => this.sdk.environments.create({
      name,
      ...options?.description === undefined ? {} : { description: options.description },
      config: config as never,
      metadata: {
        source: 'dsh-qoder-bots',
        ...runtimeMode === 'shared' ? { kind: 'cloud_computer' } : {},
        ...options?.metadata,
      },
    }, post(signal)) as Promise<unknown> as Promise<EnvironmentView>)
  }

  createCloudComputerEnvironment(
    params: {
      name: string
      description?: string | undefined
      idleTimeoutSeconds?: number | undefined
      metadata?: Record<string, string> | undefined
    },
    signal?: AbortSignal,
  ): Promise<EnvironmentView> {
    return this.createEnvironment(params.name, signal, {
      description: params.description ?? 'Persistent Cloud Computer (shared runtime_mode) managed by DeepSeek Harness dsh-qoder-bots',
      runtimeMode: 'shared',
      idleTimeoutSeconds: params.idleTimeoutSeconds ?? 3600,
      metadata: params.metadata,
    })
  }

  // --- Agents (Bots & Teams) ---

  listAgents(signal?: AbortSignal): Promise<CursorPage<AgentView>> {
    return this.call(signal, async () => ({
      data: await collect(this.sdk.agents.list({ limit: 100 }, { signal: signal ?? null })) as unknown as AgentView[],
    }))
  }

  getAgent(id: string, signal?: AbortSignal): Promise<AgentView> {
    return this.call(signal, () => this.sdk.agents.retrieve(id, {}, { signal: signal ?? null }) as Promise<unknown> as Promise<AgentView>)
  }

  createAgent(body: CreateAgentRequest, signal?: AbortSignal): Promise<AgentView> {
    return this.call(signal, () => this.sdk.agents.create({
      ...body,
      metadata: { ...body.metadata, source: 'dsh-qoder-bots' },
    }, post(signal)) as Promise<unknown> as Promise<AgentView>)
  }

  updateAgent(id: string, body: UpdateAgentRequest, signal?: AbortSignal): Promise<AgentView> {
    return this.call(signal, () => this.sdk.agents.update(id, body, post(signal)) as Promise<unknown> as Promise<AgentView>)
  }

  archiveAgent(id: string, signal?: AbortSignal): Promise<AgentView> {
    return this.call(signal, () => this.sdk.agents.archive(id, {}, post(signal)) as Promise<unknown> as Promise<AgentView>)
  }

  // --- Memory Stores & Memories ---

  listMemoryStores(signal?: AbortSignal): Promise<CursorPage<MemoryStoreView>> {
    return this.call(signal, async () => ({
      data: await collect(this.sdk.memoryStores.list({ limit: 100 }, { signal: signal ?? null })) as unknown as MemoryStoreView[],
    }))
  }

  getMemoryStore(id: string, signal?: AbortSignal): Promise<MemoryStoreView> {
    return this.call(signal, () => this.sdk.memoryStores.retrieve(id, {}, { signal: signal ?? null }) as Promise<unknown> as Promise<MemoryStoreView>)
  }

  createMemoryStore(
    params: { name: string; description?: string; metadata?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<MemoryStoreView> {
    return this.call(signal, () => this.sdk.memoryStores.create({
      name: params.name,
      ...params.description === undefined ? {} : { description: params.description },
      metadata: { ...params.metadata, source: 'dsh-qoder-bots' },
    }, post(signal)) as Promise<unknown> as Promise<MemoryStoreView>)
  }

  listMemories(memoryStoreId: string, signal?: AbortSignal): Promise<CursorPage<MemoryEntryView>> {
    return this.call(signal, async () => {
      const raw = await collect(this.sdk.memoryStores.memories.list(memoryStoreId, { limit: 100 }, { signal: signal ?? null }))
      const entries = raw
        .filter((item): item is Extract<typeof item, { id: string }> => typeof (item as { id?: unknown }).id === 'string')
        .map(item => item as unknown as MemoryEntryView)
      return { data: entries }
    })
  }

  getMemory(memoryStoreId: string, memoryId: string, signal?: AbortSignal): Promise<MemoryEntryView> {
    return this.call(signal, () => this.sdk.memoryStores.memories.retrieve(
      memoryId,
      { memory_store_id: memoryStoreId },
      { signal: signal ?? null },
    ) as Promise<unknown> as Promise<MemoryEntryView>)
  }

  createMemory(
    memoryStoreId: string,
    params: { path: string; content: string; metadata?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<MemoryEntryView> {
    return this.call(signal, () => this.sdk.memoryStores.memories.create(memoryStoreId, {
      path: params.path,
      content: params.content,
      ...params.metadata === undefined ? {} : { metadata: params.metadata },
    }, post(signal)) as Promise<unknown> as Promise<MemoryEntryView>)
  }

  updateMemory(
    memoryStoreId: string,
    memoryId: string,
    params: { content: string; contentSha256?: string },
    signal?: AbortSignal,
  ): Promise<MemoryEntryView> {
    return this.call(signal, () => this.sdk.memoryStores.memories.update(memoryId, {
      memory_store_id: memoryStoreId,
      content: params.content,
      ...params.contentSha256 === undefined ? {} : { content_sha256: params.contentSha256 },
    }, post(signal)) as Promise<unknown> as Promise<MemoryEntryView>)
  }

  deleteMemory(memoryStoreId: string, memoryId: string, signal?: AbortSignal): Promise<{ id: string }> {
    return this.call(signal, () => this.sdk.memoryStores.memories.delete(memoryId, {
      memory_store_id: memoryStoreId,
    }, post(signal)) as Promise<unknown> as Promise<{ id: string }>)
  }

  // --- Dreams (Memory Consolidation) ---

  createDream(body: CreateDreamRequest, signal?: AbortSignal): Promise<DreamView> {
    return this.call(signal, () => this.sdk.dreams.create(body, post(signal)) as Promise<unknown> as Promise<DreamView>)
  }

  getDream(id: string, signal?: AbortSignal): Promise<DreamView> {
    return this.call(signal, () => this.sdk.dreams.retrieve(id, {}, { signal: signal ?? null }) as Promise<unknown> as Promise<DreamView>)
  }

  listDreams(limit = 20, signal?: AbortSignal): Promise<CursorPage<DreamView>> {
    return this.call(signal, async () => {
      const out: DreamView[] = []
      for await (const item of this.sdk.dreams.list({ limit: Math.min(limit, 100) }, { signal: signal ?? null })) {
        out.push(item as unknown as DreamView)
        if (out.length >= limit) break
      }
      return { data: out }
    })
  }

  cancelDream(id: string, signal?: AbortSignal): Promise<DreamView> {
    return this.call(signal, () => this.sdk.dreams.cancel(id, {}, post(signal)) as Promise<unknown> as Promise<DreamView>)
  }

  archiveDream(id: string, signal?: AbortSignal): Promise<DreamView> {
    return this.call(signal, () => this.sdk.dreams.archive(id, {}, post(signal)) as Promise<unknown> as Promise<DreamView>)
  }

  // --- Files ---

  async uploadFile(
    params: { bytes: Uint8Array; filename: string; mimeType?: string },
    signal?: AbortSignal,
  ): Promise<FileView> {
    const uploadable = await toFile(
      params.bytes,
      params.filename,
      params.mimeType === undefined ? undefined : { type: params.mimeType },
    )
    return this.call(signal, () => this.sdk.files.upload({
      file: uploadable,
      name: params.filename,
    }, post(signal)) as Promise<unknown> as Promise<FileView>)
  }

  getFileMetadata(fileId: string, signal?: AbortSignal): Promise<FileView> {
    return this.call(signal, () => this.sdk.files.getMetadata(fileId, {}, { signal: signal ?? null }) as Promise<unknown> as Promise<FileView>)
  }

  async downloadFile(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.call(signal, () => this.sdk.files.download(fileId, {}, { signal: signal ?? null }))
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  // --- Deployments & Runs (24/7 Cloud Routines) ---

  listDeployments(
    params: { agentId?: string; status?: 'active' | 'paused' } = {},
    signal?: AbortSignal,
  ): Promise<CursorPage<DeploymentView>> {
    return this.call(signal, async () => ({
      data: await collect(this.sdk.deployments.list({
        limit: 100,
        ...params.agentId === undefined ? {} : { agent_id: params.agentId },
        ...params.status === undefined ? {} : { status: params.status },
      }, { signal: signal ?? null })) as unknown as DeploymentView[],
    }))
  }

  getDeployment(id: string, signal?: AbortSignal): Promise<DeploymentView> {
    return this.call(signal, () => this.sdk.deployments.retrieve(id, {}, { signal: signal ?? null }) as Promise<unknown> as Promise<DeploymentView>)
  }

  createDeployment(body: CreateDeploymentRequest, signal?: AbortSignal): Promise<DeploymentView> {
    return this.call(signal, () => this.sdk.deployments.create({
      ...body,
      metadata: { ...body.metadata, source: 'dsh-qoder-bots' },
    }, post(signal)) as Promise<unknown> as Promise<DeploymentView>)
  }

  updateDeployment(id: string, body: UpdateDeploymentRequest, signal?: AbortSignal): Promise<DeploymentView> {
    return this.call(signal, () => this.sdk.deployments.update(id, body, post(signal)) as Promise<unknown> as Promise<DeploymentView>)
  }

  pauseDeployment(id: string, signal?: AbortSignal): Promise<DeploymentView> {
    return this.call(signal, () => this.sdk.deployments.pause(id, {}, post(signal)) as Promise<unknown> as Promise<DeploymentView>)
  }

  unpauseDeployment(id: string, signal?: AbortSignal): Promise<DeploymentView> {
    return this.call(signal, () => this.sdk.deployments.unpause(id, {}, post(signal)) as Promise<unknown> as Promise<DeploymentView>)
  }

  archiveDeployment(id: string, signal?: AbortSignal): Promise<DeploymentView> {
    return this.call(signal, () => this.sdk.deployments.archive(id, {}, post(signal)) as Promise<unknown> as Promise<DeploymentView>)
  }

  runDeploymentNow(id: string, signal?: AbortSignal): Promise<DeploymentRunView> {
    return this.call(signal, () => this.sdk.deployments.run(id, {}, post(signal)) as Promise<unknown> as Promise<DeploymentView> as Promise<unknown> as Promise<DeploymentRunView>)
  }

  listDeploymentRuns(
    params: { deploymentId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<CursorPage<DeploymentRunView>> {
    return this.call(signal, async () => {
      const cap = params.limit ?? 20
      const out: DeploymentRunView[] = []
      const pageIter = this.sdk.deploymentRuns.list({
        limit: Math.min(cap, 100),
        ...params.deploymentId === undefined ? {} : { deployment_id: params.deploymentId },
      }, { signal: signal ?? null })
      for await (const item of pageIter) {
        out.push(item as unknown as DeploymentRunView)
        if (out.length >= cap) break
      }
      return { data: out }
    })
  }

  getDeploymentRun(runId: string, signal?: AbortSignal): Promise<DeploymentRunView> {
    return this.call(signal, () => this.sdk.deploymentRuns.retrieve(runId, {}, { signal: signal ?? null }) as Promise<unknown> as Promise<DeploymentRunView>)
  }

  // --- Sessions, Threads & Events ---

  listSessions(
    params: { agentId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<CursorPage<SessionView>> {
    return this.call(signal, async () => {
      const cap = params.limit ?? 20
      const out: SessionView[] = []
      const iter = this.sdk.sessions.list({
        limit: Math.min(cap, 100),
        ...params.agentId === undefined ? {} : { agent_id: params.agentId },
      }, { signal: signal ?? null })
      for await (const item of iter) {
        out.push(item as unknown as SessionView)
        if (out.length >= cap) break
      }
      return { data: out }
    })
  }

  createSession(body: CreateSessionRequest, signal?: AbortSignal): Promise<SessionView> {
    return this.call(signal, () => this.sdk.sessions.create({
      ...body,
      metadata: { ...body.metadata, source: 'dsh-qoder-bots' },
    }, post(signal)))
  }

  getSession(id: string, signal?: AbortSignal): Promise<SessionView> {
    return this.call(signal, () => this.sdk.sessions.retrieve(id, {}, { signal: signal ?? null }))
  }

  listSessionThreads(sessionId: string, signal?: AbortSignal): Promise<CursorPage<SessionThreadView>> {
    return this.call(signal, async () => ({
      data: await collect(this.sdk.sessions.threads.list(sessionId, { limit: 100 }, { signal: signal ?? null })) as unknown as SessionThreadView[],
    }))
  }

  listSessionEvents(sessionId: string, signal?: AbortSignal): Promise<CursorPage<SessionEvent>> {
    return this.call(signal, async () => ({
      data: await collect(this.sdk.sessions.events.list(sessionId, { limit: 100 }, { signal: signal ?? null })) as unknown as SessionEvent[],
    }))
  }

  addSessionFileResource(
    sessionId: string,
    params: { fileId: string; mountPath?: string },
    signal?: AbortSignal,
  ): Promise<{ id: string; file_id: string; mount_path?: string }> {
    return this.call(signal, () => this.sdk.sessions.resources.add(sessionId, {
      type: 'file',
      file_id: params.fileId,
      ...params.mountPath === undefined ? {} : { mount_path: params.mountPath },
    }, post(signal)) as Promise<unknown> as Promise<{ id: string; file_id: string; mount_path?: string }>)
  }

  sendEvents(id: string, events: readonly Record<string, unknown>[], signal?: AbortSignal): Promise<{ data: SessionEvent[] }> {
    return this.call(signal, async () => {
      const sent = await this.sdk.sessions.events.send(
        id,
        { events: events as unknown as ManagedAgentsEventParamsUnion[] },
        post(signal),
      )
      return { data: (sent.data ?? []) as unknown as SessionEvent[] }
    })
  }

  confirmSessionTool(
    sessionId: string,
    toolUseId: string,
    decision: 'allow' | 'deny',
    denyMessage?: string,
    signal?: AbortSignal,
  ): Promise<{ data: SessionEvent[] }> {
    return this.sendEvents(sessionId, [{
      type: 'user.tool_confirmation',
      tool_use_id: toolUseId,
      result: decision,
      ...decision === 'deny'
        ? { deny_message: denyMessage?.trim() || 'Rejected by user in DeepSeek Harness Qoder Bots.' }
        : {},
    }], signal)
  }

  cancelSession(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.call(signal, () => this.sdk.sessions.cancel(id, {}, post(signal)))
  }

  archiveSession(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.call(signal, () => this.sdk.sessions.archive(id, {}, post(signal)))
  }

  async *streamEvents(id: string, lastEventId: string | undefined, signal: AbortSignal): AsyncGenerator<SessionEvent> {
    const stream = await this.call(signal, () => this.sdk.sessions.events.streamEvents(
      id,
      lastEventId === undefined ? {} : { last_event_id: lastEventId },
      { signal, maxRetries: 0 },
    ))
    try {
      for await (const event of stream) {
        const view = event as unknown as SessionEvent
        yield { ...view, id: view.id ?? stream.lastEventID }
      }
    } catch (error: unknown) {
      throw failure(error, signal)
    } finally {
      await stream.close()
    }
  }

  private async call<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    try {
      return await run()
    } catch (error: unknown) {
      throw failure(error, signal)
    }
  }
}

function post(signal: AbortSignal | undefined): { signal: AbortSignal | null; idempotencyKey: string } {
  return { signal: signal ?? null, idempotencyKey: randomUUID() }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = []
  for await (const item of items) all.push(item)
  return all
}

function failure(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason
  if (!(error instanceof APIError) || error.status === undefined) return error
  return new QoderCloudError(error.status, error.type ?? 'api_error', error.message, error.request_id ?? undefined, { cause: error })
}

/** Abortable sleep. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
