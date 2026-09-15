/**
 * Tests for mcpCircuitBreakers service
 *
 * Covers: breaker registry, isCircuitBreakerFailure classifier, getBreaker singleton,
 * getAllBreakerStates, resetBreaker.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock CloudWatch to avoid real AWS calls
vi.mock('@server/utils/cloudwatch', () => ({
  recordCircuitBreakerTransition: vi.fn().mockResolvedValue(undefined),
  recordCircuitBreakerRejection: vi.fn().mockResolvedValue(undefined),
}));

import {
  getBreaker,
  getAllBreakerStates,
  resetBreaker,
  isCircuitBreakerFailure,
  classifyOperation,
} from './mcpCircuitBreakers';
import { AxiosError } from 'axios';

// Helper to create mock Axios errors
function createAxiosError(status: number, code?: string): AxiosError {
  const error = new Error(`Request failed with status ${status}`) as AxiosError;
  error.isAxiosError = true;
  error.response = {
    status,
    statusText: 'Error',
    headers: {},
    data: {},
    config: {} as AxiosError['response'] extends infer R ? (R extends { config: infer C } ? C : never) : never,
  } as AxiosError['response'];
  if (code) {
    error.code = code;
  }
  return error;
}

describe('mcpCircuitBreakers', () => {
  describe('isCircuitBreakerFailure', () => {
    it('should return false for 400 Bad Request', () => {
      expect(isCircuitBreakerFailure(createAxiosError(400))).toBe(false);
    });

    it('should return false for 401 Unauthorized', () => {
      expect(isCircuitBreakerFailure(createAxiosError(401))).toBe(false);
    });

    it('should return false for 403 Forbidden', () => {
      expect(isCircuitBreakerFailure(createAxiosError(403))).toBe(false);
    });

    it('should return false for 404 Not Found', () => {
      expect(isCircuitBreakerFailure(createAxiosError(404))).toBe(false);
    });

    it('should return true for 500 Internal Server Error', () => {
      expect(isCircuitBreakerFailure(createAxiosError(500))).toBe(true);
    });

    it('should return true for 502 Bad Gateway', () => {
      expect(isCircuitBreakerFailure(createAxiosError(502))).toBe(true);
    });

    it('should return true for 503 Service Unavailable', () => {
      expect(isCircuitBreakerFailure(createAxiosError(503))).toBe(true);
    });

    it('should return true for ECONNREFUSED errors', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return true for ETIMEDOUT errors', () => {
      const error = new Error('connect ETIMEDOUT');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return true for socket hang up errors', () => {
      const error = new Error('socket hang up');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return true for connection closed errors', () => {
      const error = new Error('Connection closed');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return true for MCP handler invocation failures with 5xx', () => {
      const error = new Error('MCP handler invocation failed: 502 Bad Gateway');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return false for MCP handler invocation failures with 401', () => {
      const error = new Error('MCP handler invocation failed: 401 Unauthorized');
      expect(isCircuitBreakerFailure(error)).toBe(false);
    });

    it('should return true for generic errors (conservative default)', () => {
      const error = new Error('Something unexpected happened');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });
  });

  describe('classifyOperation', () => {
    it('should return "read" for getTools action', () => {
      expect(classifyOperation('getTools')).toBe('read');
    });

    it('should return "read" for getTools even with a toolName', () => {
      expect(classifyOperation('getTools', 'create_issue')).toBe('read');
    });

    it('should return "read" when no toolName is provided', () => {
      expect(classifyOperation('callTool')).toBe('read');
    });

    it('should return "read" for read-prefixed tools', () => {
      expect(classifyOperation('callTool', 'get_issue')).toBe('read');
      expect(classifyOperation('callTool', 'list_repos')).toBe('read');
      expect(classifyOperation('callTool', 'search_issues')).toBe('read');
    });

    it.each([
      'create_issue',
      'update_issue',
      'delete_issue',
      'add_comment',
      'remove_label',
      'bulk_update',
      'assign_issue',
      'move_card',
      'upload_attachment',
      'merge_pull_request',
      'approve_review',
      'close_issue',
      'reply_to_comment',
      'request_review',
    ])('should return "write" for %s', toolName => {
      expect(classifyOperation('callTool', toolName)).toBe('write');
    });

    it('should be case-insensitive for tool names', () => {
      expect(classifyOperation('callTool', 'Create_Issue')).toBe('write');
      expect(classifyOperation('callTool', 'DELETE_BRANCH')).toBe('write');
    });
  });

  describe('getBreaker', () => {
    it('should return the same instance for the same server name and op type', () => {
      const breaker1 = getBreaker('test-singleton', 'read');
      const breaker2 = getBreaker('test-singleton', 'read');
      expect(breaker1).toBe(breaker2);
    });

    it('should return different instances for different server names', () => {
      const breaker1 = getBreaker('test-a', 'read');
      const breaker2 = getBreaker('test-b', 'read');
      expect(breaker1).not.toBe(breaker2);
    });

    it('should return different instances for read vs write on same server', () => {
      const readBreaker = getBreaker('test-rw', 'read');
      const writeBreaker = getBreaker('test-rw', 'write');
      expect(readBreaker).not.toBe(writeBreaker);
    });

    it('should default to read when no operationType specified', () => {
      const defaultBreaker = getBreaker('test-default');
      const readBreaker = getBreaker('test-default', 'read');
      expect(defaultBreaker).toBe(readBreaker);
    });

    it('should create a breaker with the given name', () => {
      const breaker = getBreaker('test-named', 'read');
      const state = breaker.getState();
      expect(state.state).toBe('CLOSED');
      expect(state.failureCount).toBe(0);
    });
  });

  describe('getAllBreakerStates', () => {
    it('should return states for all created breakers with compound keys', () => {
      getBreaker('states-a', 'read');
      getBreaker('states-b', 'write');
      const states = getAllBreakerStates();
      expect(states['states-a:read']).toBeDefined();
      expect(states['states-b:write']).toBeDefined();
      expect(states['states-a:read'].state).toBe('CLOSED');
    });
  });

  describe('resetBreaker', () => {
    it('should reset an existing breaker to CLOSED using compound key', async () => {
      const breaker = getBreaker('test-reset-compound', 'read');

      // Trip the breaker by causing failures
      for (let i = 0; i < 5; i++) {
        try {
          await breaker.execute(() => Promise.reject(new Error('fail')));
        } catch {
          // expected
        }
      }
      expect(breaker.getState().state).toBe('OPEN');

      resetBreaker('test-reset-compound:read');
      expect(breaker.getState().state).toBe('CLOSED');
    });

    it('should reset both read and write breakers when given a plain server name', async () => {
      const readBreaker = getBreaker('test-reset-both', 'read');
      const writeBreaker = getBreaker('test-reset-both', 'write');

      // Trip the read breaker
      for (let i = 0; i < 5; i++) {
        try {
          await readBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch {
          // expected
        }
      }
      // Trip the write breaker (threshold is 3 for writes)
      for (let i = 0; i < 3; i++) {
        try {
          await writeBreaker.execute(() => Promise.reject(new Error('fail')));
        } catch {
          // expected
        }
      }

      expect(readBreaker.getState().state).toBe('OPEN');
      expect(writeBreaker.getState().state).toBe('OPEN');

      // Reset with plain name - should reset both
      resetBreaker('test-reset-both');
      expect(readBreaker.getState().state).toBe('CLOSED');
      expect(writeBreaker.getState().state).toBe('CLOSED');
    });

    it('should be a no-op for non-existent breaker', () => {
      // Should not throw
      resetBreaker('does-not-exist');
    });
  });

  describe('isCircuitBreakerFailure - edge cases', () => {
    it('should return true for ECONNRESET errors', () => {
      const error = new Error('read ECONNRESET');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return true for EPIPE errors', () => {
      const error = new Error('write EPIPE');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return true for "bad gateway" text errors', () => {
      const error = new Error('Received bad gateway response');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return true for "gateway timeout" text errors', () => {
      const error = new Error('upstream gateway timeout');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return true for "service unavailable" text errors', () => {
      const error = new Error('The service is unavailable');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return false for 422 Unprocessable Entity', () => {
      expect(isCircuitBreakerFailure(createAxiosError(422))).toBe(false);
    });

    it('should return true for 429 Too Many Requests (rate limiting = service overloaded)', () => {
      expect(isCircuitBreakerFailure(createAxiosError(429))).toBe(true);
    });

    it('should return true for Axios error with no response (network failure)', () => {
      const error = new Error('Network Error') as AxiosError;
      error.isAxiosError = true;
      error.response = undefined;
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });

    it('should return false for MCP handler invocation failure with 400', () => {
      const error = new Error('MCP handler invocation failed: 400 Bad Request');
      expect(isCircuitBreakerFailure(error)).toBe(false);
    });

    it('should return false for MCP handler invocation failure with 403', () => {
      const error = new Error('MCP handler invocation failed: 403 Forbidden');
      expect(isCircuitBreakerFailure(error)).toBe(false);
    });

    it('should return false for MCP handler invocation failure with 404', () => {
      const error = new Error('MCP handler invocation failed: 404 Not Found');
      expect(isCircuitBreakerFailure(error)).toBe(false);
    });

    it('should return false for MCP handler invocation failure with 409', () => {
      const error = new Error('MCP handler invocation failed: 409 Conflict');
      expect(isCircuitBreakerFailure(error)).toBe(false);
    });

    it('should return false for MCP handler invocation failure with 422', () => {
      const error = new Error('MCP handler invocation failed: 422 Unprocessable');
      expect(isCircuitBreakerFailure(error)).toBe(false);
    });

    it('should return true for MCP handler invocation failure when port 4010 is in message (not a 401)', () => {
      const error = new Error('MCP handler invocation failed: Error at port 4010');
      expect(isCircuitBreakerFailure(error)).toBe(true);
    });
  });

  describe('classifyOperation - edge cases', () => {
    it('should return "read" for unknown action types without a toolName', () => {
      expect(classifyOperation('unknownAction')).toBe('read');
    });

    it('should return "read" for tools with mixed prefixes not in write list', () => {
      expect(classifyOperation('callTool', 'get_all_issues')).toBe('read');
      expect(classifyOperation('callTool', 'find_user')).toBe('read');
      expect(classifyOperation('callTool', 'read_file')).toBe('read');
    });

    it('should correctly classify all write prefixes', () => {
      const writePrefixes = [
        'create_',
        'update_',
        'delete_',
        'add_',
        'remove_',
        'bulk_',
        'assign_',
        'move_',
        'upload_',
        'merge_',
        'approve_',
        'close_',
        'reply_',
        'request_',
      ];

      for (const prefix of writePrefixes) {
        expect(classifyOperation('callTool', `${prefix}something`)).toBe('write');
      }
    });
  });

  describe('getBreaker config overrides', () => {
    it('should create write breakers with stricter thresholds', async () => {
      const writeBreaker = getBreaker('test-write-strict', 'write');

      // Write breaker has failureThreshold of 3 (vs 5 for read)
      const failFn = vi.fn().mockRejectedValue(new Error('server error'));
      for (let i = 0; i < 3; i++) {
        try {
          await writeBreaker.execute(failFn);
        } catch {
          // expected
        }
      }
      expect(writeBreaker.getState().state).toBe('OPEN');
    });

    it('should create read breakers with standard thresholds', async () => {
      const readBreaker = getBreaker('test-read-standard', 'read');

      const failFn = vi.fn().mockRejectedValue(new Error('server error'));
      // 3 failures should NOT trip the read breaker (threshold is 5)
      for (let i = 0; i < 3; i++) {
        try {
          await readBreaker.execute(failFn);
        } catch {
          // expected
        }
      }
      expect(readBreaker.getState().state).toBe('CLOSED');

      // 2 more should trip it (total = 5)
      for (let i = 0; i < 2; i++) {
        try {
          await readBreaker.execute(failFn);
        } catch {
          // expected
        }
      }
      expect(readBreaker.getState().state).toBe('OPEN');
    });
  });
});
