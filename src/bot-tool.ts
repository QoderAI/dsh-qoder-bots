/**
 * First-party typed DSH tool (`ask_qoder_bot`) registered onto `ctx.tools`
 * so the local DeepSeek agent can explicitly delegate tasks to a named Qoder
 * Cloud Bot (by bot name, agent ID, or built-in template slug like
 * `deep-researcher` / `code-reviewer`), with each bot automatically carrying
 * its own cloud persona and persistent Memory Store.
 *
 * @module dsh-qoder-bots/bot-tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { BUILTIN_BOT_TEMPLATES } from './templates.ts'

export const ASK_BOT_TOOL_NAME = 'ask_qoder_bot'

export interface AskBotToolDeps {
  readonly runDelegation: (params: {
    bot?: string | undefined
    task: string
    callerAgent: unknown
    signal: AbortSignal
  }) => Promise<{ text: string; stopReason: string }>
}

export function createAskQoderBotTool(deps: AskBotToolDeps): ToolDefinition {
  const templateList = BUILTIN_BOT_TEMPLATES.map(t => `${t.id} (${t.avatar} ${t.description})`).join('; ')
  return defineTool({
    name: ASK_BOT_TOOL_NAME,
    description: [
      'Delegate a self-contained coding, review, research, or data analysis task to a named Qoder Cloud Bot running in an isolated cloud sandbox with its own persistent Memory Store.',
      `Built-in bot templates (auto-created on first use if not yet provisioned): ${templateList}.`,
      'You can also pass any existing Qoder Bot name or `agent_...` ID, or omit `bot` to use the profile\'s active bot.',
    ].join(' '),
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'Complete, self-contained instructions for the Qoder Cloud Bot.',
      },
      bot: {
        type: 'string',
        description: 'Target bot name, `agent_...` ID, or built-in template slug (e.g. `code-reviewer`, `deep-researcher`, `data-analyst`, `incident-commander`). Omit to use the active bot.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reply: { type: 'string', required: true },
          stopReason: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.reply }]
      },
    },
    isConcurrencySafe() {
      // Cloud bots run in isolated remote sandboxes, so parallel @bot fan-out is safe!
      return true
    },
    async execute(args, exec) {
      const out = await deps.runDelegation({
        bot: args.bot,
        task: args.task,
        callerAgent: exec.agent,
        signal: exec.signal,
      })
      return {
        reply: out.text,
        stopReason: out.stopReason,
      }
    },
  })
}
