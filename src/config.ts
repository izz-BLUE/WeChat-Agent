import 'dotenv/config'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { memoryFileIn } from './memory-store.js'

export type BotMode = 'smoke' | 'chat'

function positiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const botMode = process.env.BOT_MODE ?? 'smoke'

if (botMode !== 'smoke' && botMode !== 'chat') {
  throw new Error('BOT_MODE must be smoke or chat')
}

/**
 * Runtime memory data path.
 *
 * CURRENT_MIGRATION_DECISION: `WECHAT_MEMORY_PATH` points at agent runtime data
 * (a directory, or an explicit `*.json` file). The default is the per-user
 * application data directory the historical store already used
 * (`%LOCALAPPDATA%\WeChatAgent`). Candidate / freeze artifact roots are rejected
 * by `MemoryStore` so runtime memory can never land in a release artifact.
 */
export function resolveMemoryFilePath(): { filePath: string; source: string } {
  const configured = process.env.WECHAT_MEMORY_PATH?.trim()
  if (configured) {
    const resolved = isAbsolute(configured) ? configured : join(process.cwd(), configured)
    return {
      filePath: resolved.toLowerCase().endsWith('.json') ? resolved : memoryFileIn(resolved),
      source: 'WECHAT_MEMORY_PATH',
    }
  }

  const localAppData = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
  return { filePath: memoryFileIn(join(localAppData, 'WeChatAgent', 'memory')), source: 'DEFAULT' }
}

const memoryPath = resolveMemoryFilePath()

export const config = {
  puppet: process.env.WECHATY_PUPPET ?? 'xp',
  botMode: botMode as BotMode,
  botDisplayName: process.env.BOT_DISPLAY_NAME?.trim() || '椰椰',
  openAiApiBase: process.env.OPENAI_API_BASE?.replace(/\/$/, '') ?? '',
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  openAiModel: process.env.OPENAI_MODEL ?? '',
  contextMessageLimit: positiveInteger('CONTEXT_MESSAGE_LIMIT', 50),
  maxContextMessages: positiveInteger('MAX_CONTEXT_MESSAGES', 100),
  maxContextChars: positiveInteger('MAX_CONTEXT_CHARS', 12_000),
  /**
   * Group ambient context budget. `maxEntries` and the TTL both apply, and the
   * character budget bounds the final render so 30 long messages cannot blow up
   * the prompt. The most recent lines always win.
   */
  ambientMaxEntries: positiveInteger('GROUP_AMBIENT_MAX_ENTRIES', 30),
  ambientTtlMs: positiveInteger('GROUP_AMBIENT_TTL_MINUTES', 30) * 60_000,
  ambientMaxChars: positiveInteger('GROUP_AMBIENT_MAX_CHARS', 4_000),
  /** Persistent memory is on by default; `WECHAT_MEMORY_ENABLED=0` disables it. */
  memoryEnabled: (process.env.WECHAT_MEMORY_ENABLED ?? '1').trim() !== '0',
  memoryFilePath: memoryPath.filePath,
  memoryPathSource: memoryPath.source,
}

export function validateChatConfig(): void {
  const missing = [
    ['OPENAI_API_BASE', config.openAiApiBase],
    ['OPENAI_API_KEY', config.openAiApiKey],
    ['OPENAI_MODEL', config.openAiModel],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(`Chat mode requires: ${missing.join(', ')}`)
  }
}
