import { describe, it, expect } from 'vitest';
import { createSuccessResponse, createErrorResponse, createCustomErrorResponse } from '../../helpers/responses.js';

describe('Response Helpers', () => {
  describe('createSuccessResponse', () => {
    it('should create a success response with provided data', () => {
      const data = { foo: 'bar', count: 42 };
      const result = createSuccessResponse(data);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.foo).toBe('bar');
      expect(parsed.count).toBe(42);
    });

    it('should format JSON with 2-space indentation', () => {
      const result = createSuccessResponse({ key: 'value' });
      const text = result.content[0].text;

      // Check for proper indentation
      expect(text).toContain('  "success"');
      expect(text).toContain('  "key"');
    });

    it('should handle nested objects', () => {
      const data = {
        user: {
          name: 'Test',
          nested: { deep: true },
        },
      };
      const result = createSuccessResponse(data);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.user.name).toBe('Test');
      expect(parsed.user.nested.deep).toBe(true);
    });

    it('should handle arrays', () => {
      const data = { items: [1, 2, 3], tags: ['a', 'b'] };
      const result = createSuccessResponse(data);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.items).toEqual([1, 2, 3]);
      expect(parsed.tags).toEqual(['a', 'b']);
    });

    it('should handle null and undefined values', () => {
      const data = { nullVal: null, undefinedVal: undefined };
      const result = createSuccessResponse(data);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.nullVal).toBeNull();
      expect(parsed.undefinedVal).toBeUndefined();
    });

    it('should handle empty object', () => {
      const result = createSuccessResponse({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(Object.keys(parsed)).toEqual(['success']);
    });
  });

  describe('createErrorResponse', () => {
    it('should create an error response with isError flag', () => {
      const error = { message: 'Something went wrong', status: 500 };
      const result = createErrorResponse(error);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Something went wrong');
      expect(parsed.status).toBe(500);
    });

    it('should include response details when available', () => {
      const error = {
        message: 'API Error',
        status: 404,
        response: { data: { message: 'Not found', documentation_url: 'https://docs.github.com/rest' } },
      };
      const result = createErrorResponse(error);
      const parsed = JSON.parse(result.content[0].text);

      // Only safe fields are included in sanitized response
      expect(parsed.details).toEqual({ message: 'Not found', documentation_url: 'https://docs.github.com/rest' });
    });

    it('should set details to null when response.data is missing', () => {
      const error = { message: 'Error', status: 500 };
      const result = createErrorResponse(error);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.details).toBeNull();
    });

    it('should include additional data when provided', () => {
      const error = { message: 'Error' };
      const result = createErrorResponse(error, {
        requested_repository: 'owner/repo',
        hint: 'Try again',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.requested_repository).toBe('owner/repo');
      expect(parsed.hint).toBe('Try again');
    });

    it('should handle Error objects', () => {
      const error = new Error('Standard error');
      const result = createErrorResponse(error);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toBe('Standard error');
      expect(parsed.success).toBe(false);
    });

    it('should handle errors without status', () => {
      const error = { message: 'No status error' };
      const result = createErrorResponse(error);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.status).toBeUndefined();
    });
  });

  describe('createCustomErrorResponse', () => {
    it('should create an error response with custom message', () => {
      const result = createCustomErrorResponse('Custom error message');

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Custom error message');
    });

    it('should include additional data when provided', () => {
      const result = createCustomErrorResponse('Error', {
        code: 'VALIDATION_FAILED',
        field: 'email',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.code).toBe('VALIDATION_FAILED');
      expect(parsed.field).toBe('email');
    });

    it('should handle empty additional data', () => {
      const result = createCustomErrorResponse('Error', {});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Error');
    });
  });
});
