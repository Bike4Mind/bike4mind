import { describe, it, expect } from 'vitest';
import { getErrorInfo, getErrorMessage, hasStatus, asNotionError } from '../../helpers/errors.js';

describe('Notion Error Helpers', () => {
  describe('getErrorInfo', () => {
    it('should extract message from Error instance', () => {
      const error = new Error('Something went wrong');
      const info = getErrorInfo(error);
      expect(info.message).toBe('Something went wrong');
      expect(info.status).toBeUndefined();
    });

    it('should extract status from Error with status property', () => {
      const error = new Error('Not found');
      (error as Error & { status?: number }).status = 404;
      const info = getErrorInfo(error);
      expect(info.message).toBe('Not found');
      expect(info.status).toBe(404);
    });

    it('should extract code from Error with code property', () => {
      const error = new Error('Invalid request');
      (error as Error & { code?: string }).code = 'validation_error';
      const info = getErrorInfo(error);
      expect(info.message).toBe('Invalid request');
      expect(info.code).toBe('validation_error');
    });

    it('should handle object-shaped errors', () => {
      const error = { message: 'API error', status: 400, code: 'invalid_json' };
      const info = getErrorInfo(error);
      expect(info.message).toBe('API error');
      expect(info.status).toBe(400);
      expect(info.code).toBe('invalid_json');
    });

    it('should handle object without message', () => {
      const error = { status: 500 };
      const info = getErrorInfo(error);
      expect(info.message).toBe('Unknown error');
      expect(info.status).toBe(500);
    });

    it('should handle string errors', () => {
      const info = getErrorInfo('simple error');
      expect(info.message).toBe('simple error');
    });

    it('should handle null', () => {
      const info = getErrorInfo(null);
      expect(info.message).toBe('Unknown error');
    });

    it('should handle undefined', () => {
      const info = getErrorInfo(undefined);
      expect(info.message).toBe('Unknown error');
    });

    it('should handle number errors', () => {
      const info = getErrorInfo(42);
      expect(info.message).toBe('42');
    });
  });

  describe('getErrorMessage', () => {
    it('should return the message string', () => {
      expect(getErrorMessage(new Error('test'))).toBe('test');
    });

    it('should handle null', () => {
      expect(getErrorMessage(null)).toBe('Unknown error');
    });
  });

  describe('hasStatus', () => {
    it('should return true for matching status', () => {
      const error = new Error('Not found');
      (error as Error & { status?: number }).status = 404;
      expect(hasStatus(error, 404)).toBe(true);
    });

    it('should return false for non-matching status', () => {
      const error = new Error('Not found');
      (error as Error & { status?: number }).status = 404;
      expect(hasStatus(error, 500)).toBe(false);
    });

    it('should return false when no status', () => {
      expect(hasStatus(new Error('test'), 404)).toBe(false);
    });
  });

  describe('asNotionError', () => {
    it('should cast unknown to NotionApiError', () => {
      const error = { message: 'test', status: 400 };
      const result = asNotionError(error);
      expect(result.message).toBe('test');
      expect(result.status).toBe(400);
    });
  });
});
