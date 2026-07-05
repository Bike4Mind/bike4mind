// Pure helpers for the outbound-email -> Slack mirror. Kept side-effect-free
// (no axios / DB / SST) so the security-critical redaction is unit-testable
// in isolation. The poster that resolves the webhook and calls Slack lives
// in `slack.ts` (postEmailMirrorToSlack).
//
// SECURITY: transactional emails (password reset, email verification) carry
// single-use tokens in their links. Mirroring raw bodies into Slack would
// firehose live reset/verification links into a chat channel - so every mirrored
// preview is redacted here before it leaves the process. Redaction is defensive
// (over-redacts rather than under-redacts). Channel access must also be scoped
// (private, need-to-know).

/** Structured, already-redacted payload the poster turns into a Slack message. */
export interface EmailMirrorPayload {
  to: string;
  subject: string;
  emailType: string;
  /** Short, redacted body preview (never raw - pass through `redactEmailContentForMirror`). */
  bodyPreview: string;
}

/** How many characters of the (redacted) body to include in the mirror preview. */
export const EMAIL_PREVIEW_MAX_CHARS = 500;

/**
 * Strip secrets/tokens from text before it is mirrored to Slack. Defensive by
 * design - it removes anything token-shaped even at the cost of over-redacting:
 *  1. JWTs (`eyJ...........`) -> `<redacted-jwt>`.
 *  2. URL query strings and #fragments (where reset/verify tokens usually ride)
 *     -> kept as `<origin+path>?<redacted>` so the destination is still visible.
 *  3. Any remaining long opaque token (≥24 chars of base64url/hex, incl. token
 *     path segments) -> `<redacted>`.
 */
export function redactEmailContentForMirror(input: string | null | undefined): string {
  if (!input) return '';
  let out = String(input);

  // 1) JWTs first (three base64url segments) - before the generic rule so the
  //    dotted structure is replaced as a unit rather than segment-by-segment.
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>');

  // 2) URL query + fragment stripped (token-in-query is the common reset/verify shape).
  //    Keep scheme://host/path so reviewers can still see where the link points.
  out = out.replace(/(https?:\/\/[^\s?#]+)(?:[?#]\S*)?/gi, '$1?<redacted>');

  // 3) Any remaining long opaque token - including token-in-path segments left
  //    inside the kept URL base (e.g. /verify/<64-hex>) - collapses to <redacted>.
  out = out.replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');

  return out;
}

/**
 * Best-effort classification of an outbound email from its subject, so the
 * mirror carries a coarse type without touching the ~dozen `sendEmail` callers.
 * Order matters: more specific patterns win (email-change before verification).
 */
export function inferEmailType(subject: string | null | undefined): string {
  const s = (subject ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/(email\s*change|change.*email|new email)/.test(s)) return 'email-change';
  if (/(reset|forgot).*(password)|password.*reset/.test(s)) return 'password-reset';
  if (/verif|confirm your email|activate/.test(s)) return 'email-verification';
  if (/invit/.test(s)) return 'invite';
  if (/welcome/.test(s)) return 'welcome';
  if (/credit/.test(s)) return 'credit-grant';
  if (/what.?s new|release|update/.test(s)) return 'whats-new';
  if (/system health|health check/.test(s)) return 'system-health';
  return 'other';
}

/** Crudely strip HTML tags to plain text for the preview (previews only, not for rendering). */
function htmlToText(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      // Tags stripped to spaces leave a gap before punctuation ("ready ." ) - tidy it.
      .replace(/\s+([.,!?;:])/g, '$1')
      .trim()
  );
}

/**
 * Extract a short, redacted body preview from a nodemailer-style payload
 * (`{ text?, html? }`). Prefers `text`; falls back to tag-stripped `html`.
 * Always returns redacted, length-capped output.
 */
export function extractBodyPreview(data: unknown, maxChars: number = EMAIL_PREVIEW_MAX_CHARS): string {
  const d = (data ?? {}) as { text?: unknown; html?: unknown };
  const raw =
    typeof d.text === 'string' && d.text.trim() ? d.text : typeof d.html === 'string' ? htmlToText(d.html) : '';
  const redacted = redactEmailContentForMirror(raw).trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…`;
}

/** Build the Slack message text for a mirrored email. Assumes `bodyPreview` is already redacted. */
export function buildEmailMirrorMessage(payload: EmailMirrorPayload): string {
  const { to, subject, emailType, bodyPreview } = payload;
  const lines = [
    `:email: *Outbound email* — \`${emailType}\``,
    `*To:* ${to}`,
    `*Subject:* ${subject}`,
    `*At:* ${new Date().toISOString()}`,
  ];
  if (bodyPreview) lines.push(`*Preview (secrets redacted):*\n>>> ${bodyPreview}`);
  return lines.join('\n');
}
