/**
 * Child plugin of the 「Qoder Bot 模式」 agent preset: pins every model request
 * of the preset's agent to the `qoder-bots` provider route, and stabilizes
 * `{{provider}}` / `{{model}}` template variables across turns.
 *
 * @module dsh-qoder-bots/bot-route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { BOT_ACTIVE_MODEL, BOT_MODEL_PREFIX, BOT_PROVIDER } from './bot-constants.ts'

export const name = 'qoder-bots-route'

export function apply(ctx: Context): void {
  ctx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const { reasoningEffort: _effort, maxTokens: _maxTokens, ...rest } = await next()
    // Preserve an explicit `bot:<agent_id>` model choice when the user picked a specific bot in the model selector;
    // otherwise route to the profile's active bot (`active-bot`).
    const chosenModel = rest.provider === BOT_PROVIDER && rest.model.startsWith(BOT_MODEL_PREFIX)
      ? rest.model
      : BOT_ACTIVE_MODEL
    return { ...rest, provider: BOT_PROVIDER, model: chosenModel }
  }, { prepend: true })

  ctx.on('system-prompt/assemble', async (_assembly, _context, next): Promise<PromptAssembly> => {
    const assembly = await next()
    return {
      ...assembly,
      variables: {
        ...assembly.variables,
        provider: BOT_PROVIDER,
        model: BOT_ACTIVE_MODEL,
      },
    }
  }, { prepend: true })
}
