import type { GroupMessage } from './context.js'
import {
  CURRENT_REQUESTER_LABEL,
  ASSISTANT_LABEL,
  type AmbientLine,
  type GroupAmbientContext,
} from './group-ambient-context.js'
import { RequesterLocalContext } from './requester-local-context.js'
import { GroupTopicCapsuleStore, type GroupTopicCapsulePromptItem } from './group-topic-capsule.js'

/** Provider-safe message shape shared by the mixed-context prompt and Planner. */
export type GroupConversationPromptMessage = Pick<
  GroupMessage,
  'senderName' | 'publicDisplayName' | 'text' | 'timestamp' | 'messageId'
>

export type TopicContextItem = GroupTopicCapsulePromptItem

export interface GroupConversationContext {
  currentTurn: GroupConversationPromptMessage
  requesterLocalContext: readonly GroupConversationPromptMessage[]
  recentGroupAmbient: readonly AmbientLine[]
  topicContext: readonly TopicContextItem[]
  diagnostics: GroupConversationContextDiagnostics
}

export interface GroupConversationContextDiagnostics {
  requesterLocalAvailable: number
  requesterLocalSelected: number
  groupAmbientAvailable: number
  groupAmbientSelected: number
  currentTurnIncluded: true
  topicCapsuleAvailable: number
  topicCapsuleSelected: number
  topicCapsuleExpiredDropped: number
  topicBudgetTruncated: boolean
  ambientHighSelected: number
  ambientNormalSelected: number
  ambientLowSelected: number
  ambientAdjacencyAdded: number
  ambientDuplicateDropped: number
  topicSelectedByLexical: number
  topicSelectedByRecency: number
  topicStalePenaltyApplied: number
  answerContextSources: string
  currentEventDroppedFromAmbient: boolean
  crossRequesterLocalDropped: number
  crossGroupDropped: number
  budgetTruncated: boolean
  result: 'PASS'
}

export interface GroupConversationContextAssemblerOptions {
  requesterLocalMaxEntries?: number
  requesterLocalMaxChars?: number
  groupAmbientMaxEntries?: number
  groupAmbientMaxChars?: number
  topicCapsuleStore?: GroupTopicCapsuleStore
  topicCapsuleMaxSelected?: number
  topicCapsuleMaxChars?: number
}

export interface GroupConversationContextAssemblyInput {
  groupConversationId: string
  requesterIdentity: string
  currentEventId: string
  /** Active requester events already rendered by the local prompt view. */
  activeEventIds?: readonly string[]
  currentTurn: GroupMessage
  currentSpeakerLabel: string
}

/** Reads two bounded stores and creates the four-layer GROUP provider view. */
export class GroupConversationContextAssembler {
  public constructor(
    private readonly requesterLocal: RequesterLocalContext,
    private readonly groupAmbient: GroupAmbientContext,
    private readonly options: GroupConversationContextAssemblerOptions = {},
  ) {}

