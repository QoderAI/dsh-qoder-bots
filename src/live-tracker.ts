/**
 * Live Cloud Computer & Approval Gate tracker (`LiveSessionTracker`).
 *
 * Bridges real-time Qoder Cloud session activity to both:
 *   1. The Left-Sidebar **Qoder Bots Studio & Proactive Inbox** (showing which
 *      bots are actively running on their cloud computers, unread deliverables,
 *      and `Needs Approval` human-in-the-loop gates).
 *   2. The Conversation Right-Sidebar **Cloud Computer Monitor** (live cloud
 *      Chromium viewport screenshots, current browser URL, Take Control link,
 *      live bash/file/thread activity feed, and delivered artifacts).
 *
 * Also manages clean `dshSessionId -> { remoteSessionId, botId }` pre-bindings
 * so clicking "💬 打开对话" on a Bot card or "继续追问" on an Inbox item opens
 * a native DSH chat bound directly to that cloud computer without magic text!
 *
 * @module dsh-qoder-bots/live-tracker
 */

export interface DeliveredArtifactItem {
  readonly fileId: string
  readonly filename: string
  readonly size?: number | undefined
  readonly contentType?: string | undefined
  readonly isBrowserFrame: boolean
  readonly timestamp: string
}

export interface ActivityFeedItem {
  readonly id: string
  readonly kind: 'bash' | 'browser' | 'file' | 'tool' | 'thread' | 'thinking' | 'artifact' | 'approval'
  readonly title: string
  readonly detail?: string | undefined
  readonly status?: 'running' | 'done' | 'error' | undefined
  readonly timestamp: string
}

export interface PendingApprovalItem {
  readonly toolUseId: string
  readonly remoteSessionId: string
  readonly dshSessionId?: string | undefined
  readonly botId?: string | undefined
  readonly botName: string
  readonly botAvatar: string
  readonly toolName: string
  readonly inputSummary: string
  readonly rawInput: unknown
  readonly createdAt: string
}

export interface ApprovalDecision {
  readonly decision: 'allow' | 'deny'
  readonly denyMessage?: string | undefined
}

export interface LiveCloudComputerState {
  remoteSessionId: string
  dshSessionId?: string | undefined
  botId?: string | undefined
  botName: string
  botAvatar: string
  status: 'idle' | 'running' | 'needs_approval'
  resultBranch?: string | undefined
  currentBrowserUrl?: string | undefined
  latestBrowserFrame?: DeliveredArtifactItem | undefined
  takeoverUrl: string
  artifacts: DeliveredArtifactItem[]
  activities: ActivityFeedItem[]
  updatedAt: string
}

export interface PreboundDshSession {
  readonly dshSessionId: string
  readonly remoteSessionId: string
  readonly botId?: string | undefined
  readonly botName?: string | undefined
}

const MAX_ACTIVITIES_PER_SESSION = 60

export function defaultQoderTakeoverUrl(remoteSessionId: string, metadata?: Readonly<Record<string, string>>): string {
  const direct = metadata?.agentbay_takeover_url || metadata?.takeover_url || metadata?.browser_takeover_url
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim()
  return `https://qoder.com/cloud/sessions/${encodeURIComponent(remoteSessionId)}/browser`
}

export function isImageFilename(name: string | undefined, contentType?: string): boolean {
  if (contentType?.startsWith('image/')) return true
  if (!name) return false
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(name)
}

export interface LocalBotBinding {
  readonly dshSessionId: string
  readonly botId: string
  readonly botName: string
  readonly botAvatar: string
  readonly updatedAt: string
}

export class LiveSessionTracker {
  private readonly computers = new Map<string, LiveCloudComputerState>()
  private readonly dshBindings = new Map<string, PreboundDshSession>()
  private readonly localBotBindings = new Map<string, LocalBotBinding>()
  private readonly pendingApprovals = new Map<string, PendingApprovalItem>()
  private readonly approvalWaiters = new Map<string, (decision: ApprovalDecision) => void>()
  private lastSawBrowserTool = new Set<string>()

  /** Pre-bind a DSH session to a specific remote Qoder Cloud session (Cloud Execution Mode). */
  bindDshSession(binding: PreboundDshSession): void {
    this.localBotBindings.delete(binding.dshSessionId)
    this.dshBindings.set(binding.dshSessionId, binding)
    const existing = this.computers.get(binding.remoteSessionId)
    if (existing !== undefined) {
      existing.dshSessionId = binding.dshSessionId
      existing.updatedAt = new Date().toISOString()
    } else {
      this.ensureComputer({
        remoteSessionId: binding.remoteSessionId,
        dshSessionId: binding.dshSessionId,
        botId: binding.botId,
        botName: binding.botName ?? 'Qoder Bot',
        botAvatar: '🤖',
      })
    }
  }

