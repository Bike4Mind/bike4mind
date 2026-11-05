import { describe, expect, it, vi } from 'vitest';
import type {
  ISpendAlert,
  ISpendRollup,
  SpendAlertRecord,
  SpendRollupScopeType,
  SpendSourceTotal,
} from '@bike4mind/common';
import type { SlackAlarmMessage } from '../../events/alarmSlackMessage';
import { evaluateSpend, type EvaluateDeps } from './evaluate';
import type { SpendThresholds } from './rules';
import { createSpendPost } from './slackPost';
import { NO_TRUST, parseSpendTrustConfig, type SpendTrustConfig } from './trust';

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
  trustedAccountSpikeFloorCredits: 20000,
  trustedAccountCeilingCredits: 40000,
};

const rollup = (
  scopeType: SpendRollupScopeType,
  scopeId: string,
  bucketStart: Date,
  credits: number,
  // A steady platform cost clears the cost floor without spiking, so the credit rules decide.
  costUsd = scopeType === 'platform' ? 20 : 0
): ISpendRollup => ({ bucketStart, scopeType, scopeId, credits, costUsd, creditsCharged: credits, requests: 1 });

/** Three buckets filling the evaluated window [10:00, 10:15). */
const windowBuckets = (scopeType: SpendRollupScopeType, scopeId: string, creditsPerBucket: number) =>
  [0, 1, 2].map(i => rollup(scopeType, scopeId, new Date(WINDOW_START.getTime() + i * BUCKET_MS), creditsPerBucket));

/** A quiet previous 24h on the platform scope, so the platform has a baseline. */
const quietPlatformHistory = (creditsPerBucket = 100): ISpendRollup[] =>
  Array.from({ length: DAY_MS / BUCKET_MS }, (_, i) =>
    rollup('platform', 'all', new Date(WINDOW_START.getTime() - (i + 1) * BUCKET_MS), creditsPerBucket)
  );

/** A steady 7 days on one scope: every 15-minute window sums to 3 x creditsPerBucket, so that is its p95 baseline. */
const steadyHistory = (scopeType: SpendRollupScopeType, scopeId: string, creditsPerBucket: number): ISpendRollup[] =>
  Array.from({ length: (7 * DAY_MS) / BUCKET_MS }, (_, i) =>
    rollup(scopeType, scopeId, new Date(WINDOW_START.getTime() - (i + 1) * BUCKET_MS), creditsPerBucket)
  );

