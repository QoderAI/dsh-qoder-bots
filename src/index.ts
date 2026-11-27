/**
 * `dsh-qoder-bots` — Qoder Cloud Bot harness plugin for DeepSeek Harness.
 *
 * Pure Managed Mode (`/api/v1/cloud`) architecture:
 *   - Persistent persona Bots (`Agent` + dedicated `MemoryStore` auto-mounted
 *     in `read_write` mode across sessions and `@bot` delegations)
 *   - 7 built-in one-click Bot templates (`general-coder`, `code-reviewer`,
 *     `deep-researcher`, `data-analyst`, `field-monitor`, `incident-commander`,
 *     `structured-extractor`)
 *   - Multimodal Bot Mode (`QoderBotAdapter` on provider `qoder-bots`) with
 *     image & file attachment forwarding and artifact delivery rendering
 *   - Subagent provider (`qoder-bots` -> `subagent_qoder_bots` with `@bot`
 *     prefix support) + explicit typed `ask_qoder_bot` tool (`bot` parameter)
 *   - `/qoder-bot` slash command (`list`, `templates`, `create`, `use`,
 *     `memory`, `env`, `reset`)
 *
 * @module dsh-qoder-bots
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  assertUsableCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-llm'
import { createBotApiHandlers } from './api-routes.ts'
import {
  BotManager,
  DEFAULT_TEMPLATE_ID,
  SelectionRequiredError,
  type Asker,
  type BotProfile,
  type BotSelection,
} from './bot-manager.ts'
import {
  BOT_ACTIVE_MODEL,
  BOT_MODEL_PREFIX,
  BOT_PRESET_ID,
  BOT_PROVIDER,
  QoderBotAdapter,
  parseAdoptSessionDirective,
  splitBotHistory,
  type CustomToolHandler,
} from './bot-mode.ts'
import { API_BASE_PATH, BROWSER_TOOLSET, MANAGE_BOT_ROUTINE_TOOL } from './bot-constants.ts'
import { ASK_BOT_TOOL_NAME, createAskQoderBotTool } from './bot-tool.ts'
import {
  BotWorkspaceRunner,
  projectSessionEventsToMessages,
  type BotWorkspaceArtifact,
  type BotWorkspaceMessage,
  type BotWorkspaceStep,
} from './bot-workspace.ts'
import { DEFAULT_BASE_URL, QoderCloudClient, QoderCloudError } from './client.ts'
import { COMMAND_NAME, qoderBotCommand, splitCommandArgs } from './command.ts'
import { DreamManager } from './dreams.ts'
import { detectRepository, httpsRemote } from './git.ts'
import { LiveSessionTracker } from './live-tracker.ts'
import {
  MANAGE_BOT_ROUTINE_CUSTOM_TOOL,
  RoutineManager,
  validatePosixCron5,
} from './routines.ts'
import {
  DEFAULT_TIMEOUT_MS,
  parseLeadingBotDirective,
  prepareMultimodalContent,
  startQoderBotRun,
} from './run.ts'
import { BUILTIN_BOT_TEMPLATES, findBotTemplate, type BotTemplate } from './templates.ts'

export {
  API_BASE_PATH,
  ASK_BOT_TOOL_NAME,
  BOT_ACTIVE_MODEL,
  BOT_MODEL_PREFIX,
  BOT_PRESET_ID,
  BOT_PROVIDER,
  BROWSER_TOOLSET,
  BUILTIN_BOT_TEMPLATES,
  BotManager,
  BotWorkspaceRunner,
  COMMAND_NAME,
  DreamManager,
  LiveSessionTracker,
  MANAGE_BOT_ROUTINE_CUSTOM_TOOL,
  MANAGE_BOT_ROUTINE_TOOL,
  QoderBotAdapter,
  QoderCloudClient,
  QoderCloudError,
  RoutineManager,
  SelectionRequiredError,
  createBotApiHandlers,
  detectRepository,
  findBotTemplate,
  httpsRemote,
  parseAdoptSessionDirective,
  parseLeadingBotDirective,
  prepareMultimodalContent,
  projectSessionEventsToMessages,
  splitBotHistory,
  splitCommandArgs,
  validatePosixCron5,
  type BotProfile,
  type BotSelection,
  type BotTemplate,
  type BotWorkspaceArtifact,
  type BotWorkspaceMessage,
  type BotWorkspaceStep,
  type CustomToolHandler,
}

export const name = 'qoder-bots'
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'qoder-bots'
const DEFAULT_BOT_NAME = 'dsh-bot-coder'
const DEFAULT_ENTRY_ID = 'qoder-bots'
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface Config {
  /** Provider name on `ctx.subagents` (default `qoder-bots`). */
  providerName?: string
  /** Qoder Cloud Managed API base URL (default `https://api.qoder.com/api/v1/cloud`). */
  baseURL?: string
  /** Credential / environment variable holding the Qoder PAT (default `QODER_PAT`). */
  tokenEnv?: string
  /** Literal PAT; prefer {@link tokenEnv} so secrets stay out of config files. */
  token?: string
  /** Active Bot (`agent_…`); unset: uses default plugin bot or prompts interactively. Live-editable. */
  botId?: Volatile<string | undefined>
  /** Default name when provisioning the initial bot (default `dsh-bot-coder`). */
  defaultBotName?: string
  /** Default built-in template slug when provisioning the initial bot (default `general-coder`). */
  defaultTemplate?: string
  /** Cloud model ID for newly created bots (default `ultimate`). */
  model?: string
  /** Automatically create & mount a persistent `MemoryStore` for every managed bot (default `true`). */
  autoMemory?: boolean
  /** Cloud environment (`env_…`); unset: uses the sole cloud env or prompts interactively. Live-editable. */
  environmentId?: Volatile<string | undefined>
  /** `auto` mounts the workspace's git `origin` in the sandbox; `none` sends tasks without repo mount. */
  repository?: 'auto' | 'none'
  /** Credential / environment variable holding a git token for clone/push (default `QODER_GIT_TOKEN`). */
  gitTokenEnv?: string
  /** Account name on non-GitHub git hosts when authenticating with `gitTokenEnv`. */
  gitUsername?: string
  /** Prefix of the branch cloud bots push changes to (default `qoder-bots/`). */
  branchPrefix?: string
  /** Policy answer for tool calls paused by `always_ask` (default `allow`). */
  toolConfirmation?: 'allow' | 'deny'
  /** Extra sandbox environment variables injected into every bot session. */
  environmentVariables?: Record<string, string>
  /** Archive one-shot delegated sessions after turn completion (default `false`). */
  archiveOnFinish?: boolean
  /** Ceiling for one delegated bot turn in milliseconds (default 2 h). */
  timeoutMs?: number
  /** Extra gateway HTTP headers. */
  headers?: Record<string, string>
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  baseURL: z.string().min(1).default(DEFAULT_BASE_URL),
  tokenEnv: z.string().role('credential-ref').default('QODER_PAT'),
  token: z.string().role('secret'),
  botId: z.string().min(1).volatile(),
  defaultBotName: z.string().min(1).default(DEFAULT_BOT_NAME),
  defaultTemplate: z.string().min(1).default(DEFAULT_TEMPLATE_ID),
  model: z.string().min(1).default('ultimate'),
  autoMemory: z.boolean().default(true),
  environmentId: z.string().min(1).volatile(),
  repository: z.union(['auto', 'none'] as const).default('auto'),
  gitTokenEnv: z.string().role('credential-ref').default('QODER_GIT_TOKEN'),
  gitUsername: z.string().min(1),
  branchPrefix: z.string().min(1).default('qoder-bots/'),
  toolConfirmation: z.union(['allow', 'deny'] as const).default('allow'),
  environmentVariables: z.dict(z.string()).default({}),
  archiveOnFinish: z.boolean().default(false),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  headers: z.dict(z.string()).default({}),
}) as z<Config>

