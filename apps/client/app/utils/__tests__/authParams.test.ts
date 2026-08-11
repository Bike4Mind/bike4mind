import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHashParams, parseQueryParams, parseAuthParams } from '../authParams';

describe('authParams', () => {
  describe('parseHashParams', () => {
    it('should parse complete hash params with leading #', () => {
      const hash = '#token=abc123&userId=user789';
      const result = parseHashParams(hash);

      expect(result).toEqual({
        token: 'abc123',
        userId: 'user789',
        error: undefined,
      });
    });

    it('should parse complete hash params without leading #', () => {
      const hash = 'token=abc123&userId=user789';
      const result = parseHashParams(hash);

      expect(result).toEqual({
        token: 'abc123',
        userId: 'user789',
        error: undefined,
      });
    });

    it('should include error when present with complete params', () => {
      const hash = '#token=abc&userId=user&error=some_error';
      const result = parseHashParams(hash);

      expect(result).toEqual({
        token: 'abc',
        userId: 'user',
        error: 'some_error',
      });
    });

    it('should return error-only result when only error is present', () => {
      const hash = '#error=access_denied';
      const result = parseHashParams(hash);

      expect(result).toEqual({ error: 'access_denied' });
    });

    it('should return null for empty hash', () => {
      expect(parseHashParams('')).toBeNull();
      expect(parseHashParams('#')).toBeNull();
    });

    it('should return null for incomplete token data', () => {
      // Missing userId
      expect(parseHashParams('#token=abc')).toBeNull();
      // Missing token
      expect(parseHashParams('#userId=user')).toBeNull();
      // A stale fragment carrying only the (now cookie-borne) refresh token is not a session
      expect(parseHashParams('#refreshToken=ref&userId=user')).toBeNull();
    });

    it('should handle URL-encoded values', () => {
      const hash = '#token=abc%20123&userId=user%40test';
      const result = parseHashParams(hash);

      expect(result).toEqual({
        token: 'abc 123',
        userId: 'user@test',
        error: undefined,
      });
    });

    it('should handle JWT-like tokens', () => {
      // nosemgrep: generic.secrets.security.detected-jwt-token.detected-jwt-token
      const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
      const hash = `#token=${jwtToken}&userId=123`;
      const result = parseHashParams(hash);

      expect(result?.token).toBe(jwtToken);
    });
  });

  describe('parseQueryParams', () => {
    it('should parse complete query params', () => {
      const search = {
        token: 'abc123',
        userId: 'user789',
      };
      const result = parseQueryParams(search);

      expect(result).toEqual({
        token: 'abc123',
        userId: 'user789',
        error: undefined,
      });
    });

    it('should include error when present', () => {
      const search = {
        token: 'abc',
        userId: 'user',
        error: 'some_error',
      };
      const result = parseQueryParams(search);

      expect(result).toEqual({
        token: 'abc',
        userId: 'user',
        error: 'some_error',
      });
    });

    it('should handle empty search object', () => {
      const result = parseQueryParams({});

      expect(result).toEqual({
        token: undefined,
        userId: undefined,
        error: undefined,
      });
    });

    it('should ignore non-string values', () => {
      const search = {
        token: 123,
        userId: null,
        error: undefined,
      };
      const result = parseQueryParams(search as Record<string, unknown>);

      expect(result).toEqual({
        token: undefined,
        userId: undefined,
        error: undefined,
      });
    });

    it('should handle partial params', () => {
      const search = { token: 'abc' };
      const result = parseQueryParams(search);

      expect(result).toEqual({
        token: 'abc',
        userId: undefined,
        error: undefined,
      });
    });
  });

  describe('parseAuthParams', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should prefer hash params when window has hash', () => {
      const mockWindow = {
        location: {
          hash: '#token=hashToken&userId=hashUser',
          pathname: '/auth/success',
          search: '',
        },
        history: {
          replaceState: vi.fn(),
        },
      } as unknown as Window;

      const search = {
        token: 'queryToken',
        userId: 'queryUser',
      };

      const result = parseAuthParams(search, mockWindow);

      expect(result).toEqual({
        token: 'hashToken',
        userId: 'hashUser',
        error: undefined,
      });
    });

    it('should clear hash after reading', () => {
      const replaceStateMock = vi.fn();
      const mockWindow = {
        location: {
          hash: '#token=abc&userId=user',
          pathname: '/auth/success',
          search: '',
        },
        history: {
          replaceState: replaceStateMock,
        },
      } as unknown as Window;

      parseAuthParams({}, mockWindow);

      expect(replaceStateMock).toHaveBeenCalledWith(null, '', '/auth/success');
    });

    it('should fall back to query params when no hash', () => {
      const mockWindow = {
        location: {
          hash: '',
          pathname: '/auth/success',
          search: '',
        },
        history: {
          replaceState: vi.fn(),
        },
      } as unknown as Window;

      const search = {
        token: 'queryToken',
        userId: 'queryUser',
      };

      const result = parseAuthParams(search, mockWindow);

      expect(result).toEqual({
        token: 'queryToken',
        userId: 'queryUser',
        error: undefined,
      });
    });

    it('should fall back to query params when hash is incomplete', () => {
      const mockWindow = {
        location: {
          hash: '#token=hashToken', // incomplete
          pathname: '/auth/success',
          search: '',
        },
        history: {
          replaceState: vi.fn(),
        },
      } as unknown as Window;

      const search = {
        token: 'queryToken',
        userId: 'queryUser',
      };

      const result = parseAuthParams(search, mockWindow);

      expect(result).toEqual({
        token: 'queryToken',
        userId: 'queryUser',
        error: undefined,
      });
    });

    it('should return hash error when only error in hash', () => {
      const mockWindow = {
        location: {
          hash: '#error=access_denied',
          pathname: '/auth/success',
          search: '',
        },
        history: {
          replaceState: vi.fn(),
        },
      } as unknown as Window;

      const result = parseAuthParams({}, mockWindow);

      expect(result).toEqual({ error: 'access_denied' });
    });

    it('should preserve query string when clearing hash', () => {
      const replaceStateMock = vi.fn();
      const mockWindow = {
        location: {
          hash: '#token=abc&userId=user',
          pathname: '/auth/success',
          search: '?redirectTo=%2Fnew',
        },
        history: { replaceState: replaceStateMock },
      } as unknown as Window;

      parseAuthParams({}, mockWindow);

      expect(replaceStateMock).toHaveBeenCalledWith(null, '', '/auth/success?redirectTo=%2Fnew');
    });

    it('should handle undefined window (SSR)', () => {
      const search = {
        token: 'queryToken',
        userId: 'queryUser',
      };

      // Pass undefined explicitly to simulate SSR
      const result = parseAuthParams(search, undefined);

      expect(result).toEqual({
        token: 'queryToken',
        userId: 'queryUser',
        error: undefined,
      });
    });

    it('should handle window without history (edge case)', () => {
      const mockWindow = {
        location: {
          hash: '#token=abc&userId=user',
          pathname: '/auth/success',
          search: '',
        },
        // No history object
      } as unknown as Window;

      // Should not throw
      const result = parseAuthParams({}, mockWindow);

      expect(result).toEqual({
        token: 'abc',
        userId: 'user',
        error: undefined,
      });
    });
  });
});
