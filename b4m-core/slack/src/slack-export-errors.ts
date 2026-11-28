/**
 * Shared utilities for Slack export error handling
 *
 * Centralizes the classification of Slack API errors into user validation errors
 * (which should be logged as WARN) vs system errors (which should be logged as ERROR).
 */

/**
 * Slack API error codes that represent user validation issues rather than system failures.
 */
export const SLACK_USER_VALIDATION_ERRORS = [
  'not_in_channel',
  'channel_not_found',
  'is_archived',
  'missing_scope',
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'not_authed',
  'ekm_access_denied',
  'private_channel',
] as const;

export type SlackUserValidationError = (typeof SLACK_USER_VALIDATION_ERRORS)[number];

/**
 * Check if a Slack API error code represents a user validation error.
 */
export function isSlackUserValidationError(errorCode: string): boolean {
  return SLACK_USER_VALIDATION_ERRORS.includes(errorCode as SlackUserValidationError);
}

/**
 * Type guard to check if an error code is a known Slack user validation error.
 */
export function isSlackUserValidationErrorCode(errorCode: string): errorCode is SlackUserValidationError {
  return SLACK_USER_VALIDATION_ERRORS.includes(errorCode as SlackUserValidationError);
}

/**
 * Read the Web API error code from an error thrown by @slack/web-api. Only a platform
 * error (Slack answered `ok: false`) carries one in `data.error`; HTTP, network and
 * rate-limit errors do not, so they return undefined.
 */
export function getSlackApiErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined;
  const { data } = error as { data: unknown };
  if (typeof data !== 'object' || data === null || !('error' in data)) return undefined;
  const { error: code } = data as { error: unknown };
  return typeof code === 'string' ? code : undefined;
}

/**
 * True when a thrown Slack error is an expected workspace-side state (bot not invited,
 * channel gone or archived, token revoked) that only the workspace can fix, so callers
 * can log it at warn instead of error.
 */
export function isExpectedSlackWorkspaceError(error: unknown): boolean {
  const code = getSlackApiErrorCode(error);
  return code !== undefined && isSlackUserValidationError(code);
}

/**
 * Patterns to match in error messages when the original Slack error code is not available.
 */
export const SLACK_USER_ERROR_MESSAGE_PATTERNS = [
  'not a member',
  'channel not found',
  'archived',
  'missing required permissions',
  'token revoked',
  'authentication expired',
  'authentication has expired',
  'inactive or suspended',
  'no authentication token',
  'key management',
  'private channel',
] as const;

/**
 * Check if an error message indicates a user validation error.
 */
export function isSlackUserValidationErrorByMessage(errorMessage: string | undefined | null): boolean {
  if (!errorMessage) return false;
  const lowerMessage = errorMessage.toLowerCase();
  return SLACK_USER_ERROR_MESSAGE_PATTERNS.some(pattern => lowerMessage.includes(pattern));
}

/**
 * Error type classification for Slack export errors.
 */
export type SlackErrorType = 'user_validation' | 'system_error';

/**
 * Metadata included in Slack export errors.
 */
export interface SlackErrorMetadata {
  errorType: SlackErrorType;
  slackErrorCode: string;
}
