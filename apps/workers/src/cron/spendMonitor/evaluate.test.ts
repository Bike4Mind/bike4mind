import { describe, expect, it, vi } from 'vitest';
import type { ISpendAlert, ISpendRollup, SpendAlertRecord, SpendRollupScopeType } from '@bike4mind/common';
import type { SlackAlarmMessage } from '../../events/alarmSlackMessage';
import { evaluateSpend, type EvaluateDeps } from './evaluate';
import type { SpendThresholds } from './rules';
import { createSpendPost } from './slackPost';

const BUCKET_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_START = new Date('2026-10-30T10:00:00Z');
const NOW = new Date('2026-10-30T10:17:00Z');

const thresholds: SpendThresholds = {
  platformSpikeRatio: 3,
  platformCriticalRatio: 6,
  platformSpikeFloorCredits: 5000,
  platformCostFloorUsd: 20,
  accountSpikeRatio: 10,
  accountSpikeFloorCredits: 1000,
  accountCeilingCredits: 5000,
};

const rollup = (
  scopeType: SpendRollupScopeType,
  scopeId: string,
  bucketStart: Date,
  credits: number,
  costUsd = 0
): ISpendRollup => ({ bucketStart, scopeType, scopeId, credits, costUsd, creditsCharged: credits, requests: 1 });

/** Three buckets filling the evaluated window [10:00, 10:15). */
const windowBuckets = (scopeType: SpendRollupScopeType, scopeId: string, creditsPerBucket: number) =>
  [0, 1, 2].map(i => rollup(scopeType, scopeId, new Date(WINDOW_START.getTime() + i * BUCKET_MS), creditsPerBucket));

/** A quiet previous 24h on the platform scope, so the platform has a baseline. */
const quietPlatformHistory = (): ISpendRollup[] =>
  Array.from({ length: DAY_MS / BUCKET_MS }, (_, i) =>
    rollup('platform', 'all', new Date(WINDOW_START.getTime() - (i + 1) * BUCKET_MS), 100)
  );

function createFakes() {
  let rollups: ISpendRollup[] = [];
  const alerts: SpendAlertRecord[] = [];
  let nextId = 1;

  const inRange = (r: ISpendRollup, from: Date, to: Date) => r.bucketStart >= from && r.bucketStart < to;

  const sumWindow = vi.fn(async (scopeType: SpendRollupScopeType, from: Date, to: Date, scopeIds?: string[]) => {
    const totals = new Map<string, ISpendRollup>();
    for (const r of rollups) {
      if (r.scopeType !== scopeType || !inRange(r, from, to)) continue;
      if (scopeIds && !scopeIds.includes(r.scopeId)) continue;
      const previous = totals.get(r.scopeId);
      totals.set(r.scopeId, {
        ...r,
        bucketStart: from,
        credits: (previous?.credits ?? 0) + r.credits,
        costUsd: (previous?.costUsd ?? 0) + r.costUsd,
      });
    }
    return totals;
  });

  const windowSeries = vi.fn(async (scopeType: SpendRollupScopeType, scopeIds: string[], from: Date, to: Date) => {
    const series = new Map<string, ISpendRollup[]>();
    for (const r of rollups) {
      if (r.scopeType !== scopeType || !scopeIds.includes(r.scopeId) || !inRange(r, from, to)) continue;
      series.set(r.scopeId, [...(series.get(r.scopeId) ?? []), r]);
    }
    return series;
  });

  const latestBucketStart = vi.fn(async () => {
    const platform = rollups.filter(r => r.scopeType === 'platform').map(r => r.bucketStart.getTime());
    return platform.length > 0 ? new Date(Math.max(...platform)) : null;
  });

  const create = vi.fn(async (alert: ISpendAlert) => {
    if (alert.openKey && alerts.some(existing => existing.openKey === alert.openKey)) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    const record: SpendAlertRecord = { ...alert, id: `alert-${nextId++}` };
    alerts.push(record);
    return record;
  });

  const update = vi.fn(async (data: Partial<SpendAlertRecord> & { id: string }, options?: { unset?: string[] }) => {
    const record = alerts.find(alert => alert.id === data.id);
    if (!record) return null;
    Object.assign(record, data);
    for (const field of options?.unset ?? []) delete (record as Record<string, unknown>)[field];
    return record;
  });

  const findActive = vi.fn(async () =>
    alerts.filter(alert => alert.status === 'open' || alert.status === 'acknowledged')
  );

  const posts: SlackAlarmMessage[] = [];
  const post = vi.fn(async (message: SlackAlarmMessage) => {
    posts.push(message);
  });

  const deps: EvaluateDeps = {
    rollups: { sumWindow, windowSeries, latestBucketStart },
    alerts: { findActive, create, update } as unknown as EvaluateDeps['alerts'],
    resolveScopeDeps: {
      findUsersByIds: async ids => ids.map(id => ({ id, email: `${id}@example.com` })),
      findOrganizationsByIds: async () => [],
      findApiKeysByIds: async () => [],
      findAgentsByIds: async () => [],
    },
    post,
    messageContext: { creditUsd: 0.01, stage: 'production' },
    logger: { log: vi.fn(), error: vi.fn() },
  };

  return {
    deps,
    alerts,
    posts,
    post,
    create,
    windowSeries,
    setRollups: (next: ISpendRollup[]) => {
      rollups = next;
    },
  };
}