  public assemble(input: GroupConversationContextAssemblyInput): GroupConversationContext {
    const local = this.requesterLocal.select(
      input.groupConversationId,
      input.requesterIdentity,
      {
        excludeMessageId: input.currentEventId,
        maxEntries: this.options.requesterLocalMaxEntries,
        maxChars: this.options.requesterLocalMaxChars,
      },
    )
    const topic = this.options.topicCapsuleStore?.select(
      input.groupConversationId,
      input.currentTurn.text,
      {
        maxSelected: this.options.topicCapsuleMaxSelected,
        maxChars: this.options.topicCapsuleMaxChars,
        recentAmbient: this.groupAmbient.recentEvents(input.groupConversationId),
      },
    ) ?? {
      capsules: [] as readonly TopicContextItem[],
      availableCount: 0,
      selectedCount: 0,
      expiredDropped: 0,
      budgetTruncated: false,
      selectedByLexical: 0,
      selectedByRecency: 0,
      stalePenaltyApplied: 0,
    }
    const compactedSourceEventIds = this.options.topicCapsuleStore?.coveredSourceEventIds(input.groupConversationId)
    const ambient = this.groupAmbient.select(input.groupConversationId, {
      currentRequesterId: input.requesterIdentity,
      excludeMessageId: input.currentEventId,
      excludeEventIds: input.activeEventIds,
      excludeCompactedEventIds: compactedSourceEventIds,
      limit: this.options.groupAmbientMaxEntries,
      maxChars: this.options.groupAmbientMaxChars,
    })

    const requesterLocalContext = local.messages.map((message) => ({
      senderName: message.senderName === ASSISTANT_LABEL ? ASSISTANT_LABEL : input.currentSpeakerLabel,
      publicDisplayName: message.senderName === ASSISTANT_LABEL ? null : message.publicDisplayName,
      text: message.text,
      timestamp: message.timestamp,
      messageId: message.messageId,
    }))
    const currentTurn = providerSafeMessage(input.currentTurn)
    const budgetTruncated = local.selectedCount < local.availableCount ||
      ambient.selectedCount < ambient.availableCount ||
      topic.budgetTruncated

    return {
      currentTurn,
      requesterLocalContext,
      recentGroupAmbient: ambient.lines,
      topicContext: topic.capsules,
      diagnostics: {
        requesterLocalAvailable: local.availableCount,
        requesterLocalSelected: local.selectedCount,
        groupAmbientAvailable: ambient.availableCount,
        groupAmbientSelected: ambient.selectedCount,
        currentTurnIncluded: true,
        topicCapsuleAvailable: topic.availableCount,
        topicCapsuleSelected: topic.selectedCount,
        topicCapsuleExpiredDropped: topic.expiredDropped,
        topicBudgetTruncated: topic.budgetTruncated,
        ambientHighSelected: ambient.highSelected,
        ambientNormalSelected: ambient.normalSelected,
        ambientLowSelected: ambient.lowSelected,
        ambientAdjacencyAdded: ambient.adjacencyAdded,
        ambientDuplicateDropped: ambient.duplicateDropped,
        topicSelectedByLexical: topic.selectedByLexical,
        topicSelectedByRecency: topic.selectedByRecency,
        topicStalePenaltyApplied: topic.stalePenaltyApplied,
        answerContextSources: contextSourceSummary(local.selectedCount, ambient.selectedCount, topic.selectedCount),
        currentEventDroppedFromAmbient: ambient.currentEventDropped > 0,
        crossRequesterLocalDropped: local.crossRequesterLocalDropped,
        crossGroupDropped: local.crossGroupDropped,
        budgetTruncated,
        result: 'PASS',
      },
    }
  }
}

function contextSourceSummary(localCount: number, ambientCount: number, topicCount: number): string {
  return [
    'CURRENT',
    ...(localCount > 0 ? ['LOCAL'] : []),
    ...(ambientCount > 0 ? ['AMBIENT'] : []),
    ...(topicCount > 0 ? ['TOPIC'] : []),
  ].join('+')
}

function providerSafeMessage(message: GroupMessage): GroupConversationPromptMessage {
  return {
    senderName: message.senderName,
    publicDisplayName: message.publicDisplayName,
    text: message.text,
    timestamp: message.timestamp,
    messageId: message.messageId,
  }
}

export function requesterLocalAsActiveContext(
  context: GroupConversationContext,
): GroupConversationPromptMessage[] {
  return [...context.requesterLocalContext]
}

export function groupAmbientFromMixedContext(context: GroupConversationContext): readonly AmbientLine[] {
  return context.recentGroupAmbient
}

/**
 * Reuse the already trusted stable speaker label for active events that exist in
 * both views. Passive-only events retain the ambient namespace. This is purely a
 * provider-safe presentation normalization; it never correlates by text.
 */
export function stabilizeActiveAmbientLabels(
  context: GroupConversationContext,
  activeMessages: readonly GroupMessage[],
): GroupConversationContext {
  const labelsByEventId = new Map(
    activeMessages
      .filter((message): message is GroupMessage & { messageId: string } => message.messageId !== undefined)
      .map((message) => [message.messageId, message.senderName] as const),
  )
  if (labelsByEventId.size === 0) return context
  return {
    ...context,
    recentGroupAmbient: context.recentGroupAmbient.map((line) => {
      const stableLabel = line.messageId === undefined ? undefined : labelsByEventId.get(line.messageId)
      return stableLabel === undefined || line.label === ASSISTANT_LABEL
        ? line
        : { ...line, label: stableLabel }
    }),
  }
}

export function mixedContextSpeakerLabel(): string {
  return CURRENT_REQUESTER_LABEL
}
