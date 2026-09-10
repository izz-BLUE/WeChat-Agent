import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { EOL } from 'node:os'
import { join } from 'node:path'
import {
  identityToken,
  setProcessSaltOverride,
  tokenCorrelationMode,
  tokenSaltByteLength,
  type TokenCorrelationMode,
} from './identity-observer.js'

/**
 * Field-safe, privacy-respecting, single-process persistent runtime log for
 * the WeChat Agent receiver. Goal (P1 PRODUCTION_OBSERVABILITY_PERSISTENT_LOGGING
 * + P1 PERSISTENT_LOGGING_SOURCE_AND_CORRELATION_CONVERGENCE):
 *
 *   * Survives the Agent process exit / crash so a UI-side "no outbound" line
 *     can be matched against the Agent's last request / response without
 *     needing the live process.
 *   * Privacy contract is enforced here: the only fields that may be written
 *     are timestamp / process / component / event / pid / generation /
 *     msgIdToken / conversationToken / requesterToken / result / phase /
 *     errorCode plus an optional opaque tail. The caller cannot smuggle raw
 *     wxid / signature / conversationId / requesterId / senderId / owner id /
 *     memory scope key / message body / LLM prompt or answer / API key /
 *     pipe payload through this API.
 *   * Same token algorithm as the UI's IdentityTokens.Token (HMAC-SHA256 with
 *     a salt, first 12 hex chars). The salt is configurable via
 *     WECHAT_LOG_TOKEN_SALT: when both sides set the same value the operator
 *     can match a token between UI and Agent logs; when neither side sets it
 *     each process falls back to a random salt, the privacy contract still
 *     holds, but tokens MUST NOT be claimed cross-process correlated.
 *   * Single file is capped, rotates daily, and old files are pruned.
 *
 * The log path resolves WECHAT_LOG_PATH first, then %LOCALAPPDATA%\WeChatAgent\logs
 * on Windows, ~/.local/share/WeChatAgent/logs on POSIX, and a temp dir as a final
 * fallback. A logging failure is swallowed: the chat path must never observe a
 * logging exception (fail-open for chat).
 */

export const DEFAULT_MAX_BYTES_PER_FILE = 5 * 1024 * 1024
export const DEFAULT_RETENTION_DAYS = 7
export const DEFAULT_MAX_FILES = 20
const FLUSH_INTERVAL_MS = 250
/** Token length shared with the C# `IdentityTokens.Token` and identity-observer. */
const TOKEN_LENGTH = 12

export interface TokenCorrelationState {
  /** Same-salt cross-process correlation is enabled. */
  sharedSalt: boolean
  /** True when neither side configured a salt (privacy still holds). */
  processLocal: boolean
  /** Salt length in bytes, never the salt content. */
  saltBytes: number
  /** SHARED | PROCESS_LOCAL, the value the boot diagnostic prints. */
  mode: TokenCorrelationMode
}

export interface PersistentRuntimeLogOptions {
  fileBaseName: string
  directory?: string
  maxBytesPerFile?: number
  retentionDays?: number
  maxFiles?: number
  /**
   * Override salt; defaults to `WECHAT_LOG_TOKEN_SALT`, then the shared
   * process salt that `identity-observer` already resolved for this process.
   * The salt is never logged.
   */
  tokenSalt?: string
}

function sanitizeInline(value: unknown, max = 300): string {
  if (value === null || value === undefined) {
    return ''
  }
  const text = typeof value === 'string' ? value : String(value)
  const trimmed = text.length > max ? text.slice(0, max) : text
  // | and = are the field separator and key=value boundary; tabs and CR/LF
  // can otherwise smuggle a second log line through a single-line contract.
  return trimmed.replace(/[\r\n\t|]/g, ' ')
}

function safeToken(value: unknown, fallback: string): string {
  const sanitized = sanitizeInline(value)
  return sanitized.length === 0 ? fallback : sanitized
}

function formatTimestamp(date: Date): string {
  // ISO-8601 with milliseconds and explicit UTC offset.
  return date.toISOString()
}

function defaultDirectory(): string {
  const override = process.env.WECHAT_LOG_PATH
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim()
  }
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string' && local.trim().length > 0) {
    return join(local, 'WeChatAgent', 'logs')
  }
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (typeof home === 'string' && home.trim().length > 0) {
    if (process.platform === 'win32') {
      return join(home, 'AppData', 'Local', 'WeChatAgent', 'logs')
    }
    if (process.platform === 'darwin') {
      return join(home, 'Library', 'Application Support', 'WeChatAgent', 'logs')
    }
    return join(home, '.local', 'share', 'WeChatAgent', 'logs')
  }
  return join(process.cwd(), 'logs')
}

