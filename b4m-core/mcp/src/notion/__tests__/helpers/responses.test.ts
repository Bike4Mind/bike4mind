import { describe, it, expect } from 'vitest';
import { createSuccessResponse, createErrorResponse, createCustomErrorResponse } from '../../helpers/responses.js';

describe('Notion Response Helpers', () => {
  describe('createSuccessResponse', () => {
    it('should create a success response with data', () => {
      const response = createSuccessResponse({ id: '123', title: 'Test' });
      expect(response.isError).toBeUndefined();
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe('123');
      expect(parsed.title).toBe('Test');
    });
  });

  describe('createErrorResponse', () => {
    it('should create an error response from Error object', () => {
      const error = new Error('Something broke');
      const response = createErrorResponse(error);
      expect(response.isError).toBe(true);
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Something broke');
    });

    it('should include status when present', () => {
      const error = new Error('Not found');
      (error as Error & { status?: number }).status = 404;
      const response = createErrorResponse(error);
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.status).toBe(404);
    });

    it('should include code when present', () => {
      const error = new Error('Bad request');
      (error as Error & { code?: string }).code = 'validation_error';
      const response = createErrorResponse(error);
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.code).toBe('validation_error');
    });

    it('should sanitize token-like strings from error messages', () => {
      const error = new Error('Auth failed: Bearer ntn_abc123xyz');
      const response = createErrorResponse(error);
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.error).not.toContain('ntn_abc123xyz');
      expect(parsed.error).toContain('[REDACTED');
    });

    it('should sanitize secret tokens from error messages', () => {
      const error = new Error('Invalid secret_abc123def456');
      const response = createErrorResponse(error);
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.error).not.toContain('secret_abc123def456');
      expect(parsed.error).toContain('[REDACTED_SECRET]');
    });

    it('should include additional data', () => {
      const error = new Error('failed');
      const response = createErrorResponse(error, { context: 'search' });
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.context).toBe('search');
    });
  });

  describe('createCustomErrorResponse', () => {
    it('should create an error response with custom message', () => {
      const response = createCustomErrorResponse('Custom error message');
      expect(response.isError).toBe(true);
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Custom error message');
    });

    it('should include additional data', () => {
      const response = createCustomErrorResponse('error', { hint: 'try again' });
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.hint).toBe('try again');
    });
  });
});
