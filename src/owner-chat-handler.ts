import { createTrustedAssistantRuntimeFacts } from './assistant-identity.js'
import type { ChatService } from './chat.js'
import type { OwnerChatHandlerLike, OwnerChatRequest } from './owner-chat-contract.js'

/**
 * Local operator chat deliberately calls only ChatService. It receives no
 * MemoryService, group contexts, proactive queue, or outbound staging capability.
 */
export class OwnerChatHandler implements OwnerChatHandlerLike {
  public constructor(
    private readonly chatService: ChatService,
    private readonly botDisplayName: string,
  ) {}

  public handle(request: OwnerChatRequest): Promise<string> {
    const assistantRuntime = createTrustedAssistantRuntimeFacts(
      this.botDisplayName,
      request.authority.ownerConfigured,
      request.authority.ownerDisplayName,
      request.authority.creatorDisplayName,
    )
    return this.chatService.replyOwnerChat(
      request.text,
      request.recentContext,
      assistantRuntime,
      request.requestId,
    )
  }
}
