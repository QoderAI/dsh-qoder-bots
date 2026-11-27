/**
 * `/qoder-bot` — full-featured CLI/Chat command hub for Qoder Cloud Bots:
 *
 *   /qoder-bot                                         show active bot/team, routines & environment
 *   /qoder-bot list                                    list all bots & multi-bot teams
 *   /qoder-bot templates                               list 7 built-in specialist bot templates
 *   /qoder-bot create <template> [name]                create a new bot + persistent Memory Store
 *   /qoder-bot team create <name> <m1,m2,...>          assemble a Multi-Bot Team Coordinator (+ Advisor)
 *   /qoder-bot use <id|name>                           switch active bot or team (saved to profile)
 *   /qoder-bot memory [bot] [path]                     list memory entries or read a memory file
 *   /qoder-bot memory write <path> <content>           create or update a markdown memory note
 *   /qoder-bot memory delete <path|mem_id>             delete a memory note
 *   /qoder-bot dream [start|apply|rollback|list] [arg] consolidate memories (CoW) or roll back
 *   /qoder-bot routine [list|create|pause|unpause|run|archive]
 *   /qoder-bot runs [drun_...|routine]                 offline inbox: list runs or inspect one run report
 *   /qoder-bot env [<id|name>]                         list or switch Qoder Cloud environment
 *   /qoder-bot reset                                   clear saved bot & environment selection
 *
 * @module dsh-qoder-bots/command
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import {
  describeEnvironment,
  matchByIdOrName,
  type BotManager,
  type BotSelection,
} from './bot-manager.ts'
import type { QoderCloudClient } from './client.ts'
import type { DreamManager } from './dreams.ts'
import { formatRoutineLine, type RoutineManager } from './routines.ts'
import { BUILTIN_BOT_TEMPLATES } from './templates.ts'

export const COMMAND_NAME = 'qoder-bot'

type CommandResult = Awaited<ReturnType<CommandDefinition['handler']>>

export interface BotCommandDeps {
  readonly baseURL: string
  readonly client: () => Promise<QoderCloudClient | string>
  readonly manager: BotManager
  readonly routines: RoutineManager
  readonly dreams: DreamManager
  readonly persist: (selection: BotSelection) => Promise<boolean>
  readonly defaultBotName: string
  readonly cwd?: () => string | undefined
}

const USAGE = [
  'Usage:',
  '  /qoder-bot                                         show active bot/team, routines, memory & environment',
  '  /qoder-bot list                                    list all Qoder Cloud Bots & Multi-Bot Teams (* = active)',
  '  /qoder-bot templates                               list built-in specialist bot templates',
  '  /qoder-bot create <template> [name]                create a new bot + persistent Memory Store',
  '  /qoder-bot team create <name> <bot1,bot2,...>      create a Multi-Bot Team Coordinator (+ Advisor)',
  '  /qoder-bot use <id|name>                           switch active bot or team (saved to profile)',
  '  /qoder-bot memory [bot] [path]                     list memory entries or read a memory file',
  '  /qoder-bot memory write <path> "<markdown>"        create or update a memory note on the active bot',
  '  /qoder-bot memory delete <path|mem_id>             delete a memory note on the active bot',
  '  /qoder-bot dream [start|apply|rollback|list] [bot] run CoW memory consolidation or instant rollback',
  '  /qoder-bot routine [list [bot]]                    list 24/7 scheduled cloud routines',
  '  /qoder-bot routine create "<name>" "<cron>" <task> create a 5-field cron routine (or "manual")',
  '  /qoder-bot routine pause|unpause|run|archive <ref> control a routine by dep_... ID or name',
  '  /qoder-bot runs [drun_...|routine]                 offline inbox: list runs or inspect one run report',
  '  /qoder-bot env [<id|name>]                         list or switch Qoder Cloud environment',
  '  /qoder-bot reset                                   clear saved bot and environment selection',
].join('\n')

const savedNote = (ok: boolean): string => ok
  ? 'Saved to this profile.'
  : 'Applied for this process only (no settings service available; set in cordis.patch.yml to persist).'

/** Tokenize shell-style double/single quoted arguments while keeping unquoted words intact. */
export function splitCommandArgs(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | '\'' | undefined
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined
      } else if (ch === '\\' && i + 1 < raw.length && raw[i + 1] === quote) {
        current += raw[++i]!
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === '\'') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) args.push(current)
  return args
}

