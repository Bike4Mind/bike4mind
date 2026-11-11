import { adminFeedbackRecordPath, sessionPath, sessionTurnPath, toAbsoluteUrl } from '@bike4mind/common';
import { copyTextWithToast } from '@client/app/utils/copyToClipboard';
import { IExtendedFeedbackDocument } from './types';

/**
 * The two deep links a triaging admin needs on a feedback report: a shareable link back to this
 * record, and a jump to the conversation turn the report is about. The row menu and the detail
 * drawer both offer them.
 *
 * Both are built from the shared path builders in common/utils/deepLinks rather than composed
 * here, because the same scheme is emitted server-side into Slack and email notifications - one
 * definition keeps a link pasted into Slack and a link copied from this page identical.
 *
 * Callers render the conversation link as an anchor opening a new tab rather than a router
 * navigate: the admin is mid-triage with filters and a page cursor on screen, and routing away
 * discards all of it.
 */
export const copyFeedbackRecordLink = (feedbackId: string) =>
  copyTextWithToast(
    toAbsoluteUrl(window.location.origin, adminFeedbackRecordPath(feedbackId)),
    'Link to this report copied'
  );

/**
 * A product-level report has no session and a session-level one has no turn, so the target
 * degrades from turn to session to absent rather than building a link to neither.
 */
export const feedbackConversationPath = ({
  sessionId,
  questId,
}: Pick<IExtendedFeedbackDocument, 'sessionId' | 'questId'>): string | null =>
  sessionId ? (questId ? sessionTurnPath(sessionId, questId) : sessionPath(sessionId)) : null;
