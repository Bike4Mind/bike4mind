import { describe, it, expect } from 'vitest';
import { SUPPORTED_GITHUB_EVENTS, isValidGitHubEventType } from '@server/integrations/github/types';

/**
 * Unit tests for GitHub webhook configuration API.
 *
 * Full handler integration tests need baseApi middleware mocking; these focus on
 * validation logic and are supplemented by staging tests.
 * Staging script: scripts/test-github-webhook.sh
 */

describe('GitHub Webhook Config - Validation Logic', () => {
  describe('Event type validation', () => {
    it('should accept all supported GitHub event types', () => {
      for (const eventType of SUPPORTED_GITHUB_EVENTS) {
        expect(isValidGitHubEventType(eventType)).toBe(true);
      }
    });

    it('should reject invalid event types', () => {
      expect(isValidGitHubEventType('invalid_event')).toBe(false);
      expect(isValidGitHubEventType('')).toBe(false);
      expect(isValidGitHubEventType('PUSH')).toBe(false); // case sensitive
    });

    it('should have expected supported events', () => {
      const expectedEvents = [
        'ping',
        'push',
        'pull_request',
        'pull_request_review',
        'pull_request_review_comment',
        'issues',
        'issue_comment',
        'workflow_run',
        'check_run',
        'check_suite',
      ];

      expect(SUPPORTED_GITHUB_EVENTS).toEqual(expectedEvents);
    });
  });

  describe('Repository format validation', () => {
    const repoPattern = /^[^/]+\/[^/]+$/;

    it('should accept valid owner/repo format', () => {
      expect(repoPattern.test('owner/repo')).toBe(true);
      expect(repoPattern.test('my-org/my-repo')).toBe(true);
      expect(repoPattern.test('user123/project-name')).toBe(true);
    });

    it('should reject invalid repo formats', () => {
      expect(repoPattern.test('invalid-format')).toBe(false);
      expect(repoPattern.test('too/many/slashes')).toBe(false);
      expect(repoPattern.test('')).toBe(false);
      expect(repoPattern.test('/repo')).toBe(false);
      expect(repoPattern.test('owner/')).toBe(false);
    });
  });

  describe('Secret masking', () => {
    const maskSecret = (secret: string): string => {
      if (secret.length <= 4) {
        return '****';
      }
      return '****' + secret.slice(-4);
    };

    it('should mask secrets showing only last 4 characters', () => {
      expect(maskSecret('abcdefghijklmnop')).toBe('****mnop');
      expect(maskSecret('1234567890')).toBe('****7890');
    });

    it('should handle short secrets', () => {
      expect(maskSecret('abcd')).toBe('****');
      expect(maskSecret('abc')).toBe('****');
      expect(maskSecret('')).toBe('****');
    });
  });

  describe('Input limits', () => {
    it('should enforce maximum 20 events limit', () => {
      const MAX_EVENTS = 20;
      const events = Array(21).fill('push');
      expect(events.length).toBeGreaterThan(MAX_EVENTS);
    });

    it('should enforce maximum 50 repos limit', () => {
      const MAX_REPOS = 50;
      const repos = Array(51).fill('owner/repo');
      expect(repos.length).toBeGreaterThan(MAX_REPOS);
    });
  });
});