type ResolvedConfig = Required<Omit<Config, 'token' | 'botId' | 'environmentId' | 'gitUsername'>>
  & Pick<Config, 'token' | 'botId' | 'environmentId' | 'gitUsername'>

async function resolveSecret(ctx: Context, key: string): Promise<string | undefined> {
  const ref = credentialRef(key)
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = (await credentials.resolve(ref))?.value
    if (hit !== undefined && hit.length > 0) return hit
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)?.value
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}

function live(value: Volatile<string | undefined> | string | undefined): string | undefined {
  if (value === undefined || typeof value === 'string') return value
  return value.get()
}

function sessionCwd(ctx: Context, session: unknown): string | undefined {
  const service = (ctx as unknown as { get(name: string): unknown }).get('workingDirectory') as
    { get?(session: unknown): unknown } | undefined
  const fromService = service?.get?.(session)
  if (typeof fromService === 'string') return fromService
  const header = (session as { header?: { cwd?: unknown } }).header
  return typeof header?.cwd === 'string' ? header.cwd : undefined
}

function agentCwd(ctx: Context, callerAgent: unknown): string {
  const session = (callerAgent as { session?: unknown } | undefined)?.session
  return (session === undefined ? undefined : sessionCwd(ctx, session)) ?? process.cwd()
}

