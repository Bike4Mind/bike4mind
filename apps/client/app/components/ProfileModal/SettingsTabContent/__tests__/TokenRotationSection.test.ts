import { describe, it, expect } from 'vitest';
import { buildRows } from '../tokenRotationUtils';

/**
 * Tests for TokenRotationSection logic via the exported buildRows helper.
 */

describe('TokenRotationSection logic', () => {
  describe('integration row building', () => {
    it('should mark all as disconnected when user has no integrations', () => {
      const rows = buildRows({}, false, false);
      expect(rows.every(r => !r.isConnected)).toBe(true);
    });

    it('should detect GitHub connection from status query', () => {
      const rows = buildRows({}, true, false);
      expect(rows.find(r => r.integration === 'github')?.isConnected).toBe(true);
    });

    it('should mark GitHub as disconnected when status query errors', () => {
      const rows = buildRows({}, true, true);
      expect(rows.find(r => r.integration === 'github')?.isConnected).toBe(false);
    });

    it('should detect Atlassian connection', () => {
      const rows = buildRows({ atlassianConnect: { status: 'connected' } }, false, false);
      expect(rows.find(r => r.integration === 'atlassian')?.isConnected).toBe(true);
    });

    it('should show Atlassian as connected even with needs_reconnect status', () => {
      const rows = buildRows({ atlassianConnect: { status: 'needs_reconnect' } }, false, false);
      expect(rows.find(r => r.integration === 'atlassian')?.isConnected).toBe(true);
    });

    it('should detect Slack connection', () => {
      const rows = buildRows({ slackSettings: { slackUserId: 'U123' } }, false, false);
      expect(rows.find(r => r.integration === 'slack')?.isConnected).toBe(true);
    });

    it('should not detect Slack with empty slackUserId', () => {
      const rows = buildRows({ slackSettings: {} }, false, false);
      expect(rows.find(r => r.integration === 'slack')?.isConnected).toBe(false);
    });

    it('should include rotation timestamps', () => {
      const date = new Date('2024-06-15');
      const rows = buildRows(
        {
          integrationRotation: {
            github: { lastRotationInitiatedAt: date, lastRotationReason: 'manual_rotation' },
          },
        },
        true,
        false
      );
      expect(rows.find(r => r.integration === 'github')?.lastRotationInitiatedAt).toEqual(date);
      expect(rows.find(r => r.integration === 'atlassian')?.lastRotationInitiatedAt).toBeUndefined();
    });
  });

  describe('connected count', () => {
    it('should count all connected integrations', () => {
      const rows = buildRows(
        { atlassianConnect: { status: 'connected' }, slackSettings: { slackUserId: 'U123' } },
        true,
        false
      );
      expect(rows.filter(r => r.isConnected).length).toBe(3);
    });

    it('should return 0 when none connected', () => {
      const rows = buildRows({}, false, false);
      expect(rows.filter(r => r.isConnected).length).toBe(0);
    });
  });

  describe('ROTATABLE_INTEGRATIONS shared constant', () => {
    it('should produce rows for all rotatable integrations', () => {
      const rows = buildRows({}, false, false);
      expect(rows.map(r => r.integration)).toEqual(['github', 'atlassian', 'slack']);
    });
  });
});
