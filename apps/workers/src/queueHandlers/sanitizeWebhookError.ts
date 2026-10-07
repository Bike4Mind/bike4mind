/**
 * Sanitize error messages before persisting them to the DLQ dashboard.
 *
 * Org admins can see `errorMessage` on the DLQ Management dashboard. Raw exception
 * messages from Mongoose, AWS KMS, etc. can leak internal infrastructure details
 * (CMK ARNs, replica set members, collection names). This helper maps known error
 * shapes to friendly strings while keeping the full detail in structured logs.
 *
 * The notifier surfaces dispatch errors with stable prefixes - we key off those
 * prefixes so the dashboard shows actionable categories instead of opaque text.
 */

const SLACK_ERROR_CODES = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'account_inactive',
  'user_not_found',
  'token_revoked',
  'invalid_auth',
  'missing_scope',
  'rate_limited',
]);

function safeForSlack(message: string): string | null {
  // Slack API error codes are short, well-known, and safe to surface verbatim -
  // they help admins diagnose the misconfiguration without exposing internals.
  for (const code of SLACK_ERROR_CODES) {
    if (message.includes(code)) return `Slack delivery failed: ${code}`;
  }
  return null;
}

/**
 * Sanitize a notifier `dispatchError` string. Returns a user-safe label without
 * the raw underlying error suffix. The raw error remains in structured logs.
 */
export function sanitizeDispatchError(raw: string): string {
  // `No active Slack workspace with bot token` - already safe, no suffix.
  if (raw === 'No active Slack workspace with bot token') return raw;

  if (raw.startsWith('Target enumeration failed:')) return 'Database temporarily unavailable';
  if (raw.startsWith('Subscription check failed:')) return 'Database temporarily unavailable';
  if (raw.startsWith('Subscriber lookup failed:')) return 'Database temporarily unavailable';
  if (raw.startsWith('Bot token fetch failed:')) return 'Slack workspace credentials unavailable';
  if (raw.startsWith('DI resolution failed:')) return 'Internal configuration error';
  if (raw.startsWith('Notifier threw:')) return 'Notification dispatch failed';

  return 'Notification dispatch failed';
}

/**
 * Sanitize a per-user notification failure string. Slack API error codes pass
 * through verbatim (they're safe and useful); anything else is collapsed to a
 * generic label.
 */
export function sanitizeNotificationError(raw: string): string {
  const slack = safeForSlack(raw);
  if (slack) return slack;
  return 'Slack delivery failed';
}

/**
 * Sanitize a handler-thrown exception message. Handler errors are arbitrary -
 * we don't know the shape, so collapse to a generic label.
 */
export function sanitizeHandlerError(_raw: string): string {
  return 'Handler failed to process event';
}
