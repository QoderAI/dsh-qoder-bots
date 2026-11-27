import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import SystemPromptRuntime from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { after as afterAll, afterEach, before as beforeAll, beforeEach, describe, it } from 'node:test'
import { expect, vi } from './test-harness.ts'
import { BotManager } from '../src/bot-manager.ts'
import {
  BOT_ACTIVE_MODEL,
  BOT_MODEL_PREFIX,
  BOT_PROVIDER,
  QoderBotAdapter,
  parseAdoptSessionDirective,
  splitBotHistory,
} from '../src/bot-mode.ts'
import * as botRoute from '../src/bot-route.ts'
import { QoderCloudClient } from '../src/client.ts'
import { qoderBotCommand, splitCommandArgs } from '../src/command.ts'
import * as plugin from '../src/index.ts'
import { RoutineManager, validatePosixCron5 } from '../src/routines.ts'
import { parseLeadingBotDirective } from '../src/run.ts'
import { startMockQoder, type StreamContext } from './mock-server.ts'

class FixtureWorkingDirectory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }
  get(): string { return plain }
  async ensure(): Promise<string> { return plain }
  async set(_agent: unknown, path: string): Promise<string> { return path }
}

/** Minimal fake AttachmentStore serving in-memory images & files for multimodal tests. */
function makeFakeAttachments(files: Record<string, Uint8Array>, images: Record<string, { bytes: Uint8Array; mediaType: 'image/png' }>): AttachmentStore {
  return {
    async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
      const hit = images[ref.attachmentId as string]
      if (!hit) throw new Error(`missing image ${ref.attachmentId}`)
      return { data: hit.bytes, ref: { ...ref, mediaType: hit.mediaType } }
    },
    async *readFileStream(ref: FileAttachmentRef): AsyncIterable<Uint8Array> {
      const hit = files[ref.attachmentId as string]
      if (!hit) throw new Error(`missing file ${ref.attachmentId}`)
      yield hit
    },
  } as unknown as AttachmentStore
}

let repo: string
let plain: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'qoder-bots-repo-'))
  plain = mkdtempSync(join(tmpdir(), 'qoder-bots-plain-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'bot@example.com')
  git('config', 'user.name', 'bot')
  writeFileSync(join(repo, 'index.ts'), 'export const x = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', 'https://github.com/acme/demo.git')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
})

const realFetch = globalThis.fetch
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })
    }
    return realFetch(input, init)
  })
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function collectChunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const blockTexts = (chunks: StreamChunk[], kind: 'text' | 'reasoning') => chunks
  .filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.type === kind)
  .map(c => (c.block as { text: string }).text)

describe('parseLeadingBotDirective', () => {
  it('extracts @bot-name or @template-slug at the start of delegated prompts', () => {
    expect(parseLeadingBotDirective('@deep-researcher Compare Raft and Paxos'))
      .toEqual({ bot: 'deep-researcher', text: 'Compare Raft and Paxos' })
    expect(parseLeadingBotDirective('  @code-reviewer: Review commit HEAD '))
      .toEqual({ bot: 'code-reviewer', text: 'Review commit HEAD' })
    expect(parseLeadingBotDirective('Normal prompt with @someone in the middle'))
      .toEqual({ text: 'Normal prompt with @someone in the middle' })
  })
})

describe('BotManager & /qoder-bot slash command', () => {
  it('creates bots from built-in templates with dedicated persistent Memory Stores and inspects memories', async () => {
    const mock = await startMockQoder({
      environments: [{ id: 'env_cloud', name: 'default', config: { type: 'cloud' } }],
      stream: async () => {},
    })
    cleanups.push(mock.close)

    let saved: plugin.BotSelection = {}
    const client = new QoderCloudClient({ baseURL: mock.baseURL, token: 'pt-test' })
    const manager = new BotManager({
      configured: () => saved,
      defaultBotName: 'dsh-bot-coder',
      defaultTemplateId: 'general-coder',
      defaultModel: 'ultimate',
      autoMemory: true,
      entryId: 'qoder-bots',
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
    })
    const cmd = qoderBotCommand({
      baseURL: mock.baseURL,
      client: async () => client,
      manager,
      routines: new RoutineManager({
        manager,
        repositoryMode: 'auto',
        gitToken: async () => 'ghp_test',
        gitTokenEnv: 'QODER_GIT_TOKEN',
        environmentVariables: {},
      }),
      dreams: new plugin.DreamManager(manager),
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
      defaultBotName: 'dsh-bot-coder',
      cwd: () => repo,
    })
    const runCmd = (rawInput: string) => cmd.handler({ rawInput, signal: new AbortController().signal } as never)

    // 1. List built-in templates
    const tplRes = await runCmd('templates')
    expect(tplRes.kind).toBe('success')
    expect((tplRes as { text: string }).text).toContain('deep-researcher')
    expect((tplRes as { text: string }).text).toContain('code-reviewer')

    // 2. Create a bot from `deep-researcher`
    const createRes = await runCmd('create deep-researcher my-research-bot')
    expect(createRes.kind).toBe('success')
    expect((createRes as { text: string }).text).toContain('my-research-bot')
    expect(mock.memoryStores).toHaveLength(1)
    expect(mock.memoryStores[0]!.name).toBe('my-research-bot-memory')
    expect(mock.memoryStores[0]!.entries[0]?.path).toBe('README.md')
    expect(saved.botId).toBe('agent_1')

    // 3. List bots shows active marker and memory store ID
    const listRes = await runCmd('list')
    expect(listRes.kind).toBe('success')
    expect((listRes as { text: string }).text).toContain('* 🕵️ my-research-bot (agent_1) [bot] · model ultimate · mem:memstore_1')

    // 4. Inspect memory entries & read README.md
    const memList = await runCmd('memory my-research-bot')
    expect(memList.kind).toBe('success')
    expect((memList as { text: string }).text).toContain('README.md')

    const memFile = await runCmd('memory my-research-bot README.md')
    expect(memFile.kind).toBe('success')
    expect((memFile as { text: string }).text).toContain('# Bot Memory — Deep Researcher')
  })
})

