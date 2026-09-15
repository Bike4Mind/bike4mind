/**
 * Slack export error utilities.
 *
 * Pure validation logic is in @bike4mind/slack.
 * This file only contains createSlackExportError which depends on server-specific BadRequestError.
 */

import { BadRequestError } from '@server/utils/errors';
import {
  isSlackUserValidationError,
  SLACK_USER_VALIDATION_ERRORS,
  SLACK_USER_ERROR_MESSAGE_PATTERNS,
  isSlackUserValidationErrorCode,
  isSlackUserValidationErrorByMessage,
} from '@bike4mind/slack';

export type { SlackUserValidationError, SlackErrorType, SlackErrorMetadata } from '@bike4mind/slack';

// Re-export pure functions from the package for backward compatibility
export {
  SLACK_USER_VALIDATION_ERRORS,
  isSlackUserValidationError,
  isSlackUserValidationErrorCode,
  SLACK_USER_ERROR_MESSAGE_PATTERNS,
  isSlackUserValidationErrorByMessage,
};

/**
 * Create a BadRequestError with Slack-specific metadata.
 */
export function createSlackExportError(message: string, slackErrorCode: string): BadRequestError {
  const errorType = isSlackUserValidationError(slackErrorCode) ? 'user_validation' : 'system_error';

  return new BadRequestError(message, {
    errorType,
    slackErrorCode,
  });
}
