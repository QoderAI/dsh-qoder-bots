/**
 * Host HTTP API & File-Streaming bridge (`/api/qoder-bots/*`) powering:
 *   1. Left-Sidebar Full-Screen **Qoder Bots Studio & Proactive Inbox**
 *   2. Conversation Right-Sidebar **Live Cloud Computer Monitor**
 *   3. Native inline image/chart rendering & 1-click Deliverable downloads
 *
 * Mounted on `ctx.connection.fetch` (authenticated JSON endpoints) and
 * `ctx.webServer` (cookie-verified `GET /api/qoder-bots/file` binary streaming
 * for `<img>` / `<a>` tags). Completely decouples all UI interactions from
 * `/qoder-bot` slash commands so conversations stay 100% clean.
 *
 * @module dsh-qoder-bots/api-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_BASE_PATH } from './bot-constants.ts'
import type { BotManager, BotSelection } from './bot-manager.ts'
import { BotWorkspaceRunner, projectSessionEventsToMessages } from './bot-workspace.ts'
import type { QoderCloudClient, SessionView } from './client.ts'
import type { DreamManager } from './dreams.ts'
import { defaultQoderTakeoverUrl, type LiveSessionTracker } from './live-tracker.ts'
import type { RoutineManager } from './routines.ts'
import { BUILTIN_BOT_TEMPLATES } from './templates.ts'

export interface BotApiDeps {
  readonly baseURL: string
  readonly client: () => Promise<QoderCloudClient | string>
  readonly manager: BotManager
  readonly routines: RoutineManager
  readonly dreams: DreamManager
  readonly tracker: LiveSessionTracker
  readonly workspace?: BotWorkspaceRunner | undefined
  readonly persist: (selection: BotSelection) => Promise<boolean>
  readonly cwd: () => string
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function inferMimeType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/plain; charset=utf-8'
  if (/\.(txt|log|ts|tsx|js|jsx|py|go|rs|java|yml|yaml|toml|sh)$/i.test(lower)) {
    return 'text/plain; charset=utf-8'
  }
  return 'application/octet-stream'
}

export function createBotApiHandlers(deps: BotApiDeps) {
  const signalOf = (req?: Request): AbortSignal => req?.signal ?? AbortSignal.timeout(60_000)
  const workspace = deps.workspace ?? new BotWorkspaceRunner({
    client: deps.client,
    manager: deps.manager,
    tracker: deps.tracker,
    toolConfirmation: 'allow',
    customToolHandler: async (call, sig) => {
      const c = await deps.client()
      if (typeof c === 'string') return { text: c, isError: true }
      return deps.routines.handleCustomToolCall(c, call, deps.cwd(), sig)
    },
  })

  const handleDashboard = async (req: Request): Promise<Response> => {
    const signal = signalOf(req)
    const c = await deps.client()
    const selection = deps.manager.currentSelection()
    if (typeof c === 'string') {
      return jsonResponse(200, {
        ok: true,
        configured: false,
        tokenError: c,
        baseURL: deps.baseURL,
        activeSelection: selection,
        templates: BUILTIN_BOT_TEMPLATES,
        environments: [],
        bots: [],
        routines: [],
        inboxRuns: [],
        pendingApprovals: deps.tracker.listPendingApprovals(),
        dreams: [],
        skills: [],
        vaults: [],
        liveComputers: deps.tracker.listComputers(),
      })
    }

    try {
      const [envsRes, bots, routines, inboxRes, dreamsRes, skillsRes, vaultsRes] = await Promise.all([
        c.listEnvironments(signal).catch(() => ({ data: [] })),
        deps.manager.listBots(c, signal),
        deps.routines.listRoutines(c, undefined, signal).catch(() => []),
        deps.routines.listRunsInbox(c, { limit: 20 }, signal).catch(() => ({ runs: [], deploymentsById: new Map() })),
        c.listDreams(15, signal).catch(() => ({ data: [] })),
        c.listSkills(signal).catch(() => ({ data: [] })),
        c.listVaults(signal).catch(() => ({ data: [] })),
      ])

      const managedBots = bots.filter(b => b.isManagedBot)
      const managedBotIds = new Set(managedBots.map(b => b.id))
      const managedRoutines = routines.filter(
        d => d.metadata?.dsh_bot_routine === 'true' || managedBotIds.has(d.agent.id),
      )
      const managedRoutineIds = new Set(managedRoutines.map(d => d.id))
      const enrichedRuns = inboxRes.runs
        .filter(r => managedRoutineIds.has(r.deployment_id) || managedBotIds.has(r.agent.id))
        .map((r) => {
          const dep = inboxRes.deploymentsById.get(r.deployment_id)
          const bot = bots.find(b => b.id === r.agent.id)
          return {
            ...r,
            routineName: dep?.name ?? r.deployment_id,
            botName: bot?.name ?? r.agent.id,
            botAvatar: bot?.avatar ?? '🤖',
          }
        })

      return jsonResponse(200, {
        ok: true,
        configured: true,
        baseURL: deps.baseURL,
        activeSelection: deps.manager.currentSelection(),
        templates: BUILTIN_BOT_TEMPLATES,
        environments: envsRes.data.filter(e => !e.archived_at),
        bots: managedBots,
        allAgentsCount: bots.length,
        routines: managedRoutines,
        inboxRuns: enrichedRuns,
        pendingApprovals: deps.tracker.listPendingApprovals(),
        dreams: dreamsRes.data.filter(d => !d.archived_at),
        skills: skillsRes.data,
        vaults: vaultsRes.data.filter(v => !v.archived_at),
        liveComputers: deps.tracker.listComputers(),
      })
    } catch (error: unknown) {
      return jsonResponse(500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleComputerStatus = async (req: Request): Promise<Response> => {
    const signal = signalOf(req)
    const url = new URL(req.url, 'http://localhost')
    const dshSessionId = url.searchParams.get('dshSessionId') ?? undefined
    const explicitRemoteId = url.searchParams.get('remoteSessionId') ?? undefined
    const explicitBotId = url.searchParams.get('botId') ?? undefined
    const includeMessages = url.searchParams.get('includeMessages') !== '0'

    const c = await deps.client()
    if (typeof c === 'string') {
      return jsonResponse(200, { ok: true, configured: false, tokenError: c })
    }

    try {
      const localBinding = deps.tracker.getLocalBotBinding(dshSessionId)
      let comp = explicitRemoteId
        ? deps.tracker.getComputer(explicitRemoteId)
        : (localBinding ? undefined : deps.tracker.getComputerByDshSession(dshSessionId))

      const bots = await deps.manager.listBots(c, signal).catch(() => [])
      const activeBotId = explicitBotId ?? localBinding?.botId ?? comp?.botId ?? deps.manager.currentSelection().botId
      const bot = (activeBotId ? bots.find(b => b.id === activeBotId) : undefined)
        ?? bots.find(b => b.isManagedBot)

      const executionMode: 'local' | 'cloud' = localBinding !== undefined ? 'local' : 'cloud'
      const remoteSessionId = executionMode === 'local'
        ? undefined
        : (explicitRemoteId ?? comp?.remoteSessionId ?? bot?.primarySessionId)
      let remoteSession: SessionView | null = null
      let environmentDetail: unknown = null
      let threads: unknown[] = []
      let messages: unknown[] = []

      if (remoteSessionId) {
        const [sess, th, msgs] = await Promise.all([
          c.getSession(remoteSessionId, signal).catch(() => null),
          c.listSessionThreads(remoteSessionId, signal).catch(() => ({ data: [] })),
          includeMessages
            ? workspace.getMessages(c, remoteSessionId, signal).catch(async () => {
                const evs = await c.listSessionEvents(remoteSessionId, signal).catch(() => ({ data: [] }))
                return projectSessionEventsToMessages(evs.data, remoteSessionId, deps.tracker)
              })
            : Promise.resolve([]),
        ])
        remoteSession = sess
        threads = th.data
        messages = msgs
        const envIdToFetch = sess?.environment_id ?? bot?.dedicatedEnvId ?? deps.manager.currentSelection().environmentId
        if (envIdToFetch) {
          environmentDetail = await c.getEnvironment(envIdToFetch, signal).catch(() => null)
        }
        if (sess !== null) {
          comp = deps.tracker.ensureComputer({
            remoteSessionId,
            dshSessionId,
            botId: bot?.id,
            botName: bot?.name,
            botAvatar: bot?.avatar,
            sessionMetadata: sess.metadata,
          })
          const activeLocally = workspace.isRunning(remoteSessionId)
          if ((sess.status === 'running' || activeLocally) && comp.status === 'idle') {
            comp.status = 'running'
          } else if (sess.status === 'idle' && !activeLocally && comp.status === 'running') {
            comp.status = 'idle'
          }
        }
      } else {
        const envIdToFetch = bot?.dedicatedEnvId ?? deps.manager.currentSelection().environmentId
        if (envIdToFetch) {
          environmentDetail = await c.getEnvironment(envIdToFetch, signal).catch(() => null)
        }
      }

      let memories: unknown[] = []
      if (bot?.memoryStoreId) {
        const memRes = await c.listMemories(bot.memoryStoreId, signal).catch(() => ({ data: [] }))
        memories = memRes.data
      }

      const approvals = deps.tracker.listPendingApprovals().filter(
        p => (remoteSessionId && p.remoteSessionId === remoteSessionId) || (dshSessionId && p.dshSessionId === dshSessionId),
      )

      return jsonResponse(200, {
        ok: true,
        configured: true,
        executionMode,
        localWorkingDirectory: deps.cwd(),
        bot: bot ?? null,
        remoteSessionId: remoteSessionId ?? null,
        remoteSession,
        environment: environmentDetail,
        slotId: remoteSession?.slot_id ?? null,
        takeoverUrl: remoteSessionId ? (comp?.takeoverUrl ?? defaultQoderTakeoverUrl(remoteSessionId)) : null,
        computer: comp ?? null,
        threads,
        messages,
        memories,
        pendingApprovals: approvals,
      })
    } catch (error: unknown) {
      return jsonResponse(500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleAction = async (req: Request): Promise<Response> => {
    const signal = signalOf(req)
    let body: Record<string, any> = {}
    try {
      body = (await req.json()) as Record<string, any>
    } catch {
      return jsonResponse(400, { ok: false, error: 'Invalid JSON request body' })
    }

    const action = String(body.action ?? '')
    const c = await deps.client()
    if (typeof c === 'string') {
      return jsonResponse(400, { ok: false, error: c })
    }

    try {
      switch (action) {
        case 'selectEnv': {
          const environmentId = String(body.environmentId ?? '').trim()
          if (!environmentId) throw new Error('Missing environmentId')
          deps.manager.remember({ environmentId })
          await deps.persist({ environmentId })
          return jsonResponse(200, { ok: true, environmentId })
        }

        case 'provisionCloudComputer': {
          const name = String(body.name ?? '').trim() || 'dsh-bots-cloud-computer'
          const idleTimeoutSeconds = typeof body.idleTimeoutSeconds === 'number'
            ? Math.max(600, Math.min(86400, Math.round(body.idleTimeoutSeconds)))
            : 3600
          const env = await c.createCloudComputerEnvironment({
            name,
            description: body.description ? String(body.description) : undefined,
            idleTimeoutSeconds,
          }, signal)
          deps.manager.remember({ environmentId: env.id })
          await deps.persist({ environmentId: env.id })
          return jsonResponse(200, { ok: true, environment: env })
        }

        case 'selectBot': {
          const botId = String(body.botId ?? '').trim()
          if (!botId) throw new Error('Missing botId')
          deps.manager.remember({ botId })
          await deps.persist({ botId })
          return jsonResponse(200, { ok: true, botId })
        }

        case 'createBot': {
          const bot = await deps.manager.createBot(c, {
            templateId: body.templateId ? String(body.templateId) : undefined,
            name: body.name ? String(body.name) : undefined,
            description: body.description ? String(body.description) : undefined,
            model: body.model ? String(body.model) : undefined,
            defaultRuntime: body.defaultRuntime === 'local' ? 'local' : 'cloud',
            approvalMode: body.approvalMode === 'gated' ? 'gated' : 'auto',
            browserEnabled: body.browserEnabled !== false,
            vaultIds: Array.isArray(body.vaultIds) ? body.vaultIds.map(String) : undefined,
            skillIds: Array.isArray(body.skillIds) ? body.skillIds.map(String) : undefined,
          }, signal)
          deps.manager.remember({ botId: bot.id })
          await deps.persist({ botId: bot.id })
          return jsonResponse(200, { ok: true, bot })
        }

        case 'createTeam': {
          const name = String(body.name ?? '').trim()
          const members = Array.isArray(body.members)
            ? body.members.map(String)
            : String(body.members ?? '').split(',').map(s => s.trim()).filter(Boolean)
          const out = await deps.manager.createTeamBot(c, {
            name,
            members,
            description: body.description ? String(body.description) : undefined,
            model: body.model ? String(body.model) : undefined,
          }, signal)
          deps.manager.remember({ botId: out.team.id })
          await deps.persist({ botId: out.team.id })
          return jsonResponse(200, { ok: true, ...out })
        }

        case 'updateBot': {
          const botId = String(body.botId ?? '').trim()
          const updated = await deps.manager.updateBotConfig(c, botId, {
            name: body.name !== undefined ? String(body.name) : undefined,
            description: body.description !== undefined ? String(body.description) : undefined,
            model: body.model !== undefined ? String(body.model) : undefined,
            defaultRuntime: body.defaultRuntime === 'local' ? 'local' : body.defaultRuntime === 'cloud' ? 'cloud' : undefined,
            approvalMode: body.approvalMode === 'gated' ? 'gated' : body.approvalMode === 'auto' ? 'auto' : undefined,
            browserEnabled: typeof body.browserEnabled === 'boolean' ? body.browserEnabled : undefined,
            dedicatedEnvId: body.dedicatedEnvId !== undefined ? String(body.dedicatedEnvId) : undefined,
            vaultIds: Array.isArray(body.vaultIds) ? body.vaultIds.map(String) : undefined,
            skillIds: Array.isArray(body.skillIds) ? body.skillIds.map(String) : undefined,
          }, signal)
          return jsonResponse(200, { ok: true, bot: updated })
        }

        case 'archiveBot': {
          const botId = String(body.botId ?? '').trim()
          await c.archiveAgent(botId, signal)
          return jsonResponse(200, { ok: true, archivedId: botId })
        }

        case 'openLocalBot': {
          const botId = String(body.botId ?? '').trim()
          const dshSessionId = String(body.dshSessionId ?? '').trim()
          if (!botId || !dshSessionId) {
            throw new Error('Both botId and dshSessionId are required for openLocalBot')
          }
          const agent = await c.getAgent(botId, signal)
          const bots = await deps.manager.listBots(c, signal)
          const bot = bots.find(b => b.id === agent.id)
          const binding = deps.tracker.bindLocalBotSession({
            dshSessionId,
            botId: agent.id,
            botName: bot?.name ?? agent.name,
            botAvatar: bot?.avatar ?? '🤖',
          })
          deps.manager.remember({ botId: agent.id })
          await deps.persist({ botId: agent.id })
          return jsonResponse(200, {
            ok: true,
            executionMode: 'local',
            bot: bot ?? null,
            binding,
          })
        }

        case 'openBotComputer': {
          const botId = String(body.botId ?? '').trim()
          const dshSessionId = body.dshSessionId ? String(body.dshSessionId).trim() : undefined
          const forceReset = Boolean(body.reset)
          const ensured = forceReset
            ? await deps.manager.resetPrimaryComputerSession(c, botId, signal)
            : await deps.manager.ensurePrimaryComputerSession(c, botId, signal)
          deps.manager.remember({ botId: ensured.bot.id })
          await deps.persist({ botId: ensured.bot.id })
          if (dshSessionId) {
            deps.tracker.bindDshSession({
              dshSessionId,
              remoteSessionId: ensured.session.id,
              botId: ensured.bot.id,
              botName: `${ensured.bot.avatar} ${ensured.bot.name}`,
            })
          }
          deps.tracker.ensureComputer({
            remoteSessionId: ensured.session.id,
            dshSessionId,
            botId: ensured.bot.id,
            botName: ensured.bot.name,
            botAvatar: ensured.bot.avatar,
            sessionMetadata: ensured.session.metadata,
          })
          return jsonResponse(200, {
            ok: true,
            bot: ensured.bot,
            remoteSessionId: ensured.session.id,
            environmentId: ensured.environmentId,
            environment: ensured.environment ?? null,
            slotId: ensured.session.slot_id ?? null,
            created: ensured.created,
          })
        }

        case 'bindSession': {
          const dshSessionId = String(body.dshSessionId ?? '').trim()
          const remoteSessionId = String(body.remoteSessionId ?? '').trim()
          const botId = body.botId ? String(body.botId).trim() : undefined
          const botName = body.botName ? String(body.botName).trim() : undefined
          if (!dshSessionId || !remoteSessionId) {
            throw new Error('Both dshSessionId and remoteSessionId are required')
          }
          deps.tracker.bindDshSession({ dshSessionId, remoteSessionId, botId, botName })
          if (botId) {
            deps.manager.remember({ botId })
            await deps.persist({ botId })
          }
          return jsonResponse(200, { ok: true, dshSessionId, remoteSessionId })
        }

        case 'inspectMemories': {
          const botRef = body.botId ? String(body.botId) : undefined
          const out = await deps.manager.inspectBotMemories(c, botRef, signal)
          return jsonResponse(200, { ok: true, ...out })
        }

        case 'readMemory': {
          const storeId = String(body.memoryStoreId ?? '').trim()
          const memoryId = String(body.memoryId ?? '').trim()
          const detail = await c.getMemory(storeId, memoryId, signal)
          return jsonResponse(200, { ok: true, entry: detail })
        }

        case 'writeMemory': {
          const out = await deps.manager.writeBotMemoryEntry(c, {
            botIdOrName: body.botId ? String(body.botId) : undefined,
            path: String(body.path ?? ''),
            content: String(body.content ?? ''),
          }, signal)
          return jsonResponse(200, { ok: true, ...out })
        }

        case 'deleteMemory': {
          const out = await deps.manager.deleteBotMemoryEntry(c, {
            botIdOrName: body.botId ? String(body.botId) : undefined,
            pathOrId: String(body.pathOrId ?? ''),
          }, signal)
          return jsonResponse(200, { ok: true, ...out })
        }

        case 'startDream': {
          const outcome = await deps.dreams.startDream(c, {
            botIdOrName: body.botId ? String(body.botId) : undefined,
            instructions: body.instructions ? String(body.instructions) : undefined,
            waitMs: typeof body.waitMs === 'number' ? body.waitMs : 8_000,
            pollIntervalMs: 800,
          }, signal)
          return jsonResponse(200, { ok: true, outcome })
        }

        case 'applyDream': {
          const outcome = await deps.dreams.applyCompletedDream(
            c,
            body.botId ? String(body.botId) : undefined,
            body.dreamId ? String(body.dreamId) : undefined,
            signal,
          )
          return jsonResponse(200, { ok: true, outcome })
        }

        case 'rollbackDream': {
          const out = await deps.dreams.rollbackMemoryStore(
            c,
            body.botId ? String(body.botId) : undefined,
            signal,
          )
          return jsonResponse(200, { ok: true, ...out })
        }

        case 'createRoutine': {
          const created = await deps.routines.createRoutine(c, {
            botIdOrName: body.botId ? String(body.botId) : undefined,
            name: String(body.name ?? ''),
            description: body.description ? String(body.description) : undefined,
            cronExpression: body.cronExpression ? String(body.cronExpression) : undefined,
            timezone: body.timezone ? String(body.timezone) : undefined,
            taskPrompt: String(body.taskPrompt ?? ''),
            cwd: deps.cwd(),
          }, signal)
          return jsonResponse(200, { ok: true, ...created })
        }

        case 'controlRoutine': {
          const id = String(body.deploymentId ?? '').trim()
          const op = String(body.op ?? '')
          if (op === 'pause') return jsonResponse(200, { ok: true, deployment: await c.pauseDeployment(id, signal) })
          if (op === 'unpause') return jsonResponse(200, { ok: true, deployment: await c.unpauseDeployment(id, signal) })
          if (op === 'archive') return jsonResponse(200, { ok: true, deployment: await c.archiveDeployment(id, signal) })
          if (op === 'run') return jsonResponse(200, { ok: true, run: await c.runDeploymentNow(id, signal) })
          throw new Error(`Unknown routine op "${op}"`)
        }

        case 'inspectRunReport': {
          const runId = String(body.runId ?? '').trim()
          const report = await deps.routines.inspectRunReport(c, runId, signal)
          return jsonResponse(200, { ok: true, report })
        }

        case 'sendBotMessage': {
          const botId = String(body.botId ?? '').trim()
          const text = String(body.text ?? '').trim()
          const remoteSessionId = body.remoteSessionId ? String(body.remoteSessionId).trim() : undefined
          if (!botId) throw new Error('Missing botId')
          if (!text) throw new Error('Missing message text')
          const out = await workspace.sendMessage({ botId, text, remoteSessionId }, signal)
          deps.manager.remember({ botId: out.bot.id })
          await deps.persist({ botId: out.bot.id })
          return jsonResponse(200, {
            ok: true,
            bot: out.bot,
            remoteSessionId: out.remoteSessionId,
            userEventId: out.userEventId ?? null,
          })
        }

        case 'interruptBotTurn': {
          const remoteSessionId = String(body.remoteSessionId ?? '').trim()
          if (!remoteSessionId) throw new Error('Missing remoteSessionId')
          await workspace.interrupt(remoteSessionId, signal)
          return jsonResponse(200, { ok: true, remoteSessionId })
        }

        case 'decideApproval': {
          const toolUseId = String(body.toolUseId ?? '').trim()
          const remoteSessionId = String(body.remoteSessionId ?? '').trim()
          const decision = body.decision === 'deny' ? 'deny' : 'allow'
          const denyMessage = body.denyMessage ? String(body.denyMessage) : undefined
          if (!toolUseId || !remoteSessionId) {
            throw new Error('Missing toolUseId or remoteSessionId')
          }
          // If an active foreground turn is awaiting this approval in LiveSessionTracker, resolving
          // the tracker wakes `answerPause()` to send `user.tool_confirmation`; otherwise send directly!
          const hadWaiter = deps.tracker.listPendingApprovals().some(p => p.toolUseId === toolUseId)
          deps.tracker.resolvePendingApproval(toolUseId, { decision, denyMessage })
          if (!hadWaiter) {
            await c.confirmSessionTool(remoteSessionId, toolUseId, decision, denyMessage, signal)
          }
          return jsonResponse(200, { ok: true, toolUseId, decision })
        }

        default:
          return jsonResponse(400, { ok: false, error: `Unknown action "${action}"` })
      }
    } catch (error: unknown) {
      return jsonResponse(500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleFileDownload = async (url: URL, signal: AbortSignal): Promise<{
    status: number
    headers: Record<string, string>
    body: Uint8Array | string
  }> => {
    const fileId = url.searchParams.get('id')?.trim()
    if (!fileId) {
      return { status: 400, headers: { 'content-type': 'text/plain' }, body: 'Missing file id' }
    }
    const c = await deps.client()
    if (typeof c === 'string') {
      return { status: 401, headers: { 'content-type': 'text/plain' }, body: c }
    }
    try {
      const explicitName = url.searchParams.get('name')?.trim()
      const inline = url.searchParams.get('inline') === '1'
      const [meta, bytes] = await Promise.all([
        explicitName ? Promise.resolve({ filename: explicitName, mime_type: undefined }) : c.getFileMetadata(fileId, signal).catch(() => ({ filename: `${fileId}.bin`, mime_type: undefined })),
        c.downloadFile(fileId, signal),
      ])
      const filename = meta.filename || explicitName || `${fileId}.bin`
      const contentType = meta.mime_type || inferMimeType(filename)
      const safeName = filename.replace(/["\r\n]/g, '_')
      const disposition = inline || contentType.startsWith('image/') || contentType.startsWith('text/')
        ? `inline; filename="${safeName}"`
        : `attachment; filename="${safeName}"`
      return {
        status: 200,
        headers: {
          'content-type': contentType,
          'content-disposition': disposition,
          'cache-control': 'private, max-age=300',
        },
        body: bytes,
      }
    } catch (error: unknown) {
      return {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Node `http` handler for `webServer.register({ kind: 'exact', path: '/api/qoder-bots/file' })`. */
  const serveNodeFileRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    checkAuth: (req: IncomingMessage) => number | undefined,
  ): Promise<void> => {
    const rejection = checkAuth(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain' })
      res.end('Unauthorized')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const out = await handleFileDownload(url, controller.signal)
    res.writeHead(out.status, out.headers)
    res.end(typeof out.body === 'string' ? out.body : Buffer.from(out.body))
  }

  return {
    paths: {
      dashboard: `${API_BASE_PATH}/dashboard`,
      computer: `${API_BASE_PATH}/computer`,
      action: `${API_BASE_PATH}/action`,
      file: `${API_BASE_PATH}/file`,
    },
    handleDashboard,
    handleComputerStatus,
    handleAction,
    handleFileFetch: async (req: Request): Promise<Response> => {
      const out = await handleFileDownload(new URL(req.url, 'http://localhost'), signalOf(req))
      const payload = typeof out.body === 'string' ? out.body : new Uint8Array(out.body)
      return new Response(payload, { status: out.status, headers: out.headers })
    },
    serveNodeFileRoute,
  }
}