describe('QoderBotAdapter (multimodal Bot mode + persistent MemoryStore + custom tool hook)', () => {
  it('auto-provisions bot + MemoryStore, forwards base64 images & uploaded files, handles custom tools, and continues across turns', async () => {
    let turn = 0
    const mock = await startMockQoder({
      environments: [{ id: 'env_1', name: 'cloud-default', config: { type: 'cloud' } }],
      stream: async (s: StreamContext) => {
        turn++
        if (turn === 1) {
          s.emit({ type: 'session.status_running' })
          const customId = s.emit({
            type: 'agent.custom_tool_use',
            name: 'ping_local',
            input: { message: 'hello host' },
          })
          s.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [customId] } })
          const toolReply = await s.waitFor('user.custom_tool_result')
          expect(toolReply.content[0].text).toBe('pong: hello host')
          s.emit({
            type: 'agent.artifact_delivered',
            file_id: 'file_report_1',
            original_filename: 'summary.md',
            size: 512,
          })
          s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Analyzed screenshot and CSV!' }] })
          s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
        } else {
          s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Follow-up completed with new file!' }] })
          s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
        }
      },
    })
    cleanups.push(mock.close)

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const csvBytes = new TextEncoder().encode('col1,col2\n1,2\n')
    const csv2Bytes = new TextEncoder().encode('col1,col2\n3,4\n')
    const attachments = makeFakeAttachments(
      { att_csv_1: csvBytes, att_csv_2: csv2Bytes },
      { att_img_1: { bytes: pngBytes, mediaType: 'image/png' } },
    )

    const client = new QoderCloudClient({ baseURL: mock.baseURL, token: 'pt-test' })
    const manager = new BotManager({
      configured: () => ({}),
      defaultBotName: 'dsh-bot-coder',
      defaultTemplateId: 'data-analyst',
      defaultModel: 'ultimate',
      autoMemory: true,
      entryId: 'qoder-bots',
      persist: async () => true,
    })

    const adapter = new QoderBotAdapter({
      client: async () => client,
      manager,
      attachments: () => attachments,
      turnContext: () => ({ cwd: repo, asker: undefined }),
      repository: 'auto',
      gitToken: async () => 'ghp_test',
      gitTokenEnv: 'QODER_GIT_TOKEN',
      gitUsername: undefined,
      branchPrefix: 'qoder-bots/',
      toolConfirmation: 'allow',
      environmentVariables: { BOT_ENV: '1' },
      customToolHandler: async (call) => {
        if (call.name === 'ping_local') {
          return { text: `pong: ${(call.input as { message: string }).message}` }
        }
        return undefined
      },
    })

    // First turn: text + image + file attachment
    const firstTurnMsg: RequestMessage = {
      id: 'u1',
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'Plot this CSV and check the screenshot.' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'att_img_1',
            mediaType: 'image/png',
            bytes: pngBytes.byteLength,
            width: 100,
            height: 100,
            name: 'ui.png',
          },
        } as unknown as ContentBlock,
        {
          type: 'file',
          attachment: {
            attachmentId: 'att_csv_1',
            name: 'metrics.csv',
            bytes: csvBytes.byteLength,
          },
        } as unknown as ContentBlock,
      ],
    } as unknown as RequestMessage

    const turn1Chunks = await collectChunks(adapter.stream({
      provider: BOT_PROVIDER,
      model: BOT_ACTIVE_MODEL,
      messages: [firstTurnMsg],
      sessionId: 'dsh_sess_1' as GenerateOptions['sessionId'],
    }))

    const visible1 = blockTexts(turn1Chunks, 'text').join('\n')
    expect(visible1).toContain('Analyzed screenshot and CSV!')
    expect(visible1).toContain('summary.md')
    expect(visible1).toContain('file_report_1')

    // Verify POST /sessions included: github_repository + memory_store + uploaded file resource
    const createSessReq = mock.requests.find(r => r.method === 'POST' && r.path === '/sessions')
    expect(createSessReq).toBeDefined()
    expect(createSessReq!.body.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'github_repository', url: 'https://github.com/acme/demo.git' }),
      expect.objectContaining({ type: 'memory_store', memory_store_id: 'memstore_1', access: 'read_write' }),
      expect.objectContaining({ type: 'file', file_id: 'file_1', mount_path: '/mnt/session/uploads/metrics.csv' }),
    ]))

    // Verify user.message carried inline base64 image block!
    const firstUserEvent = mock.posted.find(e => e.type === 'user.message')
    expect(firstUserEvent.content).toHaveLength(2)
    expect(firstUserEvent.content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from(pngBytes).toString('base64'),
      },
    })

    // Extract replayState from finish chunk and run Turn 2 with a new file attachment
    const finish1 = turn1Chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
    expect(finish1?.replayState?.response).toEqual(expect.objectContaining({ remoteSessionId: 'sess_1', botId: 'agent_1' }))

    const assistantMsg1: RequestMessage = {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'text', text: visible1 }],
      source: {
        kind: 'model',
        provider: BOT_PROVIDER,
        model: BOT_ACTIVE_MODEL,
        replayState: finish1!.replayState,
      },
    } as unknown as RequestMessage

    const secondTurnMsg: RequestMessage = {
      id: 'u2',
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'Now compare with Q2.' },
        {
          type: 'file',
          attachment: {
            attachmentId: 'att_csv_2',
            name: 'q2.csv',
            bytes: csv2Bytes.byteLength,
          },
        } as unknown as ContentBlock,
      ],
    } as unknown as RequestMessage

    expect(splitBotHistory([firstTurnMsg, assistantMsg1, secondTurnMsg]).replay?.remoteSessionId).toBe('sess_1')

    const turn2Chunks = await collectChunks(adapter.stream({
      provider: BOT_PROVIDER,
      model: `${BOT_MODEL_PREFIX}agent_1`,
      messages: [firstTurnMsg, assistantMsg1, secondTurnMsg],
      sessionId: 'dsh_sess_1' as GenerateOptions['sessionId'],
    }))

    expect(blockTexts(turn2Chunks, 'text').join('\n')).toContain('Follow-up completed with new file!')
    // Follow-up file should have been attached dynamically via POST /sessions/sess_1/resources
    expect(mock.sessionResources).toEqual([
      { sessionId: 'sess_1', file_id: 'file_2', mount_path: '/mnt/session/uploads/q2.csv' },
    ])

    // Dynamic listModels includes active-bot + managed bot entry
    const models = await adapter.listModels(BOT_PROVIDER)
    expect(models.map(m => m.id)).toEqual([BOT_ACTIVE_MODEL, 'bot:agent_1'])
  })

  it('bot-route child plugin pins provider to qoder-bots while preserving explicit bot:<id> picks', async () => {
    const ctx = new Context()
    await ctx.plugin(botRoute)
    const defaultRouted = await (ctx as any).waterfall('agent/request', {}, async () => ({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      maxTokens: 4096,
    }))
    expect(defaultRouted).toEqual({ provider: BOT_PROVIDER, model: BOT_ACTIVE_MODEL })

    const explicitRouted = await (ctx as any).waterfall('agent/request', {}, async () => ({
      provider: BOT_PROVIDER,
      model: 'bot:agent_42',
    }))
    expect(explicitRouted).toEqual({ provider: BOT_PROVIDER, model: 'bot:agent_42' })
  })
})

