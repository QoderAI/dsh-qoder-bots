/**
 * Dream Memory Consolidation (`POST /api/v1/cloud/dreams`) with Copy-on-Write
 * atomic pointer switching and one-click rollback!
 *
 * How Qoder Cloud Dreams work in Managed Mode:
 *   - `POST /dreams` takes `{ type: "memory_store", memory_store_id: storeA }`
 *     plus up to 100 recent `{ type: "sessions", session_ids: [...] }` of that Bot.
 *   - It NEVER mutates `storeA`. When `status === "completed"`, `outputs[0]`
 *     yields a brand-new consolidated clone `storeB` (`files_touched` lists
 *     added/merged/pruned markdown notes).
 *   - `DreamManager.applyCompletedDream()` atomically updates:
 *       1. `agent.metadata.dsh_prev_memory_store_id = storeA` (for instant rollback!)
 *       2. `agent.metadata.dsh_memory_store_id = storeB` (OCC `version` guarded)
 *       3. Every non-archived `Deployment` (24/7 Routine) belonging to that Bot
 *          whose `resources[]` referenced `storeA` -> swapped to `storeB`.
 *
 * @module dsh-qoder-bots/dreams
 */

import {
  BOT_META_LAST_DREAM_ID,
  BOT_META_MEMORY_STORE_ID,
  BOT_META_PREV_MEMORY_STORE_ID,
} from './bot-constants.ts'
import { matchByIdOrName, toBotProfile, type BotManager, type BotProfile } from './bot-manager.ts'
import {
  delay,
  type CreateDreamRequest,
  type DreamView,
  type QoderCloudClient,
  type UpdateDeploymentRequest,
} from './client.ts'

export interface StartDreamOptions {
  readonly botIdOrName?: string | undefined
  readonly instructions?: string | undefined
  readonly model?: string | undefined
  /** Max recent sessions of this Bot to feed into consolidation (default 20, max 100). */
  readonly maxRecentSessions?: number | undefined
  /** Wait up to this many ms for fast completion before returning pending status (default 15_000). */
  readonly waitMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
}

export interface DreamConsolidationOutcome {
  readonly bot: BotProfile
  readonly dream: DreamView
  readonly switched: boolean
  readonly previousStoreId?: string | undefined
  readonly newStoreId?: string | undefined
  readonly filesTouched: readonly string[]
  readonly updatedRoutineIds: readonly string[]
}

export class DreamManager {
  constructor(private readonly bots: BotManager) {}

  private async targetBot(
    client: QoderCloudClient,
    botIdOrName: string | undefined,
    signal?: AbortSignal,
  ): Promise<BotProfile> {
    const all = await this.bots.listBots(client, signal)
    if (botIdOrName !== undefined && botIdOrName.trim().length > 0) {
      const hit = matchByIdOrName(all, botIdOrName, 'bot')
      if (typeof hit === 'string') throw new Error(`qoder-bots: ${hit}`)
      return hit
    }
    const activeId = this.bots.currentSelection().botId
    const byActive = activeId === undefined ? undefined : all.find(b => b.id === activeId)
    const fallback = byActive ?? all.find(b => b.isManagedBot) ?? all[0]
    if (fallback === undefined) throw new Error('qoder-bots: no bots exist yet; create one first with `/qoder-bot create <template>`')
    return fallback
  }

  /**
   * Start a Dream memory consolidation job for a Bot, optionally waiting up to
   * `waitMs` for completion and automatically performing the CoW store swap if
   * it settles within the window.
   */
  async startDream(
    client: QoderCloudClient,
    options: StartDreamOptions = {},
    signal: AbortSignal,
  ): Promise<DreamConsolidationOutcome> {
    const bot = await this.targetBot(client, options.botIdOrName, signal)
    if (bot.memoryStoreId === undefined) {
      throw new Error(`qoder-bots: bot "${bot.name}" (${bot.id}) has no Memory Store to consolidate`)
    }

    const sessionCap = Math.min(Math.max(options.maxRecentSessions ?? 20, 0), 100)
    const inputs: CreateDreamRequest['inputs'] = [
      { type: 'memory_store', memory_store_id: bot.memoryStoreId },
    ]

    if (sessionCap > 0) {
      const recentSessions = await client.listSessions({ agentId: bot.id, limit: sessionCap }, signal).catch(() => ({ data: [] }))
      const sessionIds = recentSessions.data.map(s => s.id).filter(Boolean).slice(0, 100)
      if (sessionIds.length > 0) {
        inputs.push({ type: 'sessions', session_ids: sessionIds })
      }
    }

    let dream = await client.createDream({
      inputs,
      model: options.model ?? bot.model ?? 'ultimate',
      ...options.instructions !== undefined && options.instructions.trim().length > 0
        ? { instructions: options.instructions.trim() }
        : {},
    }, signal)

    // Record `dsh_last_dream_id` on the bot so `/qoder-bot dream apply` can find it automatically
    const freshAgent = await client.getAgent(bot.id, signal)
    await client.updateAgent(bot.id, {
      ...freshAgent.version !== undefined ? { version: freshAgent.version } : {},
      metadata: {
        ...freshAgent.metadata,
        [BOT_META_LAST_DREAM_ID]: dream.id,
      },
    }, signal)

    const waitMs = options.waitMs ?? 15_000
    const pollMs = options.pollIntervalMs ?? 1_500
    const deadline = Date.now() + waitMs

    while ((dream.status === 'pending' || dream.status === 'running') && Date.now() < deadline) {
      await delay(Math.min(pollMs, Math.max(deadline - Date.now(), 50)), signal)
      dream = await client.getDream(dream.id, signal)
    }

    if (dream.status === 'completed') {
      return this.applyCompletedDream(client, bot.id, dream.id, signal)
    }

    return {
      bot: toBotProfile(await client.getAgent(bot.id, signal)),
      dream,
      switched: false,
      filesTouched: [],
      updatedRoutineIds: [],
    }
  }

