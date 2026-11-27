import { describe, it, expect } from 'vitest';
import {
  errorLogFields,
  getErrorInfo,
  getErrorMessage,
  hasStatus,
  isRateLimitError,
  asGitHubError,
} from '../../helpers/errors.js';

describe('Error Helpers', () => {
  describe('getErrorInfo', () => {
    it('should extract message from Error instance', () => {
      const error = new Error('Something went wrong');
      const info = getErrorInfo(error);

      expect(info.message).toBe('Something went wrong');
      expect(info.status).toBeUndefined();
    });

    it('should extract status from Error with status property', () => {
      const error = new Error('Not found');
      (error as { status?: number }).status = 404;
      const info = getErrorInfo(error);

      expect(info.message).toBe('Not found');
      expect(info.status).toBe(404);
    });

    it('should handle object-shaped errors', () => {
      const error = { message: 'API Error', status: 500 };
      const info = getErrorInfo(error);

      expect(info.message).toBe('API Error');
      expect(info.status).toBe(500);
    });

    it('should handle object without message', () => {
      const error = { status: 403 };
      const info = getErrorInfo(error);

      expect(info.message).toBe('Unknown error');
      expect(info.status).toBe(403);
    });

    it('should handle string errors', () => {
      const info = getErrorInfo('Simple error string');

      expect(info.message).toBe('Simple error string');
      expect(info.status).toBeUndefined();
    });

    it('should handle null', () => {
      const info = getErrorInfo(null);

      expect(info.message).toBe('Unknown error');
      expect(info.status).toBeUndefined();
    });

    it('should handle undefined', () => {
      const info = getErrorInfo(undefined);

      expect(info.message).toBe('Unknown error');
      expect(info.status).toBeUndefined();
    });

    it('should handle number errors', () => {
      const info = getErrorInfo(42);

      expect(info.message).toBe('42');
      expect(info.status).toBeUndefined();
    });
  });

  describe('getErrorMessage', () => {
    it('should return message from Error', () => {
      const error = new Error('Test error');
      expect(getErrorMessage(error)).toBe('Test error');
    });

    it('should return message from object', () => {
      const error = { message: 'Object error' };
      expect(getErrorMessage(error)).toBe('Object error');
    });

    it('should return string error as-is', () => {
      expect(getErrorMessage('String error')).toBe('String error');
    });
  });

  describe('hasStatus', () => {
    it('should return true when status matches', () => {
      const error = new Error('Not found');
      (error as { status?: number }).status = 404;

      expect(hasStatus(error, 404)).toBe(true);
    });

    it('should return false when status does not match', () => {
      const error = new Error('Server error');
      (error as { status?: number }).status = 500;

      expect(hasStatus(error, 404)).toBe(false);
    });

    it('should return false when no status', () => {
      const error = new Error('No status');

      expect(hasStatus(error, 404)).toBe(false);
    });
  });

  describe('isRateLimitError', () => {
    it('should return true for rate limit error', () => {
      const error = {
        message: 'API rate limit exceeded for user',
        status: 403,
      };

      expect(isRateLimitError(error)).toBe(true);
    });

    it('should return true for rate limit error (case insensitive)', () => {
      const error = {
        message: 'RATE LIMIT exceeded',
        status: 403,
      };

      expect(isRateLimitError(error)).toBe(true);
    });

    it('should return false for 403 without rate limit message', () => {
      const error = {
        message: 'Forbidden',
        status: 403,
      };

      expect(isRateLimitError(error)).toBe(false);
    });

    it('should return false for rate limit message without 403', () => {
      const error = {
        message: 'Rate limit exceeded',
        status: 429,
      };

      expect(isRateLimitError(error)).toBe(false);
    });
  });

  describe('asGitHubError', () => {
    it('should cast error to GitHubApiError type', () => {
      const error = { message: 'Test', status: 404, response: { data: {} } };
      const githubError = asGitHubError(error);

      expect(githubError.message).toBe('Test');
      expect(githubError.status).toBe(404);
      expect(githubError.response?.data).toEqual({});
    });
  });

  describe('errorLogFields', () => {
    const withStatus = Object.assign(new Error('Not Found'), { status: 404 });
    it.each([
      ['Error with numeric status', withStatus, { detail: 'Not Found', status: 404 }],
      ['plain Error', new Error('boom'), { detail: 'boom', status: undefined }],
      ['thrown string', 'just a string', { detail: 'just a string', status: undefined }],
      ['null', null, { detail: 'Unknown error', status: undefined }],
    ])('maps %s', (_name, input, expected) => {
      expect(errorLogFields(input)).toEqual(expected);
    });
  });
});