describe('Subagent @bot delegation & ask_qoder_bot tool', () => {
  it('auto-provisions specialist bots on @<template> delegation and mounts each bot\'s own Memory Store', async () => {
    const mock = await startMockQoder({
      environments: [{ id: 'env_1', name: 'default', config: { type: 'cloud' } }],
      stream: async (s: StreamContext) => {
        s.emit({ type: 'agent.message', content: [{ type: 'text', text: `Report from ${s.sessionId}` }] })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
      },
    })
    cleanups.push(mock.close)

    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(FixtureWorkingDirectory)
    await ctx.plugin(SystemPromptRuntime)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(plugin, {
      baseURL: mock.baseURL,
      token: 'pt-test',
      repository: 'none',
    })
    cleanups.push(() => fiber.dispose())

    // 1. Subagent delegation with `@code-reviewer` prefix
    const provider = ctx.subagents.getProvider('qoder-bots') as SubagentProvider
    const run = await provider.start!({
      cwd: plain,
      prompt: [{ type: 'text', text: '@code-reviewer Check auth middleware for race conditions' }],
      parent: {} as Agent,
      signal: new AbortController().signal,
    })
    const subRes = await run.result
    await run.dispose()

    expect(subRes.stopReason).toBe('completed')
    const subText = (subRes.output[0] as { text: string }).text
    expect(subText).toContain('Report from sess_1')
    expect(subText).toContain('🔍 dsh-bot-reviewer')
    expect(subText).toContain('memory memstore_1')

    // 2. Explicit `ask_qoder_bot` tool call targeting `incident-commander`
    const toolRes = await ctx.tools.execute({
      name: plugin.ASK_BOT_TOOL_NAME,
      arguments: { bot: 'incident-commander', task: 'Analyze OOM spike in worker pod' },
      signal: new AbortController().signal,
    })

    expect(toolRes.isError).toBe(false)
    const rendered = (toolRes.content[0] as { text: string }).text
    expect(rendered).toContain('🚨 dsh-bot-sre')
    expect(rendered).toContain('memory memstore_2')

    // Two distinct bots with two isolated Memory Stores were created!
    expect(mock.agents.map(a => a.name)).toEqual(['dsh-bot-reviewer', 'dsh-bot-sre'])
    expect(mock.memoryStores.map(m => m.name)).toEqual(['dsh-bot-reviewer-memory', 'dsh-bot-sre-memory'])
  })
})

