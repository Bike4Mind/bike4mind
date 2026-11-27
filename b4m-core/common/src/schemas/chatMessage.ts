import * as z from 'zod';
import type { IChatHistoryItemDocument } from '../types/entities/SessionTypes';
import { passthroughShape } from './responseShape';
import { redactPromptMetaForViewer } from '../utils/promptMetaRedaction';

/**
 * Server-only chat message fields, never sent to the client. Also excluded from the quests
 * data-subscription projection (apps/client/server/websocket/dataSubscribeFieldLimits.ts), so the
 * REST and WS transports withhold the same set:
 * - `callback`: the caller's webhook URL and API key id (already `select: false` on QuestModel).
 * - `apiKeyId`, `oauthClientId`: which exchange key and connected app created the turn, for usage reporting.
 * - `embedding`: the message's search vector, internal to retrieval and heavy on list reads.
 * - `slackNotification`: the Slack thread the reply is posted back to.
 * - `signupActivity`: retired turn provenance a quest may still hold until its drop migration runs.
 * - `pendingActionResolution`: how the last pending action ended, read only by brief serialization.
 * - `lakeSaveCount`: the per-turn data lake save cap's counter, read only by save_content_to_data_lake.
 */
export const CHAT_MESSAGE_WITHHELD_FIELDS = [
  'callback',
  'apiKeyId',
  'oauthClientId',
  'embedding',
  'slackNotification',
  'signupActivity',
  'pendingActionResolution',
  'lakeSaveCount',
] as const;

/**
 * Chat message fields only the session owner is shown: a pending tool approval is the owner's to
 * act on, so a viewer holding only a share has no use for it. Withheld from every non-owner viewer
 * through {@link redactChatMessageForViewer} on REST and on the quests data-subscription projection
 * (dataSubscribeFieldLimits.ts).
 */
export const OWNER_ONLY_CHAT_MESSAGE_FIELDS = ['pendingAction'] as const;

export type OwnerOnlyChatMessageField = (typeof OWNER_ONLY_CHAT_MESSAGE_FIELDS)[number];

/** A message as any viewer may receive it: the owner-only fields are present only for the owner. */
export type ViewerChatMessage<T> = Omit<T, OwnerOnlyChatMessageField> &
  Partial<Pick<T, OwnerOnlyChatMessageField & keyof T>>;

/**
 * A chat message as a non-owner viewer may read it: `promptMeta` redacted by
 * redactPromptMetaForViewer and the {@link OWNER_ONLY_CHAT_MESSAGE_FIELDS} dropped. The one place
 * a quest-returning route applies the viewer policy, so a new owner-only field is added to the list
 * above and not at every route. The owner gets the input back untouched; the input is never mutated.
 */
export function redactChatMessageForViewer<T extends { promptMeta?: Parameters<typeof redactPromptMetaForViewer>[0] }>(
  message: T,
  isOwner: boolean
): ViewerChatMessage<T> {
  if (isOwner) return message;
  const redacted: Record<string, unknown> = {
    ...message,
    promptMeta: redactPromptMetaForViewer(message.promptMeta, false),
  };
  for (const field of OWNER_ONLY_CHAT_MESSAGE_FIELDS) delete redacted[field];
  return redacted as ViewerChatMessage<T>;
}

type ChatMessageResponseField = Exclude<keyof IChatHistoryItemDocument, (typeof CHAT_MESSAGE_WITHHELD_FIELDS)[number]>;

// Held to IChatHistoryItemDocument: a new message field fails the build here until it is
// classified, either listed below or added to CHAT_MESSAGE_WITHHELD_FIELDS.
const CHAT_MESSAGE_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  sessionId: true,
  conversationItemId: true,
  openaiMessageId: true,
  claudeMessageId: true,
  type: true,
  timestamp: true,
  prompt: true,
  fabFileIds: true,
  agentIds: true,
  reply: true,
  replies: true,
  structuredReplies: true,
  toolResults: true,
  questMasterReply: true,
  images: true,
  videos: true,
  videoJobIds: true,
  generationJobs: true,
  agentVideoClipsClaimed: true,
  agentMusicTracksClaimed: true,
  agentImagesClaimed: true,
  agentSpeechClipsClaimed: true,
  agentSoundEffectsClaimed: true,
  oob: true,
  promptMeta: true,
  status: true,
  creditsUsed: true,
  errorCode: true,
  questMasterPlanId: true,
  agentExecutionId: true,
  correctsQuestId: true,
  clientFirstTokenTime: true,
  routingSource: true,
  pinned: true,
  researchModeResults: true,
  deepResearchState: true,
  fallbackInfo: true,
  promptEnhancement: true,
  pendingAction: true,
  attachmentNotices: true,
  attachmentDelivery: true,
  turnTiming: true,
  navigationIntents: true,
  suggestedChoices: true,
  attachmentList: true,
  uiSideEffects: true,
  jupyterNotebook: true,
} as const satisfies Record<ChatMessageResponseField, true>;

/**
 * A chat message (quest) as returned by the session chat routes. `promptMeta` and the owner-only
 * fields pass through as given, so routes must still apply redactChatMessageForViewer for share
 * viewers first.
 */
export const chatMessageResponseSchema = z.object(passthroughShape(CHAT_MESSAGE_RESPONSE_FIELDS));

/** Response for PUT /api/v1/sessions/{id}/messages/{messageId}. */
export const updateChatMessageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  data: chatMessageResponseSchema,
});
