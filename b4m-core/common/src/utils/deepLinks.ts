/**
 * The one definition of how a feedback report, the session it describes, and the individual turn
 * inside that session are addressed by URL.
 *
 * Four independent parties have to agree on these paths, and none of them can see the others:
 * the Slack payload builder and the email template (server-side, composing an absolute URL from
 * APP_URL), the router's search-param contract, and the admin console that reads the params back
 * out. Encoding the scheme once here is what stops a second, incompatible scheme appearing the
 * next time a channel wants to link to a report.
 *
 * These are pure PATH builders with no environment access, so client code can import them too -
 * a server caller prepends the origin with toAbsoluteUrl().
 */

/** Search-param names. Shared so a builder and its reader cannot drift onto different spellings. */
export const ADMIN_TAB_PARAM = 'tab';
export const FEEDBACK_ID_PARAM = 'feedbackId';
export const QUEST_ID_PARAM = 'questId';

/**
 * URL-stable slug for the admin console's Feedback tab.
 *
 * Deliberately NOT the `AdminTab` enum's numeric value: those are positional, so a link built
 * today would silently point at a different tab the first time someone reorders the enum. A link
 * in a Slack message or an email outlives the enum's ordering.
 */
export const ADMIN_FEEDBACK_TAB_SLUG = 'feedback';

/** Deep link to one feedback record in the admin console's Feedback tab. */
export function adminFeedbackRecordPath(feedbackId: string): string {
  const params = new URLSearchParams({
    [ADMIN_TAB_PARAM]: ADMIN_FEEDBACK_TAB_SLUG,
    [FEEDBACK_ID_PARAM]: feedbackId,
  });
  return `/admin?${params.toString()}`;
}

/** Deep link to a chat session. */
export function sessionPath(sessionId: string): string {
  return `/notebooks/${encodeURIComponent(sessionId)}`;
}

/**
 * Deep link to one turn within a session. The session still loads normally; `questId` tells the
 * thread which turn to scroll to and highlight once it has rendered.
 */
export function sessionTurnPath(sessionId: string, questId: string): string {
  const params = new URLSearchParams({ [QUEST_ID_PARAM]: questId });
  return `${sessionPath(sessionId)}?${params.toString()}`;
}

/**
 * Join an origin and one of the paths above. Tolerates a trailing slash on the base because
 * APP_URL is operator-configured and arrives both ways.
 */
export function toAbsoluteUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}