describe('Batch 2: 24/7 Cloud Routines (Deployments) & Offline Run Inbox', () => {
  it('validates 5-field POSIX cron, parses quoted slash-command args, and extracts [adopt-session:...] directives', () => {
    expect(validatePosixCron5('0 9 * * 1-5')).toBeUndefined()
    expect(validatePosixCron5('@daily')).toContain('not supported')
    expect(validatePosixCron5('0 0 9 * * *')).toContain('5-field')
    expect(validatePosixCron5('0 9 ? * MON')).toContain('special characters')

    expect(splitCommandArgs('routine create "Daily PR Digest" "0 9 * * 1-5" Check recent commits'))
      .toEqual(['routine', 'create', 'Daily PR Digest', '0 9 * * 1-5', 'Check', 'recent', 'commits'])

    expect(parseAdoptSessionDirective('[adopt-session:sess_routine_1] Explain finding #2'))
      .toEqual({ adoptSessionId: 'sess_routine_1', text: 'Explain finding #2' })
  })

  it('lets a Bot conversationally schedule its own 24/7 Cloud Routine via manage_bot_routine, run it, inspect the Offline Run Inbox, and adopt the run session for follow-ups', async () => {
    let streamTurn = 0
    const mock = await startMockQoder({
      environments: [{ id: 'env_cloud', name: 'default', config: { type: 'cloud' } }],
      stream: async (s: StreamContext) => {
        streamTurn++
        if (streamTurn === 1) {
          // Bot invokes client-side custom tool `manage_bot_routine` during chat!
          const callId = s.emit({
            type: 'agent.custom_tool_use',
            name: plugin.MANAGE_BOT_ROUTINE_TOOL,
            input: {
              action: 'create',
              name: 'Weekday Morning Digest',
              cron_expression: '0 9 * * 1-5',
              timezone: 'Asia/Shanghai',
              task_prompt: 'Review overnight commits and update awareness notes.',
            },
          })
          s.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [callId] } })
          const toolResult = await s.waitFor('user.custom_tool_result')
          expect(toolResult.is_error).toBe(false)
          const parsed = JSON.parse(toolResult.content[0].text)
          expect(parsed.deployment_id).toBe('dep_1')
          expect(parsed.schedule.expression).toBe('0 9 * * 1-5')

          s.emit({
            type: 'agent.message',
            content: [{ type: 'text', text: `Scheduled routine "${parsed.name}" (${parsed.deployment_id})!` }],
          })
          s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
        } else {
          // Stream turn 2: user adopted `sess_routine_2` from the Offline Run Inbox!
          expect(s.sessionId).toBe('sess_routine_2')
          s.emit({
            type: 'agent.message',
            content: [{ type: 'text', text: 'Resumed inside the routine session: commit #3 touched router.go.' }],
          })
          s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
        }
      },
    })
    cleanups.push(mock.close)

    const client = new QoderCloudClient({ baseURL: mock.baseURL, token: 'pt-test' })
    let saved: plugin.BotSelection = {}
    const manager = new BotManager({
      configured: () => saved,
      defaultBotName: 'dsh-bot-coder',
      defaultTemplateId: 'code-reviewer',
      defaultModel: 'ultimate',
      autoMemory: true,
      entryId: 'qoder-bots',
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
    })
    const routines = new RoutineManager({
      manager,
      repositoryMode: 'auto',
      gitToken: async () => 'ghp_test',
      gitTokenEnv: 'QODER_GIT_TOKEN',
      environmentVariables: { CI_MODE: 'routine' },
    })
    const adapter = new QoderBotAdapter({
      client: async () => client,
      manager,
      attachments: () => undefined,
      turnContext: () => ({ cwd: repo, asker: undefined }),
      repository: 'auto',
      gitToken: async () => 'ghp_test',
      gitTokenEnv: 'QODER_GIT_TOKEN',
      gitUsername: undefined,
      branchPrefix: 'qoder-bots/',
      toolConfirmation: 'allow',
      environmentVariables: { CI_MODE: 'routine' },
      customToolHandler: (call, sig) => routines.handleCustomToolCall(client, call, repo, sig),
    })

    // 1. User chats with Bot asking it to schedule a 9am weekday routine
    const chatChunks = await collectChunks(adapter.stream({
      provider: BOT_PROVIDER,
      model: BOT_ACTIVE_MODEL,
      messages: [{
        id: 'u1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Every weekday at 9am review overnight commits.' }],
      } as unknown as RequestMessage],
      sessionId: 'dsh_chat_1' as GenerateOptions['sessionId'],
    }))
    expect(blockTexts(chatChunks, 'text').join('\n')).toContain('Scheduled routine "Weekday Morning Digest" (dep_1)!')

    // Verify the created Deployment inherited both the Bot's MemoryStore AND the workspace Git repository!
    expect(mock.deployments).toHaveLength(1)
    expect(mock.deployments[0]!.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'memory_store', memory_store_id: 'memstore_1', access: 'read_write' }),
      expect.objectContaining({ type: 'github_repository', url: 'https://github.com/acme/demo.git' }),
    ]))
    expect(mock.deployments[0]!.environment_variables).toBe('CI_MODE=routine')

    // Verify created Bot Agent has the `manage_bot_routine` custom tool declared on it
    expect(mock.agents[0]!.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'custom', name: plugin.MANAGE_BOT_ROUTINE_TOOL }),
    ]))

    // 2. Manage routine & read Offline Run Inbox via `/qoder-bot routine` and `/qoder-bot runs`
    const cmd = qoderBotCommand({
      baseURL: mock.baseURL,
      client: async () => client,
      manager,
      routines,
      dreams: new plugin.DreamManager(manager),
      persist: async () => true,
      defaultBotName: 'dsh-bot-coder',
      cwd: () => repo,
    })
    const runCmd = (rawInput: string) => cmd.handler({ rawInput, signal: new AbortController().signal } as never)

    const listOut = await runCmd('routine list')
    expect((listOut as { text: string }).text).toContain('dep_1')
    expect((listOut as { text: string }).text).toContain('0 9 * * 1-5')

    const pauseOut = await runCmd('routine pause dep_1')
    expect((pauseOut as { text: string }).text).toContain('Paused routine "Weekday Morning Digest"')
    expect(mock.deployments[0]!.status).toBe('paused')

    const unpauseOut = await runCmd('routine unpause "Weekday Morning Digest"')
    expect((unpauseOut as { text: string }).text).toContain('Resumed routine "Weekday Morning Digest"')
    expect(mock.deployments[0]!.status).toBe('active')

    // Trigger immediate run (`POST /deployments/dep_1/run`)
    const triggerOut = await runCmd('routine run dep_1')
    expect((triggerOut as { text: string }).text).toContain('drun_1')
    expect((triggerOut as { text: string }).text).toContain('sess_routine_2')

    // Check Offline Run Inbox list & single run report
    const inboxList = await runCmd('runs')
    expect((inboxList as { text: string }).text).toContain('drun_1')
    expect((inboxList as { text: string }).text).toContain('Weekday Morning Digest')

    const runReport = await runCmd('runs drun_1')
    const reportText = (runReport as { text: string }).text
    expect(reportText).toContain('3 new commits reviewed, 0 critical issues.')
    expect(reportText).toContain('daily-digest.md (file_digest_1)')
    expect(reportText).toContain('[adopt-session:sess_routine_2]')

    // 3. Seamlessly adopt the background routine's cloud session in a new DSH conversation!
    const adoptChunks = await collectChunks(adapter.stream({
      provider: BOT_PROVIDER,
      model: BOT_ACTIVE_MODEL,
      messages: [{
        id: 'u_adopt',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '[adopt-session:sess_routine_2] Which file did commit #3 touch?' }],
      } as unknown as RequestMessage],
      sessionId: 'dsh_chat_adopted' as GenerateOptions['sessionId'],
    }))
    expect(blockTexts(adoptChunks, 'text').join('\n')).toContain('Resumed inside the routine session: commit #3 touched router.go.')
  })
})

