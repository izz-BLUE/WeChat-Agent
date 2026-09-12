import { identityToken } from './identity-observer.js'

export type OwnerPrivateTargetOperation = 'BIND' | 'REBIND' | 'RESTART'
export type OwnerPrivateTargetResult = 'PASS' | 'UNBOUND'
export type OwnerPrivateTargetLogger = (
  operation: OwnerPrivateTargetOperation,
  result: OwnerPrivateTargetResult,
  targetToken: string,
) => void

/** Process-local target for the private-owner-to-group command channel. */
export class OwnerPrivateDispatchTarget {
  private targetConversationId: string | null = null

  public constructor(private readonly log?: OwnerPrivateTargetLogger) {}

  public get conversationId(): string | null {
    return this.targetConversationId
  }

  /** A new Agent process starts unbound; no target is loaded from disk. */
  public clearForRestart(): void {
    this.targetConversationId = null
    this.write('RESTART', 'UNBOUND', 'NONE')
  }

  public bind(conversationId: string): OwnerPrivateTargetOperation | null {
    const target = conversationId.trim()
    if (!target) return null
    const operation: OwnerPrivateTargetOperation = this.targetConversationId === null
      ? 'BIND'
      : 'REBIND'
    this.targetConversationId = target
    this.write(operation, 'PASS', identityToken(target))
    return operation
  }

  private write(operation: OwnerPrivateTargetOperation, result: 'PASS' | 'UNBOUND', targetToken: string): void {
    this.log?.(operation, result, targetToken)
  }
}
