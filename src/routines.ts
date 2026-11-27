/**
 * 24/7 Cloud Routines (autonomous scheduled runs & offline run inbox)
 * built 100% on Qoder Cloud Agents Managed Mode `/api/v1/cloud/deployments` and
 * `/api/v1/cloud/deployment_runs`.
 *
 * Includes:
 *   1. `MANAGE_BOT_ROUTINE_CUSTOM_TOOL` — the `type: "custom"` client-side tool
 *      schema injected into Managed Bots so users can ask a bot in natural
 *      language ("Every weekday at 9am check new commits and write a digest")
 *      and the bot creates/lists/pauses/runs its own cloud `Deployment`!
 *   2. `RoutineManager` — creates Cron or manual-trigger Routines inheriting
 *      the Bot's `MemoryStore` + workspace Git repository, manages lifecycle
 *      (`pause` / `unpause` / `runNow` / `archive`), and reads the offline Run
 *      Inbox (`inspectRunReport`) so users can read completed background runs
 *      or even resume chatting in a routine's spawned session.
 *
 * @module dsh-qoder-bots/routines
 */

import {
  BOT_META_BOT_ID,
  BOT_META_BOT_NAME,
  BOT_META_ROUTINE_FLAG,
  MANAGE_BOT_ROUTINE_TOOL,
} from './bot-constants.ts'
import { matchByIdOrName, type BotManager, type BotProfile } from './bot-manager.ts'
import type { CustomToolCall } from './bot-mode.ts'
import type {
  CreateDeploymentRequest,
  DeploymentRunView,
  DeploymentView,
  QoderCloudClient,
  SessionEvent,
} from './client.ts'
import { detectRepository } from './git.ts'
import { repositoryResource } from './run.ts'

export const DEFAULT_ROUTINE_TIMEZONE = 'Asia/Shanghai'

/** System prompt guidance teaching Managed Bots how to schedule 24/7 routines safely. */
export const ROUTINE_SYSTEM_INSTRUCTIONS = [
  '24/7 Cloud Routines (`manage_bot_routine` tool):',
  '- When the user asks you to run a recurring task, cron job, daily digest, or standing monitor in the cloud, call `manage_bot_routine` with `action: "create"`, a 5-field POSIX `cron_expression` (e.g. `"0 9 * * 1-5"`), an IANA `timezone` (default `"Asia/Shanghai"`), and a self-contained `task_prompt`.',
  '- IMPORTANT: Scheduled cloud runs execute unattended while the user\'s laptop may be offline! Write `task_prompt` so future scheduled runs ONLY use cloud-native sandbox tools (`Bash`, `Read`, `Write`, `WebSearch`, `WebFetch`, `DeliverArtifacts`, awareness memory) and NEVER call `manage_bot_routine` during a scheduled run.',
].join('\n')

/** QCA `type: "custom"` tool definition attached to every Managed Bot's `tools[]`. */
export const MANAGE_BOT_ROUTINE_CUSTOM_TOOL = {
  type: 'custom' as const,
  name: MANAGE_BOT_ROUTINE_TOOL,
  description: [
    'Create, list, pause, unpause, trigger (`run_now`), or archive 24/7 Qoder Cloud scheduled routines (`Deployments`) for yourself.',
    'Scheduled routines run automatically in Qoder Cloud sandboxes on a 5-field POSIX cron schedule even when DeepSeek Harness is closed, mounting your persistent Memory Store.',
  ].join(' '),
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'pause', 'unpause', 'run_now', 'archive'],
        description: 'Operation to perform on your cloud routines.',
      },
      name: {
        type: 'string',
        description: 'Human-readable routine name (required for `create`; or used to match an existing routine).',
      },
      routine_id: {
        type: 'string',
        description: 'Routine/deployment ID (`dep_...`) or exact routine name (required for `pause`, `unpause`, `run_now`, `archive`).',
      },
      cron_expression: {
        type: 'string',
        description: '5-field POSIX cron expression: `minute hour day-of-month month day-of-week`, e.g. `"0 9 * * *"` or `"0 9 * * 1-5"`. Omit for manual-only routines.',
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone identifier such as `"Asia/Shanghai"` or `"UTC"` (defaults to `"Asia/Shanghai"`).',
      },
      task_prompt: {
        type: 'string',
        description: 'Complete, self-contained instructions sent to you at the start of every scheduled run (required for `create`).',
      },
      description: {
        type: 'string',
        description: 'Optional summary of what this routine monitors or produces.',
      },
      include_repository: {
        type: 'boolean',
        description: 'When `true` (default), mounts the current workspace git repository into every scheduled run if available.',
      },
    },
    required: ['action'],
  },
}