  /** Bind a DSH session to run a Bot locally (`Local` mode) with its persona & cloud Memory Store injected. */
  bindLocalBotSession(binding: Omit<LocalBotBinding, 'updatedAt'>): LocalBotBinding {
    this.dshBindings.delete(binding.dshSessionId)
    const entry: LocalBotBinding = {
      ...binding,
      updatedAt: new Date().toISOString(),
    }
    this.localBotBindings.set(binding.dshSessionId, entry)
    return entry
  }

  getLocalBotBinding(dshSessionId: string | undefined): LocalBotBinding | undefined {
    if (!dshSessionId) return undefined
    return this.localBotBindings.get(dshSessionId)
  }

  getBindingForDshSession(dshSessionId: string | undefined): PreboundDshSession | undefined {
    if (!dshSessionId) return undefined
    return this.dshBindings.get(dshSessionId)
  }

  getComputerByDshSession(dshSessionId: string | undefined): LiveCloudComputerState | undefined {
    if (!dshSessionId) return undefined
    const bound = this.dshBindings.get(dshSessionId)
    if (bound !== undefined) return this.computers.get(bound.remoteSessionId)
    for (const comp of this.computers.values()) {
      if (comp.dshSessionId === dshSessionId) return comp
    }
    return undefined
  }

  getComputer(remoteSessionId: string): LiveCloudComputerState | undefined {
    return this.computers.get(remoteSessionId)
  }