function createFakes() {
  let storedRollups: ISpendRollup[] = [];
  // Each later window shifts every rollup (and the run time) forward one bucket, as the real cron sees it.
  let windowOffset = 0;
  const alerts: SpendAlertRecord[] = [];
  let nextId = 1;

  const inRange = (r: ISpendRollup, from: Date, to: Date) => r.bucketStart >= from && r.bucketStart < to;
  const currentRollups = () =>
    storedRollups.map(r => ({ ...r, bucketStart: new Date(r.bucketStart.getTime() + windowOffset * BUCKET_MS) }));

  const sumWindow = vi.fn(async (scopeType: SpendRollupScopeType, from: Date, to: Date, scopeIds?: string[]) => {
    const totals = new Map<string, ISpendRollup>();
    for (const r of currentRollups()) {
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
    for (const r of currentRollups()) {
      if (r.scopeType !== scopeType || !scopeIds.includes(r.scopeId) || !inRange(r, from, to)) continue;
      series.set(r.scopeId, [...(series.get(r.scopeId) ?? []), r]);
    }
    return series;
  });

  const latestBucketStart = vi.fn(async () => {
    const platform = currentRollups()
      .filter(r => r.scopeType === 'platform')
      .map(r => r.bucketStart.getTime());
    return platform.length > 0 ? new Date(Math.max(...platform)) : null;
  });

  let sourceTotals: SpendSourceTotal[] = [];
  const sourceMix = vi.fn(
    async (_from: Date, _to: Date, scopes: Array<{ scopeType: SpendRollupScopeType; scopeId: string }>) =>
      sourceTotals.filter(row => scopes.some(s => s.scopeType === row.scopeType && s.scopeId === row.scopeId))
  );

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

  const applyEvaluation = vi.fn(
    async (
      data: Partial<SpendAlertRecord> & { id: string; lastEvaluatedWindowEnd: Date },
      options?: { unset?: string[] }
    ) => {
      const record = alerts.find(alert => alert.id === data.id);
      if (!record) return false;
      if (record.lastEvaluatedWindowEnd && record.lastEvaluatedWindowEnd >= data.lastEvaluatedWindowEnd) return false;
      await update(data, options);
      return true;
    }
  );

  const findActive = vi.fn(async () =>
    alerts.filter(alert => alert.status === 'open' || alert.status === 'acknowledged')
  );

  const posts: SlackAlarmMessage[] = [];
  const post = vi.fn(async (message: SlackAlarmMessage) => {
    posts.push(message);
  });

  const findUsersByIds = vi.fn<EvaluateDeps['resolveScopeDeps']['findUsersByIds']>(async ids =>
    ids.map(id => ({ id, email: `${id}@example.com`, emailVerified: true }))
  );

  const deps: EvaluateDeps = {
    rollups: { sumWindow, windowSeries, latestBucketStart, sourceMix },
    alerts: { findActive, create, update, applyEvaluation } as unknown as EvaluateDeps['alerts'],
    resolveScopeDeps: {
      findUsersByIds,
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
    update,
    applyEvaluation,
    sumWindow,
    windowSeries,
    sourceMix,
    findUsersByIds,
    setSourceTotals: (next: SpendSourceTotal[]) => {
      sourceTotals = next;
    },
    setRollups: (next: ISpendRollup[]) => {
      storedRollups = next;
    },
    nextWindow: () => {
      windowOffset += 1;
    },
    now: () => new Date(NOW.getTime() + windowOffset * BUCKET_MS),
  };
}

const run = (fakes: ReturnType<typeof createFakes>, trust: SpendTrustConfig = NO_TRUST) =>
  evaluateSpend(fakes.now(), fakes.deps, thresholds, trust);

describe('evaluateSpend', () => {
  it('opens and posts once on a platform spike, stays quiet at the same value, escalates at double', async () => {
    const fakes = createFakes();
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 5000)]);

    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
    expect(fakes.alerts).toHaveLength(1);
    expect(fakes.alerts[0]).toMatchObject({ rule: 'platform_spike', status: 'open', lastNotifiedValue: 15000 });

    fakes.nextWindow();
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 0 });

    fakes.nextWindow();
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

    fakes.nextWindow();
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
    expect(fakes.alerts[0].lastNotifiedValue).toBe(15000);
    // The opening post never landed, so the re-notification still announces an open, not an escalation.
    expect(JSON.stringify(fakes.posts[0])).not.toContain('escalated');
  });

  it('resolves an incident whose open was never announced without posting a stray resolve', async () => {
    const fakes = createFakes();
    const platform = windowBuckets('platform', 'all', 100);
    fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000)]);
    fakes.post.mockRejectedValueOnce(new Error('slack down'));

    await expect(run(fakes)).resolves.toMatchObject({ posted: 0 });
    expect(fakes.alerts[0].lastNotifiedAt).toBeUndefined();

    fakes.nextWindow();
    fakes.setRollups(platform);
    await run(fakes);
    fakes.nextWindow();
    await expect(run(fakes)).resolves.toMatchObject({ posted: 0 });
    expect(fakes.alerts[0]).toMatchObject({ status: 'resolved' });
    expect(fakes.alerts[0]).not.toHaveProperty('openKey');
    expect(fakes.post).toHaveBeenCalledTimes(1);
  });

  it('resolves an account that left the window after 2 runs, posts the resolve, and reopens fresh later', async () => {
    const fakes = createFakes();
    const platform = windowBuckets('platform', 'all', 100);
    fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000)]);

    await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });
    expect(fakes.alerts[0]).toMatchObject({ rule: 'account_ceiling', scopeId: 'u1', openKey: expect.any(String) });
    expect(fakes.posts[0].text).toContain('Account spend ceiling');

    fakes.nextWindow();
    fakes.setRollups(platform);
    await expect(run(fakes)).resolves.toMatchObject({ posted: 0 });
    expect(fakes.alerts[0]).toMatchObject({ status: 'open', clearRuns: 1 });

    fakes.nextWindow();
    await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });
    expect(fakes.alerts[0]).toMatchObject({ status: 'resolved' });
    expect(fakes.alerts[0]).not.toHaveProperty('openKey');
    expect(fakes.posts[1].text).toContain('Resolved');

    fakes.nextWindow();
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
    expect(fakes.deps.logger.error).toHaveBeenCalledWith('spend-monitor-post-failed', expect.anything());
  });

  it('does nothing before any bucket has been rolled up', async () => {
    const fakes = createFakes();
    await expect(run(fakes)).resolves.toEqual({ breaches: 0, posted: 0 });
  });

  it('a retried run for the same window neither double-counts clear runs nor re-posts', async () => {
    const fakes = createFakes();
    const platform = windowBuckets('platform', 'all', 100);
    fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000)]);
    await run(fakes);
    await expect(run(fakes)).resolves.toMatchObject({ posted: 0 });
    expect(fakes.alerts).toHaveLength(1);

    fakes.nextWindow();
    fakes.setRollups(platform);
    await run(fakes);
    await run(fakes);

    expect(fakes.alerts[0]).toMatchObject({ status: 'open', clearRuns: 1 });
  });

  it('skips the post when an overlapping run already applied the window', async () => {
    const fakes = createFakes();
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 5000)]);
    await run(fakes);
    fakes.nextWindow();
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 10000)]);
    fakes.applyEvaluation.mockResolvedValueOnce(false);

    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 0 });
    expect(fakes.posts).toHaveLength(1);
    expect(fakes.deps.logger.log).toHaveBeenCalledWith(
      'spend-monitor-evaluation-lost-race',
      expect.objectContaining({ alertId: fakes.alerts[0].id, kind: 'escalate' })
    );
  });

  it('surfaces a failed notification bookkeeping write after a successful post', async () => {
    const fakes = createFakes();
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 5000)]);
    fakes.update.mockRejectedValueOnce(new Error('mongo down'));

    await expect(run(fakes)).rejects.toThrow(AggregateError);
    expect(fakes.posts).toHaveLength(1);
    expect(fakes.deps.logger.error).toHaveBeenCalledWith('spend-monitor-notify-bookkeeping-failed', expect.anything());
    expect(fakes.deps.logger.error).not.toHaveBeenCalledWith('spend-monitor-post-failed', expect.anything());

    // At-least-once: the stamp never landed, so the next window announces the incident again, still as an open.
    fakes.nextWindow();
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
    expect(fakes.posts).toHaveLength(2);
    expect(JSON.stringify(fakes.posts[1])).not.toContain('escalated');
    expect(fakes.alerts[0]).toMatchObject({ lastNotifiedValue: 15000, lastNotifiedAt: fakes.now() });

    fakes.nextWindow();
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 0 });
    expect(fakes.posts).toHaveLength(2);
  });

  it('retries a critical escalation whose post failed on the next window', async () => {
    const fakes = createFakes();
    // Baseline 1200 per window: 5100 is a x4.25 warning, 7500 a x6.25 critical, below 2x the announced 5100.
    fakes.setRollups([...quietPlatformHistory(400), ...windowBuckets('platform', 'all', 1700)]);
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
    expect(fakes.alerts[0]).toMatchObject({ severity: 'warning', lastNotifiedSeverity: 'warning' });

    fakes.nextWindow();
    fakes.setRollups([...quietPlatformHistory(400), ...windowBuckets('platform', 'all', 2500)]);
    fakes.post.mockRejectedValueOnce(new Error('slack down'));
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 0 });
    expect(fakes.alerts[0]).toMatchObject({ severity: 'critical', lastNotifiedSeverity: 'warning' });

    fakes.nextWindow();
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
    expect(JSON.stringify(fakes.posts.at(-1))).toContain('escalated, critical');
    expect(fakes.alerts[0]).toMatchObject({ lastNotifiedSeverity: 'critical', lastNotifiedValue: 7500 });

    fakes.nextWindow();
    await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 0 });
  });

  describe('same-weekday slot baseline', () => {
    const SLOT_CREDITS_PER_BUCKET: Record<number, number> = { 7: 1000, 14: 2000, 21: 4000, 28: 8000 };
    const NEIGHBOUR_CREDITS = 1_000_000;

    /** 29 days of quiet platform buckets, with the slot windows and the buckets either side of them overridden. */
    const slotHistory = (): ISpendRollup[] => {
      const credits = new Map<number, number>();
      const totalBuckets = (29 * DAY_MS) / BUCKET_MS;
      for (let i = 1; i <= totalBuckets; i++) credits.set(WINDOW_START.getTime() - i * BUCKET_MS, 100);
      for (const [days, perBucket] of Object.entries(SLOT_CREDITS_PER_BUCKET)) {
        const slotStart = WINDOW_START.getTime() - Number(days) * DAY_MS;
        for (const i of [0, 1, 2]) credits.set(slotStart + i * BUCKET_MS, perBucket);
        credits.set(slotStart - BUCKET_MS, NEIGHBOUR_CREDITS);
        credits.set(slotStart + 3 * BUCKET_MS, NEIGHBOUR_CREDITS);
      }
      return [...credits].map(([bucketMs, value]) => rollup('platform', 'all', new Date(bucketMs), value));
    };

    it('takes the median of the 7/14/21/28-day slot windows and ignores their neighbours', async () => {
      const fakes = createFakes();
      // Slot sums 3000, 6000, 12000, 24000: median 9000, so 36000 is a x4 spike.
      fakes.setRollups([...slotHistory(), ...windowBuckets('platform', 'all', 12000)]);

      await expect(run(fakes)).resolves.toEqual({ breaches: 1, posted: 1 });
      expect(fakes.alerts[0].context).toEqual({ baseline: 9000, ratio: 4 });
    });
  });

  it('lists the top 5 accounts and top 3 models, reusing the account totals already summed', async () => {
    const fakes = createFakes();
    const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].flatMap((id, i) => windowBuckets('User', id, 10 + i));
    const models = ['m1', 'm2', 'm3', 'm4'].flatMap((id, i) => windowBuckets('model', id, 10 + i));
    fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 5000), ...users, ...models]);

    await run(fakes);

    const text = JSON.stringify(fakes.posts[0]);
    expect(['u6', 'u5', 'u4', 'u3', 'u2'].every(id => text.includes(`${id}@example.com`))).toBe(true);
    expect(text).not.toContain('u1@example.com');
    expect(['m4', 'm3', 'm2'].every(id => text.includes(id))).toBe(true);
    expect(text).not.toContain('m1:');
    const accountSums = fakes.sumWindow.mock.calls.filter(
      ([scopeType]) => scopeType === 'User' || scopeType === 'Organization'
    );
    expect(accountSums).toHaveLength(2);
  });

  describe('folding api keys into their payer', () => {
    const keyDeps = (
      fakes: ReturnType<typeof createFakes>,
      key: { userId: string; billingOwnerType?: string; organizationId?: string }
    ) => {
      fakes.deps.resolveScopeDeps = {
        ...fakes.deps.resolveScopeDeps,
        findApiKeysByIds: async ids => ids.map(id => ({ id, name: 'ci-key', ...key })),
        findOrganizationsByIds: async ids => ids.map(id => ({ id, name: `Org ${id}` })),
      };
    };
    const platform = windowBuckets('platform', 'all', 100);

    it('posts one account incident for a key and its owner, naming the key', async () => {
      const fakes = createFakes();
      keyDeps(fakes, { userId: 'u1' });
      fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000), ...windowBuckets('apiKey', 'k1', 2000)]);

      await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });
      expect(fakes.alerts).toHaveLength(1);
      expect(fakes.alerts[0]).toMatchObject({ rule: 'account_ceiling', context: { viaKeys: ['ci-key'] } });
      expect(JSON.stringify(fakes.posts[0])).toContain('ci-key');
    });

    it('folds an org-billed key into its Organization', async () => {
      const fakes = createFakes();
      keyDeps(fakes, { userId: 'u9', billingOwnerType: 'Organization', organizationId: 'o1' });
      fakes.setRollups([
        ...platform,
        ...windowBuckets('Organization', 'o1', 2000),
        ...windowBuckets('apiKey', 'k1', 2000),
      ]);

      await run(fakes);

      expect(fakes.alerts).toHaveLength(1);
      expect(fakes.alerts[0]).toMatchObject({
        scopeType: 'Organization',
        scopeId: 'o1',
        context: { viaKeys: ['ci-key'] },
      });
    });

    it('folds a spiking key into its owner at the ceiling, as one card', async () => {
      const fakes = createFakes();
      keyDeps(fakes, { userId: 'u1' });
      // Key: 3,000 over a 300 baseline is a 10x spike below the 5,000 ceiling. Owner: 6,000, past the ceiling.
      fakes.setRollups([
        ...platform,
        ...steadyHistory('apiKey', 'k1', 100),
        ...windowBuckets('apiKey', 'k1', 1000),
        ...windowBuckets('User', 'u1', 2000),
      ]);

      await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });
      expect(fakes.alerts).toHaveLength(1);
      expect(fakes.alerts[0]).toMatchObject({
        rule: 'account_ceiling',
        scopeType: 'User',
        context: { viaKeys: ['ci-key'], viaKeyIds: ['k1'] },
      });
    });

    it('keeps the key incident when its owner did not breach', async () => {
      const fakes = createFakes();
      keyDeps(fakes, { userId: 'u1' });
      fakes.setRollups([...platform, ...windowBuckets('apiKey', 'k1', 2000)]);

      await run(fakes);

      expect(fakes.alerts).toHaveLength(1);
      expect(fakes.alerts[0]).toMatchObject({ rule: 'apikey_ceiling', scopeType: 'apiKey' });
      expect(fakes.alerts[0].context).not.toHaveProperty('viaKeys');
    });

    it('resolves a standing key incident silently once its owner breaches too', async () => {
      const fakes = createFakes();
      keyDeps(fakes, { userId: 'u1' });
      fakes.setRollups([...platform, ...windowBuckets('apiKey', 'k1', 2000)]);
      await run(fakes);

      fakes.nextWindow();
      fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000), ...windowBuckets('apiKey', 'k1', 2000)]);
      await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });

      expect(fakes.alerts.map(a => [a.rule, a.status])).toEqual([
        ['apikey_ceiling', 'resolved'],
        ['account_ceiling', 'open'],
      ]);
      expect(fakes.posts.map(p => p.text).join('\n')).not.toContain('Resolved');
    });

    it('does not open a key incident while the payer incident that folded it is still clearing', async () => {
      const fakes = createFakes();
      keyDeps(fakes, { userId: 'u1' });
      fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000), ...windowBuckets('apiKey', 'k1', 2000)]);
      await run(fakes);

      fakes.nextWindow();
      fakes.setRollups([...platform, ...windowBuckets('apiKey', 'k1', 2000)]);
      await expect(run(fakes)).resolves.toMatchObject({ posted: 0 });

      expect(fakes.alerts.map(a => [a.rule, a.status])).toEqual([['account_ceiling', 'open']]);
    });

    it('still posts the unfolded cards when the lookup fails', async () => {
      const fakes = createFakes();
      fakes.deps.resolveScopeDeps = {
        ...fakes.deps.resolveScopeDeps,
        findApiKeysByIds: vi.fn().mockRejectedValueOnce(new Error('mongo down')).mockResolvedValue([]),
      };
      fakes.setRollups([...platform, ...windowBuckets('User', 'u1', 2000), ...windowBuckets('apiKey', 'k1', 2000)]);

      await expect(run(fakes)).resolves.toMatchObject({ posted: 2 });
      expect(fakes.alerts).toHaveLength(2);
      expect(fakes.deps.logger.error).toHaveBeenCalledWith('spend-monitor-fold-failed', expect.anything());
    });
  });

  it('mentions the group once per run, on the platform critical', async () => {
    const fakes = createFakes();
    fakes.deps.messageContext = { ...fakes.deps.messageContext, mention: 'channel' };
    fakes.setRollups([
      ...quietPlatformHistory(100),
      ...windowBuckets('platform', 'all', 5000),
      ...windowBuckets('User', 'u1', 2000),
      ...windowBuckets('User', 'u2', 2000),
    ]);

    await expect(run(fakes)).resolves.toMatchObject({ posted: 3 });

    const mentioned = fakes.posts.filter(post => post.text.includes('<!channel>'));
    expect(mentioned).toHaveLength(1);
    expect(mentioned[0].text).toContain('Platform');
  });

  describe('trusted accounts', () => {
    const trustedDomain = parseSpendTrustConfig('example.com', '');
    /** 10,000 credits per bucket: 30,000 in the window, typical heavy desktop use. */
    const heavyUser = (id: string) => windowBuckets('User', id, 10_000);

    it('keeps a trusted account under its higher ceiling quiet', async () => {
      const fakes = createFakes();
      fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 100), ...heavyUser('staff')]);

      await expect(run(fakes, trustedDomain)).resolves.toEqual({ breaches: 0, posted: 0 });
      expect(fakes.alerts).toEqual([]);
    });

    it('pages a trusted account past the trusted ceiling and marks it trusted', async () => {
      const fakes = createFakes();
      fakes.setRollups([
        ...quietPlatformHistory(),
        ...windowBuckets('platform', 'all', 100),
        ...windowBuckets('User', 'staff', 15_000),
      ]);

      await run(fakes, trustedDomain);

      const ceiling = fakes.alerts.find(alert => alert.rule === 'account_ceiling');
      expect(ceiling).toMatchObject({ severity: 'critical', context: { trusted: true } });
      expect(JSON.stringify(fakes.posts)).toContain('staff@example.com (trusted)');
    });

    it('holds an untrusted account to the standard ceiling', async () => {
      const fakes = createFakes();
      fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 100), ...heavyUser('outsider')]);

      await run(fakes, parseSpendTrustConfig('corp.example.org', ''));

      const ceiling = fakes.alerts.find(alert => alert.rule === 'account_ceiling');
      expect(ceiling?.severity).toBe('critical');
      expect(ceiling?.context).not.toHaveProperty('trusted');
    });

    it('falls back to standard thresholds and still alerts when the trust lookup fails', async () => {
      const fakes = createFakes();
      fakes.findUsersByIds.mockRejectedValueOnce(new Error('users down'));
      fakes.setRollups([...quietPlatformHistory(), ...windowBuckets('platform', 'all', 100), ...heavyUser('staff')]);

      await run(fakes, trustedDomain);

      const ceiling = fakes.alerts.find(alert => alert.rule === 'account_ceiling');
      expect(ceiling).toMatchObject({ severity: 'critical' });
      expect(ceiling?.context).not.toHaveProperty('trusted');
      expect(fakes.deps.logger.error).toHaveBeenCalledWith('spend-monitor-trust-lookup-failed', expect.anything());
    });

    it('loads the users behind every candidate scope in a single batch', async () => {
      const fakes = createFakes();
      fakes.setRollups([
        ...quietPlatformHistory(),
        ...windowBuckets('platform', 'all', 100),
        ...heavyUser('staff-1'),
        ...heavyUser('staff-2'),
        ...heavyUser('staff-3'),
      ]);

      await run(fakes, trustedDomain);

      expect(fakes.findUsersByIds).toHaveBeenCalledTimes(1);
      expect([...fakes.findUsersByIds.mock.calls[0][0]].sort()).toEqual(['staff-1', 'staff-2', 'staff-3']);
    });

    /** The previous 24h of one owner scope, for a baseline that already held trusted use. */
    const ownerHistory = (id: string, creditsPerBucket: number): ISpendRollup[] =>
      Array.from({ length: DAY_MS / BUCKET_MS }, (_, i) =>
        rollup('User', id, new Date(WINDOW_START.getTime() - (i + 1) * BUCKET_MS), creditsPerBucket)
      );

    it('does not page the platform spike on trusted-only spend of about 15k credits', async () => {
      const fakes = createFakes();
      // 15,000 credits in the window against a 300-credit baseline; 14,700 of it is one trusted account.
      fakes.setRollups([
        ...quietPlatformHistory(),
        ...windowBuckets('platform', 'all', 5000),
        ...windowBuckets('User', 'staff', 4900),
      ]);

      await expect(run(fakes, trustedDomain)).resolves.toEqual({ breaches: 0, posted: 0 });
    });

    it('judges the platform on its full total when the trust lookup fails', async () => {
      const fakes = createFakes();
      fakes.findUsersByIds.mockRejectedValueOnce(new Error('users down'));
      fakes.setRollups([
        ...quietPlatformHistory(),
        ...windowBuckets('platform', 'all', 5000),
        ...windowBuckets('User', 'staff', 4900),
      ]);

      await run(fakes, trustedDomain);

      expect(fakes.alerts.find(alert => alert.rule === 'platform_spike')).toMatchObject({
        severity: 'critical',
        lastValue: 15000,
      });
    });

    it('judges the platform on its full total when the trusted history read fails', async () => {
      const fakes = createFakes();
      fakes.setRollups([
        ...quietPlatformHistory(),
        ...windowBuckets('platform', 'all', 5000),
        ...windowBuckets('User', 'staff', 4900),
      ]);
      // The trusted history is the first owner-scope series read of the run.
      fakes.windowSeries.mockRejectedValueOnce(new Error('rollup read failed'));

      await run(fakes, trustedDomain);

      expect(fakes.alerts.find(alert => alert.rule === 'platform_spike')).toMatchObject({ lastValue: 15000 });
      expect(fakes.deps.logger.error).toHaveBeenCalledWith('spend-monitor-trusted-spend-failed', expect.anything());
    });

    it('still pages the same spike when the account is not trusted', async () => {
      const fakes = createFakes();
      fakes.setRollups([
        ...quietPlatformHistory(),
        ...windowBuckets('platform', 'all', 5000),
        ...windowBuckets('User', 'outsider', 4900),
      ]);

      // A trust list is configured, but this account is not on it.
      await run(fakes, parseSpendTrustConfig('corp.example.org', ''));

      expect(fakes.alerts.find(alert => alert.rule === 'platform_spike')).toMatchObject({
        severity: 'critical',
        lastValue: 15000,
      });
      expect(fakes.alerts.find(alert => alert.rule === 'platform_spike')?.context).not.toHaveProperty(
        'trustedExcluded'
      );
    });

    it('pages a standard spike next to trusted use, reporting the full total and the trusted share', async () => {
      const fakes = createFakes();
      fakes.setRollups([
        ...quietPlatformHistory(),
        ...windowBuckets('platform', 'all', 5000),
        ...windowBuckets('User', 'staff', 2000),
      ]);

      await run(fakes, trustedDomain);

      const platform = fakes.alerts.find(alert => alert.rule === 'platform_spike');
      // 15,000 total, 6,000 trusted: 9,000 standard against a 300 baseline.
      expect(platform).toMatchObject({
        lastValue: 15000,
        context: { baseline: 300, ratio: 30, trustedExcluded: 6000 },
      });
      expect(JSON.stringify(fakes.posts)).toContain('Trusted accounts, not in ratio');
    });

    it('takes trusted use out of the baseline too', async () => {
      const fakes = createFakes();
      // The last 24h ran 2,000 credits per bucket, 1,900 of it the trusted account: a 300 standard baseline.
      // The window runs 4,000 per bucket with the same 1,900 trusted: 6,300 standard, a x21 spike.
      fakes.setRollups([
        ...quietPlatformHistory(2000),
        ...ownerHistory('staff', 1900),
        ...windowBuckets('platform', 'all', 4000),
        ...windowBuckets('User', 'staff', 1900),
      ]);

      await run(fakes, trustedDomain);

      expect(fakes.alerts.find(alert => alert.rule === 'platform_spike')).toMatchObject({
        severity: 'critical',
        context: { baseline: 300, ratio: 21 },
      });
    });
  });

  it('shows where the spend came from on each announced alert', async () => {
    const fakes = createFakes();
    fakes.setRollups([
      ...quietPlatformHistory(),
      ...windowBuckets('platform', 'all', 100),
      ...windowBuckets('User', 'u1', 2000),
    ]);
    fakes.setSourceTotals([
      { scopeType: 'User', scopeId: 'u1', source: 'cli', credits: 1000 },
      { scopeType: 'User', scopeId: 'u1', source: 'desktop', credits: 5000 },
    ]);

    await run(fakes);

    expect(fakes.sourceMix).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fakes.posts[0])).toContain('desktop: 5,000\\ncli: 1,000');
  });

  it('still posts the alert when the source mix read fails', async () => {
    const fakes = createFakes();
    fakes.setRollups([
      ...quietPlatformHistory(),
      ...windowBuckets('platform', 'all', 100),
      ...windowBuckets('User', 'u1', 2000),
    ]);
    fakes.sourceMix.mockRejectedValueOnce(new Error('ledger down'));

    await expect(run(fakes)).resolves.toMatchObject({ posted: 1 });
    expect(fakes.deps.logger.error).toHaveBeenCalledWith('spend-monitor-source-mix-failed', expect.anything());
  });

});
