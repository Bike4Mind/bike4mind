/**
 * Classifies Slack `apps.manifest.*` rejections of an app configuration token.
 *
 * Configuration tokens are short-lived and admin-supplied, so Slack rejecting the token itself is an
 * expected admin action (log at warn), not a system failure. Codes are the token-validity entries of
 * the Errors tables for apps.manifest.export / update / create. Used by the admin slack-app routes
 * (`pages/api/admin/slack-app/*`).
 */
export const SLACK_CONFIG_TOKEN_AUTH_ERRORS = [
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
  'account_inactive',
  'not_allowed_token_type',
] as const;

export type SlackConfigTokenAuthError = (typeof SLACK_CONFIG_TOKEN_AUTH_ERRORS)[number];

const AUTH_ERROR_CODES: ReadonlySet<string> = new Set(SLACK_CONFIG_TOKEN_AUTH_ERRORS);

export function isSlackConfigTokenAuthError(code: unknown): code is SlackConfigTokenAuthError {
  return typeof code === 'string' && AUTH_ERROR_CODES.has(code);
}

/** For a token stored on the workspace: the admin must reconnect. */
export const STORED_CONFIG_TOKEN_REJECTED_MESSAGE =
  'Configuration token expired or invalid. Reconnect with a fresh app configuration token.';

/** For a token the admin just submitted: they must paste a new one. */
export const SUBMITTED_CONFIG_TOKEN_REJECTED_MESSAGE =
  'Configuration token expired or invalid. Generate a fresh app configuration token in Slack and try again.';