  listComputers(): LiveCloudComputerState[] {
    return [...this.computers.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  listPendingApprovals(): PendingApprovalItem[] {
    return [...this.pendingApprovals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  ensureComputer(init: {
    remoteSessionId: string
    dshSessionId?: string | undefined
    botId?: string | undefined
    botName?: string | undefined
    botAvatar?: string | undefined
    resultBranch?: string | undefined
    sessionMetadata?: Readonly<Record<string, string>> | undefined
  }): LiveCloudComputerState {
    const now = new Date().toISOString()
    const metaBranch = init.resultBranch ?? init.sessionMetadata?.result_branch
    let comp = this.computers.get(init.remoteSessionId)
    if (comp === undefined) {
      comp = {
        remoteSessionId: init.remoteSessionId,
        dshSessionId: init.dshSessionId,
        botId: init.botId,
        botName: init.botName ?? 'Qoder Bot',
        botAvatar: init.botAvatar ?? '🤖',
        status: 'idle',
        ...metaBranch !== undefined ? { resultBranch: metaBranch } : {},
        takeoverUrl: defaultQoderTakeoverUrl(init.remoteSessionId, init.sessionMetadata),
        artifacts: [],
        activities: [],
        updatedAt: now,
      }
      this.computers.set(init.remoteSessionId, comp)
    } else {
      if (init.dshSessionId !== undefined) comp.dshSessionId = init.dshSessionId
      if (init.botId !== undefined) comp.botId = init.botId
      if (init.botName !== undefined) comp.botName = init.botName
      if (init.botAvatar !== undefined) comp.botAvatar = init.botAvatar
      if (metaBranch !== undefined) comp.resultBranch = metaBranch
      if (init.sessionMetadata !== undefined) {
        comp.takeoverUrl = defaultQoderTakeoverUrl(init.remoteSessionId, init.sessionMetadata)
      }
      comp.updatedAt = now
    }
    if (init.dshSessionId !== undefined) {
      this.dshBindings.set(init.dshSessionId, {
        dshSessionId: init.dshSessionId,
        remoteSessionId: init.remoteSessionId,
        botId: comp.botId,
        botName: comp.botName,
      })
    }
    return comp
  }

  setStatus(remoteSessionId: string, status: LiveCloudComputerState['status']): void {
    const comp = this.ensureComputer({ remoteSessionId })
    comp.status = status
    comp.updatedAt = new Date().toISOString()
  }

  recordToolUse(
    remoteSessionId: string,
    eventId: string,
    toolName: string,
    input: unknown,
    summary: string,
  ): void {
    const comp = this.ensureComputer({ remoteSessionId })
    comp.status = 'running'
    const lower = toolName.toLowerCase()
    const rec = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>

    let kind: ActivityFeedItem['kind'] = 'tool'
    if (lower.startsWith('browser_')) {
      kind = 'browser'
      this.lastSawBrowserTool.add(remoteSessionId)
      if (lower === 'browser_navigate' && typeof rec.url === 'string' && rec.url.length > 0) {
        comp.currentBrowserUrl = rec.url
      }
    } else if (lower === 'bash') {
      kind = 'bash'
      if (typeof rec.command === 'string') {
        const pushMatch = /git\s+push(?:\s+-u)?\s+origin\s+([^\s;&|]+)/.exec(rec.command)
          || /git\s+checkout\s+-b\s+([^\s;&|]+)/.exec(rec.command)
        if (pushMatch?.[1]) {
          comp.resultBranch = pushMatch[1]
        }
      }
    } else if (lower === 'write' || lower === 'edit' || lower === 'read') {
      kind = 'file'
    }

    this.pushActivity(comp, {
      id: eventId,
      kind,
      title: toolName,
      detail: summary,
      status: 'running',
      timestamp: new Date().toISOString(),
    })
  }

  recordArtifact(
    remoteSessionId: string,
    artifact: { fileId: string; filename: string; size?: number | undefined; contentType?: string | undefined },
  ): DeliveredArtifactItem {
    const comp = this.ensureComputer({ remoteSessionId })
    const isImg = isImageFilename(artifact.filename, artifact.contentType)
    const isBrowserFrame = isImg && (
      /browser|screenshot|screen|page|capture|viewport/i.test(artifact.filename)
      || this.lastSawBrowserTool.has(remoteSessionId)
    )
    const item: DeliveredArtifactItem = {
      fileId: artifact.fileId,
      filename: artifact.filename,
      size: artifact.size,
      contentType: artifact.contentType,
      isBrowserFrame,
      timestamp: new Date().toISOString(),
    }
    if (!comp.artifacts.some(a => a.fileId === item.fileId)) {
      comp.artifacts.unshift(item)
    }
    if (isImg && (isBrowserFrame || comp.latestBrowserFrame === undefined)) {
      comp.latestBrowserFrame = item
    }
    this.pushActivity(comp, {
      id: `art_${artifact.fileId}`,
      kind: 'artifact',
      title: isBrowserFrame ? `📸 实时画面已更新: ${artifact.filename}` : `📦 交付产物: ${artifact.filename}`,
      detail: artifact.fileId,
      status: 'done',
      timestamp: item.timestamp,
    })
    return item
  }

  recordThreadActivity(remoteSessionId: string, id: string, title: string, detail?: string): void {
    const comp = this.ensureComputer({ remoteSessionId })
    this.pushActivity(comp, {
      id,
      kind: 'thread',
      title,
      detail,
      status: 'done',
      timestamp: new Date().toISOString(),
    })
  }

  /** Register a pending human-in-the-loop approval and wait until decided via UI or chat. */
  registerPendingApproval(item: PendingApprovalItem): Promise<ApprovalDecision> {
    this.pendingApprovals.set(item.toolUseId, item)
    const comp = this.ensureComputer({
      remoteSessionId: item.remoteSessionId,
      dshSessionId: item.dshSessionId,
      botId: item.botId,
      botName: item.botName,
      botAvatar: item.botAvatar,
    })
    comp.status = 'needs_approval'
    this.pushActivity(comp, {
      id: `appr_${item.toolUseId}`,
      kind: 'approval',
      title: `🛡️ 待审批: ${item.toolName}`,
      detail: item.inputSummary,
      status: 'running',
      timestamp: item.createdAt,
    })

    return new Promise<ApprovalDecision>((resolve) => {
      this.approvalWaiters.set(item.toolUseId, resolve)
    })
  }

  /** Resolve a pending approval from either the Inbox/Cloud Computer UI OR the DSH chat prompt. */
  resolvePendingApproval(toolUseId: string, decision: ApprovalDecision): PendingApprovalItem | undefined {
    const pending = this.pendingApprovals.get(toolUseId)
    this.pendingApprovals.delete(toolUseId)
    const waiter = this.approvalWaiters.get(toolUseId)
    this.approvalWaiters.delete(toolUseId)
    if (pending !== undefined) {
      const comp = this.computers.get(pending.remoteSessionId)
      if (comp !== undefined) {
        const stillWaiting = [...this.pendingApprovals.values()].some(p => p.remoteSessionId === pending.remoteSessionId)
        comp.status = stillWaiting ? 'needs_approval' : 'running'
        comp.updatedAt = new Date().toISOString()
      }
    }
    waiter?.(decision)
    return pending
  }

  cancelPendingApproval(toolUseId: string): void {
    this.pendingApprovals.delete(toolUseId)
    this.approvalWaiters.delete(toolUseId)
  }

  private pushActivity(comp: LiveCloudComputerState, item: ActivityFeedItem): void {
    const existingIdx = comp.activities.findIndex(a => a.id === item.id)
    if (existingIdx >= 0) {
      comp.activities[existingIdx] = item
    } else {
      comp.activities.unshift(item)
      if (comp.activities.length > MAX_ACTIVITIES_PER_SESSION) {
        comp.activities.length = MAX_ACTIVITIES_PER_SESSION
      }
    }
    comp.updatedAt = item.timestamp
  }
}
