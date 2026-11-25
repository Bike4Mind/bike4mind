import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UsageEvent, usageEventRepository } from './UsageEventModel';
import { CreditHolderType, type UsageEventStatus } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UsageEvent.deleteMany({});
});

type Seed = {
  at: string;
  userId: string;
  feature: string;
  costUsd: number;
  creditsCharged?: number;
  units?: number;
  status?: UsageEventStatus;
};

let seq = 0;
async function seed(events: Seed[]) {
  await UsageEvent.insertMany(
    events.map(event => ({
      requestId: `req-${++seq}`,
      userId: event.userId,
      ownerId: event.userId,
      ownerType: CreditHolderType.User,
      feature: event.feature,
      provider: 'elevenlabs',
      model: 'm',
      status: event.status ?? 'ok',
      costUsd: event.costUsd,
      creditsCharged: event.creditsCharged ?? 0,
      units: event.units,
      createdAt: new Date(event.at),
    }))
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FROM = new Date('2026-03-08T00:00:00Z');
const TO = new Date('2026-03-15T00:00:00Z');
// The range's last day is today and still in progress, so spikes compare the day before it.
const SPIKE_END = new Date(TO.getTime() - DAY_MS);
const LAST_DAY = new Date(SPIKE_END.getTime() - DAY_MS);
const TRAILING_FROM = new Date(LAST_DAY.getTime() - 7 * DAY_MS);
const WINDOW = { from: FROM, to: TO, spikeEnd: SPIKE_END };

// A deterministic spread: three features, four users, every status, events before the range
// (trailing window only), on the range edges, and after it.
function sampleEvents(): Seed[] {
  const features = ['music_generation', 'text_to_speech', 'chat'];
  const users = ['u1', 'u2', 'u3', 'u4'];
  const statuses: UsageEventStatus[] = ['ok', 'ok', 'error', 'ok', 'timeout', 'refusal', 'ok', 'degenerate'];
  const events: Seed[] = [];
  for (let i = 0; i < 120; i++) {
    const at = new Date(TRAILING_FROM.getTime() - DAY_MS + i * 3.7 * 60 * 60 * 1000);
    events.push({
      at: at.toISOString(),
      userId: users[i % users.length],
      feature: features[(i * 7) % features.length],
      costUsd: ((i * 13) % 17) / 4,
      creditsCharged: (i * 11) % 23,
      units: i % 3 === 0 ? undefined : (i % 5) + 1,
      status: statuses[i % statuses.length],
    });
  }
  events.push({ at: FROM.toISOString(), userId: 'u1', feature: 'chat', costUsd: 1 });
  events.push({ at: TO.toISOString(), userId: 'u1', feature: 'chat', costUsd: 1000 });
  return events;
}

/**
 * The same numbers computed the obvious way, row by row, as the reference. The status rules are
 * spelled out here rather than imported, so a misclassification in the shared constants fails.
 */
function directAggregate(events: Seed[], feature?: string) {
  const failed = (event: Seed) => event.status === 'error' || event.status === 'timeout';
  const counted = (event: Seed) => event.status !== 'error';
  const time = (event: Seed) => new Date(event.at).getTime();
  const byFeature = new Map<
    string,
    {
      requests: number;
      failedRequests: number;
      costUsd: number;
      creditsCharged: number;
      units: number;
      lastDayUsd: number;
      trailingUsd: number;
      users: Set<string>;
    }
  >();
  for (const event of events) {
    if (feature && event.feature !== feature) continue;
    const key = feature ? event.userId : event.feature;
    const acc = byFeature.get(key) ?? {
      requests: 0,
      failedRequests: 0,
      costUsd: 0,
      creditsCharged: 0,
      units: 0,
      lastDayUsd: 0,
      trailingUsd: 0,
      users: new Set<string>(),
    };
    const t = time(event);
    if (t >= TO.getTime()) continue;
    if (t >= FROM.getTime()) {
      acc.requests += 1;
      acc.users.add(event.userId);
      if (failed(event)) acc.failedRequests += 1;
      if (counted(event)) {
        acc.costUsd += event.costUsd;
        acc.creditsCharged += event.creditsCharged ?? 0;
        acc.units += event.units ?? 0;
      }
    }
    if (counted(event) && t >= LAST_DAY.getTime() && t < SPIKE_END.getTime()) acc.lastDayUsd += event.costUsd;
    if (counted(event) && t >= TRAILING_FROM.getTime() && t < LAST_DAY.getTime()) acc.trailingUsd += event.costUsd;
    byFeature.set(key, acc);
  }
  return byFeature;
}

describe('spendFeatures', () => {
  it('matches a direct aggregation over the same events', async () => {
    const events = sampleEvents();
    await seed(events);

    const rows = await usageEventRepository.spendFeatures(WINDOW);
    const expected = directAggregate(events);

    expect(rows.map(r => r.feature).sort()).toEqual([...expected.keys()].sort());
    for (const row of rows) {
      const want = expected.get(row.feature)!;
      expect(row.requests).toBe(want.requests);
      expect(row.failedRequests).toBe(want.failedRequests);
      expect(row.distinctUsers).toBe(want.users.size);
      expect(row.costUsd).toBeCloseTo(want.costUsd, 9);
      expect(row.creditsCharged).toBeCloseTo(want.creditsCharged, 9);
      expect(row.units).toBe(want.units);
      expect(row.lastDayUsd).toBeCloseTo(want.lastDayUsd, 9);
      expect(row.trailingUsd).toBeCloseTo(want.trailingUsd, 9);
      expect(row.daily.reduce((sum, d) => sum + d.costUsd, 0)).toBeCloseTo(want.costUsd, 9);
      expect(row.daily.every(d => d.day >= '2026-03-08' && d.day < '2026-03-15')).toBe(true);
    }
  });

  it("totals the same cost as the explorer's breakdown, timeouts included", async () => {
    const events = sampleEvents().filter(event => event.status !== 'error');
    events.push({ at: '2026-03-10T00:00:00Z', userId: 'u1', feature: 'chat', costUsd: 0.4, status: 'timeout' });
    await seed(events);

    const rows = await usageEventRepository.spendFeatures(WINDOW);
    const breakdown = await usageEventRepository.spendBreakdown({
      from: FROM,
      to: TO,
      limit: 10,
      segmentIds: { internal: [], partner: [] },
    });
    expect(rows.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(breakdown.totalCostUsd, 9);
  });

  it('narrows to one acting user and to an audience', async () => {
    await seed([
      { at: '2026-03-10T00:00:00Z', userId: 'staff', feature: 'music_generation', costUsd: 5 },
      { at: '2026-03-10T00:00:00Z', userId: 'customer', feature: 'music_generation', costUsd: 2 },
      { at: '2026-03-10T00:00:00Z', userId: 'customer', feature: 'chat', costUsd: 1 },
    ]);

    const [onlyStaff] = await usageEventRepository.spendFeatures({
      ...WINDOW,
      userFilter: { mode: 'include', userIds: ['staff'] },
    });
    expect(onlyStaff).toMatchObject({ feature: 'music_generation', costUsd: 5, distinctUsers: 1 });

    const external = await usageEventRepository.spendFeatures({
      ...WINDOW,
      userFilter: { mode: 'exclude', userIds: ['staff'] },
    });
    expect(external.find(r => r.feature === 'music_generation')?.costUsd).toBe(2);

    const customer = await usageEventRepository.spendFeatures({ ...WINDOW, actorUserId: 'customer' });
    expect(customer.map(r => r.feature).sort()).toEqual(['chat', 'music_generation']);
  });
});

describe('spendFeatureUsers', () => {
  it("pages a feature's users by cost and matches a direct aggregation", async () => {
    const events = sampleEvents();
    await seed(events);
    const expected = directAggregate(events, 'music_generation');
    const expectedOrder = [...expected.entries()]
      .filter(([, acc]) => acc.requests > 0)
      .sort((a, b) => b[1].costUsd - a[1].costUsd || a[0].localeCompare(b[0]));

    const first = await usageEventRepository.spendFeatureUsers({
      ...WINDOW,
      feature: 'music_generation',
      limit: 2,
      offset: 0,
    });
    const second = await usageEventRepository.spendFeatureUsers({
      ...WINDOW,
      feature: 'music_generation',
      limit: 2,
      offset: 2,
    });

    expect(first.totalUsers).toBe(expectedOrder.length);
    expect(first.featureCostUsd).toBeCloseTo(
      expectedOrder.reduce((sum, [, acc]) => sum + acc.costUsd, 0),
      9
    );
    const paged = [...first.users, ...second.users];
    expect(paged.map(u => u.userId)).toEqual(expectedOrder.map(([id]) => id));
    for (const user of paged) {
      const want = expected.get(user.userId)!;
      expect(user.requests).toBe(want.requests);
      expect(user.failedRequests).toBe(want.failedRequests);
      expect(user.costUsd).toBeCloseTo(want.costUsd, 9);
      expect(user.lastDayUsd).toBeCloseTo(want.lastDayUsd, 9);
      expect(user.trailingUsd).toBeCloseTo(want.trailingUsd, 9);
    }
  });
});

describe('spendActorIds', () => {
  it('returns each acting user in the scan window once, including trailing-only users', async () => {
    await seed([
      { at: '2026-03-10T00:00:00Z', userId: 'a', feature: 'chat', costUsd: 1 },
      { at: '2026-03-11T00:00:00Z', userId: 'a', feature: 'chat', costUsd: 1 },
      { at: TRAILING_FROM.toISOString(), userId: 'b', feature: 'music_generation', costUsd: 1 },
      { at: TO.toISOString(), userId: 'c', feature: 'chat', costUsd: 1 },
    ]);
    const ids = await usageEventRepository.spendActorIds(WINDOW);
    expect(ids.sort()).toEqual(['a', 'b']);
    const musicIds = await usageEventRepository.spendActorIds({ ...WINDOW, feature: 'music_generation' });
    expect(musicIds).toEqual(['b']);
  });
});
