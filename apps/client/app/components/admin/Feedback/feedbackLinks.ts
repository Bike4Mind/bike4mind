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

// A mailto URL travels through the OS to a mail client, and several clients truncate or refuse
// one past a few thousand characters once percent-encoded; the quote is cut well short of that.
const MAILTO_QUOTE_MAX_CHARS = 1500;

const quoteForMail = (content: string): string => {
  const trimmed = content.trim();
  let excerpt = trimmed.slice(0, MAILTO_QUOTE_MAX_CHARS);
  // A cut between the two halves of a surrogate pair would encode to a malformed URI.
  if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
  const lines = excerpt.split(/\r?\n/).map(line => `> ${line}`);
  if (excerpt.length < trimmed.length) lines.push('> ...');
  return lines.join('\r\n');
};

/**
 * A `mailto:` draft to the person who filed a report, with the report quoted so the reply has its
 * context. Undefined when the report carries no email, so callers can hide the action.
 *
 * Quotes `content` directly rather than going through getFeedbackDisplayContent: an expired
 * report's "[content expired]" placeholder is UI copy, not something to quote back to a reporter.
 */
export const feedbackReporterMailto = ({
  userEmail,
  content,
  createdAt,
}: Pick<IExtendedFeedbackDocument, 'userEmail' | 'content' | 'createdAt'>): string | undefined => {
  const address = userEmail?.trim();
  if (!address) return undefined;

  const reportedOn = new Date(createdAt);
  const subject = Number.isNaN(reportedOn.getTime())
    ? 'Your Bike4Mind feedback'
    : `Your Bike4Mind feedback from ${reportedOn.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;

  const params = [`subject=${encodeURIComponent(subject)}`];
  if (content?.trim()) params.push(`body=${encodeURIComponent(quoteForMail(content))}`);

  return `mailto:${encodeURIComponent(address)}?${params.join('&')}`;
};