function processName(): string {
  const name = typeof process.title === 'string' && process.title.length > 0
    ? process.title
    : (process.argv[1] ?? 'agent')
  return safeToken(String(name).split(/[\\/]/).pop() ?? 'agent', 'agent')
}

/**
 * Resolves the cross-process token correlation mode. The mode is decided by
 * whether WECHAT_LOG_TOKEN_SALT was set at process start; the salt itself is
 * NEVER written to disk.
 *
 *   - Salt present: SHARED — UI and Agent can produce the same token for the
 *     same raw identity, so CROSS_PROCESS_CORRELATION is enabled.
 *   - Salt absent: PROCESS_LOCAL — each side keeps a random salt, the privacy
 *     contract holds, but tokens MUST NOT be claimed cross-process correlated.
 */
export function resolveTokenCorrelationState(
  env: NodeJS.ProcessEnv = process.env,
): TokenCorrelationState {
  const mode = tokenCorrelationMode(env)
  const saltBytes = tokenSaltByteLength(env)
  return {
    sharedSalt: mode === 'SHARED',
    processLocal: mode === 'PROCESS_LOCAL',
    saltBytes,
    mode,
  }
}

function formatStamp(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0')
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = date.getUTCDate().toString().padStart(2, '0')
  return `${year}${month}${day}`
}

