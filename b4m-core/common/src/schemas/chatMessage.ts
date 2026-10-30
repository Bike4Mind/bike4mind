import * as z from 'zod';
import type { IChatHistoryItemDocument } from '../types/entities/SessionTypes';
import { passthroughShape } from './responseShape';

/**
 * Server-only chat message fields, never sent to the client. Also excluded from the quests
 * data-subscription projection (apps/client/server/websocket/dataSubscribeFieldLimits.ts), so the
 * REST and WS transports withhold the same set:
 * - `callback`: the caller's webhook URL and API key id (already `select: false` on QuestModel).
 * - `embedding`: the message's search vector, internal to retrieval and heavy on list reads.
 * - `slackNotification`: the Slack thread the reply is posted back to.
 */
export const CHAT_MESSAGE_WITHHELD_FIELDS = ['callback', 'embedding', 'slackNotification', 'signupActivity'] as const;

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
 * A chat message (quest) as returned by the session chat routes. `promptMeta` passes through
 * as given, so routes must still apply redactPromptMetaForViewer for share viewers first.
 */
export const chatMessageResponseSchema = z.object(passthroughShape(CHAT_MESSAGE_RESPONSE_FIELDS));
