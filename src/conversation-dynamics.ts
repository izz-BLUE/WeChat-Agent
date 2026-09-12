/**
 * Deterministic, transient observation of recent group interaction structure.
 *
 * This module deliberately does not inspect message text. The input messages are
 * the already-selected history views; only event identity, speaker category and
 * provider-facing labels participate in the observation. The returned profile is
 * provider-safe and contains counts, booleans and coarse enum values only.
 */
import type { GroupMessage } from './context.js'
import {
  ASSISTANT_LABEL,
  CURRENT_REQUESTER_LABEL,
  type AmbientReplyTarget,
  type AmbientLine,
} from './group-ambient-context.js'

export type ConversationContinuity =
  | 'NONE'
  | 'FOLLOW_UP_LIKELY'
  | 'CONTINUATION_POSSIBLE'
  | 'INTERRUPTED'

export type ConversationParticipation = 'QUIET' | 'FOCUSED' | 'MULTI_PARTY'

export type ConversationPace = 'LOW' | 'MEDIUM' | 'HIGH'

/** Coarse transient pressure for ordinary group reply depth. */
export type GroupReplyPressure = 'LOW' | 'MEDIUM' | 'HIGH'

export interface ConversationDynamicsProfile {
  activeTurnCount: number
  ambientLineCount: number
  lastActiveRequester: 'SAME_REQUESTER' | 'OTHER_REQUESTER' | 'NONE'
  assistantRecent: boolean
  lastAssistantReplyTarget: AmbientReplyTarget
  membersAfterAssistant: number
  participation: ConversationParticipation
  pace: ConversationPace
  continuity: ConversationContinuity
}

export interface ConversationDynamicsObservationInput {
  /** Historical active turns selected before the current request is appended. */
  recentGroupContext: readonly GroupMessage[]
  /** Historical ambient lines selected before the current request is appended. */
  groupAmbientContext: readonly AmbientLine[]
  /** The current requester's runtime pseudonymous speaker label. */
  currentSpeakerLabel: string
  /** Trusted requester identity, used only to classify historical active turns. */
  currentRequesterId?: string
}

/**
 * Derive response-depth pressure from structure only. This is not a semantic
 * classifier and does not decide whether the current message needs detail.
 */
export function deriveGroupReplyPressure(profile: ConversationDynamicsProfile): GroupReplyPressure {
  if (profile.participation === 'MULTI_PARTY' && profile.pace === 'HIGH') {
    return 'HIGH'
  }
  if (profile.participation === 'MULTI_PARTY' || profile.pace === 'HIGH') {
    return 'MEDIUM'
  }
  return 'LOW'
}

/** Explicit bounds keep the profile small, explainable and deterministic. */
export const CONVERSATION_DYNAMICS_THRESHOLDS = Object.freeze({
  assistantRecentLineLimit: 8,
  pace: Object.freeze({ lowMax: 2, mediumMax: 6 }),
  focusedParticipantMax: 1,
})

type ObservedSource = 'ACTIVE' | 'AMBIENT'
type ObservedSpeaker = 'MEMBER' | 'ASSISTANT'

interface ObservedEvent {
  source: ObservedSource
  speaker: ObservedSpeaker
  /** A label is used only for the in-memory participant count. */
  speakerLabel: string
  /** Present only for assistant events; provider-safe and never a raw id. */
  replyTarget?: AmbientReplyTarget
}

/**
 * Build the structural profile from the two bounded context views.
 *
 * Events with a non-empty ID are de-duplicated across both views. Events without
 * an ID are never compared by text and therefore remain separate observations.
 */
export function observeConversationDynamics(
  input: ConversationDynamicsObservationInput,
): ConversationDynamicsProfile {
  const events = collectEvents(input)
  const activeEvents = events.filter((event) => event.source === 'ACTIVE')
  const ambientEvents = events.filter((event) => event.source === 'AMBIENT')
  const lastActiveEvent = activeEvents[activeEvents.length - 1]
  const lastActiveRequester = lastActiveEvent === undefined
    ? 'NONE'
    : lastActiveEvent.speakerLabel === input.currentSpeakerLabel
      ? 'SAME_REQUESTER'
      : 'OTHER_REQUESTER'
  const recentAmbientEvents = ambientEvents.slice(-CONVERSATION_DYNAMICS_THRESHOLDS.assistantRecentLineLimit)
  const assistantRecent = recentAmbientEvents.some((event) => event.speaker === 'ASSISTANT')
  const lastAssistantEvent = ambientEvents[findLastIndex(ambientEvents, (event) => event.speaker === 'ASSISTANT')]
  const lastAssistantReplyTarget = lastAssistantEvent?.replyTarget ?? 'NONE'
  const lastAssistantIndex = findLastIndex(ambientEvents, (event) => event.speaker === 'ASSISTANT')
  const membersAfterAssistant = lastAssistantIndex < 0
    ? 0
    : ambientEvents
        .slice(lastAssistantIndex + 1)
        .filter((event) => event.speaker === 'MEMBER').length
  const participation = classifyParticipation(events, input.currentSpeakerLabel)
  const pace = classifyPace(events.length)

  const partial: Omit<ConversationDynamicsProfile, 'continuity'> = {
    activeTurnCount: activeEvents.length,
    ambientLineCount: ambientEvents.length,
    lastActiveRequester,
    assistantRecent,
    lastAssistantReplyTarget,
    membersAfterAssistant,
    participation,
    pace,
  }

  return {
    ...partial,
    continuity: classifyContinuity(partial),
  }
}

