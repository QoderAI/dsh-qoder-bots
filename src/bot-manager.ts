/**
 * Bot lifecycle, environment resolution, and persistent Memory Store binding.
 *
 * A "Bot" in pure Managed Mode (`/api/v1/cloud`) is a Qoder Cloud `Agent`
 * tagged with `metadata.dsh_bot = "true"` and paired with its own cloud
 * `MemoryStore` (`metadata.dsh_memory_store_id = "memstore_..."`). Every
 * session started for that Bot automatically attaches its Memory Store in
 * `read_write` mode so the bot remembers context across conversations,
 * machines, and delegated @bot tasks.
 *
 * @module dsh-qoder-bots/bot-manager
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import {
  BOT_META_APPROVAL_MODE,
  BOT_META_AVATAR,
  BOT_META_BROWSER_ENABLED,
  BOT_META_DEDICATED_ENV_ID,
  BOT_META_DEFAULT_RUNTIME,
  BOT_META_FLAG,
  BOT_META_LAST_DREAM_ID,
  BOT_META_MEMORY_STORE_ID,
  BOT_META_PREV_MEMORY_STORE_ID,
  BOT_META_PRIMARY_SESSION_ID,
  BOT_META_TEAM_FLAG,
  BOT_META_TEAM_MEMBERS,
  BOT_META_TEMPLATE,
  BOT_META_VAULT_IDS,
  BROWSER_TOOLSET,
  MANAGE_BOT_ROUTINE_TOOL,
} from './bot-constants.ts'
import {
  AGENT_TOOLSET,
  type AgentView,
  type CreateAgentRequest,
  type EnvironmentView,
  type MemoryEntryView,
  type MemoryStoreView,
  type QoderCloudClient,
  type SessionResource,
  type SessionView,
  type UpdateAgentRequest,
} from './client.ts'
import {
  MANAGE_BOT_ROUTINE_CUSTOM_TOOL,
  ROUTINE_SYSTEM_INSTRUCTIONS,
} from './routines.ts'
import {
  BROWSER_LIVE_INSTRUCTIONS,
  BUILTIN_BOT_TEMPLATES,
  MEMORY_AWARENESS_INSTRUCTIONS,
  findBotTemplate,
  type BotTemplate,
} from './templates.ts'

/** Default environment name created when an account has none. */
export const DEFAULT_ENVIRONMENT_NAME = 'dsh-bots-default'

/** Default bot template used when auto-provisioning the first bot. */
export const DEFAULT_TEMPLATE_ID = 'general-coder'

const ENVIRONMENT_QUESTION = 'qoder-bots-environment'
const BOT_QUESTION = 'qoder-bots-bot'
const MAX_BOT_OPTIONS = 20

/** Ask the human; rejects with a `code`-carrying error when nobody can answer. */
export type Asker = (questions: AskUserQuestionItem[], signal: AbortSignal) => Promise<AskUserQuestionAnswer>

/** Fields persisted into this plugin's profile entry. */
export interface BotSelection {
  environmentId?: string | undefined
  botId?: string | undefined
}

/** Enriched view of a Qoder Cloud Agent acting as a persistent Bot or Multi-Bot Team. */
export interface BotProfile {
  readonly id: string
  readonly name: string
  readonly avatar: string
  readonly description: string
  readonly model: string
  readonly templateId?: string
  readonly memoryStoreId?: string
  readonly previousMemoryStoreId?: string
  readonly lastDreamId?: string
  readonly primarySessionId?: string
  readonly dedicatedEnvId?: string
  readonly defaultRuntime: 'local' | 'cloud'
  readonly approvalMode: 'auto' | 'gated'
  readonly browserEnabled: boolean
  readonly vaultIds: readonly string[]
  readonly skillIds: readonly string[]
  readonly isManagedBot: boolean
  readonly isTeam: boolean
  readonly teamMemberIds?: readonly string[]
  readonly version?: number
}

/** Resolved execution target for one Bot session or delegated run. */
export interface ResolvedBotTarget {
  readonly bot: BotProfile
  readonly environmentId: string
  readonly memoryResource?: SessionResource
  readonly notes: readonly string[]
}

export interface BotManagerOptions {
  readonly configured: () => BotSelection
  readonly defaultBotName: string
  readonly defaultTemplateId: string
  readonly defaultModel: string
  readonly autoMemory: boolean
  readonly entryId: string
  readonly persist: (selection: BotSelection) => Promise<boolean>
}

export interface CreateBotInput {
  readonly name?: string | undefined
  readonly templateId?: string | undefined
  readonly model?: string | undefined
  readonly description?: string | undefined
  readonly system?: string | undefined
  readonly avatar?: string | undefined
  readonly withMemory?: boolean | undefined
  readonly defaultRuntime?: 'local' | 'cloud' | undefined
  readonly approvalMode?: 'auto' | 'gated' | undefined
  readonly browserEnabled?: boolean | undefined
  readonly dedicatedEnvId?: string | undefined
  readonly vaultIds?: readonly string[] | undefined
  readonly skillIds?: readonly string[] | undefined
}

export interface UpdateBotConfigInput {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly model?: string | undefined
  readonly defaultRuntime?: 'local' | 'cloud' | undefined
  readonly approvalMode?: 'auto' | 'gated' | undefined
  readonly browserEnabled?: boolean | undefined
  readonly dedicatedEnvId?: string | undefined
  readonly vaultIds?: readonly string[] | undefined
  readonly skillIds?: readonly string[] | undefined
  readonly primarySessionId?: string | null | undefined
}

export interface CreateTeamInput {
  readonly name: string
  /** Member bot IDs, names, or built-in template slugs (auto-provisioned if needed!). */
  readonly members: readonly string[]
  readonly model?: string | undefined
  /** Optional Advisor model ID (e.g. `ultimate`); pass `false` to omit Advisor. */
  readonly advisorModel?: string | false | undefined
  readonly includeSelf?: boolean | undefined
  readonly description?: string | undefined
  readonly system?: string | undefined
  readonly withMemory?: boolean | undefined
}

const UNANSWERABLE = new Set(['NO_PROVIDER', 'DELEGATED_CALLER', 'CALLER_NOT_LIVE'])

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function active<T extends { archived_at?: string | null }>(items: readonly T[]): T[] {
  return items.filter(item => !item.archived_at)
}

function isManagedCloud(env: EnvironmentView): boolean {
  return env.config?.type !== 'self_hosted'
}

export function isSharedCloudComputer(env: EnvironmentView | null | undefined): boolean {
  return Boolean(env && env.config?.type !== 'self_hosted' && env.config?.runtime_mode === 'shared')
}

export function desktopSlotIdForBot(botId: string): string {
  const clean = botId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96)
  return clean.startsWith('bot_') ? clean : `bot_${clean.replace(/^agent_/, '')}`
}

