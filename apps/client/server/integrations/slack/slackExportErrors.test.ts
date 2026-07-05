import { describe, it, expect } from 'vitest';
import { BadRequestError } from '@server/utils/errors';
import {
  SLACK_USER_VALIDATION_ERRORS,
  SLACK_USER_ERROR_MESSAGE_PATTERNS,
  isSlackUserValidationError,
  isSlackUserValidationErrorCode,
  isSlackUserValidationErrorByMessage,
  createSlackExportError,
} from './slackExportErrors';

describe('slackExportErrors', () => {
  describe('isSlackUserValidationError', () => {
    it.each(SLACK_USER_VALIDATION_ERRORS)('returns true for user validation error code: %s', errorCode => {
      expect(isSlackUserValidationError(errorCode)).toBe(true);
    });

    it.each(['ratelimited', 'internal_error', 'server_error', 'unknown_error', 'timeout', ''])(
      'returns false for system/unknown error code: %s',
      errorCode => {
        expect(isSlackUserValidationError(errorCode)).toBe(false);
      }
    );
  });

  describe('isSlackUserValidationErrorCode (type guard)', () => {
    it.each(SLACK_USER_VALIDATION_ERRORS)('returns true and narrows type for: %s', errorCode => {
      expect(isSlackUserValidationErrorCode(errorCode)).toBe(true);
    });

    it.each(['ratelimited', 'internal_error', 'server_error', 'unknown_error'])(
      'returns false for system error code: %s',
      errorCode => {
        expect(isSlackUserValidationErrorCode(errorCode)).toBe(false);
      }
    );

    it('provides type narrowing in conditional blocks', () => {
      const errorCode: string = 'not_in_channel';
      if (isSlackUserValidationErrorCode(errorCode)) {
        // TypeScript should narrow errorCode to SlackUserValidationError here
        const narrowed: typeof errorCode = errorCode;
        expect(narrowed).toBe('not_in_channel');
      }
    });
  });

  describe('isSlackUserValidationErrorByMessage', () => {
    it.each([
      ['Bot is not a member of this channel', 'not a member'],
      ['Channel not found or bot cannot access it', 'channel not found'],
      ['This channel has been archived', 'archived'],
      ['Bot missing required permissions to access channel', 'missing required permissions'],
      ['Bot token revoked by workspace admin', 'token revoked'],
      ['Workspace authentication expired', 'authentication expired'],
      ['Workspace authentication has expired, please reconnect', 'authentication has expired'],
      ['Slack workspace is inactive or suspended', 'inactive or suspended'],
      ['No authentication token was provided', 'no authentication token'],
      ['Enterprise Key Management restrictions apply', 'key management'],
      ['Cannot access private channel without membership', 'private channel'],
    ])('returns true for message containing pattern: "%s"', (message, _pattern) => {
      expect(isSlackUserValidationErrorByMessage(message)).toBe(true);
    });

    it('handles case-insensitive matching', () => {
      expect(isSlackUserValidationErrorByMessage('BOT IS NOT A MEMBER')).toBe(true);
      expect(isSlackUserValidationErrorByMessage('Channel Not Found')).toBe(true);
      expect(isSlackUserValidationErrorByMessage('ARCHIVED channel')).toBe(true);
    });

    it.each([
      'Connection timeout',
      'Rate limit exceeded',
      'Internal server error',
      'Unknown error occurred',
      'Failed to connect to Slack API',
    ])('returns false for system error message: "%s"', message => {
      expect(isSlackUserValidationErrorByMessage(message)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isSlackUserValidationErrorByMessage(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isSlackUserValidationErrorByMessage(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isSlackUserValidationErrorByMessage('')).toBe(false);
    });
  });

  describe('constants', () => {
    it('SLACK_USER_VALIDATION_ERRORS contains expected error codes', () => {
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('not_in_channel');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('channel_not_found');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('is_archived');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('missing_scope');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('invalid_auth');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('token_revoked');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('account_inactive');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('not_authed');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('ekm_access_denied');
      expect(SLACK_USER_VALIDATION_ERRORS).toContain('private_channel');
    });

    it('SLACK_USER_ERROR_MESSAGE_PATTERNS contains expected patterns', () => {
      expect(SLACK_USER_ERROR_MESSAGE_PATTERNS).toContain('not a member');
      expect(SLACK_USER_ERROR_MESSAGE_PATTERNS).toContain('channel not found');
      expect(SLACK_USER_ERROR_MESSAGE_PATTERNS).toContain('archived');
      expect(SLACK_USER_ERROR_MESSAGE_PATTERNS).toContain('missing required permissions');
      expect(SLACK_USER_ERROR_MESSAGE_PATTERNS).toContain('private channel');
    });
  });

  describe('createSlackExportError', () => {
    it('creates BadRequestError with user_validation type for user validation errors', () => {
      const error = createSlackExportError('Bot is not a member of this channel', 'not_in_channel');

      expect(error).toBeInstanceOf(BadRequestError);
      expect(error.message).toBe('Bot is not a member of this channel');
      expect(error.additionalInfo).toEqual({
        errorType: 'user_validation',
        slackErrorCode: 'not_in_channel',
      });
    });

    it('creates BadRequestError with system_error type for system errors', () => {
      const error = createSlackExportError('Slack API internal error', 'internal_error');

      expect(error).toBeInstanceOf(BadRequestError);
      expect(error.message).toBe('Slack API internal error');
      expect(error.additionalInfo).toEqual({
        errorType: 'system_error',
        slackErrorCode: 'internal_error',
      });
    });

    it.each(SLACK_USER_VALIDATION_ERRORS)('classifies %s as user_validation error type', errorCode => {
      const error = createSlackExportError('Test message', errorCode);
      expect(error.additionalInfo?.errorType).toBe('user_validation');
      expect(error.additionalInfo?.slackErrorCode).toBe(errorCode);
    });

    it.each(['ratelimited', 'internal_error', 'server_error', 'unknown_error'])(
      'classifies %s as system_error error type',
      errorCode => {
        const error = createSlackExportError('Test message', errorCode);
        expect(error.additionalInfo?.errorType).toBe('system_error');
        expect(error.additionalInfo?.slackErrorCode).toBe(errorCode);
      }
    );
  });
});