const run = (fakes: ReturnType<typeof createFakes>) => evaluateSpend(NOW, fakes.deps, thresholds);

describe('evaluateSpend', () => {
  it('opens and posts once on a platform spike, stays quiet at the same value, escalates at double', async () => {
    const fakes = createFakes();
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 5000)]);

    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
    expect(fakes.alerts).toHaveLength(1);
    expect(fakes.alerts[0]).toMatchObject({ rule: 'platform_spike', status: 'open', lastNotifiedValue: 15000 });

    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 0 });

    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 10000)]);
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
    expect(fakes.alerts).toHaveLength(1);
    expect(fakes.alerts[0]).toMatchObject({ lastValue: 30000, lastNotifiedValue: 30000 });
  });

  it('keeps the incident when the post throws and re-notifies on the next run', async () => {
    const fakes = createFakes();
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 5000)]);
    fakes.post.mockRejectedValueOnce(new Error('slack down'));

    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 0 });
    expect(fakes.alerts).toHaveLength(1);
    expect(fakes.alerts[0].lastNotifiedValue).toBeUndefined();

    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
    expect(fakes.alerts[0].lastNotifiedValue).toBe(15000);
  });

  it('resolves an account that left the window after 2 runs, posts the resolve, and reopens fresh later', async () => {
    const fakes = createFakes();
    const platform = windowBuckets('platform', 'all', 100);
    fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000)]);

    await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });
    expect(fakes.alerts[0]).toMatchObject({ rule: 'account_ceiling', scopeId: 'u1', openKey: expect.any(String) });
    expect(fakes.posts[0].text).toContain('Account spend ceiling');

    fakes.setRollups(platform);
    await expect(run(fakes)).resolves.toMatchObject({ posted: 0 });
    expect(fakes.alerts[0]).toMatchObject({ status: 'open', clearRuns: 1 });

    await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });
    expect(fakes.alerts[0]).toMatchObject({ status: 'resolved' });
    expect(fakes.alerts[0]).not.toHaveProperty('openKey');
    expect(fakes.posts[1].text).toContain('Resolved');

    fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000)]);
    await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });
    expect(fakes.alerts).toHaveLength(2);
    expect(fakes.alerts[1]).toMatchObject({ status: 'open', rule: 'account_ceiling', scopeId: 'u1' });
  });

  it('writes incidents and records the notification when Slack is disabled', async () => {
    const fakes = createFakes();
    const send = vi.fn();
    fakes.deps.post = createSpendPost(false, send, fakes.deps.logger);
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 5000)]);

    await run(fakes);
    await run(fakes);

    expect(send).not.toHaveBeenCalled();
    expect(fakes.alerts).toHaveLength(1);
    expect(fakes.alerts[0]).toMatchObject({ lastNotifiedValue: 15000, lastNotifiedAt: NOW });
  });

  it('skips the baseline query for scopes below the floor and the ceiling', async () => {
    const fakes = createFakes();
    fakes.setRollups([
      ...windowBuckets('platform', 'all', 100),
      ...windowBuckets('User', 'quiet', 100),
      ...windowBuckets('User', 'busy', 400),
    ]);

    await run(fakes);

    const userQueries = fakes.windowSeries.mock.calls.filter(([scopeType]) => scopeType === 'User');
    expect(userQueries.map(([, ids]) => ids)).toEqual([['busy']]);
    expect(fakes.windowSeries.mock.calls.filter(([scopeType]) => scopeType === 'Organization')).toHaveLength(0);
  });

  it('treats a lost create race as a no-op', async () => {
    const fakes = createFakes();
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 5000)]);
    fakes.create.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));

    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 0 });
    expect(fakes.alerts).toHaveLength(0);
  });

  it('surfaces other create failures after still handling the remaining decisions', async () => {
    const fakes = createFakes();
    fakes.setRollups([
      ...quietPlatformHistory(),
      ...windowBuckets('platform', 'all', 5000),
      ...windowBuckets('User', 'u1', 2000),
    ]);
    fakes.create.mockRejectedValueOnce(new Error('mongo down'));

    await expect(run(fakes)).rejects.toThrow('spend-monitor-persist-failed');
    expect(fakes.alerts).toHaveLength(1);
    expect(fakes.posts).toHaveLength(1);
  });

  it('keeps posting for other incidents when one post fails', async () => {
    const fakes = createFakes();
    fakes.setRollups([
      ...windowBuckets('platform', 'all', 100),
      ...windowBuckets('User', 'u1', 2000),
      ...windowBuckets('User', 'u2', 2000),
    ]);
    fakes.post.mockRejectedValueOnce(new Error('slack 500'));

    await expect(run(fakes)).resolves.toMatchObject({ breaches: 2, posted: 1 });
    expect(fakes.alerts).toHaveLength(2);
    expect(fakes.alerts.filter(alert => alert.lastNotifiedValue !== undefined)).toHaveLength(1);
  });

  it('does nothing before any bucket has been rolled up', async () => {
    const fakes = createFakes();
    await expect(run(fakes)).resolves.toEqual({ breaches: 0, posted: 0 });
  });
});