export function modelIdOf(model: unknown): string {
  if (typeof model === 'string' && model.length > 0) return model
  if (typeof model === 'object' && model !== null && typeof (model as { id?: unknown }).id === 'string') {
    return (model as { id: string }).id
  }
  return 'ultimate'
}

export function toBotProfile(agent: AgentView): BotProfile {
  const meta = agent.metadata ?? {}
  const templateId = meta[BOT_META_TEMPLATE]
  const tpl = templateId === undefined ? undefined : findBotTemplate(templateId)
  const isTeam = meta[BOT_META_TEAM_FLAG] === 'true' || agent.multiagent?.type === 'coordinator'
  const avatar = meta[BOT_META_AVATAR] ?? (isTeam ? '👥' : (tpl?.avatar ?? '🤖'))
  const memoryStoreId = meta[BOT_META_MEMORY_STORE_ID]
  const previousMemoryStoreId = meta[BOT_META_PREV_MEMORY_STORE_ID]
  const lastDreamId = meta[BOT_META_LAST_DREAM_ID]
  const primarySessionId = meta[BOT_META_PRIMARY_SESSION_ID]
  const dedicatedEnvId = meta[BOT_META_DEDICATED_ENV_ID]
  const defaultRuntime: 'local' | 'cloud' = !isTeam && meta[BOT_META_DEFAULT_RUNTIME] === 'local' ? 'local' : 'cloud'
  const approvalMode: 'auto' | 'gated' = meta[BOT_META_APPROVAL_MODE] === 'gated' ? 'gated' : 'auto'
  const hasBrowserToolset = (agent.tools ?? []).some(t => t.type === BROWSER_TOOLSET)
  const browserEnabled = meta[BOT_META_BROWSER_ENABLED] === 'false'
    ? false
    : (hasBrowserToolset || meta[BOT_META_BROWSER_ENABLED] === 'true')
  const vaultIds = meta[BOT_META_VAULT_IDS]?.split(',').map(s => s.trim()).filter(Boolean) ?? []
  const skillIds = (agent.skills ?? []).map(s => s.skill_id).filter(Boolean)
  const memberIdsFromMulti = (agent.multiagent?.agents ?? [])
    .filter(entry => entry.type === 'agent' && typeof entry.id === 'string')
    .map(entry => entry.id!)
  const memberIdsFromMeta = meta[BOT_META_TEAM_MEMBERS]?.split(',').map(s => s.trim()).filter(Boolean) ?? []
  const teamMemberIds = memberIdsFromMulti.length > 0 ? memberIdsFromMulti : memberIdsFromMeta

  return {
    id: agent.id,
    name: agent.name,
    avatar,
    description: agent.description ?? tpl?.description ?? '',
    model: modelIdOf(agent.model),
    ...templateId !== undefined ? { templateId } : {},
    ...memoryStoreId !== undefined && memoryStoreId.length > 0 ? { memoryStoreId } : {},
    ...previousMemoryStoreId !== undefined && previousMemoryStoreId.length > 0 ? { previousMemoryStoreId } : {},
    ...lastDreamId !== undefined && lastDreamId.length > 0 ? { lastDreamId } : {},
    ...primarySessionId !== undefined && primarySessionId.length > 0 ? { primarySessionId } : {},
    ...dedicatedEnvId !== undefined && dedicatedEnvId.length > 0 ? { dedicatedEnvId } : {},
    defaultRuntime,
    approvalMode,
    browserEnabled,
    vaultIds,
    skillIds,
    isManagedBot: meta[BOT_META_FLAG] === 'true',
    isTeam,
    ...teamMemberIds.length > 0 ? { teamMemberIds } : {},
    ...agent.version !== undefined ? { version: agent.version } : {},
  }
}

function buildBotTools(options: {
  enabledTools?: readonly string[] | undefined
  approvalMode: 'auto' | 'gated'
  browserEnabled: boolean
}): NonNullable<CreateAgentRequest['tools']> {
  const gatedConfigs = options.approvalMode === 'gated'
    ? [
        { name: 'Bash', permission_policy: { type: 'always_ask' } },
        { name: 'Write', permission_policy: { type: 'always_ask' } },
        { name: 'Edit', permission_policy: { type: 'always_ask' } },
      ]
    : undefined
  const agentToolset: Record<string, unknown> = {
    type: AGENT_TOOLSET,
    ...options.enabledTools !== undefined && options.enabledTools.length > 0
      ? { enabled_tools: [...options.enabledTools] }
      : {},
    ...gatedConfigs !== undefined
      ? {
          default_config: { permission_policy: { type: 'always_allow' } },
          configs: gatedConfigs,
        }
      : {},
  }
  const list: Record<string, unknown>[] = [agentToolset]
  if (options.browserEnabled) {
    list.push({ type: BROWSER_TOOLSET })
  }
  list.push(MANAGE_BOT_ROUTINE_CUSTOM_TOOL)
  return list as unknown as NonNullable<CreateAgentRequest['tools']>
}

export function describeEnvironment(env: EnvironmentView): string {
  const config = (env.config ?? {}) as {
    type?: string
    runtime_mode?: string
    idle_timeout_seconds?: number
    networking?: { type?: string }
    packages?: Record<string, unknown>
    setup_script?: unknown
  }
  if (config.type === 'self_hosted') {
    return `self-hosted (BYOC) · runs on your own workers${config.setup_script !== undefined ? ' · setup script' : ''}`
  }
  const parts: string[] = [
    config.runtime_mode === 'shared'
      ? `cloud computer (persistent shared desktop${config.idle_timeout_seconds ? `, idle ${Math.round(config.idle_timeout_seconds / 60)}m` : ''})`
      : (config.type ?? 'cloud'),
  ]
  const packages = Object.entries(config.packages ?? {})
    .filter(([, list]) => Array.isArray(list) && list.length > 0)
    .map(([manager, list]) => `${manager}: ${(list as unknown[]).slice(0, 4).join(', ')}${(list as unknown[]).length > 4 ? ', …' : ''}`)
  parts.push(packages.length > 0 ? packages.join('; ') : 'no extra packages')
  if (config.networking?.type !== undefined) parts.push(`network ${config.networking.type}`)
  if (config.setup_script !== undefined) parts.push('setup script')
  return parts.join(' · ')
}

/**
 * Match free text (id, exact name, or unique case-insensitive name/slug) against items.
 */
