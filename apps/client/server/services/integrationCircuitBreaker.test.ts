/**
 * Tests for integrationCircuitBreaker service
 *
 * Covers: cache behavior, manual override priority, configMissing filtering,
 * auto-trip logic, MCP server mapping, Atlassian both-down logic, clearCache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Hoisted mocks ---
const { mockOverrideRepo, mockHealthCheckRepo } = vi.hoisted(() => ({
  mockOverrideRepo: {
    getOverride: vi.fn(),
  },
  mockHealthCheckRepo: {
    getLastNChecks: vi.fn(),
  },
}));

vi.mock('@bike4mind/database', () => ({
  integrationCircuitOverrideRepository: mockOverrideRepo,
  integrationHealthCheckRepository: mockHealthCheckRepo,
  INTEGRATION_HEALTH_THRESHOLDS: {
    FAILURE_ALERT_THRESHOLD: 3,
  },
}));

vi.mock('@bike4mind/common', () => ({
  McpServerName: {
    Github: 'github',
    Atlassian: 'atlassian',
  },
}));

import {
  isAvailable,
  getUnavailableReason,
  getStatus,
  isMcpServerAvailable,
  clearCache,
} from './integrationCircuitBreaker';

// Helper to create mock health check records
function makeCheck(
  overrides: {
    status?: string;
    configMissing?: boolean;
    error?: string;
  } = {}
) {
  return {
    status: overrides.status ?? 'healthy',
    configMissing: overrides.configMissing ?? false,
    error: overrides.error ?? null,
  };
}

describe('integrationCircuitBreaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache(); // Always start with a clean cache
  });

  afterEach(() => {
    clearCache();
  });

  describe('manual override priority', () => {
    it('should block when force_block override is set', async () => {
      mockOverrideRepo.getOverride.mockResolvedValue({
        mode: 'force_block',
        reason: 'maintenance window',
      });

      const available = await isAvailable('github');
      expect(available).toBe(false);

      const reason = await getUnavailableReason('github');
      expect(reason).toContain('manually blocked');
      expect(reason).toContain('maintenance window');
    });

    it('should allow when force_open override is set, even with failures', async () => {
      mockOverrideRepo.getOverride.mockResolvedValue({
        mode: 'force_open',
      });

      // These shouldn't even be called since force_open takes priority
      const available = await isAvailable('slack');
      expect(available).toBe(true);
      expect(mockHealthCheckRepo.getLastNChecks).not.toHaveBeenCalled();
    });

    it('should fall through to auto detection when no override exists', async () => {
      mockOverrideRepo.getOverride.mockResolvedValue(null);
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'healthy' }),
      ]);

      const available = await isAvailable('github');
      expect(available).toBe(true);
      expect(mockHealthCheckRepo.getLastNChecks).toHaveBeenCalled();
    });

    it('should fall through to auto detection when override mode is auto', async () => {
      mockOverrideRepo.getOverride.mockResolvedValue({ mode: 'auto' });
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'healthy' }),
      ]);

      const available = await isAvailable('jira');
      expect(available).toBe(true);
      expect(mockHealthCheckRepo.getLastNChecks).toHaveBeenCalled();
    });
  });

  describe('auto-trip detection', () => {
    beforeEach(() => {
      mockOverrideRepo.getOverride.mockResolvedValue(null);
    });

    it('should trip when 3 consecutive checks are unhealthy', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'unhealthy', error: 'HTTP 500' }),
        makeCheck({ status: 'unhealthy', error: 'HTTP 502' }),
        makeCheck({ status: 'unhealthy', error: 'HTTP 503' }),
      ]);

      const available = await isAvailable('github');
      expect(available).toBe(false);

      clearCache();
      const reason = await getUnavailableReason('github');
      expect(reason).toContain('consecutive failures');
      expect(reason).toContain('HTTP 500');
    });

    it('should not trip when some checks are healthy', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'unhealthy' }),
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'unhealthy' }),
      ]);

      const available = await isAvailable('slack');
      expect(available).toBe(true);
    });

    it('should not trip when all checks are degraded (not unhealthy)', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'degraded' }),
        makeCheck({ status: 'degraded' }),
        makeCheck({ status: 'degraded' }),
      ]);

      const available = await isAvailable('jira');
      expect(available).toBe(true);
    });

    it('should be available when fewer than threshold checks exist', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'unhealthy' }),
        makeCheck({ status: 'unhealthy' }),
      ]);

      const available = await isAvailable('confluence');
      expect(available).toBe(true);
    });

    it('should be available when no checks exist at all', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([]);

      const available = await isAvailable('github');
      expect(available).toBe(true);
    });
  });

  describe('configMissing filtering', () => {
    beforeEach(() => {
      mockOverrideRepo.getOverride.mockResolvedValue(null);
    });

    it('should not trip when all failures are configMissing', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'unhealthy', configMissing: true }),
        makeCheck({ status: 'unhealthy', configMissing: true }),
        makeCheck({ status: 'unhealthy', configMissing: true }),
      ]);

      const available = await isAvailable('github');
      expect(available).toBe(true);
    });

    it('should not trip when configMissing records reduce count below threshold', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'unhealthy', configMissing: false }),
        makeCheck({ status: 'unhealthy', configMissing: true }),
        makeCheck({ status: 'unhealthy', configMissing: false }),
      ]);

      // Only 2 real API failures (below threshold of 3)
      const available = await isAvailable('slack');
      expect(available).toBe(true);
    });

    it('should trip when enough non-configMissing failures exist', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'unhealthy', configMissing: false, error: 'HTTP 500' }),
        makeCheck({ status: 'unhealthy', configMissing: false, error: 'HTTP 502' }),
        makeCheck({ status: 'unhealthy', configMissing: false, error: 'timeout' }),
      ]);

      const available = await isAvailable('jira');
      expect(available).toBe(false);
    });
  });

  describe('cache behavior', () => {
    beforeEach(() => {
      mockOverrideRepo.getOverride.mockResolvedValue(null);
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'healthy' }),
      ]);
    });

    it('should use cache on second call within TTL', async () => {
      await isAvailable('github');
      await isAvailable('github');

      // DB should only be called once (first call populates cache)
      expect(mockOverrideRepo.getOverride).toHaveBeenCalledTimes(1);
      expect(mockHealthCheckRepo.getLastNChecks).toHaveBeenCalledTimes(1);
    });

    it('should not share cache between different integrations', async () => {
      await isAvailable('github');
      await isAvailable('slack');

      expect(mockOverrideRepo.getOverride).toHaveBeenCalledTimes(2);
    });

    it('should refresh after clearCache is called', async () => {
      await isAvailable('github');
      clearCache('github');
      await isAvailable('github');

      expect(mockOverrideRepo.getOverride).toHaveBeenCalledTimes(2);
    });

    it('should clear all integrations when clearCache is called without args', async () => {
      await isAvailable('github');
      await isAvailable('slack');
      clearCache();
      await isAvailable('github');
      await isAvailable('slack');

      expect(mockOverrideRepo.getOverride).toHaveBeenCalledTimes(4);
    });
  });

  describe('getStatus', () => {
    it('should return full status with mode and autoTripped for auto-tripped', async () => {
      mockOverrideRepo.getOverride.mockResolvedValue(null);
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'unhealthy', error: 'HTTP 500' }),
        makeCheck({ status: 'unhealthy', error: 'HTTP 500' }),
        makeCheck({ status: 'unhealthy', error: 'HTTP 500' }),
      ]);

      const status = await getStatus('github');
      expect(status.available).toBe(false);
      expect(status.mode).toBe('auto');
      expect(status.autoTripped).toBe(true);
      expect(status.reason).toContain('consecutive failures');
    });

    it('should return force_block status', async () => {
      mockOverrideRepo.getOverride.mockResolvedValue({ mode: 'force_block', reason: 'outage' });

      const status = await getStatus('slack');
      expect(status.available).toBe(false);
      expect(status.mode).toBe('force_block');
      expect(status.autoTripped).toBe(false);
    });

    it('should return force_open status', async () => {
      mockOverrideRepo.getOverride.mockResolvedValue({ mode: 'force_open' });

      const status = await getStatus('jira');
      expect(status.available).toBe(true);
      expect(status.mode).toBe('force_open');
      expect(status.autoTripped).toBe(false);
    });
  });

  describe('isMcpServerAvailable', () => {
    beforeEach(() => {
      mockOverrideRepo.getOverride.mockResolvedValue(null);
    });

    it('should return available for unknown MCP servers (no health probes)', async () => {
      const result = await isMcpServerAvailable('linkedin');
      expect(result.available).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('should check github integration for github MCP server', async () => {
      mockHealthCheckRepo.getLastNChecks.mockResolvedValue([
        makeCheck({ status: 'unhealthy', error: 'HTTP 500' }),
        makeCheck({ status: 'unhealthy', error: 'HTTP 500' }),
        makeCheck({ status: 'unhealthy', error: 'HTTP 500' }),
      ]);

      const result = await isMcpServerAvailable('github');
      expect(result.available).toBe(false);
      expect(result.reason).toContain('github');
    });

    it('should allow atlassian when only jira is down but confluence is up', async () => {
      // First call for jira - down
      mockHealthCheckRepo.getLastNChecks.mockResolvedValueOnce([
        makeCheck({ status: 'unhealthy' }),
        makeCheck({ status: 'unhealthy' }),
        makeCheck({ status: 'unhealthy' }),
      ]);
      mockOverrideRepo.getOverride.mockResolvedValueOnce(null); // jira override

      // Second call for confluence - up
      mockHealthCheckRepo.getLastNChecks.mockResolvedValueOnce([
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'healthy' }),
        makeCheck({ status: 'healthy' }),
      ]);
      mockOverrideRepo.getOverride.mockResolvedValueOnce(null); // confluence override

      const result = await isMcpServerAvailable('atlassian');
      expect(result.available).toBe(true);
    });

    it('should block atlassian when both jira and confluence are down', async () => {
      // jira - down
      mockOverrideRepo.getOverride.mockResolvedValueOnce(null);
      mockHealthCheckRepo.getLastNChecks.mockResolvedValueOnce([
        makeCheck({ status: 'unhealthy', error: 'jira down' }),
        makeCheck({ status: 'unhealthy', error: 'jira down' }),
        makeCheck({ status: 'unhealthy', error: 'jira down' }),
      ]);

      // confluence - down
      mockOverrideRepo.getOverride.mockResolvedValueOnce(null);
      mockHealthCheckRepo.getLastNChecks.mockResolvedValueOnce([
        makeCheck({ status: 'unhealthy', error: 'confluence down' }),
        makeCheck({ status: 'unhealthy', error: 'confluence down' }),
        makeCheck({ status: 'unhealthy', error: 'confluence down' }),
      ]);

      const result = await isMcpServerAvailable('atlassian');
      expect(result.available).toBe(false);
      expect(result.reason).toContain('Atlassian');
    });
  });
});