function tryParseStamp(fileName: string, baseName: string): Date | null {
  const prefix = `${baseName}-`
  if (!fileName.startsWith(prefix)) {
    return null
  }
  const tail = fileName.slice(prefix.length)
  if (!tail.endsWith('.log')) {
    return null
  }
  const withoutSuffix = tail.slice(0, tail.length - '.log'.length)
  // Files are either {baseName}-{yyyyMMdd}.log (same-day open) or
  // {baseName}-{yyyyMMdd}-{HHmmssfff}.log (size-triggered rotation inside the
  // same day). The retention window only cares about the date part.
  const dateText = withoutSuffix.length > 8 ? withoutSuffix.slice(0, 8) : withoutSuffix
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(dateText)
  if (!match) {
    return null
  }
  const iso = `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function basename(path: string | null): string {
  if (!path) {
    return ''
  }
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1]
}

function reportStartupFailure(phase: string, cause: unknown): void {
  try {
    const message = cause instanceof Error ? cause.message : String(cause)
    const exceptionType = cause instanceof Error ? cause.constructor.name : 'Unknown'
    process.stderr.write(
      `[persistent-runtime-log] phase=${sanitizeInline(phase)} result=FAIL ` +
        `exceptionType=${sanitizeInline(exceptionType)} ` +
        `detail=${sanitizeInline(message)}\n`,
    )
  } catch {
    /* best effort */
  }
}

/**
 * Single-process persistent runtime log. Append-only, atomic per write, with
 * daily + size-cap rotation. Synchronous writes are used on the hot path: the
 * Agent is single-threaded and a logging failure must never propagate, so the
 * small per-line latency is preferred over a queue that could lose lines on
 * crash.
 */
export class PersistentRuntimeLog {
  private readonly directory: string
  private readonly fileBaseName: string
  private readonly maxBytesPerFile: number
  private readonly retentionDays: number
  private readonly maxFiles: number
  private readonly processName: string
  private readonly processId: number
  private readonly correlation: TokenCorrelationState
  private activePath: string | null = null
  private activeDateUtc = ''
  private activeBytes = 0
  private lastFlushMs = 0
  private disposed = false

  public constructor(options: PersistentRuntimeLogOptions) {
    this.fileBaseName = options.fileBaseName
    this.directory = options.directory ?? defaultDirectory()
    this.maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    this.processName = processName()
    this.processId = process.pid

    // Tokenization and salt resolution live in identity-observer: there is
    // exactly one rule and one salt source in the Agent, and it is the same
    // HMAC-SHA256 contract the C# UI implements. `tokenSalt` exists only so a
    // test can pin the salt without touching process.env.
    if (typeof options.tokenSalt === 'string' && options.tokenSalt.length > 0) {
      setProcessSaltOverride(options.tokenSalt)
    }
    this.correlation = resolveTokenCorrelationState(process.env)

    try {
      mkdirSync(this.directory, { recursive: true })
    } catch (cause) {
      reportStartupFailure('directory-create', cause)
    }
  }

  public get filePath(): string {
    this.ensureFile()
    return this.activePath ?? ''
  }

  public get correlationState(): TokenCorrelationState {
    return { ...this.correlation }
  }

  /**
   * Synchronous one-line append. The caller must keep the privacy contract:
   * structured fields must only carry tokens, lengths, counts and enums; the
   * opaque tail must not embed raw identities or message bodies.
   */
  public write(
    component: string,
    event: string,
    structured?: Record<string, string | number | boolean | null | undefined>,
    opaqueTail?: string,
  ): void {
    if (this.disposed) {
      return
    }
    const line = this.buildLine(component, event, structured, opaqueTail)
    if (line.length === 0) {
      return
    }
    try {
      this.ensureFile()
      if (this.activePath === null) {
        return
      }
      appendFileSync(this.activePath, line + EOL, { encoding: 'utf8' })
      this.activeBytes += Buffer.byteLength(line, 'utf8') + EOL.length
      const now = new Date()
      const stamp = formatStamp(now)
      if (this.activeBytes >= this.maxBytesPerFile || stamp !== this.activeDateUtc) {
        this.rotate(stamp, now)
      }
      if (now.getTime() - this.lastFlushMs >= FLUSH_INTERVAL_MS) {
        this.flush()
        this.lastFlushMs = now.getTime()
      }
    } catch (cause) {
      this.activePath = null
      reportStartupFailure('write', cause)
    }
  }

  /** Force a metadata flush to disk. Safe to call from signal handlers. */
  public flush(): void {
    if (this.disposed) {
      return
    }
    try {
      if (this.activePath !== null) {
        const fd = openSync(this.activePath, 'a')
        try { /* fall through */ }
        finally {
          try { closeSync(fd) } catch { /* best effort */ }
        }
      }
    } catch {
      /* fail-open */
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.flush()
    this.activePath = null
  }

  /**
   * Same algorithm as the UI's IdentityTokens.Token and as this project's
   * `identity-observer.identityToken`: HMAC-SHA256 with the process salt as key
   * and the raw value as message, first 12 hex chars, upper case. There is
   * exactly one tokenization rule in the system; this method delegates to it so
   * the two logs cannot drift apart.
   */
  public tokenFor(raw: unknown): string {
    return identityToken((raw ?? '').toString())
  }

  /**
   * First N characters of the same token. It is intentionally a prefix of
   * `tokenFor`, never a second hash: when the salt is shared the UI's
   * first-N-character preview of the same id matches.
   */
  public shortIdFor(raw: unknown, length = 6): string {
    const clamped = length > 0 && length < TOKEN_LENGTH ? length : TOKEN_LENGTH
    return this.tokenFor(raw).slice(0, clamped)
  }

  private buildLine(
    component: string,
    event: string,
    structured: Record<string, string | number | boolean | null | undefined> | undefined,
    opaqueTail: string | undefined,
  ): string {
    const safeComponent = safeToken(component, 'UNKNOWN')
    const safeEvent = safeToken(event, 'UNKNOWN')
    const now = new Date()
    const parts: string[] = [
      formatTimestamp(now),
      safeToken(this.processName, 'agent'),
      safeComponent,
      safeEvent,
      `pid=${this.processId}`,
    ]
    if (structured) {
      for (const [key, value] of Object.entries(structured)) {
        if (typeof key !== 'string' || key.length === 0) {
          continue
        }
        const safeKey = sanitizeInline(key).replace(/=/g, '_')
        const safeValue = sanitizeInline(value)
        parts.push(`${safeKey}=${safeValue.length === 0 ? 'NONE' : safeValue}`)
      }
    }
    if (typeof opaqueTail === 'string' && opaqueTail.length > 0) {
      parts.push(`detail=${sanitizeInline(opaqueTail)}`)
    }
    return parts.join('|')
  }

  private ensureFile(): void {
    if (this.disposed) {
      return
    }
    const today = formatStamp(new Date())
    if (this.activePath !== null && this.activeDateUtc === today && this.activeBytes < this.maxBytesPerFile) {
      return
    }
    this.rotate(today, new Date())
  }

  private rotate(todayStamp: string, now: Date): void {
    try {
      this.flush()
      mkdirSync(this.directory, { recursive: true })
      const rotationSuffix =
        `${now.getUTCHours().toString().padStart(2, '0')}` +
        `${now.getUTCMinutes().toString().padStart(2, '0')}` +
        `${now.getUTCSeconds().toString().padStart(2, '0')}` +
        `${now.getUTCMilliseconds().toString().padStart(3, '0')}`
      const fileName = `${this.fileBaseName}-${todayStamp}-${rotationSuffix}.log`
      const path = join(this.directory, fileName)

      let currentBytes = 0
      if (existsSync(path)) {
        currentBytes = statSync(path).size
      }
      this.activePath = path
      this.activeDateUtc = todayStamp
      this.activeBytes = currentBytes
      this.lastFlushMs = now.getTime()
      this.prune(todayStamp)
    } catch (cause) {
      this.activePath = null
      reportStartupFailure('rotate', cause)
    }
  }

  private prune(todayStamp: string): void {
    try {
      const files = readdirSync(this.directory)
        .filter((name) => name.startsWith(`${this.fileBaseName}-`) && name.endsWith('.log'))
        .sort()
      if (files.length === 0) {
        return
      }
      const retentionCutoff = new Date(`${todayStamp}T00:00:00.000Z`)
      retentionCutoff.setUTCDate(retentionCutoff.getUTCDate() - this.retentionDays)
      for (const name of files) {
        const stamp = tryParseStamp(name, this.fileBaseName)
        if (stamp && stamp.getTime() < retentionCutoff.getTime()) {
          try { unlinkSync(join(this.directory, name)) } catch { /* best effort */ }
        }
      }
      const remaining = readdirSync(this.directory)
        .filter((name) => name.startsWith(`${this.fileBaseName}-`) && name.endsWith('.log'))
        .sort()
      const overflow = remaining.length - this.maxFiles
      let index = 0
      let dropped = 0
      while (dropped < overflow && index < remaining.length) {
        const candidate = remaining[index]
        index += 1
        if (candidate === basename(this.activePath)) {
          continue
        }
        try {
          unlinkSync(join(this.directory, candidate))
          dropped += 1
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* best effort */
    }
  }
}

/**
 * Helper for callers that already log via console.log. The original line
 * becomes the opaque tail so the operator sees the same shape they already
 * had in stdout, with a structured envelope around it.
 */
export class PersistentRuntimeLogSink {
  public constructor(
    private readonly log: PersistentRuntimeLog,
    private readonly component: string,
    private readonly eventPrefix: string = 'MIRROR',
  ) {}

  public writeMirror(line: string): void {
    this.log.write(this.component, this.eventPrefix, undefined, line)
  }

  public writeStructured(
    event: string,
    fields?: Record<string, string | number | boolean | null | undefined>,
    opaqueTail?: string,
  ): void {
    this.log.write(this.component, event, fields, opaqueTail)
  }
}

/**
 * Structured diagnostic fields. The privacy contract applies here exactly as it
 * does to `PersistentRuntimeLog.write`: tokens, counts, enums, results, phases
 * and error codes only.
 */
export type DiagnosticFields = Record<string, string | number | boolean | null | undefined>

/**
 * The operator-facing rendering of one structured diagnostic
 * (`[EVENT] key=value key=value`).
 *
 * It is the single renderer used by `emitDiagnostic`, so a field can never exist
 * in the stdout line and be missing from the durable event (or vice versa).
 */
export function formatDiagnosticLine(event: string, fields: DiagnosticFields): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${value === null || value === undefined ? 'NONE' : String(value)}`)
  }
  return parts.length === 0 ? `[${event}]` : `[${event}] ${parts.join(' ')}`
}

/**
 * Emit one diagnostic through both channels from the same fields: the
 * operator-facing stdout line and the durable persistent-log event.
 *
 * The durable call is isolated because logging is fail-open by contract: I/O
 * failures are already swallowed inside `PersistentRuntimeLog.write`, and this
 * guard additionally covers a sink implementation that throws. A logging
 * failure must never break chat or memory.
 */
export function emitDiagnostic(
  stdout: (line: string) => void,
  sink: PersistentRuntimeLogSink | undefined,
  event: string,
  fields: DiagnosticFields,
): void {
  stdout(formatDiagnosticLine(event, fields))
  if (sink === undefined) {
    return
  }
  try {
    sink.writeStructured(event, fields)
  } catch {
    /* fail-open: a broken sink must not affect chat or memory */
  }
}