export function matchByIdOrName<T extends { id: string; name: string }>(
  items: readonly T[],
  text: string,
  kind: string,
): T | string {
  const needle = text.trim()
  const byId = items.find(item => item.id === needle)
  if (byId !== undefined) return byId
  const exact = items.filter(item => item.name === needle)
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) {
    return `several ${kind}s are named "${needle}"; use the id (${exact.map(item => item.id).join(', ')})`
  }
  const lower = needle.toLowerCase()
  const ci = items.filter(item =>
    item.name.toLowerCase() === lower
    || item.name.toLowerCase() === `dsh-bot-${lower}`,
  )
  if (ci.length === 1) return ci[0]!
  if (ci.length > 1) {
    return `several ${kind}s match "${needle}"; use the id (${ci.map(item => item.id).join(', ')})`
  }
  return `no active ${kind} matches "${needle}"`
}

export class SelectionRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectionRequiredError'
  }
}

function ambiguousEnvironment(candidates: readonly EnvironmentView[], entryId: string, reason: string): SelectionRequiredError {
  const lines = [
    candidates.length === 1
      ? `qoder-bots: the only Qoder Cloud environment is self-hosted (BYOC) and ${reason}.`
      : `qoder-bots: ${candidates.length} Qoder Cloud environments are available and ${reason}.`,
    'Choose one with `/qoder-bot env <id>` in an interactive dsh session, or set it in the profile patch:',
    '',
    `- id: ${entryId}`,
    '  config:',
    `    environmentId: ${candidates[0]?.id ?? 'env_…'}`,
    '',
    'Candidates:',
    ...candidates.map(env => `  ${env.id}  ${env.name}  (${describeEnvironment(env)})`),
  ]
  return new SelectionRequiredError(lines.join('\n'))
}

const environmentLabel = (env: EnvironmentView): string => `${env.name} · ${env.id}`
const botLabel = (bot: BotProfile): string => `${bot.avatar} ${bot.name} · ${bot.id}`

type EnvironmentPlan =
  | { kind: 'use'; env: EnvironmentView; why: string }
  | { kind: 'create' }
  | { kind: 'ask'; candidates: EnvironmentView[]; all: EnvironmentView[] }

type BotPlan =
  | { kind: 'use'; bot: BotProfile; why: string }
  | { kind: 'create'; template: BotTemplate }
  | { kind: 'ask'; candidates: BotProfile[]; all: BotProfile[]; defaultTemplate: BotTemplate }

