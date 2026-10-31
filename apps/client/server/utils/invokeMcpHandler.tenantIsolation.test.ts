/**
 * Two-tenant isolation through invokeMcpHandler with the real in-process breakers and the real
 * rate-limit snapshot store logic (backed by an in-memory repository): one tenant tripping its
 * breaker or exhausting its rate limit must not affect another tenant's calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type StoredSnapshot = {
  integration: string;
  userId: string;
  usagePercent: number | null;
  resetAt: Date | null;
};

const { snapshots, mockLocalMcpHandler } = vi.hoisted(() => ({
  snapshots: [] as StoredSnapshot[],
  mockLocalMcpHandler: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/services/integrationCircuitBreaker', () => ({
  isMcpServerAvailable: vi.fn().mockResolvedValue({ available: true, reason: null }),
}));

vi.mock('@bike4mind/server-utils/utils/mcpCall', () => ({
  handler: mockLocalMcpHandler,
}));

vi.mock('sst', () => ({
  Resource: { mcpHandler: { name: '' } },
}));

vi.mock('@bike4mind/database', () => ({
  rateLimitSnapshotRepository: {
    create: vi.fn(async (doc: StoredSnapshot) => {
      snapshots.push(doc);
      return doc;
    }),
    getLatestByIntegration: vi.fn(async (integration: string, userId: string) => {
      const matching = snapshots.filter(s => s.integration === integration && s.userId === userId);
      return matching.at(-1) ?? null;
    }),
  },
  INTEGRATION_AUDIT_INTEGRATION_NAMES: [],
}));

vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  recordRateLimitEvent: vi.fn().mockResolvedValue(undefined),
  recordCircuitBreakerRejection: vi.fn().mockResolvedValue(undefined),
  recordCircuitBreakerTransition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: { create: vi.fn() },
}));

vi.stubEnv('IS_LOCAL', 'true');

import { invokeMcpHandler } from './invokeMcpHandler';
import { UNATTRIBUTED_MCP_TENANT } from '@bike4mind/server-utils/utils/mcpTenantKey';

// A github record whose server can start; one without a token is refused before any invoke.
const GITHUB_ENV = [{ key: 'GITHUB_ACCESS_TOKEN', value: 'test-token' }];

type Payload = Parameters<typeof invokeMcpHandler>[0];

const RESET_IN_MS = 5_000;

function callAs(userId: string | undefined, server: string): Promise<unknown> {
  return invokeMcpHandler({
    name: server,
    action: 'callTool',
    toolName: 'get_issue',
    userId,
    envVariables: GITHUB_ENV,
  } as Payload);
}

/** Fail every call for one tenant with an outage-class error, succeed for everyone else. */
function failCallsFor(failingUserId: string): void {
  mockLocalMcpHandler.mockImplementation(async (payload: Payload) => {
    if (payload.userId === failingUserId) throw new Error('ECONNRESET');
    return { ok: true };
  });
}

async function tripBreakerFor(userId: string, server: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const error = await callAs(userId, server).catch((e: unknown) => e);
    if (error instanceof Error && error.message.includes('temporarily unavailable')) return;
  }
  throw new Error(`breaker for ${userId} never opened`);
}

describe('invokeMcpHandler tenant isolation', () => {
  beforeEach(() => {
    snapshots.length = 0;
    mockLocalMcpHandler.mockReset();
  });

  describe('in-process circuit breaker', () => {
    it("keeps tenant B's calls flowing after tenant A trips the breaker", async () => {
      failCallsFor('tenant-a');
      await tripBreakerFor('tenant-a', 'iso-breaker-server');

      await expect(callAs('tenant-b', 'iso-breaker-server')).resolves.toEqual({ ok: true });
    });

    it('keeps rejecting the tenant that tripped it, even once its server recovers', async () => {
      failCallsFor('tenant-a');
      await tripBreakerFor('tenant-a', 'iso-breaker-same');

      mockLocalMcpHandler.mockClear().mockResolvedValue({ ok: true });
      await expect(callAs('tenant-a', 'iso-breaker-same')).rejects.toThrow('temporarily unavailable');
      expect(mockLocalMcpHandler).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'tenant-a' }));
    });
  });

  describe('calls with no user', () => {
    it('never open a breaker that would block the next unattributed caller', async () => {
      mockLocalMcpHandler.mockRejectedValue(new Error('ECONNRESET'));
      for (let attempt = 0; attempt < 10; attempt++) {
        await callAs(undefined, 'iso-unattributed').catch(() => undefined);
      }

      mockLocalMcpHandler.mockResolvedValue({ ok: true });
      await expect(callAs(undefined, 'iso-unattributed')).resolves.toEqual({ ok: true });
    });
  });

  describe('pre-call rate-limit throttle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      mockLocalMcpHandler.mockResolvedValue({ ok: true });
      snapshots.push({
        integration: 'github',
        userId: 'tenant-a',
        usagePercent: 99,
        resetAt: new Date(Date.now() + RESET_IN_MS),
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function isHeldBack(userId: string | undefined): Promise<boolean> {
      let settled = false;
      const pending = callAs(userId, 'github').then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      const heldBack = !settled;
      await vi.advanceTimersByTimeAsync(RESET_IN_MS);
      await pending;
      return heldBack;
    }

    it('throttles only the tenant that exhausted its limit', async () => {
      expect(await isHeldBack('tenant-a')).toBe(true);
      expect(await isHeldBack('tenant-b')).toBe(false);
    });

    it('never throttles a call with no user on a snapshot stored without one', async () => {
      snapshots.push({ ...snapshots[0], userId: UNATTRIBUTED_MCP_TENANT });

      expect(await isHeldBack(undefined)).toBe(false);
    });
  });
});