/** Only counts, booleans and enum values cross the prompt boundary. */
export function formatConversationDynamicsProfile(profile: ConversationDynamicsProfile): string {
  return [
    `ACTIVE_TURN_COUNT=${profile.activeTurnCount}`,
    `AMBIENT_LINE_COUNT=${profile.ambientLineCount}`,
    `LAST_ACTIVE_REQUESTER=${profile.lastActiveRequester}`,
    `ASSISTANT_RECENT=${profile.assistantRecent}`,
    `LAST_ASSISTANT_REPLY_TARGET=${profile.lastAssistantReplyTarget}`,
    `MEMBERS_AFTER_ASSISTANT=${profile.membersAfterAssistant}`,
    `PARTICIPATION=${profile.participation}`,
    `PACE=${profile.pace}`,
    `CONTINUITY=${profile.continuity}`,
  ].join('\n')
}

function collectEvents(input: ConversationDynamicsObservationInput): ObservedEvent[] {
  const events: ObservedEvent[] = []
  const seenEventIds = new Set<string>()

  for (const message of input.recentGroupContext) {
    if (shouldKeepEvent(message.messageId, seenEventIds)) {
      events.push({
        source: 'ACTIVE',
        speaker: 'MEMBER',
        speakerLabel: isCurrentRequester(message, input) ? input.currentSpeakerLabel : message.senderName,
      })
    }
  }

  for (const line of input.groupAmbientContext) {
    if (shouldKeepEvent(line.messageId, seenEventIds)) {
      events.push({
        source: 'AMBIENT',
        speaker: line.label === ASSISTANT_LABEL ? 'ASSISTANT' : 'MEMBER',
        speakerLabel: line.label,
        replyTarget: line.label === ASSISTANT_LABEL ? line.replyTarget ?? 'UNKNOWN' : undefined,
      })
    }
  }

  return events
}

function shouldKeepEvent(eventId: string | undefined, seenEventIds: Set<string>): boolean {
  const normalized = eventId?.trim()
  if (normalized === undefined || normalized.length === 0) {
    // Missing identity is not repaired with text equality: it is one observation.
    return true
  }
  if (seenEventIds.has(normalized)) {
    return false
  }
  seenEventIds.add(normalized)
  return true
}

function isCurrentRequester(message: GroupMessage, input: ConversationDynamicsObservationInput): boolean {
  return (
    (input.currentRequesterId !== undefined && message.senderId === input.currentRequesterId) ||
    message.senderName === input.currentSpeakerLabel
  )
}

function classifyParticipation(
  events: readonly ObservedEvent[],
  currentSpeakerLabel: string,
): ConversationParticipation {
  const memberLabels = new Set<string>()
  for (const [index, event] of events.entries()) {
    if (event.speaker === 'ASSISTANT') {
      continue
    }
    const label = event.source === 'AMBIENT' && event.speakerLabel === CURRENT_REQUESTER_LABEL
      ? currentSpeakerLabel
      : event.speakerLabel
    // The fallback is internal-only and never enters the returned profile.
    memberLabels.add(label.trim() || `UNLABELLED_MEMBER_${index}`)
  }

  if (memberLabels.size === 0) {
    return 'QUIET'
  }
  if (memberLabels.size <= CONVERSATION_DYNAMICS_THRESHOLDS.focusedParticipantMax) {
    return 'FOCUSED'
  }
  return 'MULTI_PARTY'
}

function classifyPace(eventCount: number): ConversationPace {
  if (eventCount <= CONVERSATION_DYNAMICS_THRESHOLDS.pace.lowMax) {
    return 'LOW'
  }
  if (eventCount <= CONVERSATION_DYNAMICS_THRESHOLDS.pace.mediumMax) {
    return 'MEDIUM'
  }
  return 'HIGH'
}

function classifyContinuity(
  profile: Omit<ConversationDynamicsProfile, 'continuity'>,
): ConversationContinuity {
  if (profile.activeTurnCount === 0 && profile.ambientLineCount === 0) {
    return 'NONE'
  }

  if (profile.membersAfterAssistant > 0 || profile.participation === 'MULTI_PARTY') {
    return 'INTERRUPTED'
  }

  if (
    profile.lastActiveRequester === 'SAME_REQUESTER' &&
    profile.assistantRecent &&
    profile.lastAssistantReplyTarget === 'CURRENT_REQUESTER' &&
    profile.membersAfterAssistant === 0
  ) {
    return 'FOLLOW_UP_LIKELY'
  }

  if (
    (profile.assistantRecent && profile.lastAssistantReplyTarget === 'CURRENT_REQUESTER') ||
    profile.lastActiveRequester === 'SAME_REQUESTER'
  ) {
    return 'CONTINUATION_POSSIBLE'
  }

  return 'NONE'
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) {
      return index
    }
  }
  return -1
}