export class BotManager {
  private memo: BotSelection = {}
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: BotManagerOptions) {}

  forget(): void {
    this.memo = {}
  }

  remember(selection: BotSelection): void {
    this.memo = { ...this.memo, ...selection }
  }

  currentSelection(): BotSelection {
    const cfg = this.options.configured()
    return {
      environmentId: cfg.environmentId ?? this.memo.environmentId,
      botId: cfg.botId ?? this.memo.botId,
    }
  }

  /** List all active Qoder Cloud Agents projected as BotProfiles (managed bots first). */
  async listBots(client: QoderCloudClient, signal?: AbortSignal): Promise<BotProfile[]> {
    const agents = active((await client.listAgents(signal)).data).map(toBotProfile)
    return [
      ...agents.filter(b => b.isManagedBot),
      ...agents.filter(b => !b.isManagedBot),
    ]
  }

  /**
   * Create a new Bot (Agent + dedicated persistent Memory Store) from a template
   * or custom fields. If an active bot with the exact target name already exists,
   * returns it after ensuring its memory store is attached when `withMemory` is on.
   */
  async createBot(
    client: QoderCloudClient,
    input: CreateBotInput = {},
    signal?: AbortSignal,
  ): Promise<BotProfile> {
    const tpl = input.templateId !== undefined
      ? findBotTemplate(input.templateId)
      : (findBotTemplate(this.options.defaultTemplateId) ?? BUILTIN_BOT_TEMPLATES[0]!)
    if (input.templateId !== undefined && tpl === undefined) {
      const valid = BUILTIN_BOT_TEMPLATES.map(t => t.id).join(', ')
      throw new Error(`qoder-bots: unknown template "${input.templateId}" (available: ${valid})`)
    }
    const name = (input.name?.trim() || tpl?.defaultName || this.options.defaultBotName).slice(0, 64)
    const existing = active((await client.listAgents(signal)).data).find(a => a.name === name)
    if (existing !== undefined) {
      const profile = toBotProfile(existing)
      if ((input.withMemory ?? this.options.autoMemory) && profile.memoryStoreId === undefined) {
        return this.ensureBotMemoryStore(client, profile.id, signal)
      }
      return profile
    }

    const wantMemory = input.withMemory ?? this.options.autoMemory
    let memoryStore: MemoryStoreView | undefined
    if (wantMemory) {
      memoryStore = await client.createMemoryStore({
        name: `${name}-memory`,
        description: `Persistent memory store for Qoder Bot "${name}"`,
        metadata: { [BOT_META_FLAG]: 'true', bot_name: name },
      }, signal)
      const seed = tpl?.initialMemory
      if (seed !== undefined && seed.trim().length > 0) {
        await client.createMemory(memoryStore.id, {
          path: 'README.md',
          content: seed,
        }, signal).catch(() => {
          // Best-effort seed: an empty store is still completely usable.
        })
      }
    }

    const defaultRuntime: 'local' | 'cloud' = input.defaultRuntime === 'local' ? 'local' : 'cloud'
    const approvalMode: 'auto' | 'gated' = input.approvalMode === 'gated' ? 'gated' : 'auto'
    const browserEnabled = input.browserEnabled !== false
    const vaultIds = (input.vaultIds ?? []).map(s => s.trim()).filter(Boolean)
    const skillIds = (input.skillIds ?? []).map(s => s.trim()).filter(Boolean)

    const baseSystem = input.system ?? tpl?.system ?? 'You are a helpful Qoder Bot.'
    const systemSections = [baseSystem]
    if (wantMemory) systemSections.push(MEMORY_AWARENESS_INSTRUCTIONS)
    if (browserEnabled) systemSections.push(BROWSER_LIVE_INSTRUCTIONS)
    systemSections.push(ROUTINE_SYSTEM_INSTRUCTIONS)
    const fullSystem = systemSections.join('\n\n')
    const avatar = input.avatar ?? tpl?.avatar ?? '🤖'
    const description = input.description ?? tpl?.description ?? 'Managed by DeepSeek Harness dsh-qoder-bots'
    const model = input.model ?? this.options.defaultModel

    const metadata: Record<string, string> = {
      [BOT_META_FLAG]: 'true',
      [BOT_META_AVATAR]: avatar,
      [BOT_META_DEFAULT_RUNTIME]: defaultRuntime,
      [BOT_META_APPROVAL_MODE]: approvalMode,
      [BOT_META_BROWSER_ENABLED]: browserEnabled ? 'true' : 'false',
      ...tpl !== undefined ? { [BOT_META_TEMPLATE]: tpl.id } : {},
      ...memoryStore !== undefined ? { [BOT_META_MEMORY_STORE_ID]: memoryStore.id } : {},
      ...input.dedicatedEnvId ? { [BOT_META_DEDICATED_ENV_ID]: input.dedicatedEnvId } : {},
      ...vaultIds.length > 0 ? { [BOT_META_VAULT_IDS]: vaultIds.join(',') } : {},
    }

    const skillsPayload = skillIds.length > 0
      ? skillIds.map(id => ({ type: 'custom' as const, skill_id: id }))
      : undefined

    let created: AgentView
    try {
      created = await client.createAgent({
        name,
        model,
        description,
        system: fullSystem,
        tools: buildBotTools({ enabledTools: tpl?.enabledTools, approvalMode, browserEnabled }),
        ...skillsPayload !== undefined ? { skills: skillsPayload } : {},
        metadata,
      }, signal)
    } catch (error: unknown) {
      // Graceful fallback if an older/BYOC gateway rejects `browser_toolset_20260714`
      if (browserEnabled && String(error).includes(BROWSER_TOOLSET)) {
        created = await client.createAgent({
          name,
          model,
          description,
          system: fullSystem,
          tools: buildBotTools({ enabledTools: tpl?.enabledTools, approvalMode, browserEnabled: false }),
          ...skillsPayload !== undefined ? { skills: skillsPayload } : {},
          metadata: { ...metadata, [BOT_META_BROWSER_ENABLED]: 'false' },
        }, signal)
      } else {
        throw error
      }
    }

    return toBotProfile(created)
  }

  /**
   * Update a Managed Bot's configuration (name, description, model, approval gate,
   * cloud browser toolset, dedicated environment, Vaults, Skills, or primary session).
   */
  async updateBotConfig(
    client: QoderCloudClient,
    botId: string,
    patch: UpdateBotConfigInput,
    signal?: AbortSignal,
  ): Promise<BotProfile> {
    const agent = await client.getAgent(botId, signal)
    const current = toBotProfile(agent)
    const nextRuntime = current.isTeam ? 'cloud' : (patch.defaultRuntime ?? current.defaultRuntime)
    const nextApproval = patch.approvalMode ?? current.approvalMode
    const nextBrowser = patch.browserEnabled ?? current.browserEnabled
    const nextVaults = patch.vaultIds ?? current.vaultIds
    const nextSkills = patch.skillIds ?? current.skillIds
    const tpl = current.templateId ? findBotTemplate(current.templateId) : undefined

    const nextMeta: Record<string, string> = {
      ...agent.metadata,
      [BOT_META_FLAG]: 'true',
      [BOT_META_DEFAULT_RUNTIME]: nextRuntime,
      [BOT_META_APPROVAL_MODE]: nextApproval,
      [BOT_META_BROWSER_ENABLED]: nextBrowser ? 'true' : 'false',
    }
    if (patch.dedicatedEnvId !== undefined) {
      if (patch.dedicatedEnvId.trim().length > 0) nextMeta[BOT_META_DEDICATED_ENV_ID] = patch.dedicatedEnvId.trim()
      else delete nextMeta[BOT_META_DEDICATED_ENV_ID]
    }
    if (patch.vaultIds !== undefined) {
      if (nextVaults.length > 0) nextMeta[BOT_META_VAULT_IDS] = nextVaults.join(',')
      else delete nextMeta[BOT_META_VAULT_IDS]
    }
    if (patch.primarySessionId !== undefined) {
      if (patch.primarySessionId && patch.primarySessionId.trim().length > 0) {
        nextMeta[BOT_META_PRIMARY_SESSION_ID] = patch.primarySessionId.trim()
      } else {
        delete nextMeta[BOT_META_PRIMARY_SESSION_ID]
      }
    }

    let nextSystem = agent.system ?? ''
    if (nextBrowser && !nextSystem.includes('browser_screenshot')) {
      nextSystem = `${nextSystem}${nextSystem.length > 0 ? '\n\n' : ''}${BROWSER_LIVE_INSTRUCTIONS}`
    }

    const toolsRebuildNeeded =
      patch.approvalMode !== undefined || patch.browserEnabled !== undefined
    const nextTools = toolsRebuildNeeded && !current.isTeam
      ? (buildBotTools({
          enabledTools: tpl?.enabledTools,
          approvalMode: nextApproval,
          browserEnabled: nextBrowser,
        }) as unknown as NonNullable<UpdateAgentRequest['tools']>)
      : undefined

    const updated = await client.updateAgent(agent.id, {
      ...agent.version !== undefined ? { version: agent.version } : {},
      ...patch.name !== undefined && patch.name.trim().length > 0 ? { name: patch.name.trim() } : {},
      ...patch.description !== undefined ? { description: patch.description } : {},
      ...patch.model !== undefined && patch.model.trim().length > 0 ? { model: patch.model.trim() } : {},
      ...nextSystem !== (agent.system ?? '') ? { system: nextSystem } : {},
      ...nextTools !== undefined ? { tools: nextTools } : {},
      ...patch.skillIds !== undefined
        ? { skills: nextSkills.map(id => ({ type: 'custom' as const, skill_id: id })) }
        : {},
      metadata: nextMeta,
    }, signal)
    return toBotProfile(updated)
  }

  /**
   * "A Computer of Its Own" (Qoder Cloud `runtime_mode: "shared"` + `slot_id`):
   * Return a Bot's persistent Cloud Computer (`Session` + `slot_id`), reusing
   * `dsh_primary_session_id` whenever it is still alive (`idle` / `running` /
   * `rescheduling`) on a shared Cloud Computer environment, or upgrading/provisioning
   * a `runtime_mode: "shared"` Cloud Computer environment + isolated `slot_id`
   * virtual desktop slot.
   */
  async ensurePrimaryComputerSession(
    client: QoderCloudClient,
    botId: string,
    signal: AbortSignal,
  ): Promise<{ bot: BotProfile; session: SessionView; environmentId: string; environment?: EnvironmentView | undefined; created: boolean }> {
    const target = await this.resolve(client, undefined, signal, botId)
    let bot = target.bot

    const activeEnvs = active((await client.listEnvironments(signal)).data)
    let chosenEnv = activeEnvs.find(e => e.id === target.environmentId)
    // Prefer a shared Cloud Computer (`config.runtime_mode === "shared"`) whenever available.
    if (!isSharedCloudComputer(chosenEnv) && bot.dedicatedEnvId === undefined) {
      const sharedCandidate = activeEnvs.find(isSharedCloudComputer)
      if (sharedCandidate !== undefined) {
        chosenEnv = sharedCandidate
        this.remember({ environmentId: sharedCandidate.id })
        await this.options.persist({ environmentId: sharedCandidate.id }).catch(() => false)
      }
    }
    const effectiveEnvId = chosenEnv?.id ?? target.environmentId
    const sharedMode = isSharedCloudComputer(chosenEnv)
    const slotId = sharedMode ? desktopSlotIdForBot(bot.id) : undefined

    if (bot.primarySessionId !== undefined) {
      const existing = await client.getSession(bot.primarySessionId, signal).catch(() => null)
      const matchesSharedUpgrade = !sharedMode || existing?.environment_id === undefined || existing.environment_id === effectiveEnvId
      if (existing !== null && existing.status !== 'terminated' && matchesSharedUpgrade) {
        return {
          bot,
          session: existing,
          environmentId: effectiveEnvId,
          ...chosenEnv !== undefined ? { environment: chosenEnv } : {},
          created: false,
        }
      }
    }

    const resources: SessionResource[] = []
    if (target.memoryResource !== undefined) {
      resources.push(target.memoryResource)
    }

    let session: SessionView
    const baseReq = {
      agent: bot.id,
      environment_id: effectiveEnvId,
      title: `${bot.avatar} ${bot.name} · Cloud Computer`,
      metadata: {
        mode: 'bot_computer',
        bot_id: bot.id,
        bot_name: bot.name,
        ...sharedMode ? { runtime_mode: 'shared' } : {},
      },
      ...resources.length > 0 ? { resources } : {},
      ...bot.vaultIds.length > 0 ? { vault_ids: [...bot.vaultIds] } : {},
    }
    try {
      session = await client.createSession({
        ...baseReq,
        ...slotId !== undefined ? { slot_id: slotId } : {},
      }, signal)
    } catch (err: unknown) {
      // Fallback if an older/mock gateway does not recognize `slot_id`
      if (slotId !== undefined && String(err).includes('slot_id')) {
        session = await client.createSession(baseReq, signal)
      } else {
        throw err
      }
    }

    bot = await this.updateBotConfig(client, bot.id, {
      primarySessionId: session.id,
    }, signal).catch(() => bot)

    return {
      bot,
      session,
      environmentId: effectiveEnvId,
      ...chosenEnv !== undefined ? { environment: chosenEnv } : {},
      created: true,
    }
  }

  /**
   * Reset a Bot's persistent Cloud Computer: archive the old primary session (if
   * any) and spin up a clean cloud computer while keeping its persistent Memory Store!
   */
  async resetPrimaryComputerSession(
    client: QoderCloudClient,
    botId: string,
    signal: AbortSignal,
  ): Promise<{ bot: BotProfile; session: SessionView; environmentId: string; environment?: EnvironmentView | undefined; created: boolean }> {
    const agent = await client.getAgent(botId, signal)
    const current = toBotProfile(agent)
    if (current.primarySessionId !== undefined) {
      await client.archiveSession(current.primarySessionId, signal).catch(() => {})
      await this.updateBotConfig(client, botId, { primarySessionId: null }, signal).catch(() => {})
    }
    return this.ensurePrimaryComputerSession(client, botId, signal)
  }

  /**
   * Ensure a Managed Bot has the `manage_bot_routine` client-side tool and
   * prompt instructions (smoothly upgrades Batch-1 bots on the fly!).
   */
  async ensureBotRoutineTool(
    client: QoderCloudClient,
    botId: string,
    signal?: AbortSignal,
  ): Promise<BotProfile> {
    const agent = await client.getAgent(botId, signal)
    const existingTools = agent.tools ?? []
    const hasRoutineTool = existingTools.some(
      t => t.type === 'custom' && t.name?.toLowerCase() === MANAGE_BOT_ROUTINE_TOOL,
    )
    if (hasRoutineTool) return toBotProfile(agent)

    const preservedTools = existingTools.length > 0
      ? [...existingTools]
      : [{ type: AGENT_TOOLSET }]
    const nextTools = [
      ...preservedTools,
      MANAGE_BOT_ROUTINE_CUSTOM_TOOL,
    ] as unknown as NonNullable<UpdateAgentRequest['tools']>

    const prevSystem = agent.system ?? ''
    const nextSystem = prevSystem.includes(MANAGE_BOT_ROUTINE_TOOL)
      ? prevSystem
      : `${prevSystem}${prevSystem.length > 0 ? '\n\n' : ''}${ROUTINE_SYSTEM_INSTRUCTIONS}`

    const updated = await client.updateAgent(agent.id, {
      ...agent.version !== undefined ? { version: agent.version } : {},
      system: nextSystem,
      tools: nextTools,
    }, signal)
    return toBotProfile(updated)
  }

  /**
   * Attach a new persistent Memory Store to an existing Agent/Bot via OCC update
   * (`version` check) if it does not already have one.
   */
  async ensureBotMemoryStore(
    client: QoderCloudClient,
    botId: string,
    signal?: AbortSignal,
  ): Promise<BotProfile> {
    const agent = await client.getAgent(botId, signal)
    const current = toBotProfile(agent)
    if (current.memoryStoreId !== undefined) return current

    const store = await client.createMemoryStore({
      name: `${agent.name}-memory`,
      description: `Persistent memory store for Qoder Bot "${agent.name}"`,
      metadata: { [BOT_META_FLAG]: 'true', bot_id: agent.id, bot_name: agent.name },
    }, signal)

    await client.createMemory(store.id, {
      path: 'README.md',
      content: `# Bot Memory — ${agent.name}\n\nPersistent notes and user preferences across sessions.\n`,
    }, signal).catch(() => {})

    const prevSystem = agent.system ?? ''
    const nextSystem = prevSystem.includes('/awareness/')
      ? prevSystem
      : `${prevSystem}${prevSystem.length > 0 ? '\n\n' : ''}${MEMORY_AWARENESS_INSTRUCTIONS}`

    const updated = await client.updateAgent(agent.id, {
      ...agent.version !== undefined ? { version: agent.version } : {},
      system: nextSystem,
      metadata: {
        ...agent.metadata,
        [BOT_META_FLAG]: 'true',
        [BOT_META_MEMORY_STORE_ID]: store.id,
      },
    }, signal)
    return toBotProfile(updated)
  }

  /** Inspect memories inside a Bot's attached Memory Store. */
  async inspectBotMemories(
    client: QoderCloudClient,
    botIdOrName: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ bot: BotProfile; store?: MemoryStoreView; entries: MemoryEntryView[] }> {
    const bots = await this.listBots(client, signal)
    const picked = botIdOrName !== undefined && botIdOrName.trim().length > 0
      ? matchByIdOrName(bots, botIdOrName, 'bot')
      : (() => {
          const activeId = this.currentSelection().botId
          return activeId !== undefined ? (bots.find(b => b.id === activeId) ?? 'no active bot found') : (bots[0] ?? 'no bots exist yet')
        })()
    if (typeof picked === 'string') throw new Error(`qoder-bots: ${picked}`)
    if (picked.memoryStoreId === undefined) {
      return { bot: picked, entries: [] }
    }
    const [store, list] = await Promise.all([
      client.getMemoryStore(picked.memoryStoreId, signal),
      client.listMemories(picked.memoryStoreId, signal),
    ])
    return { bot: picked, store, entries: list.data }
  }

  /** Write (create or overwrite) a markdown memory entry in a Bot's persistent Memory Store. */
  async writeBotMemoryEntry(
    client: QoderCloudClient,
    params: { botIdOrName?: string | undefined; path: string; content: string },
    signal?: AbortSignal,
  ): Promise<{ bot: BotProfile; entry: MemoryEntryView; created: boolean }> {
    const cleanPath = params.path.trim().replace(/^\/+/, '')
    if (cleanPath.length === 0 || cleanPath.includes('..')) {
      throw new Error(`qoder-bots: memory path "${params.path}" must be a relative path without ".."`)
    }
    const inspected = await this.inspectBotMemories(client, params.botIdOrName, signal)
    let bot = inspected.bot
    if (bot.memoryStoreId === undefined) {
      bot = await this.ensureBotMemoryStore(client, bot.id, signal)
    }
    const storeId = bot.memoryStoreId!
    const existing = inspected.entries.find(e => e.path === cleanPath)
    if (existing !== undefined) {
      const updated = await client.updateMemory(storeId, existing.id, { content: params.content }, signal)
      return { bot, entry: updated, created: false }
    }
    const created = await client.createMemory(storeId, { path: cleanPath, content: params.content }, signal)
    return { bot, entry: created, created: true }
  }

  /** Delete a memory entry by path or `mem_...` ID from a Bot's persistent Memory Store. */
  async deleteBotMemoryEntry(
    client: QoderCloudClient,
    params: { botIdOrName?: string | undefined; pathOrId: string },
    signal?: AbortSignal,
  ): Promise<{ bot: BotProfile; deletedPath: string; deletedId: string }> {
    const inspected = await this.inspectBotMemories(client, params.botIdOrName, signal)
    if (inspected.bot.memoryStoreId === undefined) {
      throw new Error(`qoder-bots: bot "${inspected.bot.name}" has no attached Memory Store`)
    }
    const needle = params.pathOrId.trim().replace(/^\/+/, '')
    const hit = inspected.entries.find(e => e.path === needle || e.id === params.pathOrId.trim())
    if (hit === undefined) {
      throw new Error(`qoder-bots: no memory entry "${params.pathOrId}" found in ${inspected.bot.memoryStoreId}`)
    }
    await client.deleteMemory(inspected.bot.memoryStoreId, hit.id, signal)
    return { bot: inspected.bot, deletedPath: hit.path, deletedId: hit.id }
  }

  /**
   * Assemble a Multi-Bot Team Coordinator (`multiagent: { type: "coordinator" }`)
   * over Qoder Cloud Managed Agents!
   *
   * Member refs can be existing bot IDs, bot names, or built-in template slugs
   * (any missing template slug is auto-provisioned as a specialist bot first).
   * Note: QCA enforces depth limit 1 — member bots themselves must not be teams.
   */
  async createTeamBot(
    client: QoderCloudClient,
    input: CreateTeamInput,
    signal?: AbortSignal,
  ): Promise<{ team: BotProfile; members: BotProfile[] }> {
    const teamName = input.name.trim().slice(0, 64)
    if (teamName.length === 0) throw new Error('qoder-bots: team name must not be empty')
    if (input.members.length === 0) throw new Error('qoder-bots: at least one member bot is required to form a team')

    const existingBots = await this.listBots(client, signal)
    const resolvedMembers: BotProfile[] = []
    const seenIds = new Set<string>()

    for (const rawRef of input.members) {
      const ref = rawRef.trim()
      if (ref.length === 0) continue
      const matched = matchByIdOrName(existingBots, ref, 'bot')
      let member: BotProfile
      if (typeof matched !== 'string') {
        member = matched
      } else {
        const tpl = findBotTemplate(ref)
        if (tpl === undefined) {
          throw new Error(`qoder-bots: "${ref}" is neither an existing bot nor a built-in template slug`)
        }
        member = await this.createBot(client, { templateId: tpl.id }, signal)
      }
      if (member.isTeam) {
        throw new Error(`qoder-bots: member "${member.name}" (${member.id}) is already a coordinator team (Qoder Cloud multiagent depth limit is 1)`)
      }
      if (!seenIds.has(member.id)) {
        seenIds.add(member.id)
        resolvedMembers.push(member)
      }
    }

    if (resolvedMembers.length === 0) {
      throw new Error('qoder-bots: no valid member bots resolved for team')
    }

    const wantMemory = input.withMemory ?? this.options.autoMemory
    let memoryStore: MemoryStoreView | undefined
    if (wantMemory) {
      memoryStore = await client.createMemoryStore({
        name: `${teamName}-team-memory`,
        description: `Shared coordinator memory store for Multi-Bot Team "${teamName}"`,
        metadata: { [BOT_META_FLAG]: 'true', [BOT_META_TEAM_FLAG]: 'true', bot_name: teamName },
      }, signal)
      await client.createMemory(memoryStore.id, {
        path: 'README.md',
        content: [
          `# Team Memory — ${teamName}`,
          '',
          `Members: ${resolvedMembers.map(m => `${m.avatar} ${m.name} (${m.id})`).join(', ')}`,
          '',
          'Record cross-functional architecture decisions, task ownership boundaries, and team synthesis notes here.',
        ].join('\n'),
      }, signal).catch(() => {})
    }

    const rosterSummary = resolvedMembers
      .map(m => `- **${m.name}** (\`${m.id}\`): ${m.description || 'Specialist bot'}`)
      .join('\n')

    const baseCoordinatorSystem = input.system ?? [
      `You are "${teamName}", a Multi-Bot Team Coordinator orchestrating specialist Qoder Cloud Bots inside a shared sandbox.`,
      'Available team members:',
      rosterSummary,
      '',
      'Coordination rules:',
      '1. Decompose complex requests into independent workstreams and delegate them in parallel to the most appropriate specialist bot(s).',
      '2. All threads in this session share the same filesystem: assign disjoint file/directory write boundaries so parallel bots never overwrite each other.',
      '3. Consult your Advisor before irreversible architectural or data changes when an Advisor is configured.',
      '4. Cross-check findings across child threads, resolve contradictions, and present a unified, well-structured response to the user.',
    ].join('\n')

    const systemSections = [baseCoordinatorSystem]
    if (wantMemory) systemSections.push(MEMORY_AWARENESS_INSTRUCTIONS)
    systemSections.push(ROUTINE_SYSTEM_INSTRUCTIONS)

    const rosterEntries: NonNullable<CreateAgentRequest['multiagent']>['agents'] = resolvedMembers.map(m => m.id)
    if (input.includeSelf) {
      rosterEntries.push({ type: 'self' })
    }
    const advisorModel = input.advisorModel === false
      ? undefined
      : (input.advisorModel ?? this.options.defaultModel)
    if (advisorModel !== undefined) {
      rosterEntries.push({ type: 'advisor', model: advisorModel })
    }

    const model = input.model ?? this.options.defaultModel
    const description = input.description
      ?? `Multi-Bot Team (${resolvedMembers.map(m => `${m.avatar} ${m.name}`).join(' + ')})`

    const created = await client.createAgent({
      name: teamName,
      model,
      description,
      system: systemSections.join('\n\n'),
      tools: [
        { type: AGENT_TOOLSET },
        MANAGE_BOT_ROUTINE_CUSTOM_TOOL,
      ],
      multiagent: {
        type: 'coordinator',
        agents: rosterEntries,
      },
      metadata: {
        [BOT_META_FLAG]: 'true',
        [BOT_META_TEAM_FLAG]: 'true',
        [BOT_META_AVATAR]: '👥',
        [BOT_META_TEAM_MEMBERS]: resolvedMembers.map(m => m.id).join(','),
        ...memoryStore !== undefined ? { [BOT_META_MEMORY_STORE_ID]: memoryStore.id } : {},
      },
    }, signal)

    return { team: toBotProfile(created), members: resolvedMembers }
  }

  /**
   * Resolve the execution target (Bot + Environment + MemoryStore resource).
   * If `explicitBot` (id, name, or template slug) is passed — e.g. from `@bot`
   * delegation or a `bot:<id>` model route — resolves that specific bot without
   * mutating the profile's default bot selection.
   */
  resolve(
    client: QoderCloudClient,
    asker: Asker | undefined,
    signal: AbortSignal,
    explicitBot?: string,
  ): Promise<ResolvedBotTarget> {
    const next = this.queue.then(() => this.resolveNow(client, asker, signal, explicitBot))
    this.queue = next.catch(() => {})
    return next
  }

  private async resolveNow(
    client: QoderCloudClient,
    asker: Asker | undefined,
    signal: AbortSignal,
    explicitBot?: string,
  ): Promise<ResolvedBotTarget> {
    const { options } = this
    const current = this.currentSelection()
    let environmentId = current.environmentId
    const targetBotRef = explicitBot?.trim() || current.botId

    const notes: string[] = []
    const toPersist: BotSelection = {}

    // 1. Resolve Environment
    let envPlan: EnvironmentPlan | undefined
    if (environmentId === undefined) {
      envPlan = this.planEnvironment(active((await client.listEnvironments(signal)).data))
    }

    // 2. Resolve Bot
    let resolvedBot: BotProfile | undefined
    let botPlan: BotPlan | undefined
    const allBots = await this.listBots(client, signal)

    if (targetBotRef !== undefined) {
      const matched = matchByIdOrName(allBots, targetBotRef, 'bot')
      if (typeof matched !== 'string') {
        resolvedBot = matched
      } else if (explicitBot !== undefined) {
        // Allow on-the-fly provisioning when an explicit delegation names a built-in template slug!
        const tpl = findBotTemplate(explicitBot)
        if (tpl !== undefined) {
          resolvedBot = await this.createBot(client, { templateId: tpl.id }, signal)
          notes.push(`Created bot "${resolvedBot.name}" (${resolvedBot.id}) from built-in template "${tpl.id}"`)
        } else {
          const available = allBots.map(b => b.name).join(', ') || 'none'
          const templates = BUILTIN_BOT_TEMPLATES.map(t => t.id).join(', ')
          throw new Error(`qoder-bots: ${matched}. Existing bots: [${available}]; built-in templates: [${templates}]`)
        }
      }
    }

    if (resolvedBot === undefined) {
      botPlan = this.planBot(allBots, asker !== undefined)
    }

    // Prefer Bot's dedicated environment if configured and active
    if (resolvedBot?.dedicatedEnvId) {
      const envs = active((await client.listEnvironments(signal)).data)
      const dedicated = envs.find(e => e.id === resolvedBot!.dedicatedEnvId)
      if (dedicated !== undefined) {
        environmentId = dedicated.id
        envPlan = undefined
      }
    }

    // 3. Interactive Questions if needed
    const questions: AskUserQuestionItem[] = []
    if (envPlan?.kind === 'ask') {
      questions.push({
        id: ENVIRONMENT_QUESTION,
        header: 'Qoder Bots',
        question: 'Which Qoder Cloud environment should your bots run in?',
        detail: 'Managed cloud environments run on Qoder sandboxes; self-hosted (BYOC) ones run on your own workers. '
          + 'Change later with `/qoder-bot env`.',
        options: [
          ...envPlan.candidates.map(env => ({ label: environmentLabel(env), description: describeEnvironment(env) })),
          { label: `Create a new environment "${DEFAULT_ENVIRONMENT_NAME}"`, description: 'cloud · network unrestricted' },
        ],
      })
    }
    if (botPlan?.kind === 'ask') {
      questions.push({
        id: BOT_QUESTION,
        header: 'Qoder Bots',
        question: 'Which Qoder Cloud Bot would you like to use?',
        detail: 'Each managed bot carries its own persona and persistent cloud Memory Store. '
          + 'Change or create more anytime with `/qoder-bot`.',
        options: [
          {
            label: `Create "${botPlan.defaultTemplate.avatar} ${options.defaultBotName}" (${botPlan.defaultTemplate.id})`,
            description: `${botPlan.defaultTemplate.description} · model ${options.defaultModel}`,
          },
          ...botPlan.candidates.map(bot => ({
            label: botLabel(bot),
            description: `model ${bot.model}${bot.memoryStoreId ? ' · persistent memory' : ''}${bot.description ? ` · ${bot.description}` : ''}`,
          })),
        ],
      })
    }

    let answer: AskUserQuestionAnswer | undefined
    if (questions.length > 0) {
      let unanswerable: string | undefined = asker === undefined ? 'no one can be asked to choose (no interactive UI)' : undefined
      if (asker !== undefined) {
        try {
          answer = await asker(questions, signal)
        } catch (error: unknown) {
          const code = errorCode(error)
          if (code === undefined || !UNANSWERABLE.has(code)) throw error
          unanswerable = code === 'NO_PROVIDER'
            ? 'no one can be asked to choose (no interactive UI is attached)'
            : 'the delegating agent is itself a delegated task, which cannot ask the user'
        }
      }
      if (answer === undefined && envPlan?.kind === 'ask') {
        throw ambiguousEnvironment(envPlan.candidates, options.entryId, unanswerable ?? 'none was chosen')
      }
    }

    if (envPlan !== undefined) {
      const env = await this.applyEnvironment(client, envPlan, answer, signal)
      environmentId = env.id
      toPersist.environmentId = env.id
      notes.push(`Environment: ${env.name} (${env.id})${envPlan.kind === 'use' ? ` — ${envPlan.why}` : ''}`)
    }

    if (resolvedBot === undefined && botPlan !== undefined) {
      const effectivePlan: BotPlan = answer === undefined && botPlan.kind === 'ask'
        ? { kind: 'create', template: botPlan.defaultTemplate }
        : botPlan
      resolvedBot = await this.applyBot(client, effectivePlan, answer, signal)
      if (explicitBot === undefined) {
        toPersist.botId = resolvedBot.id
      }
      notes.push(`Bot: ${resolvedBot.avatar} ${resolvedBot.name} (${resolvedBot.id})${botPlan.kind === 'use' ? ` — ${botPlan.why}` : ''}`)
    }

    // Ensure persistent memory store when autoMemory is enabled on managed bots (and cloud env supports resources)
    let finalBot = resolvedBot!
    const envs = active((await client.listEnvironments(signal)).data)
    const chosenEnv = envs.find(e => e.id === environmentId)
    const envSupportsResources = chosenEnv === undefined || isManagedCloud(chosenEnv)

    if (options.autoMemory && finalBot.isManagedBot && finalBot.memoryStoreId === undefined && envSupportsResources) {
      try {
        finalBot = await this.ensureBotMemoryStore(client, finalBot.id, signal)
        notes.push(`Attached new persistent Memory Store ${finalBot.memoryStoreId}`)
      } catch {
        // Non-fatal: continue even if memory store quota is full
      }
    }

    if (finalBot.isManagedBot) {
      try {
        finalBot = await this.ensureBotRoutineTool(client, finalBot.id, signal)
      } catch {
        // Non-fatal: older mock or custom tools unsupported
      }
    }

    if (Object.keys(toPersist).length > 0) {
      this.memo = { ...this.memo, ...toPersist }
      const saved = await options.persist(toPersist)
      notes.push(saved
        ? 'Saved selection to profile; manage bots with /qoder-bot.'
        : 'Applied for this process (set environmentId / botId in profile patch to persist).')
    }

    const memoryResource: SessionResource | undefined =
      finalBot.memoryStoreId !== undefined && envSupportsResources
        ? {
            type: 'memory_store',
            memory_store_id: finalBot.memoryStoreId,
            access: 'read_write',
            instructions: `Long-term memory store for bot "${finalBot.name}". Read and update markdown notes here across sessions.`,
          }
        : undefined

    return {
      bot: finalBot,
      environmentId: environmentId!,
      ...memoryResource !== undefined ? { memoryResource } : {},
      notes,
    }
  }

  private planEnvironment(envs: EnvironmentView[]): EnvironmentPlan {
    if (envs.length === 0) return { kind: 'create' }
    const sharedCloudComputers = envs.filter(isSharedCloudComputer)
    if (sharedCloudComputers.length === 1) {
      return { kind: 'use', env: sharedCloudComputers[0]!, why: 'persistent Qoder Cloud Computer (runtime_mode=shared)' }
    }
    if (envs.length === 1 && isManagedCloud(envs[0]!)) {
      return { kind: 'use', env: envs[0]!, why: 'the only cloud environment' }
    }
    const ordered = [
      ...sharedCloudComputers,
      ...envs.filter(env => isManagedCloud(env) && !isSharedCloudComputer(env)),
      ...envs.filter(env => !isManagedCloud(env)),
    ]
    return { kind: 'ask', candidates: ordered, all: envs }
  }

  private planBot(bots: BotProfile[], canAsk: boolean): BotPlan {
    const defaultTpl = findBotTemplate(this.options.defaultTemplateId) ?? BUILTIN_BOT_TEMPLATES[0]!
    const byDefaultName = bots.find(b => b.name === this.options.defaultBotName || b.name === defaultTpl.defaultName)
    if (byDefaultName !== undefined) {
      return { kind: 'use', bot: byDefaultName, why: 'default plugin bot' }
    }
    const managedBots = bots.filter(b => b.isManagedBot)
    if (managedBots.length === 1) {
      return { kind: 'use', bot: managedBots[0]!, why: 'the only Qoder Bot' }
    }
    if (!canAsk || bots.length === 0) {
      return { kind: 'create', template: defaultTpl }
    }
    return { kind: 'ask', candidates: bots.slice(0, MAX_BOT_OPTIONS), all: bots, defaultTemplate: defaultTpl }
  }

  private async applyEnvironment(
    client: QoderCloudClient,
    plan: EnvironmentPlan,
    answer: AskUserQuestionAnswer | undefined,
    signal: AbortSignal,
  ): Promise<EnvironmentView> {
    if (plan.kind === 'use') return plan.env
    if (plan.kind === 'ask') {
      const item = answer?.answers.find(entry => entry.id === ENVIRONMENT_QUESTION)
      const label = item?.selected[0]
      const picked = plan.candidates.find(env => environmentLabel(env) === label)
      if (picked !== undefined) return picked
      const custom = item?.custom?.trim()
      if (custom !== undefined && custom.length > 0 && label === undefined) {
        const match = matchByIdOrName(plan.all, custom, 'environment')
        if (typeof match === 'string') throw new SelectionRequiredError(`qoder-bots: ${match}`)
        return match
      }
      if (label === undefined) throw new SelectionRequiredError('qoder-bots: no Qoder Cloud environment was chosen')
    }
    return client.createEnvironment(DEFAULT_ENVIRONMENT_NAME, signal).catch((err: unknown) => {
      if (String(err).includes('runtime_mode')) {
        return client.createEnvironment(DEFAULT_ENVIRONMENT_NAME, signal, { runtimeMode: 'session' })
      }
      throw err
    })
  }

  private async applyBot(
    client: QoderCloudClient,
    plan: BotPlan,
    answer: AskUserQuestionAnswer | undefined,
    signal: AbortSignal,
  ): Promise<BotProfile> {
    if (plan.kind === 'use') return plan.bot
    if (plan.kind === 'ask') {
      const item = answer?.answers.find(entry => entry.id === BOT_QUESTION)
      const label = item?.selected[0]
      const picked = plan.candidates.find(bot => botLabel(bot) === label)
      if (picked !== undefined) return picked
      const custom = item?.custom?.trim()
      if (custom !== undefined && custom.length > 0 && label === undefined) {
        const match = matchByIdOrName(plan.all, custom, 'bot')
        if (typeof match === 'string') throw new SelectionRequiredError(`qoder-bots: ${match}`)
        return match
      }
      if (label === undefined) throw new SelectionRequiredError('qoder-bots: no Qoder Bot was chosen')
    }
    const tpl = plan.kind === 'create' ? plan.template : plan.defaultTemplate
    return this.createBot(client, {
      name: this.options.defaultBotName,
      templateId: tpl.id,
      model: this.options.defaultModel,
    }, signal)
  }
}
