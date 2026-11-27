/**
 * Shared route constants for Qoder Bot mode. Kept free of heavy imports so
 * both the host plugin (`src/index.ts`), the preset child (`src/bot-route.ts`),
 * the adapter (`src/bot-mode.ts`), and the API bridge (`src/api-routes.ts`)
 * share a single source of truth.
 *
 * @module dsh-qoder-bots/bot-constants
 */

/** LLM provider id registered by `dsh-qoder-bots`. */
export const BOT_PROVIDER = 'qoder-bots'

/** Default model route id representing the currently selected active bot. */
export const BOT_ACTIVE_MODEL = 'active-bot'

/** Prefix for explicit per-bot model route ids (`bot:<agent_id>`). */
export const BOT_MODEL_PREFIX = 'bot:'

/** Agent preset id inserted by `cordis.patch.yml`. */
export const BOT_PRESET_ID = 'qoder-bots'

/** Host HTTP API prefix mounted on `ctx.connection.fetch` / `ctx.webServer`. */
export const API_BASE_PATH = '/api/qoder-bots'

/** Qoder Cloud Browser Use & Shared Cloud Computer Desktop Slot beta headers. */
export const BROWSER_TOOLSET = 'browser_toolset_20260714'
export const BROWSER_USE_BETA = 'browser-use-2026-07-14'
export const SESSION_SLOT_BETA = 'session-slot-2026-11-24'
export const DEFAULT_QODER_BETA_HEADER = `${BROWSER_USE_BETA},${SESSION_SLOT_BETA}`

/** Metadata keys written to Qoder Cloud Agents / Memory Stores / Deployments managed as bots. */
export const BOT_META_FLAG = 'dsh_bot'
export const BOT_META_TEMPLATE = 'dsh_bot_template'
export const BOT_META_MEMORY_STORE_ID = 'dsh_memory_store_id'
export const BOT_META_PREV_MEMORY_STORE_ID = 'dsh_prev_memory_store_id'
export const BOT_META_LAST_DREAM_ID = 'dsh_last_dream_id'
export const BOT_META_AVATAR = 'dsh_bot_avatar'
export const BOT_META_TEAM_FLAG = 'dsh_bot_team'
export const BOT_META_TEAM_MEMBERS = 'dsh_bot_team_members'
export const BOT_META_ROUTINE_FLAG = 'dsh_bot_routine'
export const BOT_META_BOT_ID = 'dsh_bot_id'
export const BOT_META_BOT_NAME = 'dsh_bot_name'

/** Persistent Cloud Computer metadata keys: default runtime (local | cloud), primary session, dedicated env, approval gate, vaults & browser. */
export const BOT_META_DEFAULT_RUNTIME = 'dsh_default_runtime'
export const BOT_META_PRIMARY_SESSION_ID = 'dsh_primary_session_id'
export const BOT_META_DEDICATED_ENV_ID = 'dsh_env_id'
export const BOT_META_APPROVAL_MODE = 'dsh_approval_mode'
export const BOT_META_VAULT_IDS = 'dsh_vault_ids'
export const BOT_META_BROWSER_ENABLED = 'dsh_browser_enabled'

/** Custom client-side tool injected into Managed Bots so they can conversationally manage 24/7 Cloud Routines. */
export const MANAGE_BOT_ROUTINE_TOOL = 'manage_bot_routine'