export interface CreateRoutineInput {
  readonly name: string
  readonly taskPrompt: string
  readonly cronExpression?: string | undefined
  readonly timezone?: string | undefined
  readonly description?: string | undefined
  readonly botIdOrName?: string | undefined
  readonly cwd?: string | undefined
  readonly includeRepository?: boolean | undefined
}

export interface RoutineRunReport {
  readonly run: DeploymentRunView
  readonly deployment?: DeploymentView | undefined
  readonly sessionStatus?: string | undefined
  readonly finalMessage?: string | undefined
  readonly artifacts: readonly { fileId: string; name: string; size?: number }[]
}

export interface RoutineManagerDeps {
  readonly manager: BotManager
  readonly repositoryMode: 'auto' | 'none'
  readonly gitToken: () => Promise<string | undefined>
  readonly gitTokenEnv: string
  readonly gitUsername?: string | undefined
  readonly environmentVariables: Readonly<Record<string, string>>
}

function encodeEnvVarsString(vars: Readonly<Record<string, string>>): string | undefined {
  const entries = Object.entries(vars)
  if (entries.length === 0) return undefined
  return entries.map(([k, v]) => `${k}=${v}`).join('\n')
}

function extractEventText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } =>
      typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
}

/** Validate basic 5-field POSIX cron syntax before hitting the gateway for clearer error feedback. */
export function validatePosixCron5(expr: string): string | undefined {
  const trimmed = expr.trim()
  if (trimmed.startsWith('@')) {
    return `shortcut "${trimmed}" is not supported; use a 5-field POSIX cron like "0 9 * * *"`
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    return `expected a 5-field POSIX cron expression (minute hour dom month dow), got ${parts.length} field(s): "${trimmed}"`
  }
  if (/[LW#?]/.test(trimmed)) {
    return `cron special characters L, W, #, ? are not supported in "${trimmed}"`
  }
  return undefined
}

export function formatRoutineLine(dep: DeploymentView): string {
  const state = dep.status === 'active' ? '🟢 active' : '⏸️ paused'
  const cron = dep.schedule
    ? `cron \`${dep.schedule.expression}\` (${dep.schedule.timezone})`
    : 'manual-only'
  const next = dep.schedule?.upcoming_runs_at?.[0]
  const botTag = dep.metadata?.[BOT_META_BOT_NAME] ?? dep.agent.id
  return `${state}  ${dep.id}  "${dep.name}"  [bot: ${botTag}] · ${cron}${next ? ` · next: ${next}` : ''}`
}

export class RoutineManager {
  constructor(private readonly deps: RoutineManagerDeps) {}

  /** List non-archived routines, optionally filtered to a specific Bot (`agent_id` or bot name). */
  async listRoutines(
    client: QoderCloudClient,
    botIdOrName?: string,
    signal?: AbortSignal,
  ): Promise<DeploymentView[]> {
    let agentId: string | undefined
    if (botIdOrName !== undefined && botIdOrName.trim().length > 0) {
      const bots = await this.deps.manager.listBots(client, signal)
      const matched = matchByIdOrName(bots, botIdOrName, 'bot')
      if (typeof matched === 'string') throw new Error(`qoder-bots: ${matched}`)
      agentId = matched.id
    }
    const page = await client.listDeployments(agentId === undefined ? {} : { agentId }, signal)
    return page.data.filter(d => !d.archived_at)
  }

  /** Resolve a routine by `dep_...` ID or unique name. */
  async resolveRoutine(
    client: QoderCloudClient,
    idOrName: string,
    botIdOrName?: string,
    signal?: AbortSignal,
  ): Promise<DeploymentView> {
    const list = await this.listRoutines(client, botIdOrName, signal)
    const matched = matchByIdOrName(list, idOrName, 'routine')
    if (typeof matched === 'string') throw new Error(`qoder-bots: ${matched}`)
    return matched
  }

  /**
   * Create a new 24/7 Cloud Routine (`Deployment`) bound to the target Bot, its
   * cloud `Environment`, its persistent `MemoryStore`, and (when available) the
   * workspace's Git repository.
   */
  async createRoutine(
    client: QoderCloudClient,
    input: CreateRoutineInput,
    signal: AbortSignal,
  ): Promise<{ deployment: DeploymentView; bot: BotProfile; notes: string[] }> {
    const name = input.name.trim()
    if (name.length === 0) throw new Error('qoder-bots: routine name must not be empty')
    const taskPrompt = input.taskPrompt.trim()
    if (taskPrompt.length === 0) throw new Error('qoder-bots: routine taskPrompt must not be empty')

    if (input.cronExpression !== undefined && input.cronExpression.trim().length > 0) {
      const cronErr = validatePosixCron5(input.cronExpression)
      if (cronErr !== undefined) throw new Error(`qoder-bots: invalid cron_expression — ${cronErr}`)
    }

    const target = await this.deps.manager.resolve(client, undefined, signal, input.botIdOrName)
    const notes: string[] = [...target.notes]
    const resources: NonNullable<CreateDeploymentRequest['resources']> = []

    if (target.memoryResource !== undefined) {
      resources.push(target.memoryResource as NonNullable<CreateDeploymentRequest['resources']>[number])
    }

    const wantRepo = (input.includeRepository ?? true) && this.deps.repositoryMode === 'auto' && input.cwd !== undefined
    if (wantRepo && input.cwd !== undefined) {
      const repo = await detectRepository(input.cwd, signal)
      if (repo !== undefined) {
        const gitToken = await this.deps.gitToken()
        const repoRes = repositoryResource(repo, {
          gitToken,
          gitTokenEnv: this.deps.gitTokenEnv,
          gitUsername: this.deps.gitUsername,
        })
        resources.push(repoRes as NonNullable<CreateDeploymentRequest['resources']>[number])
        notes.push(`Mounted repository ${repo.url} into routine`)
      }
    }

    const envStr = encodeEnvVarsString(this.deps.environmentVariables)
    const schedule = input.cronExpression !== undefined && input.cronExpression.trim().length > 0
      ? {
          type: 'cron' as const,
          expression: input.cronExpression.trim(),
          timezone: (input.timezone?.trim() || DEFAULT_ROUTINE_TIMEZONE),
        }
      : undefined

    const runInstruction = [
      `[Scheduled Cloud Routine: "${name}"]`,
      taskPrompt,
      '',
      'Note: You are running as an unattended scheduled cloud routine. Do not invoke client-side tools (like `manage_bot_routine`); record durable findings in your awareness Memory Store or deliver files via `DeliverArtifacts`.',
    ].join('\n')

    const deployment = await client.createDeployment({
      name: name.slice(0, 256),
      ...input.description !== undefined ? { description: input.description } : {},
      agent: target.bot.id,
      environment_id: target.environmentId,
      ...schedule === undefined ? {} : { schedule },
      initial_events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: runInstruction }],
        },
      ],
      ...resources.length === 0 ? {} : { resources },
      ...envStr === undefined ? {} : { environment_variables: envStr },
      metadata: {
        [BOT_META_ROUTINE_FLAG]: 'true',
        [BOT_META_BOT_ID]: target.bot.id,
        [BOT_META_BOT_NAME]: target.bot.name,
      },
    }, signal)

    return { deployment, bot: target.bot, notes }
  }

  /** Read recent Deployment Runs (Offline Inbox), optionally scoped to one routine or bot. */
  async listRunsInbox(
    client: QoderCloudClient,
    options: { routineIdOrName?: string; botIdOrName?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ runs: DeploymentRunView[]; deploymentsById: ReadonlyMap<string, DeploymentView> }> {
    const deployments = await this.listRoutines(client, options.botIdOrName, signal)
    const deploymentsById = new Map(deployments.map(d => [d.id, d]))

    let deploymentId: string | undefined
    if (options.routineIdOrName !== undefined && options.routineIdOrName.trim().length > 0) {
      const matched = matchByIdOrName(deployments, options.routineIdOrName, 'routine')
      if (typeof matched === 'string') throw new Error(`qoder-bots: ${matched}`)
      deploymentId = matched.id
    }

    const limit = options.limit ?? 20
    const page = await client.listDeploymentRuns({
      ...deploymentId === undefined ? {} : { deploymentId },
      limit: options.botIdOrName !== undefined && deploymentId === undefined ? Math.max(limit * 3, 50) : limit,
    }, signal)

    const filtered = options.botIdOrName !== undefined && deploymentId === undefined
      ? page.data.filter(r => deploymentsById.has(r.deployment_id) || r.agent.id === options.botIdOrName)
      : page.data

    return { runs: filtered.slice(0, limit), deploymentsById }
  }

  /** Fetch one Deployment Run and summarize its spawned Session's final output & delivered artifacts. */
  async inspectRunReport(
    client: QoderCloudClient,
    runId: string,
    signal?: AbortSignal,
  ): Promise<RoutineRunReport> {
    const run = await client.getDeploymentRun(runId.trim(), signal)
    let deployment: DeploymentView | undefined
    try {
      deployment = await client.getDeployment(run.deployment_id, signal)
    } catch {
      // Deployment may have been archived/deleted
    }

    if (!run.session_id) {
      return { run, deployment, artifacts: [] }
    }

    const [session, eventsPage] = await Promise.all([
      client.getSession(run.session_id, signal),
      client.listSessionEvents(run.session_id, signal),
    ])

    let finalMessage: string | undefined
    const artifacts: { fileId: string; name: string; size?: number }[] = []
    for (const ev of eventsPage.data as readonly SessionEvent[]) {
      if (ev.type === 'agent.message') {
        const text = extractEventText(ev.content)
        if (text.trim().length > 0) finalMessage = text
      } else if (ev.type === 'agent.artifact_delivered' && typeof ev.file_id === 'string') {
        artifacts.push({
          fileId: ev.file_id,
          name: ev.original_filename ?? ev.file_id,
          ...typeof ev.size === 'number' ? { size: ev.size } : {},
        })
      }
    }

    return {
      run,
      deployment,
      sessionStatus: session.status,
      ...finalMessage !== undefined ? { finalMessage } : {},
      artifacts,
    }
  }

  /**
   * Handle `agent.custom_tool_use` calls for `manage_bot_routine` emitted by a
   * Qoder Cloud Bot during an interactive DSH chat turn.
   */
  async handleCustomToolCall(
    client: QoderCloudClient,
    call: CustomToolCall,
    cwd: string | undefined,
    signal: AbortSignal,
  ): Promise<{ text: string; isError?: boolean } | undefined> {
    if (call.name !== MANAGE_BOT_ROUTINE_TOOL) return undefined

    const raw = (call.input !== null && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>
    const action = typeof raw.action === 'string' ? raw.action.trim() : ''

    try {
      switch (action) {
        case 'create': {
          const name = typeof raw.name === 'string' ? raw.name : ''
          const taskPrompt = typeof raw.task_prompt === 'string' ? raw.task_prompt : ''
          const cronExpression = typeof raw.cron_expression === 'string' ? raw.cron_expression : undefined
          const timezone = typeof raw.timezone === 'string' ? raw.timezone : undefined
          const description = typeof raw.description === 'string' ? raw.description : undefined
          const includeRepository = typeof raw.include_repository === 'boolean' ? raw.include_repository : true

          const created = await this.createRoutine(client, {
            name,
            taskPrompt,
            cronExpression,
            timezone,
            description,
            botIdOrName: call.botId,
            cwd,
            includeRepository,
          }, signal)
          const d = created.deployment
          return {
            text: JSON.stringify({
              ok: true,
              deployment_id: d.id,
              name: d.name,
              status: d.status,
              schedule: d.schedule ?? null,
              upcoming_runs_at: d.schedule?.upcoming_runs_at ?? [],
            }, null, 2),
          }
        }

        case 'list': {
          const list = await this.listRoutines(client, call.botId, signal)
          return {
            text: JSON.stringify({
              ok: true,
              count: list.length,
              routines: list.map(d => ({
                id: d.id,
                name: d.name,
                status: d.status,
                schedule: d.schedule ?? null,
              })),
            }, null, 2),
          }
        }

        case 'pause':
        case 'unpause':
        case 'archive':
        case 'run_now': {
          const ref = (typeof raw.routine_id === 'string' && raw.routine_id.trim().length > 0)
            ? raw.routine_id
            : (typeof raw.name === 'string' ? raw.name : '')
          if (ref.trim().length === 0) {
            return { text: `Missing "routine_id" (or "name") for action "${action}".`, isError: true }
          }
          const target = await this.resolveRoutine(client, ref, call.botId, signal)
          if (action === 'pause') {
            const out = await client.pauseDeployment(target.id, signal)
            return { text: JSON.stringify({ ok: true, id: out.id, name: out.name, status: out.status }) }
          }
          if (action === 'unpause') {
            const out = await client.unpauseDeployment(target.id, signal)
            return { text: JSON.stringify({ ok: true, id: out.id, name: out.name, status: out.status, upcoming_runs_at: out.schedule?.upcoming_runs_at ?? [] }) }
          }
          if (action === 'archive') {
            const out = await client.archiveDeployment(target.id, signal)
            return { text: JSON.stringify({ ok: true, id: out.id, name: out.name, archived_at: out.archived_at }) }
          }
          const run = await client.runDeploymentNow(target.id, signal)
          return {
            text: JSON.stringify({
              ok: true,
              run_id: run.id,
              deployment_id: run.deployment_id,
              session_id: run.session_id,
              error: run.error ?? null,
            }, null, 2),
          }
        }

        default:
          return {
            text: `Unsupported action "${action}". Expected one of: create, list, pause, unpause, run_now, archive.`,
            isError: true,
          }
      }
    } catch (error: unknown) {
      return {
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  }
}
