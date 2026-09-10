import type { PersistentRuntimeLogSink } from './persistent-runtime-log.js'

export interface GroupMessage {
  senderId: string
  senderName: string
  text: string
  timestamp: number
}

export class GroupContext {
  private readonly messagesByRoom = new Map<string, GroupMessage[]>()

  public constructor(
    private readonly maxMessages: number,
    private readonly persistentSink?: PersistentRuntimeLogSink,
  ) {}

  public append(roomId: string, message: GroupMessage, messageId?: string): void {
    const messages = this.messagesByRoom.get(roomId) ?? []
    messages.push(message)

    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages)
    }

    this.messagesByRoom.set(roomId, messages)
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
      `roomSize=${messages.length}`,
    )
  }

  public recent(roomId: string, messageLimit: number, maxChars: number, messageId?: string): GroupMessage[] {
    const messages = this.messagesByRoom.get(roomId) ?? []
    const selected: GroupMessage[] = []
    let chars = 0

    for (let index = messages.length - 1; index >= 0 && selected.length < messageLimit; index -= 1) {
      const message = messages[index]
      const messageChars = message.senderName.length + message.text.length + 3

      if (selected.length > 0 && chars + messageChars > maxChars) {
        break
      }

      selected.unshift(message)
      chars += messageChars
    }

    const triggered = messages.length > 0
    this.persistentSink?.writeStructured(
      // Short-term transcript namespace, see `append`.
      'CONTEXT_READ',
      {
        result: triggered ? 'TRIGGERED' : 'EMPTY',
        phase: 'context-read',
        msgIdToken: messageId ? messageId.slice(-6) : null,
      },
      `readCount=${selected.length} storedCount=${messages.length}`,
    )
    return selected
  }
}
