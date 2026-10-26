import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type StoredSnapshot = {
  integration: string;
  userId: string;
  usagePercent: number | null;
  resetAt: Date | null;
  timestamp: Date;
};

const { snapshots } = vi.hoisted(() => ({ snapshots: [] as StoredSnapshot[] }));

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
}));

vi.mock('./cloudwatch', () => ({
  recordRateLimitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { rateLimitSnapshotRepository } from '@bike4mind/database';
import { recordRateLimitEvent } from './cloudwatch';
import { persistRateLimitEvents, throttleIfNearRateLimit } from './mcpRateLimitSnapshots';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const RESET_IN_MS = 5_000;

function exhaustedGitHubEvent() {
  return {
    type: 'RATE_LIMIT_WARNING',
    integration: 'github',
    endpoint: '/repos/x/y',
    limit: 5000,
    remaining: 10,
    usagePercent: 99.8,
    resetAt: new Date(Date.now() + RESET_IN_MS).toISOString(),
  };
}

/** Resolves to true when the throttle check slept before returning. */
async function wasThrottled(tenantKey: string): Promise<boolean> {
  let settled = false;
  const pending = throttleIfNearRateLimit(tenantKey, 'github', 'callTool').then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  const throttled = !settled;
  await vi.advanceTimersByTimeAsync(RESET_IN_MS);
  await pending;
  return throttled;
}

describe('mcpRateLimitSnapshots', () => {
  beforeEach(() => {
    snapshots.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores each snapshot under the tenant that spent the quota', async () => {
    const persisted = await persistRateLimitEvents([exhaustedGitHubEvent()], TENANT_A);

    expect(persisted).toBe(1);
    expect(snapshots).toEqual([expect.objectContaining({ integration: 'github', userId: TENANT_A })]);
  });

  it('skips invalid events and counts only stored snapshots', async () => {
    const persisted = await persistRateLimitEvents(
      [null, { integration: 'not-an-integration' }, exhaustedGitHubEvent()],
      TENANT_A
    );

    expect(persisted).toBe(1);
  });

  it('leaves an event uncounted when its snapshot write fails and still persists the next one', async () => {
    vi.mocked(rateLimitSnapshotRepository.create).mockRejectedValueOnce(new Error('mongo down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const persisted = await persistRateLimitEvents([exhaustedGitHubEvent(), exhaustedGitHubEvent()], TENANT_A);

    expect(persisted).toBe(1);
    expect(snapshots).toHaveLength(1);
  });

  it('does not change the persisted count when the CloudWatch metric emit fails', async () => {
    vi.mocked(recordRateLimitEvent).mockRejectedValueOnce(new Error('cloudwatch down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const persisted = await persistRateLimitEvents([exhaustedGitHubEvent()], TENANT_A);

    expect(persisted).toBe(1);
    expect(snapshots).toHaveLength(1);
  });

  it("throttles the tenant that exhausted its limit and leaves another tenant's calls alone", async () => {
    await persistRateLimitEvents([exhaustedGitHubEvent()], TENANT_A);

    expect(await wasThrottled(TENANT_A)).toBe(true);
    expect(await wasThrottled(TENANT_B)).toBe(false);
  });

  it('never reads the retired platform-wide system bucket', async () => {
    await persistRateLimitEvents([exhaustedGitHubEvent()], 'system');

    expect(await wasThrottled(TENANT_B)).toBe(false);
  });
});
