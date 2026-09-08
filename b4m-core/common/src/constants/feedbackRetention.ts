/**
 * Feedback free-text retention, in DAYS.
 *
 * Live here (not next to the model) for the same reason as `constants/lakeAccessAudit.ts`: the
 * value is needed by both `packages/database` (the model + its TTL index) and the app-server
 * handler that writes it, and neither package may import the other.
 *
 * Unlike the lake-access retention window, this is a fixed policy (90 days, no per-org
 * configuration, no consent flag) - feedback is deliberately submitted, not passively collected,
 * so there is no lever to resolve here, only a constant and the arithmetic that derives an
 * `expiresAt` from it.
 */

/** Matches HelpEventModel's existing TTL precedent. */
export const FEEDBACK_CONTENT_RETENTION_DAYS = 90;

/** Caps a submitted report's free text so an unusually long textarea cannot balloon the
 * (already short-retention) sibling row. */
export const FEEDBACK_CONTENT_MAX_CHARS = 4000;

/** The one place `now + days` is computed for feedback text, so the model, the handler, and the
 * backfill migration cannot drift on the arithmetic. */
export function feedbackContentExpiresAt(now: Date, days: number = FEEDBACK_CONTENT_RETENTION_DAYS): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Shared by the create and update handlers so a report's free text is capped the same way
 * regardless of which path wrote it. */
export function truncateFeedbackContent(content: string): { content: string; contentTruncated: boolean } {
  if (content.length <= FEEDBACK_CONTENT_MAX_CHARS) {
    return { content, contentTruncated: false };
  }
  return { content: content.slice(0, FEEDBACK_CONTENT_MAX_CHARS), contentTruncated: true };
}