function requestCwd(ctx: Context, request: ResolvedSubagentStartRequest): string {
  const explicit = (request as { cwd?: unknown }).cwd
  if (typeof explicit === 'string') return explicit
  return agentCwd(ctx, request.parent)
}

function attachmentsOf(ctx: Context): AttachmentStore | undefined {
  return (ctx as unknown as { get(name: string): AttachmentStore | undefined }).get('attachments')
}

class QoderBotsSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly manager: BotManager,
    private readonly client: () => Promise<QoderCloudClient | string>,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const cwd = assertUsableCwd('qoder-bots', 'child cwd', requestCwd(this.ctx, request))
    const client = await this.client()
    if (typeof client === 'string') throw new Error(`qoder-bots: ${client}`)
    const questions = this.ctx.get('userQuestions')
    const asker: Asker | undefined = questions === undefined
      ? undefined
      : (items, signal) => questions.ask({ agent: request.parent, signal, questions: items })
    const gitToken = this.config.repository === 'auto'
      ? await resolveSecret(this.ctx, this.config.gitTokenEnv)
      : undefined

    return startQoderBotRun({
      cwd,
      prompt: request.prompt,
      label: request.label,
      signal: request.signal,
    }, {
      client,
      resolveTarget: (signal, explicitBot) => this.manager.resolve(client, asker, signal, explicitBot),
      attachments: attachmentsOf(this.ctx),
      repository: this.config.repository,
      gitToken,
      gitTokenEnv: this.config.gitTokenEnv,
      gitUsername: this.config.gitUsername,
      branchPrefix: this.config.branchPrefix,
      toolConfirmation: this.config.toolConfirmation,
      environmentVariables: this.config.environmentVariables,
      archiveOnFinish: this.config.archiveOnFinish,
      timeoutMs: this.config.timeoutMs,
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`qoder-bots "${this.name}": delegated run failed (${stopReason}): %o`, error)
      },
    })
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('qoder-bots', 'timeoutMs', resolved.timeoutMs)
  if (resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`qoder-bots: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  try {
    new URL(resolved.baseURL)
  } catch {
    throw new Error(`qoder-bots: baseURL is not a valid URL: ${resolved.baseURL}`)
  }

  const loaderEntryId = (ctx.fiber as { entry?: { options?: { id?: string } } }).entry?.options?.id
  const entryId = loaderEntryId ?? DEFAULT_ENTRY_ID

  const configured = (): BotSelection => ({
    environmentId: live(resolved.environmentId),
    botId: live(resolved.botId),
  })

  const persist = async (selection: BotSelection): Promise<boolean> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return false
    const ops = Object.entries(selection).map(([key, value]) => value === undefined
      ? { op: 'unset' as const, path: [key] }
      : { op: 'set' as const, path: [key], value })
    if (ops.length === 0) return true
    try {
      if (!settings.describe().some(form => form.ns === entryId)) return false
      await settings.mutate(entryId, ops)
      return true
    } catch (error: unknown) {
      ctx.logger.warn('qoder-bots: could not save selection to profile: %o', error)
      return false
    }
  }

  const client = async (): Promise<QoderCloudClient | string> => {
    const token = resolved.token ?? await resolveSecret(ctx, resolved.tokenEnv)
    if (token === undefined) {
      return `no Qoder PAT — set ${resolved.tokenEnv} (environment, ~/.dsh/.env, or dsh credentials)`
    }
    return new QoderCloudClient({ baseURL: resolved.baseURL, token, headers: resolved.headers })
  }

  const manager = new BotManager({
    configured,
    defaultBotName: resolved.defaultBotName,
    defaultTemplateId: resolved.defaultTemplate,
    defaultModel: resolved.model,
    autoMemory: resolved.autoMemory,
    entryId,
    persist,
  })

  const routines = new RoutineManager({
    manager,
    repositoryMode: resolved.repository,
    gitToken: () => resolveSecret(ctx, resolved.gitTokenEnv),
    gitTokenEnv: resolved.gitTokenEnv,
    gitUsername: resolved.gitUsername,
    environmentVariables: resolved.environmentVariables,
  })

  const dreams = new DreamManager(manager)
  const tracker = new LiveSessionTracker()
  const workspace = new BotWorkspaceRunner({
    client,
    manager,
    tracker,
    toolConfirmation: resolved.toolConfirmation,
    customToolHandler: async (call, sig) => {
      const c = await client()
      if (typeof c === 'string') return { text: c, isError: true }
      return routines.handleCustomToolCall(c, call, process.cwd(), sig)
    },
  })
  const api = createBotApiHandlers({
    baseURL: resolved.baseURL,
    client,
    manager,
    routines,
    dreams,
    tracker,
    workspace,
    persist,
    cwd: () => process.cwd(),
  })

  // 1. Register `qoder-bots` subagent provider (supports `@<bot>` prefix in delegated prompts)
  const provider = new QoderBotsSubagentProvider(resolved.providerName, ctx, resolved, manager, client)
  ctx.subagents.registerProvider(provider)

  // 2. Register Host HTTP API & File Streaming routes (`/api/qoder-bots/*`) on `ctx.connection.fetch`
  ctx.inject(['connection'], (scope) => {
    const conn = (scope as unknown as {
      connection: {
        fetch: {
          register(route: {
            path: string
            methods: readonly ('GET' | 'HEAD' | 'POST')[]
            requestBody: 'buffered' | 'streaming'
            fetch: (req: Request) => Promise<Response>
          }): () => Promise<void>
        }
      }
    }).connection

    conn.fetch.register({
      path: api.paths.dashboard,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: api.handleDashboard,
    })
    conn.fetch.register({
      path: api.paths.computer,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: api.handleComputerStatus,
    })
    conn.fetch.register({
      path: api.paths.action,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: api.handleAction,
    })
    conn.fetch.register({
      path: api.paths.file,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: api.handleFileFetch,
    })
  })

  // 3. Register named `ask_qoder_bot` tool onto `ctx.tools` when mounted
  ctx.inject(['tools'], (scope) => {
    const tool = createAskQoderBotTool({
      runDelegation: async ({ bot, task, callerAgent, signal }) => {
        const cwd = assertUsableCwd('qoder-bots', 'tool cwd', agentCwd(scope, callerAgent))
        const c = await client()
        if (typeof c === 'string') throw new Error(`qoder-bots: ${c}`)
        const questions = scope.get('userQuestions')
        const asker: Asker | undefined = questions === undefined || callerAgent === undefined
          ? undefined
          : (items, sig) => questions.ask({ agent: callerAgent as never, signal: sig, questions: items })
        const gitToken = resolved.repository === 'auto'
          ? await resolveSecret(scope, resolved.gitTokenEnv)
          : undefined
        const handle = await startQoderBotRun({
          cwd,
          prompt: [{ type: 'text', text: task }],
          bot,
          signal,
        }, {
          client: c,
          resolveTarget: (sig, explicitBot) => manager.resolve(c, asker, sig, explicitBot),
          attachments: attachmentsOf(scope),
          repository: resolved.repository,
          gitToken,
          gitTokenEnv: resolved.gitTokenEnv,
          gitUsername: resolved.gitUsername,
          branchPrefix: resolved.branchPrefix,
          toolConfirmation: resolved.toolConfirmation,
          environmentVariables: resolved.environmentVariables,
          archiveOnFinish: resolved.archiveOnFinish,
          timeoutMs: resolved.timeoutMs,
        })
        try {
          const res = await handle.result
          const text = res.output
            .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
            .map(b => b.text)
            .join('\n')
          if (res.stopReason === 'error') {
            throw new Error(res.diagnostic ?? (text || 'Qoder Bot run failed'))
          }
          return { text: text || '(no output)', stopReason: res.stopReason }
        } finally {
          await handle.dispose()
        }
      },
    })
    scope.tools.register(tool)
  })

  // 4. Inject Bot Persona + Cloud Memory Store into LOCAL DSH sessions bound via `openLocalBot`!
  ctx.inject(['systemPrompt'], (scope) => {
    ;(scope as unknown as {
      on(
        event: 'system-prompt/assemble',
        listener: (assembly: any, context: any, next: () => Promise<any>) => Promise<any>,
      ): void
    }).on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      const sid = context?.agent?.session?.id as string | undefined
      const localBind = tracker.getLocalBotBinding(sid)
      if (localBind === undefined) return assembly

      const c = await client()
      if (typeof c === 'string') return assembly
      try {
        const sig = context?.signal ?? AbortSignal.timeout(5_000)
        const agentView = await c.getAgent(localBind.botId, sig)
        const memStoreId = agentView.metadata?.dsh_memory_store_id
        let memText = ''
        if (memStoreId) {
          const entries = (await c.listMemories(memStoreId, sig).catch(() => ({ data: [] }))).data.slice(0, 6)
          const loaded = await Promise.all(
            entries.map(e => c.getMemory(memStoreId, e.id, sig).catch(() => e)),
          )
          if (loaded.length > 0) {
            memText = [
              `### Persistent Bot Memory (${memStoreId})`,
              ...loaded.map(m => `#### ${m.path}\n${m.content ?? ''}`),
            ].join('\n\n')
          }
        }
        const localBotBlock = [
          `## Active Bot Identity (Local Execution Mode): ${localBind.botAvatar} ${agentView.name} (${agentView.id})`,
          'You are currently operating in **Local Execution Mode** directly on the user\'s local machine and workspace using DeepSeek Harness local tools (`bash`, `read`, `write`, `edit`, etc.).',
          'At the same time, you retain your Bot persona, persistent Qoder Cloud Memory Store context below, and can delegate heavy cloud/browser subtasks to Qoder Cloud Agents anytime via `ask_qoder_bot` or `subagent_qoder_bots`.',
          agentView.system ? `### Bot Persona & Instructions\n${agentView.system}` : '',
          memText,
        ].filter(Boolean).join('\n\n')

        assembly.contexts.push({
          name: 'qoder-bots:local-bot-context',
          text: localBotBlock,
          interpolate: false,
        })
      } catch {
        // Non-fatal if offline: proceed with standard local prompt
      }
      return assembly
    })
  })

  // 4. Register `/qoder-bot` interactive slash command
  ctx.inject(['commands'], (scope) => {
    scope.commands.register(qoderBotCommand({
      baseURL: resolved.baseURL,
      client,
      manager,
      routines,
      dreams,
      persist,
      defaultBotName: resolved.defaultBotName,
      cwd: () => process.cwd(),
    }))
  })
}