describe('Batch 3: Memory CRUD, CoW Dream Consolidation + Rollback, and Multi-Bot Team Coordinator', () => {
  it('writes/updates/deletes Bot memories, runs CoW Dream consolidation (updating Bot + active Routines), and rolls back cleanly', async () => {
    const mock = await startMockQoder({
      environments: [{ id: 'env_cloud', name: 'default', config: { type: 'cloud' } }],
      stream: async (s: StreamContext) => {
        s.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Completed coding session!' }] })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
      },
    })
    cleanups.push(mock.close)

    let saved: plugin.BotSelection = {}
    const client = new QoderCloudClient({ baseURL: mock.baseURL, token: 'pt-test' })
    const manager = new BotManager({
      configured: () => saved,
      defaultBotName: 'dsh-bot-coder',
      defaultTemplateId: 'general-coder',
      defaultModel: 'ultimate',
      autoMemory: true,
      entryId: 'qoder-bots',
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
    })
    const routines = new RoutineManager({
      manager,
      repositoryMode: 'none',
      gitToken: async () => undefined,
      gitTokenEnv: 'QODER_GIT_TOKEN',
      environmentVariables: {},
    })
    const dreams = new plugin.DreamManager(manager)
    const cmd = qoderBotCommand({
      baseURL: mock.baseURL,
      client: async () => client,
      manager,
      routines,
      dreams,
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
      defaultBotName: 'dsh-bot-coder',
      cwd: () => plain,
    })
    const runCmd = (rawInput: string) => cmd.handler({ rawInput, signal: new AbortController().signal } as never)

    // 1. Create a Bot (`my-coder`) + a 24/7 Routine (`dep_1`) + one Session (`sess_1`)
    await runCmd('create general-coder my-coder')
    expect(saved.botId).toBe('agent_1')
    expect(mock.memoryStores[0]!.id).toBe('memstore_1')

    await runCmd('routine create "Nightly Architecture Check" "0 2 * * *" Verify architecture invariants')
    expect(mock.deployments).toHaveLength(1)
    expect(mock.deployments[0]!.resources).toEqual([
      expect.objectContaining({ type: 'memory_store', memory_store_id: 'memstore_1', access: 'read_write' }),
    ])

    await client.createSession({
      agent: 'agent_1',
      environment_id: 'env_cloud',
    })
    expect(mock.sessions).toHaveLength(1)

    // 2. Memory CRUD: write (create), write (update), write + delete
    const write1 = await runCmd('memory write /notes/arch.md "# Architecture\\n100% Managed Mode."')
    expect((write1 as { text: string }).text).toContain('Created memory "notes/arch.md"')

    const write2 = await runCmd('memory write notes/arch.md "# Architecture v2\\nCopy-on-Write Dreams."')
    expect((write2 as { text: string }).text).toContain('Updated memory "notes/arch.md"')

    const readArch = await runCmd('memory my-coder notes/arch.md')
    expect((readArch as { text: string }).text).toContain('v2)')
    expect((readArch as { text: string }).text).toContain('Copy-on-Write Dreams.')

    await runCmd('memory write notes/scratch.md "temporary scratch"')
    const delRes = await runCmd('memory delete notes/scratch.md')
    expect((delRes as { text: string }).text).toContain('Deleted memory "notes/scratch.md"')

    // 3. Run Dream Memory Consolidation (`running` -> polled `completed` -> atomic CoW swap!)
    const dreamRes = await runCmd('dream start my-coder "Synthesize architecture decisions"')
    expect(dreamRes.kind).toBe('success')
    const dreamText = (dreamRes as { text: string }).text
    expect(dreamText).toContain('Dream drm_1 completed')
    expect(dreamText).toContain('Consolidated Memory Store: memstore_2 (previous snapshot preserved: memstore_1)')
    expect(dreamText).toContain('consolidated-summary.md')
    expect(dreamText).toContain('Updated 1 routine(s) to new store: dep_1')

    // Verify POST /dreams fed BOTH the bot's Memory Store AND its recent Session!
    expect(mock.dreams[0]!.inputs).toEqual([
      { type: 'memory_store', memory_store_id: 'memstore_1' },
      { type: 'sessions', session_ids: ['sess_1'] },
    ])

    // Original memstore_1 is untouched (Copy-on-Write!), while Bot & Routine point to memstore_2
    expect(mock.memoryStores[0]!.entries.some(e => e.path === 'consolidated-summary.md')).toBe(false)
    expect(mock.memoryStores[1]!.entries.some(e => e.path === 'consolidated-summary.md')).toBe(true)
    expect(mock.deployments[0]!.resources).toEqual([
      expect.objectContaining({ type: 'memory_store', memory_store_id: 'memstore_2', access: 'read_write' }),
    ])

    const readSummary = await runCmd('memory my-coder consolidated-summary.md')
    expect((readSummary as { text: string }).text).toContain('Synthesized from 1 session(s).')

    // 4. Instant CoW Rollback restores both Bot and Routine back to memstore_1!
    const rbRes = await runCmd('dream rollback my-coder')
    expect(rbRes.kind).toBe('success')
    expect((rbRes as { text: string }).text).toContain('Active Memory Store restored to: memstore_1 (was memstore_2)')
    expect((rbRes as { text: string }).text).toContain('Repointed 1 active routine(s): dep_1')
    expect(mock.deployments[0]!.resources).toEqual([
      expect.objectContaining({ type: 'memory_store', memory_store_id: 'memstore_1', access: 'read_write' }),
    ])
  })

  it('assembles a Multi-Bot Team Coordinator (+ Advisor), enforces depth-1 nesting guard, and streams child thread collaboration', async () => {
    const mock = await startMockQoder({
      environments: [{ id: 'env_cloud', name: 'default', config: { type: 'cloud' } }],
      stream: async (s: StreamContext) => {
        s.emit({ type: 'session.status_running' })
        s.emit({
          type: 'session.thread_created',
          session_thread_id: 'thrd_rev_1',
          agent_name: 'dsh-bot-reviewer',
        })
        s.emit({
          type: 'agent.thread_message_sent',
          to_session_thread_id: 'thrd_rev_1',
          to_agent_name: 'dsh-bot-reviewer',
          content: [{ type: 'text', text: 'Audit token rotation logic in src/auth.ts' }],
        })
        s.emit({
          type: 'agent.thread_message_received',
          from_session_thread_id: 'thrd_rev_1',
          from_agent_name: 'dsh-bot-reviewer',
          content: [{ type: 'text', text: 'Verified: mutex guards concurrent refresh.' }],
        })
        s.emit({
          type: 'session.thread_status_idle',
          session_thread_id: 'thrd_rev_1',
        })
        s.emit({
          type: 'agent.message',
          content: [{ type: 'text', text: 'Team audit complete: auth module is concurrency-safe.' }],
        })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
      },
    })
    cleanups.push(mock.close)

    let saved: plugin.BotSelection = {}
    const client = new QoderCloudClient({ baseURL: mock.baseURL, token: 'pt-test' })
    const manager = new BotManager({
      configured: () => saved,
      defaultBotName: 'dsh-bot-coder',
      defaultTemplateId: 'general-coder',
      defaultModel: 'ultimate',
      autoMemory: true,
      entryId: 'qoder-bots',
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
    })
    const routines = new RoutineManager({
      manager,
      repositoryMode: 'none',
      gitToken: async () => undefined,
      gitTokenEnv: 'QODER_GIT_TOKEN',
      environmentVariables: {},
    })
    const dreams = new plugin.DreamManager(manager)
    const cmd = qoderBotCommand({
      baseURL: mock.baseURL,
      client: async () => client,
      manager,
      routines,
      dreams,
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
      defaultBotName: 'dsh-bot-coder',
      cwd: () => plain,
    })
    const runCmd = (rawInput: string) => cmd.handler({ rawInput, signal: new AbortController().signal } as never)

    // 1. Assemble team from built-in template slugs (auto-provisions both specialist bots + coordinator!)
    const teamCreate = await runCmd('team create eng-squad code-reviewer,deep-researcher')
    expect(teamCreate.kind).toBe('success')
    expect((teamCreate as { text: string }).text).toContain('Assembled and activated Multi-Bot Team: 👥 eng-squad (agent_3)')
    expect((teamCreate as { text: string }).text).toContain('🔍 dsh-bot-reviewer (agent_1)')
    expect((teamCreate as { text: string }).text).toContain('🕵️ dsh-bot-researcher (agent_2)')

    // Coordinator agent carries `multiagent: { type: 'coordinator', agents: [agent_1, agent_2, advisor] }`
    expect(mock.agents[2]!.multiagent).toEqual({
      type: 'coordinator',
      agents: [
        { type: 'agent', id: 'agent_1', version: 1 },
        { type: 'agent', id: 'agent_2', version: 1 },
        { type: 'advisor', model: 'ultimate' },
      ],
    })

    // 2. Enforce Qoder Cloud depth-1 rule: a coordinator team cannot be nested inside another team
    const nestedAttempt = await runCmd('team create meta-squad eng-squad')
    expect(nestedAttempt.kind).toBe('error')
    expect((nestedAttempt as { text: string }).text).toContain('depth limit is 1')

    // 3. Stream a conversation with the active Team Coordinator and observe live child thread events
    const adapter = new QoderBotAdapter({
      client: async () => client,
      manager,
      attachments: () => undefined,
      turnContext: () => ({ cwd: plain, asker: undefined }),
      repository: 'none',
      gitToken: async () => undefined,
      gitTokenEnv: 'QODER_GIT_TOKEN',
      gitUsername: undefined,
      branchPrefix: 'qoder-bots/',
      toolConfirmation: 'allow',
      environmentVariables: {},
    })

    const chunks = await collectChunks(adapter.stream({
      provider: BOT_PROVIDER,
      model: BOT_ACTIVE_MODEL,
      messages: [{
        id: 'u_team_1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Have the squad audit src/auth.ts' }],
      } as unknown as RequestMessage],
      sessionId: 'dsh_team_chat_1' as GenerateOptions['sessionId'],
    }))

    const reasoning = blockTexts(chunks, 'reasoning').join('\n')
    expect(reasoning).toContain('🧵 Spawned sub-bot thread `dsh-bot-reviewer` (thrd_rev_1)')
    expect(reasoning).toContain('↗ Delegated to `dsh-bot-reviewer`: Audit token rotation logic in src/auth.ts')
    expect(reasoning).toContain('↙ Report from `dsh-bot-reviewer`: Verified: mutex guards concurrent refresh.')
    expect(reasoning).toContain('✓ Sub-bot thread `thrd_rev_1` settled (idle)')
    expect(blockTexts(chunks, 'text').join('\n')).toContain('Team audit complete: auth module is concurrency-safe.')

    // Verify child thread inspection API (`GET /sessions/sess_1/threads`)
    const threads = await client.listSessionThreads('sess_1')
    expect(threads.data).toEqual([
      expect.objectContaining({ id: 'thrd_rev_1', session_id: 'sess_1', status: 'idle' }),
    ])
  })
})

