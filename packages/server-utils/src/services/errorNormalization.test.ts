/**
 * Tests for error type extraction and message normalization
 */

import { describe, it, expect } from 'vitest';
import { extractErrorType, normalizeErrorMessage } from './errorNormalization';

describe('errorNormalization', () => {
  describe('extractErrorType', () => {
    it('should extract TypeError from stack trace', () => {
      expect(extractErrorType('TypeError: Cannot read property "foo" of undefined')).toBe('TypeError');
    });

    it('should extract MongoServerError from MongoDB errors', () => {
      expect(extractErrorType('MongoServerError: E11000 duplicate key error collection: db.users')).toBe(
        'MongoServerError'
      );
    });

    it('should extract ValidationException from AWS errors', () => {
      expect(extractErrorType('ValidationException: The provided model identifier is invalid.')).toBe(
        'ValidationException'
      );
    });

    it('should handle Runtime.UnhandledPromiseRejection wrapper', () => {
      expect(extractErrorType('Runtime.UnhandledPromiseRejection: TypeError: terminated')).toBe('TypeError');
    });

    it('should return UnknownError for errors without explicit type', () => {
      expect(extractErrorType('Something went wrong with the connection')).toBe('UnknownError');
    });

    it('should handle multi-line error messages', () => {
      const multiLine = `MongoNetworkError: connection timed out
        at Connection.connect (/app/node_modules/mongodb/lib/cmap/connection.js:456:13)`;
      expect(extractErrorType(multiLine)).toBe('MongoNetworkError');
    });
  });

  describe('normalizeErrorMessage', () => {
    it('should replace UUIDs with <UUID>', () => {
      const msg = 'Request failed for user 550e8400-e29b-41d4-a716-446655440000';
      expect(normalizeErrorMessage(msg)).toBe('Request failed for user <UUID>');
    });

    it('should replace MongoDB ObjectIds with <ID>', () => {
      const msg = 'User 507f1f77bcf86cd799439011 not found';
      expect(normalizeErrorMessage(msg)).toBe('User <ID> not found');
    });

    it('should replace ISO timestamps with <TIMESTAMP>', () => {
      const msg = 'Error occurred at 2026-02-22T14:30:00Z';
      expect(normalizeErrorMessage(msg)).toBe('Error occurred at <TIMESTAMP>');
    });

    it('should replace Unix timestamps with <TS>', () => {
      const msg = 'Event timestamp: 1708613400000';
      expect(normalizeErrorMessage(msg)).toBe('Event timestamp: <TS>');
    });

    it('should replace Slack timestamps', () => {
      const msg = 'Message ts: 1708613400.123456';
      expect(normalizeErrorMessage(msg)).toBe('Message ts: <SLACK_TS>');
    });

    it('should replace port numbers with <PORT>', () => {
      const msg = 'Connection to localhost:27017 failed';
      expect(normalizeErrorMessage(msg)).toBe('Connection to localhost:<PORT> failed');
    });

    it('should replace request IDs', () => {
      const msg = 'Error in request request_id: abc-123-def';
      expect(normalizeErrorMessage(msg)).toContain('<REQ_ID>');
    });

    it('should replace email addresses', () => {
      const msg = 'Failed to send email to user@example.com';
      expect(normalizeErrorMessage(msg)).toBe('Failed to send email to <EMAIL>');
    });

    it('should replace IPv4 addresses', () => {
      const msg = 'Connection from 192.168.1.100 refused';
      expect(normalizeErrorMessage(msg)).toBe('Connection from <IP> refused');
    });

    it('should NOT normalize HTTP status codes', () => {
      const msg = 'Server returned 500 Internal Server Error';
      expect(normalizeErrorMessage(msg)).toContain('500');
    });

    it('should NOT normalize file paths', () => {
      const msg = 'Error in /app/src/handler.ts';
      expect(normalizeErrorMessage(msg)).toContain('/app/src/handler.ts');
    });

    it('should NOT normalize error codes', () => {
      const msg = 'Connection failed: ECONNREFUSED';
      expect(normalizeErrorMessage(msg)).toContain('ECONNREFUSED');
    });

    // AWS Lambda/CloudWatch normalization tests
    describe('AWS Lambda/CloudWatch normalization', () => {
      it('should normalize CloudWatch console URLs', () => {
        const msg =
          'See https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#logEventViewer:group=abc;stream=xyz';
        expect(normalizeErrorMessage(msg)).toContain('<CLOUDWATCH_URL>');
        expect(normalizeErrorMessage(msg)).not.toContain('console.aws.amazon.com');
      });

      it('should normalize CloudWatch URLs with complex query params and fragments', () => {
        const msg = `Error in [AWS](https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#logEventViewer:group=%2Faws%2Flambda%2Fbike4mind-production-frontendServerUseast2Function-bnsdmfoh;stream=2026%2F02%2F27%2F...%5B%24LATEST%5De793dde82cee4953b6c3e317e1a09af2;start=1772209059204;end=1772209059204)`;
        const normalized = normalizeErrorMessage(msg);
        expect(normalized).toContain('<CLOUDWATCH_URL>');
        expect(normalized).not.toContain('frontendServerUseast2Function');
        expect(normalized).not.toContain('e793dde82cee4953b6c3e317e1a09af2');
      });

      it('should normalize 32-char hex IDs', () => {
        const msg = 'stream=[$LATEST]e793dde82cee4953b6c3e317e1a09af2';
        expect(normalizeErrorMessage(msg)).toContain('<HEX_ID>');
        expect(normalizeErrorMessage(msg)).not.toContain('e793dde82cee4953b6c3e317e1a09af2');
      });

      it('should normalize Lambda log stream patterns', () => {
        const msg = 'Error in 2026/02/27/[$LATEST]abc123def456789012345678901234ab';
        expect(normalizeErrorMessage(msg)).toContain('<LOG_STREAM>');
      });

      it('should normalize Lambda log stream with version number', () => {
        const msg = 'Log stream: 2026/02/27/[42]deadbeef12345678901234567890abcd';
        expect(normalizeErrorMessage(msg)).toContain('<LOG_STREAM>');
      });

      it('should normalize count/duration metadata', () => {
        const msg1 = 'Error count: 5 duration: 2h 30m in service';
        const msg2 = 'Error count: 99 duration: 10h 45m in service';
        expect(normalizeErrorMessage(msg1)).toBe(normalizeErrorMessage(msg2));
        expect(normalizeErrorMessage(msg1)).toContain('<COUNT_DURATION>');
      });

      it('should normalize count/duration with varied formats', () => {
        const msg = 'Alert count: 12 duration: 1h 2m 30s triggered';
        expect(normalizeErrorMessage(msg)).toContain('<COUNT_DURATION>');
      });

      // FALSE POSITIVE PREVENTION - Verify we don't over-normalize
      it('should NOT normalize meaningful words that happen to match patterns', () => {
        const msg = 'Error in callback function for messages';
        const normalized = normalizeErrorMessage(msg);
        expect(normalized).toContain('callback');
        expect(normalized).toContain('function');
        expect(normalized).toContain('messages');
      });

      it('should preserve Lambda function names outside of URLs', () => {
        const msg = 'Error in frontendServerUseast2Function handler';
        expect(normalizeErrorMessage(msg)).toContain('frontendServerUseast2Function');
      });

      it('should preserve file paths that might look like hex', () => {
        const msg = 'Error in /app/src/abcdef12.js file';
        expect(normalizeErrorMessage(msg)).toContain('/app/src/abcdef12.js');
      });
    });
  });
});
