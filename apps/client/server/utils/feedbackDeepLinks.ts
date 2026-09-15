import { adminFeedbackRecordPath, sessionPath, sessionTurnPath, toAbsoluteUrl } from '@bike4mind/common';

/** Absolute URLs a feedback notification carries so a reader can open the report, not hunt for it. */
export interface FeedbackDeepLinks {
  /** The record in the admin console's Feedback tab. */
  record: string;
  /** The conversation, anchored to the reported turn when one is known; null for a product-level report. */
  conversation: string | null;
  /** Whether `conversation` anchors a specific turn - the two targets need different labels. */
  conversationIsTurn: boolean;
}

/**
 * Link text, shared by the Slack and the email renderer. Both channels label the same two targets,
 * and a reader triaging from one and then the other should not have to learn two vocabularies.
 */
export const FEEDBACK_LINK_LABELS = {
  record: 'Admin record',
  /** `conversationIsTurn` picks between these two. */
  turn: 'Conversation turn',
  session: 'Conversation',
} as const;

export interface FeedbackDeepLinkSource {
  feedbackId: string;
  sessionId?: string | null;
  questId?: string | null;
}

/**
 * Degrades turn -> session -> absent, matching FeedbackRowLinks in the admin console: a
 * product-level report has no session, and a session-level one has no turn.
 */
function resolveConversationPath(sessionId?: string | null, questId?: string | null): string | null {
  if (!sessionId) return null;
  return questId ? sessionTurnPath(sessionId, questId) : sessionPath(sessionId);
}

/**
 * Builds the notification deep links for a saved feedback record, or null when this deploy has no
 * APP_URL to make them absolute with.
 *
 * Returns null rather than throwing the way requireEnv does elsewhere: this runs after the record
 * is already durable, inside the two best-effort delivery side-effects, so a stage missing APP_URL
 * must lose the links and still get the notification.
 *
 * Paths come from common/utils/deepLinks rather than being composed here, so a link pasted into
 * Slack and one copied from an admin row (FeedbackRowLinks) stay the same URL.
 */
export function buildFeedbackDeepLinks(source: FeedbackDeepLinkSource): FeedbackDeepLinks | null {
  const baseUrl = process.env.APP_URL?.trim();
  if (!baseUrl) return null;

  const conversationPath = resolveConversationPath(source.sessionId, source.questId);
  return {
    record: toAbsoluteUrl(baseUrl, adminFeedbackRecordPath(source.feedbackId)),
    conversation: conversationPath ? toAbsoluteUrl(baseUrl, conversationPath) : null,
    conversationIsTurn: Boolean(source.sessionId && source.questId),
  };
}