describe('Persistent Cloud Computer, Live Browser Frame, Needs Approval Gate & API Bridge', () => {
  it('reuses a Bot\'s persistent primary Cloud Computer across separate DSH conversations, streams live browser screenshots via /api/qoder-bots/file, and resolves human Needs Approval gates via /api/qoder-bots/action', async () => {
    const tracker = new plugin.LiveSessionTracker()
    const mock = await startMockQoder({
      environments: [{ id: 'env_cloud', name: 'default', config: { type: 'cloud' } }],
      stream: async (s: StreamContext) => {
        s.emit({ type: 'session.status_running' })
        s.emit({
          type: 'agent.tool_use',
          name: 'browser_navigate',
          input: { url: 'https://docs.qoder.com/cloud-agents' },
        })
        s.emit({
          type: 'agent.artifact_delivered',
          file_id: 'file_viewport_1',
          original_filename: 'browser-screenshot-1.png',
          content_type: 'image/png',
          size: 2048,
        })
        const bashId = s.emit({
          type: 'agent.tool_use',
          name: 'Bash',
          input: { command: 'git push origin release/v2' },
        })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [bashId] } })
        const confirm = await s.waitFor('user.tool_confirmation')
        expect(confirm.result).toBe('allow')
        expect(confirm.tool_use_id).toBe(bashId)
        s.emit({
          type: 'agent.message',
          content: [{ type: 'text', text: `Operated browser & completed approved Bash in ${s.sessionId}!` }],
        })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
      },
    })
    cleanups.push(mock.close)

    let saved: plugin.BotSelection = {}
    const client = new QoderCloudClient({ baseURL: mock.baseURL, token: 'pt-test' })
    const manager = new BotManager({
      configured: () => saved,
      defaultBotName: 'dsh-bot-coder',
      defaultTemplateId: 'web-operator',
      defaultModel: 'ultimate',
      autoMemory: true,
      entryId: 'qoder-bots',
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
    })
    const routines = new RoutineManager({
      manager,
      repositoryMode: 'none',
      gitToken: async () => undefined,
      gitTokenEnv: 'QODER_GIT_TOKEN',
      environmentVariables: {},
    })
    const dreams = new plugin.DreamManager(manager)
    const api = plugin.createBotApiHandlers({
      baseURL: mock.baseURL,
      client: async () => client,
      manager,
      routines,
      dreams,
      tracker,
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
      cwd: () => plain,
    })

    // 1. Create a gated Web Operator bot via POST /api/qoder-bots/action
    const createRes = await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'createBot',
        templateId: 'web-operator',
        name: 'my-operator',
        approvalMode: 'gated',
        browserEnabled: true,
        vaultIds: ['vlt_prod_ro'],
        skillIds: ['skill_pr_audit'],
      }),
    }))
    const createJson = await createRes.json() as any
    expect(createJson.ok).toBe(true)
    expect(createJson.bot.approvalMode).toBe('gated')
    expect(createJson.bot.browserEnabled).toBe(true)
    expect(createJson.bot.vaultIds).toEqual(['vlt_prod_ro'])
    expect(mock.agents[0]!.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'agent_toolset_20260401',
        configs: expect.arrayContaining([
          { name: 'Bash', permission_policy: { type: 'always_ask' } },
        ]),
      }),
      { type: plugin.BROWSER_TOOLSET },
    ]))

    // 2. Provision persistent Cloud Computer via `openBotComputer`
    const openCompRes = await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'openBotComputer',
        botId: createJson.bot.id,
        dshSessionId: 'dsh_conv_A',
      }),
    }))
    const openCompJson = await openCompRes.json() as any
    expect(openCompJson.ok).toBe(true)
    expect(openCompJson.created).toBe(true)
    expect(openCompJson.remoteSessionId).toBe('sess_1')

    // 3. Start streaming turn on `dsh_conv_A`; while paused on `Needs Approval`, approve from API!
    const adapter = new QoderBotAdapter({
      client: async () => client,
      manager,
      tracker,
      attachments: () => undefined,
      turnContext: () => ({ cwd: plain, asker: undefined }),
      repository: 'none',
      gitToken: async () => undefined,
      gitTokenEnv: 'QODER_GIT_TOKEN',
      gitUsername: undefined,
      branchPrefix: 'qoder-bots/',
      toolConfirmation: 'deny',
      environmentVariables: {},
    })

    const turnPromise = collectChunks(adapter.stream({
      provider: BOT_PROVIDER,
      model: `${BOT_MODEL_PREFIX}${createJson.bot.id}`,
      messages: [{
        id: 'u_op_1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Open Qoder docs and push release.' }],
      } as unknown as RequestMessage],
      sessionId: 'dsh_conv_A' as GenerateOptions['sessionId'],
    }))

    // Wait briefly until `tracker.listPendingApprovals()` records the paused Bash tool call
    let pending = tracker.listPendingApprovals()
    for (let i = 0; i < 30 && pending.length === 0; i++) {
      await new Promise(r => setTimeout(r, 30))
      pending = tracker.listPendingApprovals()
    }
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('Bash')

    // Verify Live Cloud Computer endpoint reports `needs_approval`, `currentBrowserUrl`, and `latestBrowserFrame`!
    const compStatusRes = await api.handleComputerStatus(
      new Request('http://localhost/api/qoder-bots/computer?dshSessionId=dsh_conv_A'),
    )
    const compStatus = await compStatusRes.json() as any
    expect(compStatus.computer.status).toBe('needs_approval')
    expect(compStatus.computer.currentBrowserUrl).toBe('https://docs.qoder.com/cloud-agents')
    expect(compStatus.computer.latestBrowserFrame.filename).toBe('browser-screenshot-1.png')
    expect(compStatus.takeoverUrl).toContain('sess_1/browser')

    // Approve via `decideApproval` HTTP action (just like clicking Approve in Studio Inbox or Right Sidebar!)
    const decideRes = await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'decideApproval',
        toolUseId: pending[0]!.toolUseId,
        remoteSessionId: 'sess_1',
        decision: 'allow',
      }),
    }))
    expect((await decideRes.json() as any).ok).toBe(true)

    const chunksA = await turnPromise
    const textA = blockTexts(chunksA, 'text').join('\n')
    expect(textA).toContain('Operated browser & completed approved Bash in sess_1!')
    expect(textA).toContain('/api/qoder-bots/file?id=file_viewport_1')

    // 4. Stream file binary via GET /api/qoder-bots/file
    const fileRes = await api.handleFileFetch(
      new Request('http://localhost/api/qoder-bots/file?id=file_viewport_1&name=browser-screenshot-1.png&inline=1'),
    )
    expect(fileRes.status).toBe(200)
    expect(fileRes.headers.get('content-type')).toBe('image/png')

    // 5. Open a brand-new DSH conversation (`dsh_conv_B`) with the same Bot WITHOUT pre-binding:
    //    `createRemoteBotSession` automatically reuses `dsh_primary_session_id` (`sess_1`)!
    const turnBPromise = collectChunks(adapter.stream({
      provider: BOT_PROVIDER,
      model: `${BOT_MODEL_PREFIX}${createJson.bot.id}`,
      messages: [{
        id: 'u_op_2',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Continue in my persistent computer!' }],
      } as unknown as RequestMessage],
      sessionId: 'dsh_conv_B' as GenerateOptions['sessionId'],
    }))
    let pendingB = tracker.listPendingApprovals()
    for (let i = 0; i < 30 && pendingB.length === 0; i++) {
      await new Promise(r => setTimeout(r, 30))
      pendingB = tracker.listPendingApprovals()
    }
    await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'decideApproval',
        toolUseId: pendingB[0]!.toolUseId,
        remoteSessionId: 'sess_1',
        decision: 'allow',
      }),
    }))
    const chunksB = await turnBPromise
    expect(blockTexts(chunksB, 'text').join('\n')).toContain('in sess_1!')
    expect(mock.sessions).toHaveLength(1)

    // 6. Verify Hybrid Local Bot Binding (`openLocalBot` -> `executionMode: 'local'`)
    const localBindRes = await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'openLocalBot',
        botId: createJson.bot.id,
        dshSessionId: 'dsh_local_conv_1',
      }),
    }))
    const localBindJson = await localBindRes.json() as any
    expect(localBindJson.ok).toBe(true)
    expect(localBindJson.executionMode).toBe('local')

    const localCompRes = await api.handleComputerStatus(
      new Request('http://localhost/api/qoder-bots/computer?dshSessionId=dsh_local_conv_1'),
    )
    const localCompJson = await localCompRes.json() as any
    expect(localCompJson.executionMode).toBe('local')
    expect(localCompJson.bot.id).toBe(createJson.bot.id)
  })

  it('runs standalone Super-Agent Bot objectives via sendBotMessage without creating any DSH session, hydrates messages + sub-worker threads + browser frames via /computer, and resolves Needs Approval', async () => {
    const tracker = new plugin.LiveSessionTracker()
    const mock = await startMockQoder({
      environments: [{ id: 'env_cloud', name: 'default', config: { type: 'cloud' } }],
      stream: async (s: StreamContext) => {
        s.emit({ type: 'session.status_running' })
        s.emit({
          type: 'session.thread_created',
          session_thread_id: 'thrd_worker_1',
          agent_name: 'dsh-bot-reviewer',
        })
        s.emit({
          type: 'agent.tool_use',
          name: 'browser_navigate',
          input: { url: 'https://example.com' },
        })
        s.emit({
          type: 'agent.artifact_delivered',
          file_id: 'file_stand_frame_1',
          original_filename: 'standalone-viewport.png',
          content_type: 'image/png',
          size: 1024,
        })
        const writeId = s.emit({
          type: 'agent.tool_use',
          name: 'Write',
          input: { file_path: '/data/report.md' },
        })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [writeId] } })
        const confirm = await s.waitFor('user.tool_confirmation')
        expect(confirm.result).toBe('allow')
        s.emit({
          type: 'agent.message',
          content: [{ type: 'text', text: 'Standalone Super-Agent objective completed with live browser & worker!' }],
        })
        s.emit({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } })
      },
    })
    cleanups.push(mock.close)

    let saved: plugin.BotSelection = {}
    const client = new QoderCloudClient({ baseURL: mock.baseURL, token: 'pt-test' })
    const manager = new BotManager({
      configured: () => saved,
      defaultBotName: 'dsh-bot-coder',
      defaultTemplateId: 'web-operator',
      defaultModel: 'ultimate',
      autoMemory: true,
      entryId: 'qoder-bots',
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
    })
    const routines = new RoutineManager({
      manager,
      repositoryMode: 'none',
      gitToken: async () => undefined,
      gitTokenEnv: 'QODER_GIT_TOKEN',
      environmentVariables: {},
    })
    const dreams = new plugin.DreamManager(manager)
    const workspace = new plugin.BotWorkspaceRunner({
      client: async () => client,
      manager,
      tracker,
      toolConfirmation: 'deny',
      customToolHandler: (call, sig) => routines.handleCustomToolCall(client, call, plain, sig),
    })
    const api = plugin.createBotApiHandlers({
      baseURL: mock.baseURL,
      client: async () => client,
      manager,
      routines,
      dreams,
      tracker,
      workspace,
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
      cwd: () => plain,
    })

    const createRes = await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'createBot',
        templateId: 'web-operator',
        name: 'standalone-scout',
        approvalMode: 'gated',
        browserEnabled: true,
      }),
    }))
    const botId = ((await createRes.json()) as any).bot.id

    // Send objective directly inside standalone Bots app (no dshSessionId at all!)
    const sendRes = await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'sendBotMessage',
        botId,
        text: 'Inspect https://example.com and write report.',
      }),
    }))
    const sendJson = await sendRes.json() as any
    expect(sendJson.ok).toBe(true)
    expect(sendJson.remoteSessionId).toBe('sess_1')

    // Wait for Needs Approval gate
    let pending = tracker.listPendingApprovals()
    for (let i = 0; i < 40 && pending.length === 0; i++) {
      await new Promise(r => setTimeout(r, 25))
      pending = tracker.listPendingApprovals()
    }
    expect(pending).toHaveLength(1)
    expect(pending[0]!.toolName).toBe('Write')

    // Approve via API
    await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'decideApproval',
        toolUseId: pending[0]!.toolUseId,
        remoteSessionId: 'sess_1',
        decision: 'allow',
      }),
    }))

    // Wait until background runner finishes turn
    for (let i = 0; i < 40 && workspace.isRunning('sess_1'); i++) {
      await new Promise(r => setTimeout(r, 25))
    }

    const compRes = await api.handleComputerStatus(
      new Request(`http://localhost/api/qoder-bots/computer?botId=${encodeURIComponent(botId)}`),
    )
    const compJson = await compRes.json() as any
    expect(compJson.ok).toBe(true)
    expect(compJson.computer.currentBrowserUrl).toBe('https://example.com')
    expect(compJson.computer.latestBrowserFrame.filename).toBe('standalone-viewport.png')
    expect(compJson.threads).toHaveLength(1)
    expect(compJson.messages.map((m: any) => m.role)).toEqual(['user', 'assistant'])
    expect(compJson.messages[1].text).toContain('Standalone Super-Agent objective completed')
    expect(compJson.messages[1].steps.some((s: any) => s.kind === 'thread')).toBe(true)
  })

  it('provisions shared Cloud Computer environments (runtime_mode=shared) and binds isolated slot_id per Bot', async () => {
    const tracker = new plugin.LiveSessionTracker()
    const mock = await startMockQoder({
      environments: [],
      stream: async () => {},
    })
    cleanups.push(mock.close)

    let saved: plugin.BotSelection = {}
    const client = new QoderCloudClient({ baseURL: mock.baseURL, token: 'pt-test' })
    const manager = new BotManager({
      configured: () => saved,
      defaultBotName: 'dsh-bot-coder',
      defaultTemplateId: 'web-operator',
      defaultModel: 'ultimate',
      autoMemory: true,
      entryId: 'qoder-bots',
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
    })
    const routines = new RoutineManager({
      manager,
      repositoryMode: 'none',
      gitToken: async () => undefined,
      gitTokenEnv: 'QODER_GIT_TOKEN',
      environmentVariables: {},
    })
    const api = plugin.createBotApiHandlers({
      baseURL: mock.baseURL,
      client: async () => client,
      manager,
      routines,
      dreams: new plugin.DreamManager(manager),
      tracker,
      persist: async (sel) => {
        saved = { ...saved, ...sel }
        return true
      },
      cwd: () => plain,
    })

    // 1. Provision a persistent Cloud Computer (`runtime_mode: "shared"`)
    const provRes = await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'provisionCloudComputer', name: 'dsh-shared-desktop', idleTimeoutSeconds: 3600 }),
    }))
    const provJson = await provRes.json() as any
    expect(provJson.ok).toBe(true)
    expect(provJson.environment.config.runtime_mode).toBe('shared')
    expect(provJson.environment.runtime.status).toBe('ready')

    // 2. Create Bot and open its persistent Cloud Computer session — should bind `slot_id` + `session-slot-2026-11-24` beta header!
    const bot = await manager.createBot(client, { templateId: 'web-operator', name: 'slot-scout' }, new AbortController().signal)
    const openRes = await api.handleAction(new Request('http://localhost/api/qoder-bots/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'openBotComputer', botId: bot.id }),
    }))
    const openJson = await openRes.json() as any
    expect(openJson.ok).toBe(true)
    expect(openJson.environment.config.runtime_mode).toBe('shared')
    expect(openJson.slotId).toBe(`bot_${bot.id.replace(/^agent_/, '')}`)

    const sessCreateReq = mock.requests.find(r => r.method === 'POST' && r.path === '/sessions')
    expect(String(sessCreateReq?.headers['x-qoder-beta'] ?? '')).toContain('session-slot-2026-11-24')
    expect(sessCreateReq?.body.slot_id).toBe(`bot_${bot.id.replace(/^agent_/, '')}`)

    const compRes = await api.handleComputerStatus(
      new Request(`http://localhost/api/qoder-bots/computer?botId=${encodeURIComponent(bot.id)}`),
    )
    const compJson = await compRes.json() as any
    expect(compJson.environment.config.runtime_mode).toBe('shared')
    expect(compJson.slotId).toBe(`bot_${bot.id.replace(/^agent_/, '')}`)
  })
})
