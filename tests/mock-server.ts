import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: any
}

type Script = (ctx: StreamContext) => Promise<void>

export interface StreamContext {
  emit(event: Record<string, unknown>): string
  heartbeat(): void
  drop(): void
  waitFor(type: string): Promise<any>
  readonly lastEventId: string | undefined
  readonly connection: number
  readonly sessionId: string
}

export interface MockAgentState {
  id: string
  name: string
  description?: string
  system?: string
  model?: unknown
  tools?: any[]
  multiagent?: any
  version?: number
  metadata?: Record<string, string>
  archived_at?: string | null
}

export interface MockMemoryStoreState {
  id: string
  name: string
  description?: string | null
  metadata?: Record<string, string>
  archived_at?: string | null
  entries: { id: string; path: string; content: string; version: number; content_size_bytes: number }[]
}

export interface MockDeploymentState {
  id: string
  name: string
  description: string
  status: 'active' | 'paused'
  agent: { id: string; type: 'agent'; version: number }
  environment_id: string
  schedule: { type: 'cron'; expression: string; timezone: string; upcoming_runs_at: string[] } | null
  initial_events: any[]
  resources: any[]
  metadata: Record<string, string>
  environment_variables?: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface MockDeploymentRunState {
  id: string
  type: 'deployment_run'
  deployment_id: string
  agent: { id: string; type: 'agent'; version: number }
  session_id: string | null
  error: { type: string; message: string } | null
  trigger_context: { type: string }
  created_at: string
}

export interface MockDreamState {
  id: string
  type: 'dream'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled'
  inputs: any[]
  outputs: { type: 'memory_store'; memory_store_id: string; files_touched: string[] }[]
  model: unknown
  instructions?: string
  session_id: string | null
  error: { type: string; message: string } | null
  created_at: string
  ended_at: string | null
  archived_at: string | null
  _targetOutputStoreId: string
  _polls: number
}

/** Scriptable stand-in for the Qoder Cloud Agents Managed API gateway (`/api/v1/cloud`). */
export async function startMockQoder(options: {
  environments?: {
    id: string
    name: string
    archived_at?: string | null
    config?: { type: string; runtime_mode?: string; idle_timeout_seconds?: number }
    runtime?: { status: string }
    usage?: { credits: number }
  }[]
  agents?: MockAgentState[]
  memoryStores?: MockMemoryStoreState[]
  sessionHistory?: Record<string, Record<string, unknown>[]>
  stream: Script
  port?: number
  sessionId?: string
}) {
  const defaultSid = options.sessionId ?? 'sess_1'
  const requests: RecordedRequest[] = []
  const posted: any[] = []
  const waiters: { type: string; resolve: (event: any) => void }[] = []
  const envs = [...(options.environments ?? [])]
  const agents: MockAgentState[] = (options.agents ?? []).map(a => ({ version: 1, metadata: {}, tools: [], ...a }))
  const memoryStores: MockMemoryStoreState[] = (options.memoryStores ?? []).map(s => ({ ...s, entries: [...s.entries] }))
  const deployments: MockDeploymentState[] = []
  const deploymentRuns: MockDeploymentRunState[] = []
  const dreams: MockDreamState[] = []
  const sessions: {
    id: string
    agent_id?: string
    environment_id?: string
    slot_id?: string
    status: string
    title: string | null
    created_at: string
  }[] = []
  const sessionThreads = new Map<string, any[]>()
  const uploadedFiles: { id: string; filename: string; size_bytes: number; rawBody: Buffer }[] = []
  const sessionResources: { sessionId: string; file_id: string; mount_path?: string }[] = []
  const sessionEventsBySid = new Map<string, Record<string, unknown>[]>(
    Object.entries(options.sessionHistory ?? {}).map(([k, v]) => [k, [...v]]),
  )

  let seq = 0
  let agentSeq = agents.length
  let storeSeq = memoryStores.length
  let depSeq = 0
  let runSeq = 0
  let dreamSeq = 0
  let memSeq = 0
  let fileSeq = 0
  let sessSeq = 0
  let connections = 0
  const nextId = () => `sevt_${String(++seq).padStart(4, '0')}`

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/api\/v1\/cloud/, '')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const rawBuf = Buffer.concat(chunks)
    const contentType = req.headers['content-type'] ?? ''
    let body: any
    if (rawBuf.length > 0 && contentType.includes('application/json')) {
      body = JSON.parse(rawBuf.toString('utf8'))
    } else if (rawBuf.length > 0) {
      body = `<binary ${rawBuf.length} bytes>`
    }
    requests.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, headers: req.headers, body })

    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }

    // Unauthenticated presigned storage download endpoint (used by `qca-sdk` `downloadFile` step 2)
    const storageBlobMatch = /^\/mock-storage\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && storageBlobMatch !== null) {
      const f = uploadedFiles.find(x => x.id === storageBlobMatch[1])
      if (f) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(f.rawBody)
        return
      }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      return
    }

    if (req.headers.authorization !== 'Bearer pt-test') {
      json(401, { type: 'error', request_id: 'req_1', error: { type: 'authentication_error', message: 'bad token' } })
      return
    }

    // Environments, Skills & Vaults
    if (req.method === 'GET' && path === '/skills') {
      return json(200, { data: [{ id: 'skill_pr_audit', display_title: 'PR Security Audit', description: 'Audits diffs' }] })
    }
    if (req.method === 'GET' && path === '/vaults') {
      return json(200, { data: [{ id: 'vlt_prod_ro', display_name: 'Prod ReadOnly Credentials', archived_at: null }] })
    }
    if (req.method === 'GET' && path === '/environments') return json(200, { data: envs })
    if (req.method === 'POST' && path === '/environments') {
      const cfg = body.config ?? { type: 'cloud' }
      const isShared = cfg?.runtime_mode === 'shared'
      const created = {
        id: `env_${envs.length + 1}`,
        type: 'environment',
        name: body.name,
        description: body.description ?? '',
        config: isShared
          ? { type: 'cloud', runtime_mode: 'shared', idle_timeout_seconds: cfg.idle_timeout_seconds ?? 3600, ...cfg }
          : cfg,
        ...isShared ? { runtime: { status: 'ready' }, usage: { credits: 0 } } : {},
        metadata: body.metadata ?? {},
        archived_at: null,
      }
      envs.push(created)
      return json(200, created)
    }
    const envGetMatch = /^\/environments\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && envGetMatch !== null) {
      const hit = envs.find(e => e.id === envGetMatch[1])
      if (!hit) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'environment' } })
      return json(200, hit)
    }

    // Agents
    if (req.method === 'GET' && path === '/agents') return json(200, { data: agents })
    if (req.method === 'POST' && path === '/agents') {
      const normalizedMultiagent = body.multiagent
        ? {
            type: body.multiagent.type,
            agents: (body.multiagent.agents ?? []).map((entry: any) =>
              typeof entry === 'string' ? { type: 'agent', id: entry, version: 1 } : entry,
            ),
          }
        : null
      const created: MockAgentState = {
        id: `agent_${++agentSeq}`,
        name: body.name,
        description: body.description ?? '',
        system: body.system ?? '',
        model: body.model ?? 'ultimate',
        tools: body.tools ?? [],
        multiagent: normalizedMultiagent,
        version: 1,
        metadata: body.metadata ?? {},
        archived_at: null,
      }
      agents.push(created)
      return json(200, created)
    }
    const agentMatch = /^\/agents\/([^/]+)$/.exec(path)
    if (agentMatch !== null) {
      const id = agentMatch[1]!
      const found = agents.find(a => a.id === id)
      if (!found) return json(404, { type: 'error', error: { type: 'not_found_error', message: `agent ${id}` } })
      if (req.method === 'GET') return json(200, found)
      if (req.method === 'POST') {
        if (body.version !== undefined && body.version !== found.version) {
          return json(409, { type: 'error', error: { type: 'conflict_error', message: 'version mismatch' } })
        }
        if (body.name !== undefined) found.name = body.name
        if (body.description !== undefined) found.description = body.description ?? ''
        if (body.system !== undefined) found.system = body.system ?? ''
        if (body.tools !== undefined) found.tools = body.tools ?? []
        if ((body as any).skills !== undefined) (found as any).skills = (body as any).skills ?? []
        if (body.multiagent !== undefined) found.multiagent = body.multiagent
        if (body.metadata !== undefined) found.metadata = body.metadata ?? {}
        found.version = (found.version ?? 1) + 1
        return json(200, found)
      }
    }
    const agentArchiveMatch = /^\/agents\/([^/]+)\/archive$/.exec(path)
    if (req.method === 'POST' && agentArchiveMatch !== null) {
      const found = agents.find(a => a.id === agentArchiveMatch[1])
      if (!found) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'agent' } })
      found.archived_at = new Date().toISOString()
      return json(200, found)
    }

    // Deployments & Deployment Runs
    if (req.method === 'GET' && path === '/deployments') {
      const agentFilter = url.searchParams.get('agent_id')
      const statusFilter = url.searchParams.get('status')
      const filtered = deployments.filter(d =>
        d.archived_at === null
        && (agentFilter === null || d.agent.id === agentFilter)
        && (statusFilter === null || d.status === statusFilter),
      )
      return json(200, { data: filtered })
    }
    if (req.method === 'POST' && path === '/deployments') {
      const agentId = typeof body.agent === 'string' ? body.agent : body.agent?.id
      const now = new Date().toISOString()
      const dep: MockDeploymentState = {
        id: `dep_${++depSeq}`,
        name: body.name,
        description: body.description ?? '',
        status: 'active',
        agent: { id: agentId, type: 'agent', version: 1 },
        environment_id: body.environment_id,
        schedule: body.schedule
          ? {
              type: 'cron',
              expression: body.schedule.expression,
              timezone: body.schedule.timezone,
              upcoming_runs_at: ['2026-11-26T01:00:00Z', '2026-11-27T01:00:00Z'],
            }
          : null,
        initial_events: body.initial_events ?? [],
        resources: body.resources ?? [],
        metadata: body.metadata ?? {},
        ...body.environment_variables !== undefined ? { environment_variables: body.environment_variables } : {},
        archived_at: null,
        created_at: now,
        updated_at: now,
      }
      deployments.push(dep)
      return json(200, dep)
    }
    const depActionMatch = /^\/deployments\/([^/]+)(?:\/(pause|unpause|archive|run))?$/.exec(path)
    if (depActionMatch !== null) {
      const depId = depActionMatch[1]!
      const action = depActionMatch[2]
      const found = deployments.find(d => d.id === depId)
      if (!found) return json(404, { type: 'error', error: { type: 'not_found_error', message: `deployment ${depId}` } })
      if (action === undefined && req.method === 'GET') return json(200, found)
      if (action === undefined && (req.method === 'PATCH' || req.method === 'POST')) {
        if (body.name !== undefined) found.name = body.name
        if (body.resources !== undefined) found.resources = body.resources ?? []
        found.updated_at = new Date().toISOString()
        return json(200, found)
      }
      if (req.method === 'POST' && action === 'pause') {
        found.status = 'paused'
        return json(200, found)
      }
      if (req.method === 'POST' && action === 'unpause') {
        found.status = 'active'
        return json(200, found)
      }
      if (req.method === 'POST' && action === 'archive') {
        found.archived_at = new Date().toISOString()
        return json(200, found)
      }
      if (req.method === 'POST' && action === 'run') {
        const spawnedSid = `sess_routine_${++sessSeq}`
        sessionEventsBySid.set(spawnedSid, [
          {
            id: nextId(),
            type: 'agent.artifact_delivered',
            file_id: 'file_digest_1',
            original_filename: 'daily-digest.md',
            size: 1024,
          },
          {
            id: nextId(),
            type: 'agent.message',
            content: [{ type: 'text', text: `Routine "${found.name}" completed: 3 new commits reviewed, 0 critical issues.` }],
          },
          {
            id: nextId(),
            type: 'session.status_idle',
            stop_reason: { type: 'end_turn' },
          },
        ])
        const run: MockDeploymentRunState = {
          id: `drun_${++runSeq}`,
          type: 'deployment_run',
          deployment_id: found.id,
          agent: found.agent,
          session_id: spawnedSid,
          error: null,
          trigger_context: { type: 'manual' },
          created_at: new Date().toISOString(),
        }
        deploymentRuns.unshift(run)
        return json(200, run)
      }
    }
    if (req.method === 'GET' && path === '/deployment_runs') {
      const depFilter = url.searchParams.get('deployment_id')
      const filtered = depFilter ? deploymentRuns.filter(r => r.deployment_id === depFilter) : deploymentRuns
      return json(200, { data: filtered })
    }
    const drunMatch = /^\/deployment_runs\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && drunMatch !== null) {
      const found = deploymentRuns.find(r => r.id === drunMatch[1])
      if (!found) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'deployment_run' } })
      return json(200, found)
    }

    // Memory Stores & Memories
    if (req.method === 'GET' && path === '/memory_stores') return json(200, { data: memoryStores })
    if (req.method === 'POST' && path === '/memory_stores') {
      const store: MockMemoryStoreState = {
        id: `memstore_${++storeSeq}`,
        name: body.name,
        description: body.description ?? '',
        metadata: body.metadata ?? {},
        archived_at: null,
        entries: [],
      }
      memoryStores.push(store)
      return json(201, store)
    }
    const storeMatch = /^\/memory_stores\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && storeMatch !== null) {
      const store = memoryStores.find(s => s.id === storeMatch[1])
      if (!store) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'store' } })
      return json(200, { ...store, entry_count: store.entries.length })
    }
    const memoriesListMatch = /^\/memory_stores\/([^/]+)\/memories$/.exec(path)
    if (memoriesListMatch !== null) {
      const store = memoryStores.find(s => s.id === memoriesListMatch[1])
      if (!store) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'store' } })
      if (req.method === 'GET') {
        return json(200, {
          data: store.entries.map(({ content: _c, ...meta }) => ({ type: 'memory', memory_store_id: store.id, ...meta })),
        })
      }
      if (req.method === 'POST') {
        const entry = {
          id: `mem_${++memSeq}`,
          path: body.path,
          content: body.content,
          version: 1,
          content_size_bytes: Buffer.byteLength(body.content ?? '', 'utf8'),
        }
        store.entries.push(entry)
        return json(201, { type: 'memory', memory_store_id: store.id, ...entry })
      }
    }
    const memoryItemMatch = /^\/memory_stores\/([^/]+)\/memories\/([^/]+)$/.exec(path)
    if (memoryItemMatch !== null) {
      const store = memoryStores.find(s => s.id === memoryItemMatch[1])
      const entryIdx = store?.entries.findIndex(e => e.id === memoryItemMatch[2]) ?? -1
      const entry = entryIdx >= 0 ? store?.entries[entryIdx] : undefined
      if (!store || !entry) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'memory' } })
      if (req.method === 'GET') {
        return json(200, { type: 'memory', memory_store_id: store.id, ...entry })
      }
      if (req.method === 'POST') {
        entry.content = body.content ?? entry.content
        entry.version += 1
        entry.content_size_bytes = Buffer.byteLength(entry.content, 'utf8')
        return json(200, { type: 'memory', memory_store_id: store.id, ...entry })
      }
      if (req.method === 'DELETE') {
        store.entries.splice(entryIdx, 1)
        return json(200, { id: entry.id, type: 'deleted_memory' })
      }
    }

    // Dreams (Copy-on-Write Memory Consolidation)
    if (req.method === 'GET' && path === '/dreams') {
      return json(200, { data: dreams.filter(d => !d.archived_at) })
    }
    if (req.method === 'POST' && path === '/dreams') {
      const inputStoreRef = (body.inputs ?? []).find((i: any) => i.type === 'memory_store')
      const inputSessionsRef = (body.inputs ?? []).find((i: any) => i.type === 'sessions')
      const srcStore = memoryStores.find(s => s.id === inputStoreRef?.memory_store_id)
      const sessionCount = Array.isArray(inputSessionsRef?.session_ids) ? inputSessionsRef.session_ids.length : 0

      // Copy-on-Write: clone entries into a brand-new MemoryStore without mutating `srcStore`!
      const clonedEntries = (srcStore?.entries ?? []).map(e => ({ ...e, id: `mem_${++memSeq}` }))
      const summaryContent = `# Consolidated Memory\n\nSynthesized from ${sessionCount} session(s).\nInstructions: ${body.instructions ?? 'default'}\n`
      clonedEntries.push({
        id: `mem_${++memSeq}`,
        path: 'consolidated-summary.md',
        content: summaryContent,
        version: 1,
        content_size_bytes: Buffer.byteLength(summaryContent, 'utf8'),
      })
      const clonedStore: MockMemoryStoreState = {
        id: `memstore_${++storeSeq}`,
        name: `${srcStore?.name ?? 'bot-memory'}-consolidated`,
        description: `Dream consolidated store from ${srcStore?.id ?? 'unknown'}`,
        metadata: { ...(srcStore?.metadata ?? {}), dream_consolidated: 'true' },
        archived_at: null,
        entries: clonedEntries,
      }
      memoryStores.push(clonedStore)

      const now = new Date().toISOString()
      const dream: MockDreamState = {
        id: `drm_${++dreamSeq}`,
        type: 'dream',
        status: 'running',
        inputs: body.inputs ?? [],
        outputs: [],
        model: body.model ?? 'ultimate',
        ...body.instructions !== undefined ? { instructions: body.instructions } : {},
        session_id: `sess_dream_${dreamSeq}`,
        error: null,
        created_at: now,
        ended_at: null,
        archived_at: null,
        _targetOutputStoreId: clonedStore.id,
        _polls: 0,
      }
      dreams.unshift(dream)
      const { _targetOutputStoreId: _t, _polls: _p, ...publicView } = dream
      return json(201, publicView)
    }
    const dreamActionMatch = /^\/dreams\/([^/]+)(?:\/(cancel|archive))?$/.exec(path)
    if (dreamActionMatch !== null) {
      const drm = dreams.find(d => d.id === dreamActionMatch[1])
      if (!drm) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'dream' } })
      const action = dreamActionMatch[2]
      if (action === undefined && req.method === 'GET') {
        drm._polls += 1
        if (drm.status === 'running' && drm._polls >= 1) {
          drm.status = 'completed'
          drm.outputs = [{
            type: 'memory_store',
            memory_store_id: drm._targetOutputStoreId,
            files_touched: ['consolidated-summary.md'],
          }]
          drm.ended_at = new Date().toISOString()
        }
        const { _targetOutputStoreId: _t, _polls: _p, ...publicView } = drm
        return json(200, publicView)
      }
      if (req.method === 'POST' && action === 'cancel') {
        drm.status = 'canceled'
        drm.ended_at = new Date().toISOString()
        const { _targetOutputStoreId: _t, _polls: _p, ...publicView } = drm
        return json(200, publicView)
      }
      if (req.method === 'POST' && action === 'archive') {
        drm.archived_at = new Date().toISOString()
        const { _targetOutputStoreId: _t, _polls: _p, ...publicView } = drm
        return json(200, publicView)
      }
    }

    // Files
    if (req.method === 'POST' && path === '/files') {
      const rawText = rawBuf.toString('latin1')
      const fnMatch = /filename="([^"]+)"/.exec(rawText)
      const filename = fnMatch?.[1] ?? 'uploaded.bin'
      const file = {
        id: `file_${++fileSeq}`,
        type: 'file',
        filename,
        size_bytes: rawBuf.length,
        downloadable: true,
        rawBody: rawBuf,
      }
      uploadedFiles.push(file)
      return json(200, { id: file.id, type: 'file', filename: file.filename, size_bytes: file.size_bytes, downloadable: true })
    }
    const fileContentMatch = /^\/files\/([^/]+)\/content$/.exec(path)
    if (req.method === 'GET' && fileContentMatch !== null) {
      const addr = server.address() as AddressInfo
      const host = addr.address.includes(':') ? `[${addr.address}]` : addr.address
      return json(200, { url: `http://${host}:${addr.port}/mock-storage/${fileContentMatch[1]!}` })
    }
    const fileMetaMatch = /^\/files\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && fileMetaMatch !== null) {
      const f = uploadedFiles.find(x => x.id === fileMetaMatch[1])
      if (!f) {
        return json(200, { id: fileMetaMatch[1], type: 'file', filename: `${fileMetaMatch[1]}.png`, size_bytes: 8, downloadable: true })
      }
      return json(200, { id: f.id, type: 'file', filename: f.filename, size_bytes: f.size_bytes, downloadable: true })
    }

    // Sessions & Threads
    if (req.method === 'GET' && path === '/sessions') {
      const agentFilter = url.searchParams.get('agent_id')
      const filtered = agentFilter ? sessions.filter(s => s.agent_id === agentFilter) : sessions
      return json(200, { data: filtered })
    }
    if (req.method === 'POST' && path === '/sessions') {
      const id = ++sessSeq === 1 ? defaultSid : `sess_${sessSeq}`
      const agentId = typeof body.agent === 'string' ? body.agent : body.agent?.id
      const created = {
        id,
        ...agentId !== undefined ? { agent_id: agentId } : {},
        ...typeof body.environment_id === 'string' ? { environment_id: body.environment_id } : {},
        ...typeof body.slot_id === 'string' && body.slot_id.length > 0 ? { slot_id: body.slot_id } : {},
        status: 'idle',
        title: body.title ?? null,
        created_at: new Date().toISOString(),
      }
      sessions.unshift(created)
      return json(200, created)
    }
    const sessThreadsMatch = /^\/sessions\/([^/]+)\/threads$/.exec(path)
    if (req.method === 'GET' && sessThreadsMatch !== null) {
      return json(200, { data: sessionThreads.get(sessThreadsMatch[1]!) ?? [] })
    }
    const sessGetMatch = /^\/sessions\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && sessGetMatch !== null) {
      const existing = sessions.find(s => s.id === sessGetMatch[1])
      return json(200, existing ?? { id: sessGetMatch[1], status: 'idle' })
    }
    const sessResMatch = /^\/sessions\/([^/]+)\/resources$/.exec(path)
    if (req.method === 'POST' && sessResMatch !== null) {
      const rec = { sessionId: sessResMatch[1]!, file_id: body.file_id, mount_path: body.mount_path }
      sessionResources.push(rec)
      return json(200, { id: `sres_${sessionResources.length}`, type: 'file', ...rec })
    }
    const sessEventsMatch = /^\/sessions\/([^/]+)\/events$/.exec(path)
    if (sessEventsMatch !== null) {
      const sid = sessEventsMatch[1]!
      if (req.method === 'GET') {
        return json(200, { data: sessionEventsBySid.get(sid) ?? [] })
      }
      if (req.method === 'POST') {
        const data = body.events.map((event: any) => ({ ...event, id: nextId() }))
        posted.push(...data)
        const history = sessionEventsBySid.get(sid) ?? []
        history.push(...data)
        sessionEventsBySid.set(sid, history)
        for (const event of data) {
          for (const waiter of waiters.filter(w => w.type === event.type)) {
            waiters.splice(waiters.indexOf(waiter), 1)
            waiter.resolve(event)
            ;(event as any).consumed = true
          }
        }
        return json(200, { data })
      }
    }
    const sessCancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(path)
    if (req.method === 'POST' && sessCancelMatch !== null) {
      return json(202, { id: sessCancelMatch[1], type: 'session', status: 'canceling' })
    }
    const sessArchiveMatch = /^\/sessions\/([^/]+)\/archive$/.exec(path)
    if (req.method === 'POST' && sessArchiveMatch !== null) {
      const existing = sessions.find(s => s.id === sessArchiveMatch[1])
      if (existing) existing.status = 'terminated'
      return json(200, { id: sessArchiveMatch[1], status: 'terminated' })
    }
    const sessStreamMatch = /^\/sessions\/([^/]+)\/events\/stream$/.exec(path)
    if (req.method === 'GET' && sessStreamMatch !== null) {
      return stream(req, res, sessStreamMatch[1]!)
    }

    json(404, { type: 'error', error: { type: 'not_found_error', message: path } })
  })

  const stream = async (req: IncomingMessage, res: ServerResponse, sessionId: string) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.flushHeaders()
    const header = req.headers['last-event-id']
    const ctx: StreamContext = {
      emit(event) {
        const id = nextId()
        const payload = { id, processed_at: new Date().toISOString(), ...event }
        const history = sessionEventsBySid.get(sessionId) ?? []
        history.push(payload)
        sessionEventsBySid.set(sessionId, history)
        if (event.type === 'session.thread_created' && typeof event.session_thread_id === 'string') {
          const list = sessionThreads.get(sessionId) ?? []
          list.push({
            id: event.session_thread_id,
            session_id: sessionId,
            status: 'running',
            agent: { name: event.agent_name ?? 'member-bot' },
            created_at: new Date().toISOString(),
          })
          sessionThreads.set(sessionId, list)
        }
        if (event.type === 'session.thread_status_idle' && typeof event.session_thread_id === 'string') {
          const hit = (sessionThreads.get(sessionId) ?? []).find(t => t.id === event.session_thread_id)
          if (hit) hit.status = 'idle'
        }
        const frame = JSON.stringify(payload)
        res.write(`id: ${id}\r\nevent: ${String(event.type)}\r\ndata: ${frame}\r\n\r\n`)
        return id
      },
      heartbeat() { res.write(': heartbeat\n\n') },
      drop() { setTimeout(() => res.destroy(), 50) },
      waitFor(type) {
        const seen = posted.find(e => e.type === type && !e.consumed)
        if (seen !== undefined) {
          seen.consumed = true
          return Promise.resolve(seen)
        }
        return new Promise(resolve => waiters.push({ type, resolve }))
      },
      lastEventId: Array.isArray(header) ? header[0] : header,
      connection: ++connections,
      sessionId,
    }
    try {
      await options.stream(ctx)
    } catch {
      // client disconnected
    }
  }

  await new Promise<void>(resolve => server.listen(options.port ?? 0, resolve))
  const { address, port } = server.address() as AddressInfo
  const host = address.includes(':') ? `[${address}]` : address
  return {
    baseURL: `http://${host}:${port}/api/v1/cloud`,
    requests,
    posted,
    agents,
    memoryStores,
    deployments,
    deploymentRuns,
    dreams,
    sessions,
    uploadedFiles,
    sessionResources,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