  /**
   * Check a Dream (`drm_...` or the bot's latest recorded dream) and, if
   * `completed`, atomically switch the Bot + its 24/7 Routines onto the new
   * consolidated Memory Store while saving the previous store ID for rollback.
   */
  async applyCompletedDream(
    client: QoderCloudClient,
    botIdOrName: string | undefined,
    dreamId: string | undefined,
    signal: AbortSignal,
  ): Promise<DreamConsolidationOutcome> {
    const bot = await this.targetBot(client, botIdOrName, signal)
    const agent = await client.getAgent(bot.id, signal)
    const targetDreamId = dreamId?.trim() || agent.metadata?.[BOT_META_LAST_DREAM_ID]
    if (!targetDreamId) {
      throw new Error(`qoder-bots: no Dream ID provided and bot "${bot.name}" has no recorded recent Dream`)
    }

    const dream = await client.getDream(targetDreamId, signal)
    if (dream.status !== 'completed') {
      return {
        bot: toBotProfile(agent),
        dream,
        switched: false,
        filesTouched: [],
        updatedRoutineIds: [],
      }
    }

    const output = dream.outputs.find(o => o.type === 'memory_store' && typeof o.memory_store_id === 'string')
      ?? dream.outputs[0]
    if (output === undefined || !output.memory_store_id) {
      throw new Error(`qoder-bots: Dream ${dream.id} completed without a memory_store output`)
    }

    const currentStoreId = agent.metadata?.[BOT_META_MEMORY_STORE_ID]
    const newStoreId = output.memory_store_id
    const filesTouched = output.files_touched ?? []

    if (currentStoreId === newStoreId) {
      return {
        bot: toBotProfile(agent),
        dream,
        switched: false,
        previousStoreId: agent.metadata?.[BOT_META_PREV_MEMORY_STORE_ID],
        newStoreId,
        filesTouched,
        updatedRoutineIds: [],
      }
    }

    const updatedAgent = await client.updateAgent(agent.id, {
      ...agent.version !== undefined ? { version: agent.version } : {},
      metadata: {
        ...agent.metadata,
        ...currentStoreId !== undefined ? { [BOT_META_PREV_MEMORY_STORE_ID]: currentStoreId } : {},
        [BOT_META_MEMORY_STORE_ID]: newStoreId,
        [BOT_META_LAST_DREAM_ID]: dream.id,
      },
    }, signal)

    const updatedRoutineIds = currentStoreId !== undefined
      ? await this.repointBotRoutines(client, agent.id, currentStoreId, newStoreId, signal)
      : []

    return {
      bot: toBotProfile(updatedAgent),
      dream,
      switched: true,
      previousStoreId: currentStoreId,
      newStoreId,
      filesTouched,
      updatedRoutineIds,
    }
  }

  /**
   * Instant Copy-on-Write safety net: revert a Bot (and its active Routines)
   * back to `dsh_prev_memory_store_id` before the last Dream swap.
   */
  async rollbackMemoryStore(
    client: QoderCloudClient,
    botIdOrName: string | undefined,
    signal: AbortSignal,
  ): Promise<{ bot: BotProfile; restoredStoreId: string; replacedStoreId?: string; updatedRoutineIds: string[] }> {
    const bot = await this.targetBot(client, botIdOrName, signal)
    const agent = await client.getAgent(bot.id, signal)
    const prevStoreId = agent.metadata?.[BOT_META_PREV_MEMORY_STORE_ID]
    const currentStoreId = agent.metadata?.[BOT_META_MEMORY_STORE_ID]
    if (!prevStoreId) {
      throw new Error(`qoder-bots: bot "${bot.name}" has no previous Memory Store snapshot to roll back to`)
    }

    // Verify the previous store is still accessible on the platform
    await client.getMemoryStore(prevStoreId, signal)

    const nextMeta: Record<string, string> = {
      ...agent.metadata,
      [BOT_META_MEMORY_STORE_ID]: prevStoreId,
    }
    if (currentStoreId !== undefined) {
      nextMeta[BOT_META_PREV_MEMORY_STORE_ID] = currentStoreId
    }

    const updatedAgent = await client.updateAgent(agent.id, {
      ...agent.version !== undefined ? { version: agent.version } : {},
      metadata: nextMeta,
    }, signal)

    const updatedRoutineIds = currentStoreId !== undefined
      ? await this.repointBotRoutines(client, agent.id, currentStoreId, prevStoreId, signal)
      : []

    return {
      bot: toBotProfile(updatedAgent),
      restoredStoreId: prevStoreId,
      ...currentStoreId !== undefined ? { replacedStoreId: currentStoreId } : {},
      updatedRoutineIds,
    }
  }

  private async repointBotRoutines(
    client: QoderCloudClient,
    botId: string,
    oldStoreId: string,
    newStoreId: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const updatedIds: string[] = []
    const deployments = (await client.listDeployments({ agentId: botId }, signal)).data.filter(d => !d.archived_at)
    for (const dep of deployments) {
      const resources = dep.resources ?? []
      const hasOld = resources.some(r => r.type === 'memory_store' && r.memory_store_id === oldStoreId)
      if (!hasOld) continue
      const nextResources = resources.map(r =>
        r.type === 'memory_store' && r.memory_store_id === oldStoreId
          ? { ...r, memory_store_id: newStoreId }
          : r,
      ) as unknown as NonNullable<UpdateDeploymentRequest['resources']>
      await client.updateDeployment(dep.id, { resources: nextResources }, signal)
      updatedIds.push(dep.id)
    }
    return updatedIds
  }
}
