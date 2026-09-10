import type { PersistentRuntimeLogSink } from './persistent-runtime-log.js'

export interface GroupMessage {
  senderId: string
  senderName: string
  text: string
  timestamp: number
}

/**
 * One stored transcript entry: the renderable message plus the identity of the
 * inbound event it came from.
 *
 * The event id is kept for one reason: the same inbound group message is also
 * held by the ambient transcript (`group-ambient-context.ts`), and one prompt
 * must not present one event as two. Identity is the delivery id the runtime
 * already assigns, never the text — two members saying "好的" are two events.
 */
interface ContextEntry {
  message: GroupMessage
  messageId?: string
}

/** The bounded transcript window, with the event ids it covers. */
export interface GroupContextWindow {
  messages: GroupMessage[]
  /**
   * Event ids of exactly this window, in render order. A message appended
   * without an id contributes nothing here, so it can never suppress an
   * unrelated entry elsewhere.
   */
  eventIds: string[]
}

export class GroupContext {
  private readonly entriesByRoom = new Map<string, ContextEntry[]>()

  public constructor(
    private readonly maxMessages: number,
    private readonly persistentSink?: PersistentRuntimeLogSink,
  ) {}

  public append(roomId: string, message: GroupMessage, messageId?: string): void {
    const entries = this.entriesByRoom.get(roomId) ?? []
    entries.push({ message, messageId })

    if (entries.length > this.maxMessages) {
      entries.splice(0, entries.length - this.maxMessages)
    }

    this.entriesByRoom.set(roomId, entries)
    this.persistentSink?.writeStructured(
      // Short-term transcript namespace. Persistent memory owns `MEMORY_*`; a
      // transcript append must never look like a long-term memory write in a log
      // search.
      'CONTEXT_APPEND',
      {
        result: 'WRITTEN',
        phase: 'context-append',
        msgIdToken: messageId ? messageId.slice(-6) : null,
      },
      `roomSize=${entries.length}`,
    )
  }

  /**
   * The transcript window AND its event ids, from one selection pass.
   *
   * The window is computed once and both views are derived from it, so the ids a
   * caller uses to suppress duplicates elsewhere cannot describe a different set
   * of messages than the ones about to be rendered. It also keeps the durable
   * `CONTEXT_READ` line a single event per read.
   */
  public window(roomId: string, messageLimit: number, maxChars: number, messageId?: string): GroupContextWindow {
    const entries = this.entriesByRoom.get(roomId) ?? []
    const selected: ContextEntry[] = []
    let chars = 0

    for (let index = entries.length - 1; index >= 0 && selected.length < messageLimit; index -= 1) {
      const entry = entries[index] as ContextEntry
      const messageChars = entry.message.senderName.length + entry.message.text.length + 3

      if (selected.length > 0 && chars + messageChars > maxChars) {
        break
      }

      selected.unshift(entry)
      chars += messageChars
    }

    const triggered = entries.length > 0
    this.persistentSink?.writeStructured(
      // Short-term transcript namespace, see `append`.
      'CONTEXT_READ',
      {
        result: triggered ? 'TRIGGERED' : 'EMPTY',
        phase: 'context-read',
        msgIdToken: messageId ? messageId.slice(-6) : null,
      },
      `readCount=${selected.length} storedCount=${entries.length}`,
    )

    return {
      messages: selected.map((entry) => entry.message),
      eventIds: selected
        .map((entry) => entry.messageId)
        .filter((id): id is string => id !== undefined),
    }
  }

  public recent(roomId: string, messageLimit: number, maxChars: number, messageId?: string): GroupMessage[] {
    return this.window(roomId, messageLimit, maxChars, messageId).messages
  }
}
