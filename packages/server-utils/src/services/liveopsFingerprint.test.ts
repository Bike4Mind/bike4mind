/**
 * Tests for LiveOps Fingerprinting Utility
 */

import { describe, it, expect } from 'vitest';
import {
  extractErrorType,
  extractStackSignature,
  normalizeErrorMessage,
  generateFingerprint,
  generateFingerprintFromIssueBody,
  extractFingerprintFromIssueBody,
  formatFingerprintComment,
  normalizeTitle,
  jaroWinklerSimilarity,
  calculateTitleSimilarity,
  findBestTitleMatch,
  extractCoreErrorMessage,
  generateSemanticFingerprint,
  formatSemanticFingerprintComment,
  extractSemanticFingerprintFromIssueBody,
} from './liveopsFingerprint';
import type { SlackAlert } from './liveopsTriageService';

// Helper to create a mock SlackAlert
function createAlert(text: string): SlackAlert {
  return {
    ts: '1234567890.123456',
    text,
    timestamp: new Date('2026-02-22T14:00:00Z'),
  };
}

describe('liveopsFingerprint', () => {
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

  describe('extractStackSignature', () => {
    it('should extract function names WITHOUT line numbers', () => {
      // Real stack traces have leading whitespace before "at"
      const stack = `Error: Something went wrong
    at processError (/app/src/handler.js:45:12)
    at handleRequest (/app/src/server.js:123:8)`;
      const signature = extractStackSignature(stack);
      expect(signature).not.toContain('45');
      expect(signature).not.toContain('123');
      expect(signature).toContain('processError');
      expect(signature).toContain('handleRequest');
    });

    it('should filter out node_modules frames', () => {
      const stack = `Error: test
    at processError (/app/src/handler.js:45:12)
    at someLib (/app/node_modules/some-lib/index.js:10:5)`;
      const signature = extractStackSignature(stack);
      expect(signature).toContain('processError');
      expect(signature).not.toContain('someLib');
    });

    it('should filter out node:internal frames', () => {
      const stack = `Error: test
    at Fetch.onAborted (node:internal/deps/undici/undici:11322:53)
    at processRequest (/app/src/api.js:100:20)`;
      const signature = extractStackSignature(stack);
      expect(signature).toContain('processRequest');
      expect(signature).not.toContain('onAborted');
      expect(signature).not.toContain('undici');
    });

    it('should handle minified/source-mapped traces', () => {
      const stack = `Error: test
    at a.b (/app/dist/bundle.min.js:1:12345)`;
      const signature = extractStackSignature(stack);
      expect(signature).toContain('bundle.min.js');
    });

    it('should return empty string for internal-only stacks', () => {
      const stack = `TypeError: terminated
    at Fetch.onAborted (node:internal/deps/undici/undici:11322:53)
    at Fetch.terminate (node:internal/deps/undici/undici:10480:14)`;
      const signature = extractStackSignature(stack);
      expect(signature).toBe('');
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

  describe('generateFingerprint - Golden Tests', () => {
    // Golden test: Mongoose warnings from different Lambda invocations must fingerprint the same
    describe('Mongoose duplicate-index warning fingerprint parity', () => {
      it('should produce same fingerprint for Mongoose warnings from different Lambda invocations', () => {
        // Real alert text example
        const alert1 =
          createAlert(`ERROR - 2026-02-27T16:17:39.204Z    0a01a9a9-3a1a-4345-99c4-1209472da1e7    ERROR    (node:2) [MONGOOSE] Warning: Duplicate schema index on {"promptId":1} found. This is often due to declaring an index using both "index: true" and "schema.index()". Please remove the duplicate index definition.
env: production source: AWS [AWS](https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#logEventViewer:group=%2Faws%2Flambda%2Fbike4mind-production-frontendServerUseast2Function-bnsdmfoh;stream=2026%2F02%2F27%2F...%5B%24LATEST%5De793dde82cee4953b6c3e317e1a09af2;start=1772209059204;end=1772209059204)`);

        // Same alert type, different log stream ID and timestamp
        const alert2 =
          createAlert(`ERROR - 2026-02-27T16:29:47.783Z    9eb727d6-1da8-4f04-805c-359249059ba7    ERROR    (node:2) [MONGOOSE] Warning: Duplicate schema index on {"promptId":1} found. This is often due to declaring an index using both "index: true" and "schema.index()". Please remove the duplicate index definition.
env: production source: AWS [AWS](https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#logEventViewer:group=%2Faws%2Flambda%2Fbike4mind-production-frontendServerUseast2Function-bnsdmfoh;stream=2026%2F02%2F27%2F...%5B%24LATEST%5D8e6bb2f1f136428784badf12ef764074;start=1772209787783;end=1772209787783)`);

        const fp1 = generateFingerprint(alert1);
        const fp2 = generateFingerprint(alert2);

        expect(fp1).not.toBeNull();
        expect(fp2).not.toBeNull();
        expect(fp1).toBe(fp2);
      });

      it('should produce same fingerprint for same error from different Lambda functions', () => {
        // Same Mongoose warning but from different Lambda functions (using real UUID format for request IDs)
        const alertFromFrontend =
          createAlert(`ERROR - 2026-02-27T16:17:39.204Z    a1b2c3d4-e5f6-7890-abcd-ef1234567890    ERROR    (node:2) [MONGOOSE] Warning: Duplicate schema index on {"promptId":1} found.
env: production source: AWS [AWS](https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#logEventViewer:group=%2Faws%2Flambda%2Fbike4mind-production-frontendServerUseast2Function-bnsdmfoh;stream=xyz)`);

        const alertFromQuest =
          createAlert(`ERROR - 2026-02-27T17:30:00.000Z    f1e2d3c4-b5a6-0987-fedc-ba9876543210    ERROR    (node:2) [MONGOOSE] Warning: Duplicate schema index on {"promptId":1} found.
env: production source: AWS [AWS](https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#logEventViewer:group=%2Faws%2Flambda%2Fbike4mind-production-QuestProcessorFunction-xdzezazr;stream=abc)`);

        expect(generateFingerprint(alertFromFrontend)).toBe(generateFingerprint(alertFromQuest));
      });

      it('should produce same fingerprint regardless of count/duration metadata', () => {
        const alert1 = createAlert(
          `ERROR - (node:2) [MONGOOSE] Warning: Duplicate schema index on {"promptId":1} found. count: 4 duration: 7m 6s`
        );
        const alert2 = createAlert(
          `ERROR - (node:2) [MONGOOSE] Warning: Duplicate schema index on {"promptId":1} found. count: 15 duration: 2h 30m 45s`
        );

        expect(generateFingerprint(alert1)).toBe(generateFingerprint(alert2));
      });
    });

    // Critical: these two alerts must produce the same fingerprint
    describe('undici "terminated" fingerprint parity across rejection wrappers', () => {
      const issue6886Alert = createAlert(`TypeError: terminated
        at Fetch.onAborted (node:internal/deps/undici/undici:11322:53)
        at Fetch.terminate (node:internal/deps/undici/undici:10480:14)
        at TLSSocket.<anonymous> (node:internal/deps/undici/undici:6433:16)`);

      const issue6892Alert = createAlert(`Runtime.UnhandledPromiseRejection: TypeError: terminated
        at Fetch.onAborted (node:internal/deps/undici/undici:11322:53)
        at Fetch.terminate (node:internal/deps/undici/undici:10480:14)
        at TLSSocket.<anonymous> (node:internal/deps/undici/undici:6433:16)`);

      it('should generate same fingerprint for alerts', () => {
        const fp6886 = generateFingerprint(issue6886Alert);
        const fp6892 = generateFingerprint(issue6892Alert);

        expect(fp6886).not.toBeNull();
        expect(fp6892).not.toBeNull();
        expect(fp6886).toBe(fp6892);
      });
    });

    // FALSE NEGATIVE prevention (same errors MUST match)
    describe('same errors must match', () => {
      it('should match errors differing only by timestamp', () => {
        const alert1 = createAlert('Error occurred at 2026-02-22T10:00:00Z in service');
        const alert2 = createAlert('Error occurred at 2026-02-23T14:30:00Z in service');

        expect(generateFingerprint(alert1)).toBe(generateFingerprint(alert2));
      });

      it('should match errors differing only by request ID', () => {
        const alert1 = createAlert('Request failed request_id: abc-123-def with MongoError: timeout');
        const alert2 = createAlert('Request failed request_id: xyz-789-uvw with MongoError: timeout');

        expect(generateFingerprint(alert1)).toBe(generateFingerprint(alert2));
      });

      it('should match errors differing only by user ID', () => {
        const alert1 = createAlert('User 507f1f77bcf86cd799439011 encountered error');
        const alert2 = createAlert('User 507f1f77bcf86cd799439022 encountered error');

        expect(generateFingerprint(alert1)).toBe(generateFingerprint(alert2));
      });

      it('should match errors differing only by port number', () => {
        const alert1 = createAlert('Connection to mongodb:27017 timed out');
        const alert2 = createAlert('Connection to mongodb:27018 timed out');

        expect(generateFingerprint(alert1)).toBe(generateFingerprint(alert2));
      });
    });

    // FALSE POSITIVE prevention (different errors must NOT match)
    describe('different errors must NOT match', () => {
      it('should NOT match "ValidationException: max_tokens" vs "ValidationException: invalid model"', () => {
        const alert1 = createAlert('ValidationException: max_tokens value exceeds limit');
        const alert2 = createAlert('ValidationException: invalid model identifier provided');

        expect(generateFingerprint(alert1)).not.toBe(generateFingerprint(alert2));
      });

      it('should NOT match same error type in different services', () => {
        const alert1 = createAlert(`TypeError: Cannot read property of undefined
    at MongoDBHandler.query (/app/src/db/mongo.js:45:12)`);
        const alert2 = createAlert(`TypeError: Cannot read property of undefined
    at RedisClient.get (/app/src/cache/redis.js:30:8)`);

        expect(generateFingerprint(alert1)).not.toBe(generateFingerprint(alert2));
      });

      it('should NOT match different root causes', () => {
        const alert1 = createAlert('MongoNetworkError: connection timed out');
        const alert2 = createAlert('MongoNetworkError: connection refused');

        expect(generateFingerprint(alert1)).not.toBe(generateFingerprint(alert2));
      });
    });

    // Fingerprint stability
    it('should generate deterministic fingerprints (no randomness)', () => {
      const alert = createAlert('TypeError: Some error occurred');

      const fp1 = generateFingerprint(alert);
      const fp2 = generateFingerprint(alert);
      const fp3 = generateFingerprint(alert);

      expect(fp1).toBe(fp2);
      expect(fp2).toBe(fp3);
    });

    it('should generate 40-character SHA-1 hash', () => {
      const alert = createAlert('TypeError: Some error occurred');
      const fp = generateFingerprint(alert);

      expect(fp).toHaveLength(40);
      expect(fp).toMatch(/^[a-f0-9]{40}$/);
    });

    // Tiered fingerprinting tests
    describe('tiered fingerprinting', () => {
      it('should use Tier 1 (full) when error type + stack trace present', () => {
        const alert = createAlert(`TypeError: Cannot read property 'foo' of undefined
    at processRequest (/app/src/handler.js:45:12)
    at handleError (/app/src/error.js:100:8)`);
        const fp = generateFingerprint(alert);

        expect(fp).not.toBeNull();
        expect(fp).toHaveLength(40);
      });

      it('should use Tier 2 (partial) when no stack trace but has error type', () => {
        // No stack trace, but has error type and sufficient message length (20+ chars)
        const alert = createAlert('MongoNetworkError: connection timed out after 30 seconds');
        const fp = generateFingerprint(alert);

        expect(fp).not.toBeNull();
        expect(fp).toHaveLength(40);
      });

      it('should produce different fingerprints for same error with/without stack trace', () => {
        // Same error message, but one has stack trace (Tier 1) and one doesn't (Tier 2)
        const withStack = createAlert(`TypeError: Cannot read property 'x' of undefined
    at handler (/app/src/api.js:10:5)`);
        const withoutStack = createAlert("TypeError: Cannot read property 'x' of undefined");

        const fpWithStack = generateFingerprint(withStack);
        const fpWithoutStack = generateFingerprint(withoutStack);

        expect(fpWithStack).not.toBeNull();
        expect(fpWithoutStack).not.toBeNull();
        // They should be different because Tier 1 includes stack signature, Tier 2 doesn't
        expect(fpWithStack).not.toBe(fpWithoutStack);
      });

      it('should use Tier 3 (fallback) for short messages without error type', () => {
        // No error type, short but valid message (10-19 chars after normalization)
        const alert = createAlert('Short error msg');
        const fp = generateFingerprint(alert);

        expect(fp).not.toBeNull();
        expect(fp).toHaveLength(40);
      });

      it('should return null for very short messages (< 10 chars)', () => {
        const alert = createAlert('fail');
        const fp = generateFingerprint(alert);

        expect(fp).toBeNull();
      });

      it('should return null for empty alert text', () => {
        const alert = createAlert('');
        const fp = generateFingerprint(alert);

        expect(fp).toBeNull();
      });

      it('should use Tier 2 for messages with only node_modules stack frames', () => {
        // Stack trace exists but all frames are filtered out (node_modules only)
        const alert = createAlert(`MongoServerError: E11000 duplicate key error
    at someLib (/app/node_modules/mongoose/lib/model.js:45:12)
    at anotherLib (/app/node_modules/mongodb/lib/core.js:100:8)`);
        const fp = generateFingerprint(alert);

        expect(fp).not.toBeNull();
        // This should still produce a fingerprint via Tier 2 (since stack signature will be empty after filtering)
      });
    });
  });

  describe('generateFingerprintFromIssueBody', () => {
    it('should extract fingerprint-relevant data from issue body', () => {
      const issueBody = `## Error Details
MongoServerError: E11000 duplicate key error
at insertDocument (/app/src/db.js:45:12)`;

      const fp = generateFingerprintFromIssueBody(issueBody);
      expect(fp).not.toBeNull();
      expect(fp).toHaveLength(40);
    });

    it('should handle issues without stack traces', () => {
      const issueBody = `## Error Details
Connection timeout to service after 30 seconds`;

      const fp = generateFingerprintFromIssueBody(issueBody);
      expect(fp).not.toBeNull();
    });

    it('should return null for empty body', () => {
      expect(generateFingerprintFromIssueBody('')).toBeNull();
      expect(generateFingerprintFromIssueBody(null)).toBeNull();
      expect(generateFingerprintFromIssueBody(undefined)).toBeNull();
    });
  });

  describe('extractFingerprintFromIssueBody', () => {
    it('should extract fingerprint from HTML comment', () => {
      const body = `Some content
<!-- fingerprint:a1b2c3d4e5f6789012345678901234567890abcd -->
More content`;

      expect(extractFingerprintFromIssueBody(body)).toBe('a1b2c3d4e5f6789012345678901234567890abcd');
    });

    it('should return null if no fingerprint comment', () => {
      const body = 'Some content without fingerprint';
      expect(extractFingerprintFromIssueBody(body)).toBeNull();
    });

    it('should return null for malformed fingerprint', () => {
      const body = '<!-- fingerprint:short -->';
      expect(extractFingerprintFromIssueBody(body)).toBeNull();
    });

    it('should handle case-insensitive matching', () => {
      const body = '<!-- FINGERPRINT:a1b2c3d4e5f6789012345678901234567890abcd -->';
      expect(extractFingerprintFromIssueBody(body)).toBe('a1b2c3d4e5f6789012345678901234567890abcd');
    });
  });

  describe('formatFingerprintComment', () => {
    it('should format fingerprint as HTML comment', () => {
      const fp = 'a1b2c3d4e5f6789012345678901234567890abcd';
      expect(formatFingerprintComment(fp)).toBe('<!-- fingerprint:a1b2c3d4e5f6789012345678901234567890abcd -->');
    });
  });

  // Title-based matching tests

  describe('normalizeTitle', () => {
    it('should remove [LiveOps] prefix', () => {
      expect(normalizeTitle('[LiveOps] Some error title')).toBe('some error title');
    });

    it('should handle [liveops] prefix case-insensitively', () => {
      expect(normalizeTitle('[liveops] Some error title')).toBe('some error title');
      expect(normalizeTitle('[LIVEOPS] Some error title')).toBe('some error title');
    });

    it('should replace occurrence counts', () => {
      expect(normalizeTitle('Error with 5 occurrences')).toBe('error with <COUNT>');
      expect(normalizeTitle('Error happened 12 times')).toBe('error happened <COUNT>');
      expect(normalizeTitle('Found 100 errors in log')).toBe('found <COUNT> in log');
    });

    it('should replace dates', () => {
      expect(normalizeTitle('Error on 2026-03-03')).toBe('error on <DATE>');
    });

    it('should collapse whitespace', () => {
      expect(normalizeTitle('Error   with   spaces')).toBe('error with spaces');
    });

    it('should lowercase', () => {
      expect(normalizeTitle('TypeError: SOMETHING FAILED')).toBe('typeerror: something failed');
    });
  });

  describe('jaroWinklerSimilarity', () => {
    it('should return 1 for identical strings', () => {
      expect(jaroWinklerSimilarity('hello', 'hello')).toBe(1);
    });

    it('should return 0 for completely different strings', () => {
      expect(jaroWinklerSimilarity('abc', 'xyz')).toBe(0);
    });

    it('should return 0 for empty strings', () => {
      expect(jaroWinklerSimilarity('', 'hello')).toBe(0);
      expect(jaroWinklerSimilarity('hello', '')).toBe(0);
    });

    it('should handle prefix similarity well', () => {
      // Jaro-Winkler should give bonus for common prefix
      const sim = jaroWinklerSimilarity('TypeError: foo', 'TypeError: bar');
      expect(sim).toBeGreaterThan(0.7);
    });

    it('should be symmetric', () => {
      const sim1 = jaroWinklerSimilarity('hello', 'hallo');
      const sim2 = jaroWinklerSimilarity('hallo', 'hello');
      expect(sim1).toBeCloseTo(sim2, 5);
    });
  });

  describe('calculateTitleSimilarity', () => {
    it('should return 1 for identical titles (after normalization)', () => {
      expect(calculateTitleSimilarity('[LiveOps] Some error', '[liveops] Some error')).toBe(1);
    });

    it('should handle titles with different occurrence counts', () => {
      const sim = calculateTitleSimilarity('[LiveOps] Error occurred 5 times', '[LiveOps] Error occurred 100 times');
      expect(sim).toBe(1); // Should be identical after normalization
    });

    it('should return high similarity for very similar titles', () => {
      const sim = calculateTitleSimilarity(
        '[LiveOps] Mongoose duplicate schema index warning on questId field',
        '[LiveOps] Mongoose duplicate schema index warning on questId field'
      );
      expect(sim).toBe(1);
    });

    it('should return lower similarity for different error types', () => {
      const sim = calculateTitleSimilarity(
        '[LiveOps] TypeError: Cannot read property of undefined',
        '[LiveOps] MongoError: Connection timeout'
      );
      expect(sim).toBeLessThan(0.7);
    });
  });

  describe('findBestTitleMatch', () => {
    const existingIssues = [
      { number: 1, title: '[LiveOps] TypeError: Cannot read property foo', state: 'open' },
      { number: 2, title: '[LiveOps] MongoError: Connection timeout', state: 'open' },
      {
        number: 3,
        title: '[LiveOps] Mongoose duplicate schema index warning on questId',
        state: 'closed',
        closedAt: '2026-03-01T00:00:00Z',
      },
    ];

    it('should find exact match', () => {
      const result = findBestTitleMatch('[LiveOps] Mongoose duplicate schema index warning on questId', existingIssues);
      expect(result).not.toBeNull();
      expect(result!.issue.number).toBe(3);
      expect(result!.similarity).toBe(1);
    });

    it('should find close match above threshold', () => {
      const result = findBestTitleMatch(
        '[LiveOps] Mongoose duplicate schema index warning on questId field',
        existingIssues,
        { threshold: 0.85 } // Lower threshold to allow match
      );
      expect(result).not.toBeNull();
      expect(result!.issue.number).toBe(3);
    });

    it('should return null for no match above threshold', () => {
      const result = findBestTitleMatch('[LiveOps] Completely different error type', existingIssues);
      expect(result).toBeNull();
    });

    it('should return null for short titles', () => {
      const result = findBestTitleMatch('[LiveOps] Error', existingIssues, { minLength: 40 });
      expect(result).toBeNull();
    });

    it('should return best match when multiple similar', () => {
      const issues = [
        { number: 1, title: '[LiveOps] Error in service A', state: 'open' },
        { number: 2, title: '[LiveOps] Error in service B', state: 'open' },
        { number: 3, title: '[LiveOps] Error in service A handler', state: 'open' },
      ];
      const result = findBestTitleMatch(
        '[LiveOps] Error in service A',
        issues,
        { threshold: 0.8, minLength: 10 } // Lower minLength since test titles are short
      );
      expect(result).not.toBeNull();
      expect(result!.issue.number).toBe(1); // Exact match
    });
  });

  // Golden test for the actual duplicate issue scenario
  describe('Title matching - Golden test', () => {
    it('should match titles (the original bug scenario)', () => {
      const title7054 = '[LiveOps] Mongoose duplicate schema index warning on questId field';
      const title7071 = '[LiveOps] Mongoose duplicate schema index warning on questId field';

      const sim = calculateTitleSimilarity(title7054, title7071);
      expect(sim).toBe(1);

      const existingIssues = [{ number: 7054, title: title7054, state: 'closed', closedAt: '2026-03-03T05:38:28Z' }];

      const match = findBestTitleMatch(title7071, existingIssues, { threshold: 0.9 });
      expect(match).not.toBeNull();
      expect(match!.issue.number).toBe(7054);
    });

    it('should match similar titles with slight variations', () => {
      // Realistic scenario: titles may have slight differences in wording
      const existingTitle = '[LiveOps] MongoNetworkError: connection timed out to cluster0.mongodb.net';
      const newTitle = '[LiveOps] MongoNetworkError: connection timeout to cluster0.mongodb.net';

      const sim = calculateTitleSimilarity(existingTitle, newTitle);
      expect(sim).toBeGreaterThan(0.9); // Should still match despite "timed out" vs "timeout"

      const existingIssues = [{ number: 100, title: existingTitle, state: 'open' }];
      const match = findBestTitleMatch(newTitle, existingIssues, { threshold: 0.9 });
      expect(match).not.toBeNull();
    });
  });

  // Semantic fingerprinting tests

  describe('extractCoreErrorMessage', () => {
    it('should strip Runtime wrapper', () => {
      const result = extractCoreErrorMessage('Runtime.UnhandledPromiseRejection: TypeError: test');
      expect(result).not.toContain('Runtime.UnhandledPromiseRejection');
    });

    it('should extract first line only', () => {
      const multiLine = `MongoError: Connection failed
        at connect (/app/src/db.js:10:5)
        at handler (/app/src/api.js:20:10)`;
      const result = extractCoreErrorMessage(multiLine);
      expect(result).not.toContain('connect');
      expect(result).not.toContain('/app');
    });

    it('should normalize connection targets', () => {
      const result = extractCoreErrorMessage('MongoNetworkError: connection timed out to cluster0.mongodb.net:27017');
      expect(result).toContain('<TARGET>');
      expect(result).not.toContain('cluster0.mongodb.net');
    });

    it('should normalize model names', () => {
      const result = extractCoreErrorMessage('ValidationException: Invalid model model=anthropic.claude-3');
      expect(result).toContain('model=<MODEL>');
      expect(result).not.toContain('anthropic.claude-3');
    });

    it('should normalize property/key references', () => {
      const result = extractCoreErrorMessage("TypeError: Cannot read property 'foo' of undefined");
      expect(result).toContain('<KEY>');
      expect(result).not.toContain("'foo'");
    });
  });

  describe('generateSemanticFingerprint', () => {
    it('should generate 40-char SHA-1 hash', () => {
      const alert = createAlert('TypeError: Some error occurred in the application');
      const fp = generateSemanticFingerprint(alert);
      expect(fp).not.toBeNull();
      expect(fp).toHaveLength(40);
      expect(fp).toMatch(/^[a-f0-9]{40}$/);
    });

    it('should return null for short messages', () => {
      const alert = createAlert('Error');
      const fp = generateSemanticFingerprint(alert);
      expect(fp).toBeNull();
    });

    it('should enforce 15-character minimum boundary', () => {
      // Core message after extraction must be at least 15 chars
      const alertShort = createAlert('TypeError: abc'); // Short core message
      const alertLong = createAlert('TypeError: This is a longer error message'); // Long enough

      const fpShort = generateSemanticFingerprint(alertShort);
      const fpLong = generateSemanticFingerprint(alertLong);

      // Short messages should return null, longer ones should return fingerprint
      expect(fpShort).toBeNull();
      expect(fpLong).not.toBeNull();
      expect(fpLong).toHaveLength(40);
    });

    it('should produce same fingerprint for same core error with different variable context', () => {
      const alert1 = createAlert('MongoNetworkError: connection timed out to cluster1.mongodb.net:27017');
      const alert2 = createAlert('MongoNetworkError: connection timed out to cluster2.mongodb.net:27018');

      const fp1 = generateSemanticFingerprint(alert1);
      const fp2 = generateSemanticFingerprint(alert2);

      expect(fp1).toBe(fp2);
    });

    it('should produce different fingerprints for different error types', () => {
      const alert1 = createAlert('TypeError: Cannot read property of undefined');
      const alert2 = createAlert('MongoError: Connection timeout error');

      const fp1 = generateSemanticFingerprint(alert1);
      const fp2 = generateSemanticFingerprint(alert2);

      expect(fp1).not.toBe(fp2);
    });

    it('should produce different fingerprints for same error type but different messages', () => {
      const alert1 = createAlert('TypeError: Cannot read property of undefined');
      const alert2 = createAlert('TypeError: Failed to fetch resource');

      const fp1 = generateSemanticFingerprint(alert1);
      const fp2 = generateSemanticFingerprint(alert2);

      expect(fp1).not.toBe(fp2);
    });
  });

  // Golden test for semantic fingerprinting
  describe('Semantic fingerprinting - Golden test', () => {
    it('should produce same semantic fingerprint for the mongoose warning with different CloudWatch URLs', () => {
      // Real alert texts that have different exact fingerprints but same semantic fingerprint
      const alert1 = createAlert(
        `ERROR - 2026-03-02T19:27:40Z (node:2) [MONGOOSE] Warning: Duplicate schema index on {"questId":1} found.
env: production source: AWS [AWS](https://console.aws.amazon.com/cloudwatch/...stream=2026%2F03%2F02%2F...%5Be793dde82cee4953b6c3e317e1a09af2)`
      );
      const alert2 = createAlert(
        `ERROR - 2026-03-03T02:01:13Z (node:2) [MONGOOSE] Warning: Duplicate schema index on {"questId":1} found.
env: production source: AWS [AWS](https://console.aws.amazon.com/cloudwatch/...stream=2026%2F03%2F03%2F...%5B8e6bb2f1f136428784badf12ef764074)`
      );

      const sfp1 = generateSemanticFingerprint(alert1);
      const sfp2 = generateSemanticFingerprint(alert2);

      expect(sfp1).not.toBeNull();
      expect(sfp2).not.toBeNull();
      expect(sfp1).toBe(sfp2);
    });
  });

  // Tests for semantic fingerprint formatting and extraction
  describe('formatSemanticFingerprintComment', () => {
    it('should format semantic fingerprint as HTML comment', () => {
      const result = formatSemanticFingerprintComment('abc123def456abc123def456abc123def456abc1');
      expect(result).toBe('<!-- semantic-fingerprint:abc123def456abc123def456abc123def456abc1 -->');
    });
  });

  describe('extractSemanticFingerprintFromIssueBody', () => {
    it('should extract semantic fingerprint from issue body', () => {
      const body = `## Error Details
Some error happened

<!-- fingerprint:1234567890123456789012345678901234567890 -->
<!-- semantic-fingerprint:abcdef1234567890abcdef1234567890abcdef12 -->`;

      const result = extractSemanticFingerprintFromIssueBody(body);
      expect(result).toBe('abcdef1234567890abcdef1234567890abcdef12');
    });

    it('should return null if no semantic fingerprint found', () => {
      const body = `## Error Details
Some error happened

<!-- fingerprint:1234567890123456789012345678901234567890 -->`;

      const result = extractSemanticFingerprintFromIssueBody(body);
      expect(result).toBeNull();
    });

    it('should return null for null/undefined body', () => {
      expect(extractSemanticFingerprintFromIssueBody(null)).toBeNull();
      expect(extractSemanticFingerprintFromIssueBody(undefined)).toBeNull();
    });
  });
});