export function qoderBotCommand(deps: BotCommandDeps): CommandDefinition {
  return {
    name: COMMAND_NAME,
    description: 'Manage Qoder Cloud Bots, Multi-Bot Teams, Memory Stores, Dreams, 24/7 Routines, and Offline Inbox',
    input: { hint: '[list|templates|create|team|use|memory|dream|routine|runs|env|reset]' },
    handler: async ({ rawInput, signal }): Promise<CommandResult> => {
      const tokens = splitCommandArgs(rawInput.trim())
      const sub = tokens[0] ?? 'status'
      const rest = tokens.slice(1)
      try {
        switch (sub) {
          case 'status':
            return await showStatus(deps, signal)
          case 'list':
          case 'ls':
            return await listBots(deps, signal)
          case 'templates':
          case 'tpl':
            return showTemplates()
          case 'create':
          case 'new':
            return await createBotCmd(deps, rest, signal)
          case 'team':
          case 'teams':
            return await teamCmd(deps, rest, signal)
          case 'use':
          case 'select':
          case 'switch':
            return await useBotCmd(deps, rest.join(' '), signal)
          case 'memory':
          case 'mem':
            return await memoryCmd(deps, rest, signal)
          case 'dream':
          case 'dreams':
            return await dreamCmd(deps, rest, signal)
          case 'routine':
          case 'routines':
          case 'schedule':
            return await routineCmd(deps, rest, signal)
          case 'runs':
          case 'inbox':
            return await runsCmd(deps, rest, signal)
          case 'env':
          case 'environment':
            return rest.length === 0
              ? await listEnvironments(deps, signal)
              : await useEnvironment(deps, rest.join(' '), signal)
          case 'reset': {
            deps.manager.forget()
            const ok = await deps.persist({ environmentId: undefined, botId: undefined })
            return {
              kind: 'success',
              text: `Cleared saved bot and environment; the next session will choose again.\n${savedNote(ok)}`,
            }
          }
          case 'help':
            return { kind: 'success', text: USAGE }
          default:
            return { kind: 'error', text: `Unknown subcommand "${sub}".\n${USAGE}` }
        }
      } catch (error: unknown) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

async function clientOrError(deps: BotCommandDeps): Promise<QoderCloudClient> {
  const client = await deps.client()
  if (typeof client === 'string') throw new Error(client)
  return client
}

async function showStatus(deps: BotCommandDeps, signal: AbortSignal): Promise<CommandResult> {
  const { environmentId, botId } = deps.manager.currentSelection()
  const lines = [`Gateway: ${deps.baseURL}`]
  const client = await deps.client()
  if (typeof client === 'string') {
    lines.push(`Token: ${client}`)
  } else {
    const [envs, bots, routines] = await Promise.all([
      client.listEnvironments(signal),
      deps.manager.listBots(client, signal),
      deps.routines.listRoutines(client, undefined, signal).catch(() => []),
    ])
    const env = envs.data.find(item => item.id === environmentId)
    const bot = bots.find(item => item.id === botId)
    lines.push(environmentId === undefined
      ? 'Environment: auto (uses the sole cloud environment or prompts on first run)'
      : `Environment: ${env === undefined ? `${environmentId} (not found)` : `${env.name} (${env.id}) — ${describeEnvironment(env)}`}`)
    lines.push(botId === undefined
      ? `Active Bot: auto (uses "${deps.defaultBotName}" or prompts on first run; ${bots.filter(b => b.isManagedBot).length} managed bot(s) on account)`
      : bot === undefined
        ? `Active Bot: ${botId} (not found on platform)`
        : `Active Bot: ${bot.avatar} ${bot.name} (${bot.id})${bot.isTeam ? ' [team]' : ''} · model ${bot.model}${bot.memoryStoreId ? ` · memory ${bot.memoryStoreId}` : ' · no memory store'}`)
    const activeRoutines = routines.filter(r => r.status === 'active').length
    lines.push(`24/7 Routines: ${activeRoutines} active / ${routines.length} total (inspect with \`/qoder-bot routine\` or \`/qoder-bot runs\`)`)
  }
  lines.push('', USAGE)
  return { kind: 'success', text: lines.join('\n') }
}

function showTemplates(): CommandResult {
  const rows = BUILTIN_BOT_TEMPLATES.map(
    tpl => `  ${tpl.avatar} ${tpl.id.padEnd(22)} ${tpl.description} (default name: ${tpl.defaultName})`,
  )
  return {
    kind: 'success',
    text: [
      'Built-in Qoder Bot templates:',
      ...rows,
      '',
      'Create one with: /qoder-bot create <template-id> [custom-name]',
      'Assemble a multi-bot team with: /qoder-bot team create <team-name> code-reviewer,deep-researcher',
    ].join('\n'),
  }
}

async function listBots(deps: BotCommandDeps, signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const activeId = deps.manager.currentSelection().botId
  const bots = await deps.manager.listBots(client, signal)
  if (bots.length === 0) {
    return {
      kind: 'success',
      text: 'No bots/agents on this account yet. Run `/qoder-bot templates` and `/qoder-bot create <template>` to create your first persistent Bot!',
    }
  }
  const rows = bots.map((b) => {
    const mark = b.id === activeId ? '*' : ' '
    const tag = b.isTeam
      ? `[team:${b.teamMemberIds?.length ?? 0}]`
      : b.isManagedBot
        ? '[bot]'
        : '[agent]'
    const mem = b.memoryStoreId !== undefined ? `mem:${b.memoryStoreId}` : 'no-mem'
    const rollback = b.previousMemoryStoreId !== undefined ? ` (rollback:${b.previousMemoryStoreId})` : ''
    return `${mark} ${b.avatar} ${b.name} (${b.id}) ${tag} · model ${b.model} · ${mem}${rollback}`
  })
  return {
    kind: 'success',
    text: [
      'Qoder Cloud Bots & Teams (* = active):',
      ...rows,
      '',
      'Switch with `/qoder-bot use <id|name>`, create a bot with `/qoder-bot create <template>`, or assemble a team with `/qoder-bot team create <name> <m1,m2>`.',
    ].join('\n'),
  }
}

async function createBotCmd(deps: BotCommandDeps, args: readonly string[], signal: AbortSignal): Promise<CommandResult> {
  const templateId = args[0]
  if (templateId === undefined) {
    return {
      kind: 'error',
      text: `Missing template id.\n${(showTemplates() as { text: string }).text}`,
    }
  }
  const customName = args[1]
  const client = await clientOrError(deps)
  const bot = await deps.manager.createBot(client, {
    templateId,
    ...customName !== undefined ? { name: customName } : {},
  }, signal)
  deps.manager.remember({ botId: bot.id })
  const ok = await deps.persist({ botId: bot.id })
  return {
    kind: 'success',
    text: [
      `Created and activated Qoder Bot: ${bot.avatar} ${bot.name} (${bot.id})`,
      `  Template: ${bot.templateId ?? templateId}`,
      `  Model: ${bot.model}`,
      `  Memory Store: ${bot.memoryStoreId ?? 'none'}`,
      '  24/7 Routines: enabled (`manage_bot_routine` tool attached)',
      savedNote(ok),
    ].join('\n'),
  }
}

async function teamCmd(deps: BotCommandDeps, args: readonly string[], signal: AbortSignal): Promise<CommandResult> {
  const sub = args[0] ?? 'list'
  const client = await clientOrError(deps)

  if (sub === 'list' || sub === 'ls') {
    const bots = await deps.manager.listBots(client, signal)
    const teams = bots.filter(b => b.isTeam)
    if (teams.length === 0) {
      return {
        kind: 'success',
        text: [
          'No Multi-Bot Teams yet.',
          'Create one from existing bots or built-in templates (missing templates are auto-provisioned!):',
          '  /qoder-bot team create eng-squad code-reviewer,deep-researcher,incident-commander',
        ].join('\n'),
      }
    }
    const byId = new Map(bots.map(b => [b.id, b]))
    const rows = teams.map((t) => {
      const members = (t.teamMemberIds ?? [])
        .map(id => byId.get(id)?.name ?? id)
        .join(', ')
      return `  ${t.avatar} ${t.name} (${t.id}) · members: [${members || 'custom'}] · mem:${t.memoryStoreId ?? 'none'}`
    })
    return {
      kind: 'success',
      text: ['Multi-Bot Teams:', ...rows, '', 'Activate a team with: /qoder-bot use <team-name>'].join('\n'),
    }
  }

  if (sub === 'create' || sub === 'new') {
    const teamName = args[1]
    const rawMembers = args.slice(2).join(',')
    const memberRefs = rawMembers.split(',').map(s => s.trim()).filter(Boolean)
    if (!teamName || memberRefs.length === 0) {
      return {
        kind: 'error',
        text: 'Usage: /qoder-bot team create <team-name> <member1,member2,...>\nExample: /qoder-bot team create eng-squad code-reviewer,deep-researcher',
      }
    }
    const { team, members } = await deps.manager.createTeamBot(client, {
      name: teamName,
      members: memberRefs,
    }, signal)
    deps.manager.remember({ botId: team.id })
    const ok = await deps.persist({ botId: team.id })
    return {
      kind: 'success',
      text: [
        `Assembled and activated Multi-Bot Team: ${team.avatar} ${team.name} (${team.id})`,
        `  Coordinator Model: ${team.model} (+ Advisor enabled)`,
        `  Member Bots (${members.length}): ${members.map(m => `${m.avatar} ${m.name} (${m.id})`).join(', ')}`,
        `  Shared Team Memory Store: ${team.memoryStoreId ?? 'none'}`,
        savedNote(ok),
      ].join('\n'),
    }
  }

  return { kind: 'error', text: `Unknown team subcommand "${sub}". Expected: list, create.` }
}

async function useBotCmd(deps: BotCommandDeps, target: string, signal: AbortSignal): Promise<CommandResult> {
  if (target.trim().length === 0) return listBots(deps, signal)
  const client = await clientOrError(deps)
  const bots = await deps.manager.listBots(client, signal)
  const matched = matchByIdOrName(bots, target, 'bot')
  if (typeof matched === 'string') return { kind: 'error', text: matched }
  const ensured = matched.memoryStoreId === undefined && matched.isManagedBot
    ? await deps.manager.ensureBotMemoryStore(client, matched.id, signal)
    : matched
  deps.manager.remember({ botId: ensured.id })
  const ok = await deps.persist({ botId: ensured.id })
  return {
    kind: 'success',
    text: `Active bot set to ${ensured.avatar} ${ensured.name} (${ensured.id})${ensured.memoryStoreId ? ` · memory ${ensured.memoryStoreId}` : ''}.\n${savedNote(ok)}`,
  }
}

async function memoryCmd(deps: BotCommandDeps, args: readonly string[], signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const first = args[0]

  // `/qoder-bot memory write <path> <content...>`
  if (first === 'write' || first === 'set') {
    const path = args[1]
    const content = args.slice(2).join(' ')
    if (!path || content.trim().length === 0) {
      return { kind: 'error', text: 'Usage: /qoder-bot memory write <relative-path.md> "<markdown content>"' }
    }
    const out = await deps.manager.writeBotMemoryEntry(client, { path, content }, signal)
    return {
      kind: 'success',
      text: `${out.created ? 'Created' : 'Updated'} memory "${out.entry.path}" (${out.entry.id}) in ${out.bot.avatar} ${out.bot.name} (${out.bot.memoryStoreId}).`,
    }
  }

  // `/qoder-bot memory delete <path|mem_id>`
  if (first === 'delete' || first === 'rm') {
    const pathOrId = args[1]
    if (!pathOrId) {
      return { kind: 'error', text: 'Usage: /qoder-bot memory delete <relative-path | mem_id>' }
    }
    const out = await deps.manager.deleteBotMemoryEntry(client, { pathOrId }, signal)
    return {
      kind: 'success',
      text: `Deleted memory "${out.deletedPath}" (${out.deletedId}) from ${out.bot.avatar} ${out.bot.name}.`,
    }
  }

  const botArg = first
  const pathArg = args[1]
  const info = await deps.manager.inspectBotMemories(client, botArg, signal)
  if (info.store === undefined || info.bot.memoryStoreId === undefined) {
    return {
      kind: 'success',
      text: `${info.bot.avatar} ${info.bot.name} (${info.bot.id}) does not have an attached Memory Store yet.`,
    }
  }

  if (pathArg !== undefined) {
    const entry = info.entries.find(e => e.path === pathArg || e.id === pathArg)
    if (entry === undefined) {
      return {
        kind: 'error',
        text: `No memory entry "${pathArg}" in ${info.store.id}. Available paths: ${info.entries.map(e => e.path).join(', ') || '(empty)'}`,
      }
    }
    const detail = await client.getMemory(info.store.id, entry.id, signal)
    return {
      kind: 'success',
      text: [
        `Memory: ${detail.path} (${detail.id}, v${detail.version ?? 1}) in ${info.bot.avatar} ${info.bot.name}`,
        '---',
        detail.content ?? '(empty)',
      ].join('\n'),
    }
  }

  const lines = [
    `Bot: ${info.bot.avatar} ${info.bot.name} (${info.bot.id})`,
    `Memory Store: ${info.store.name} (${info.store.id})${info.bot.previousMemoryStoreId ? ` · previous snapshot: ${info.bot.previousMemoryStoreId}` : ''}`,
    `Entries (${info.entries.length}):`,
  ]
  if (info.entries.length === 0) {
    lines.push('  (empty — the bot will populate markdown files under /data/.agent/awareness/ as you chat)')
  } else {
    for (const entry of info.entries) {
      lines.push(`  - ${entry.path} (${entry.id}${entry.content_size_bytes !== undefined ? `, ${entry.content_size_bytes} bytes` : ''})`)
    }
    lines.push(
      '',
      `Read: /qoder-bot memory ${info.bot.name} <path> · Write: /qoder-bot memory write <path> "<text>" · Consolidate: /qoder-bot dream`,
    )
  }
  return { kind: 'success', text: lines.join('\n') }
}

async function dreamCmd(deps: BotCommandDeps, args: readonly string[], signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const sub = args[0]

  if (sub === 'list' || sub === 'ls') {
    const list = (await client.listDreams(15, signal)).data.filter(d => !d.archived_at)
    if (list.length === 0) return { kind: 'success', text: 'No Dream memory consolidation jobs recorded yet.' }
    const rows = list.map((d) => {
      const outStore = d.outputs[0]?.memory_store_id
      return `  ${d.id}  [${d.status}]  ${d.created_at}${outStore ? ` → ${outStore}` : ''}`
    })
    return {
      kind: 'success',
      text: ['Recent Dreams:', ...rows, '', 'Apply a completed dream with: /qoder-bot dream apply [bot] [drm_...]'].join('\n'),
    }
  }

  if (sub === 'rollback' || sub === 'revert') {
    const botRef = args[1]
    const out = await deps.dreams.rollbackMemoryStore(client, botRef, signal)
    return {
      kind: 'success',
      text: [
        `Rolled back Memory Store for ${out.bot.avatar} ${out.bot.name} (${out.bot.id}):`,
        `  Active Memory Store restored to: ${out.restoredStoreId}${out.replacedStoreId ? ` (was ${out.replacedStoreId})` : ''}`,
        ...out.updatedRoutineIds.length > 0
          ? [`  Repointed ${out.updatedRoutineIds.length} active routine(s): ${out.updatedRoutineIds.join(', ')}`]
          : [],
      ].join('\n'),
    }
  }

  if (sub === 'apply' || sub === 'sync' || sub === 'status') {
    const arg1 = args[1]
    const arg2 = args[2]
    const isArg1Dream = arg1?.startsWith('drm_') === true
    const botRef = isArg1Dream ? undefined : arg1
    const dreamId = isArg1Dream ? arg1 : arg2
    const outcome = await deps.dreams.applyCompletedDream(client, botRef, dreamId, signal)
    return formatDreamOutcome(outcome)
  }

  // `/qoder-bot dream [start] [bot] [instructions...]`
  const explicitStart = sub === 'start' || sub === 'run'
  const botRef = explicitStart ? args[1] : sub
  const instructions = (explicitStart ? args.slice(2) : args.slice(1)).join(' ').trim() || undefined
  const outcome = await deps.dreams.startDream(client, {
    botIdOrName: botRef,
    instructions,
    waitMs: 10_000,
    pollIntervalMs: 500,
  }, signal)
  return formatDreamOutcome(outcome)
}

function formatDreamOutcome(outcome: Awaited<ReturnType<DreamManager['startDream']>>): CommandResult {
  const { bot, dream } = outcome
  if (dream.status === 'failed' || dream.status === 'canceled') {
    return {
      kind: 'error',
      text: `Dream ${dream.id} ended with status "${dream.status}"${dream.error?.message ? `: ${dream.error.message}` : ''}`,
    }
  }
  if (!outcome.switched && dream.status !== 'completed') {
    return {
      kind: 'success',
      text: [
        `Started Dream memory consolidation ${dream.id} for ${bot.avatar} ${bot.name} (status: ${dream.status}).`,
        'It continues asynchronously in Qoder Cloud; run `/qoder-bot dream apply` in a minute to switch onto the consolidated store!',
      ].join('\n'),
    }
  }
  return {
    kind: 'success',
    text: [
      `✨ Dream ${dream.id} completed for ${bot.avatar} ${bot.name} (${bot.id})!`,
      `  Consolidated Memory Store: ${outcome.newStoreId}${outcome.previousStoreId ? ` (previous snapshot preserved: ${outcome.previousStoreId})` : ''}`,
      ...outcome.filesTouched.length > 0 ? [`  Files touched: ${outcome.filesTouched.join(', ')}`] : [],
      ...outcome.updatedRoutineIds.length > 0 ? [`  Updated ${outcome.updatedRoutineIds.length} routine(s) to new store: ${outcome.updatedRoutineIds.join(', ')}`] : [],
      '  Undo anytime with: /qoder-bot dream rollback',
    ].join('\n'),
  }
}

async function routineCmd(deps: BotCommandDeps, args: readonly string[], signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const action = args[0] ?? 'list'

  if (action === 'list' || action === 'ls') {
    const botFilter = args[1]
    const list = await deps.routines.listRoutines(client, botFilter, signal)
    if (list.length === 0) {
      return {
        kind: 'success',
        text: [
          'No 24/7 cloud routines yet.',
          'Create one by chatting with your Qoder Bot (e.g. "Every weekday at 9am summarize new commits"), or run:',
          '  /qoder-bot routine create "Daily Digest" "0 9 * * 1-5" Check recent commits and write a brief',
        ].join('\n'),
      }
    }
    return {
      kind: 'success',
      text: [
        `24/7 Cloud Routines (${list.length}):`,
        ...list.map(d => `  ${formatRoutineLine(d)}`),
        '',
        'Control: `/qoder-bot routine pause|unpause|run|archive <id|name>` · View runs: `/qoder-bot runs`',
      ].join('\n'),
    }
  }

  if (action === 'create' || action === 'new') {
    const [name, cronOrManual, ...promptParts] = args.slice(1)
    const taskPrompt = promptParts.join(' ').trim()
    if (!name || !cronOrManual || taskPrompt.length === 0) {
      return {
        kind: 'error',
        text: 'Usage: /qoder-bot routine create "<name>" "<5-field-cron | manual>" <task prompt>',
      }
    }
    const cronExpression = cronOrManual.toLowerCase() === 'manual' ? undefined : cronOrManual
    const created = await deps.routines.createRoutine(client, {
      name,
      cronExpression,
      taskPrompt,
      cwd: deps.cwd?.(),
    }, signal)
    const d = created.deployment
    const nextRun = d.schedule?.upcoming_runs_at?.[0]
    return {
      kind: 'success',
      text: [
        `Created 24/7 Cloud Routine: "${d.name}" (${d.id})`,
        `  Bot: ${created.bot.avatar} ${created.bot.name} (${created.bot.id})`,
        `  Schedule: ${d.schedule ? `cron \`${d.schedule.expression}\` (${d.schedule.timezone})` : 'manual trigger only'}`,
        ...nextRun ? [`  Next scheduled run: ${nextRun}`] : [],
        '  Trigger immediately anytime with: /qoder-bot routine run ' + d.id,
      ].join('\n'),
    }
  }

  if (action === 'pause' || action === 'unpause' || action === 'archive' || action === 'delete' || action === 'run') {
    const ref = args.slice(1).join(' ').trim()
    if (ref.length === 0) {
      return { kind: 'error', text: `Usage: /qoder-bot routine ${action} <dep_id | routine_name>` }
    }
    const target = await deps.routines.resolveRoutine(client, ref, undefined, signal)
    if (action === 'pause') {
      const out = await client.pauseDeployment(target.id, signal)
      return { kind: 'success', text: `Paused routine "${out.name}" (${out.id}).` }
    }
    if (action === 'unpause') {
      const out = await client.unpauseDeployment(target.id, signal)
      return {
        kind: 'success',
        text: `Resumed routine "${out.name}" (${out.id})${out.schedule?.upcoming_runs_at?.[0] ? ` · next run: ${out.schedule.upcoming_runs_at[0]}` : ''}.`,
      }
    }
    if (action === 'archive' || action === 'delete') {
      const out = await client.archiveDeployment(target.id, signal)
      return { kind: 'success', text: `Archived routine "${out.name}" (${out.id}).` }
    }
    const run = await client.runDeploymentNow(target.id, signal)
    return {
      kind: 'success',
      text: run.error
        ? `Triggered routine "${target.name}", but session creation failed: ${run.error.message ?? run.error.type}`
        : [
            `Triggered routine "${target.name}" (${target.id})!`,
            `  Run ID: ${run.id}`,
            `  Cloud Session: ${run.session_id}`,
            `  Check output once settled with: /qoder-bot runs ${run.id}`,
          ].join('\n'),
    }
  }

  return {
    kind: 'error',
    text: `Unknown routine action "${action}". Expected: list, create, pause, unpause, run, archive.`,
  }
}

async function runsCmd(deps: BotCommandDeps, args: readonly string[], signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const first = args[0]?.trim()

  if (first !== undefined && first.startsWith('drun_')) {
    const report = await deps.routines.inspectRunReport(client, first, signal)
    const r = report.run
    const lines = [
      `Routine Run: ${r.id}`,
      `  Routine: ${report.deployment ? `"${report.deployment.name}" (${r.deployment_id})` : r.deployment_id}`,
      `  Created: ${r.created_at} (${r.trigger_context?.type ?? 'scheduled'})`,
    ]
    if (r.error) {
      lines.push(`  Error: ${r.error.type ?? 'run_error'} — ${r.error.message ?? 'unknown'}`)
      return { kind: 'success', text: lines.join('\n') }
    }
    lines.push(`  Session: ${r.session_id} (status: ${report.sessionStatus ?? 'unknown'})`)
    if (report.artifacts.length > 0) {
      lines.push(`  Artifacts: ${report.artifacts.map(a => `${a.name} (${a.fileId})`).join(', ')}`)
    }
    lines.push('---', report.finalMessage ?? '(no assistant message yet — the run may still be executing)')
    if (r.session_id) {
      lines.push(
        '',
        `Tip: To continue chatting in this run's cloud sandbox, start a Qoder Bot session and send:\n  [adopt-session:${r.session_id}] <your follow-up question>`,
      )
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  const { runs, deploymentsById } = await deps.routines.listRunsInbox(client, {
    ...first !== undefined && first.length > 0 ? { routineIdOrName: first } : {},
    limit: 15,
  }, signal)

  if (runs.length === 0) {
    return {
      kind: 'success',
      text: 'Offline Run Inbox is empty — no scheduled or manual routine runs recorded yet.',
    }
  }

  const rows = runs.map((r) => {
    const depName = deploymentsById.get(r.deployment_id)?.name ?? r.deployment_id
    const trigger = r.trigger_context?.type ?? 'cron'
    const outcome = r.error
      ? `✗ ${r.error.type ?? 'error'}`
      : `session ${r.session_id}`
    return `  ${r.id}  ${r.created_at}  [${trigger}]  "${depName}" → ${outcome}`
  })
  return {
    kind: 'success',
    text: [
      `Offline Routine Run Inbox (${runs.length} recent):`,
      ...rows,
      '',
      'Inspect a run\'s full report with: /qoder-bot runs <drun_...>',
    ].join('\n'),
  }
}

async function listEnvironments(deps: BotCommandDeps, signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const current = deps.manager.currentSelection().environmentId
  const envs = (await client.listEnvironments(signal)).data.filter(env => !env.archived_at)
  if (envs.length === 0) {
    return { kind: 'success', text: 'No environments yet; the next run automatically creates "dsh-bots-default".' }
  }
  const rows = envs.map(env => `${env.id === current ? '*' : ' '} ${env.id}  ${env.name}  (${describeEnvironment(env)})`)
  return {
    kind: 'success',
    text: ['Environments (* = current):', ...rows, '', 'Switch with: /qoder-bot env <id|name>'].join('\n'),
  }
}

async function useEnvironment(deps: BotCommandDeps, text: string, signal: AbortSignal): Promise<CommandResult> {
  const client = await clientOrError(deps)
  const envs = (await client.listEnvironments(signal)).data.filter(env => !env.archived_at)
  const match = matchByIdOrName(envs, text, 'environment')
  if (typeof match === 'string') return { kind: 'error', text: match }
  deps.manager.remember({ environmentId: match.id })
  const ok = await deps.persist({ environmentId: match.id })
  const warning = match.config?.type === 'self_hosted'
    ? '\nNote: self-hosted environments require an online local/BYOC worker and do not mount cloud MemoryStore resources.'
    : ''
  return { kind: 'success', text: `Environment set to ${match.name} (${match.id}).${warning}\n${savedNote(ok)}` }
}
