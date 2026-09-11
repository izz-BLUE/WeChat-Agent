import { randomUUID } from 'node:crypto'

export const DEFAULT_PROACTIVE_QUEUE_MAX_ENTRIES = 64
export const DEFAULT_PROACTIVE_QUEUE_TTL_MS = 60_000

export interface ProactiveGroupQueueItem {
  taskId: string
  conversationType: 'GROUP'
  conversationId: string
  text: string
  createdAt: number
}

export type ProactiveQueueEnqueueResult =
  | { accepted: true; item: ProactiveGroupQueueItem }
  | { accepted: false; reason: 'QUEUE_FULL' | 'INVALID_TASK' }

export interface ProactiveGroupQueueOptions {
  maxEntries?: number
  ttlMs?: number
  now?: () => number
  idFactory?: () => string
}

interface StoredItem extends ProactiveGroupQueueItem {
  status: 'READY' | 'CLAIMED'
}

/** Process-local V1 queue. Claim removes readiness before any transport response. */
export class ProactiveGroupQueue {
  private readonly items = new Map<string, StoredItem>()
  private readonly ready: string[] = []
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly clock: () => number
  private readonly idFactory: () => string

  public constructor(options: ProactiveGroupQueueOptions = {}) {
    this.maxEntries = positiveBound(options.maxEntries ?? DEFAULT_PROACTIVE_QUEUE_MAX_ENTRIES, 'maxEntries')
    this.ttlMs = positiveBound(options.ttlMs ?? DEFAULT_PROACTIVE_QUEUE_TTL_MS, 'ttlMs')
    this.clock = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? randomUUID
  }

  public get size(): number {
    this.pruneExpired()
    return this.items.size
  }

  public pruneExpired(): number {
    const now = this.clock()
    let expired = 0
    for (const [taskId, item] of this.items) {
      if (item.status === 'READY' && now - item.createdAt >= this.ttlMs) {
        this.items.delete(taskId)
        expired += 1
      }
    }
    return expired
  }

  public enqueue(input: Omit<ProactiveGroupQueueItem, 'taskId' | 'createdAt'> & Partial<Pick<ProactiveGroupQueueItem, 'createdAt'>>): ProactiveQueueEnqueueResult {
    this.pruneExpired()
    if (input.conversationType !== 'GROUP' || !input.conversationId.trim() || !input.text.trim()) {
      return { accepted: false, reason: 'INVALID_TASK' }
    }
    if (this.items.size >= this.maxEntries) {
      return { accepted: false, reason: 'QUEUE_FULL' }
    }

    let taskId = this.idFactory().trim()
    while (this.items.has(taskId) || !taskId) taskId = this.idFactory().trim()
    const item: ProactiveGroupQueueItem = {
      taskId,
      conversationType: 'GROUP',
      conversationId: input.conversationId,
      text: input.text,
      createdAt: input.createdAt ?? this.clock(),
    }
    this.items.set(taskId, { ...item, status: 'READY' })
    this.ready.push(taskId)
    return { accepted: true, item }
  }

  /** The first poll changes READY to CLAIMED; a later poll cannot see it. */
  public claimReady(): ProactiveGroupQueueItem | null {
    this.pruneExpired()
    while (this.ready.length > 0) {
      const taskId = this.ready.shift()!
      const item = this.items.get(taskId)
      if (!item || item.status !== 'READY') continue
      item.status = 'CLAIMED'
      return { ...item }
    }
    return null
  }

  /** FINALIZED is terminal: remove it so it cannot ever be claimed again. */
  public finalize(taskId: string): boolean {
    const item = this.items.get(taskId)
    if (!item || item.status !== 'CLAIMED') return false
    this.items.delete(taskId)
    return true
  }
}

function positiveBound(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}
