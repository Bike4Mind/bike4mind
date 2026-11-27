import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { CreditHolderType } from '@bike4mind/common';
import { connectTestDB, disconnectTestDB } from './utils';
import { UsageEvent, usageEventRepository } from '../models/billing/UsageEventModel';

describe('UsageEventRepository.findDailySpendByUser', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await connectTestDB();
    await UsageEvent.ensureIndexes();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB(mongoServer);
  }, 30000);

  beforeEach(async () => {
    await UsageEvent.deleteMany({});
  });

  /** UTC midnight for today. */
  const today = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  };

  const baseEvent = {
    requestId: 'req-seed',
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
    feature: 'chat',
    source: 'web',
    status: 'ok',
    ownerType: CreditHolderType.User,
    costUsd: 0.01,
  } as const;

  let seedIndex = 0;
  const seed = (userId: string, creditsCharged: number, writtenOff?: number, at?: Date) => {
    const ts = at ?? new Date();
    return UsageEvent.create({
      ...baseEvent,
      requestId: `req-${++seedIndex}`,
      userId,
      ownerId: userId,
      creditsCharged,
      ...(writtenOff !== undefined ? { writtenOffCredits: writtenOff } : {}),
      createdAt: ts,
    });
  };

  it('returns 0 when the user has no events today', async () => {
    const result = await usageEventRepository.findDailySpendByUser('user-a', today());
    expect(result).toBe(0);
  });

  it('sums creditsCharged for events since the given date', async () => {
    await seed('user-a', 100);
    await seed('user-a', 50);
    const result = await usageEventRepository.findDailySpendByUser('user-a', today());
    expect(result).toBe(150);
  });

  it('does not add writtenOffCredits on top of creditsCharged', async () => {
    await seed('user-a', 100, 20);
    await seed('user-a', 50);
    const result = await usageEventRepository.findDailySpendByUser('user-a', today());
    expect(result).toBe(150); // 100 + 50; the write-off is part of the 100
  });

  it('excludes events before the since date', async () => {
    const yesterday = new Date(today().getTime() - 1);
    await seed('user-a', 999, undefined, yesterday);
    await seed('user-a', 50);
    const result = await usageEventRepository.findDailySpendByUser('user-a', today());
    expect(result).toBe(50);
  });

  it('does not count events from another user', async () => {
    await seed('user-b', 999);
    await seed('user-a', 50);
    const result = await usageEventRepository.findDailySpendByUser('user-a', today());
    expect(result).toBe(50);
  });

  it('excludes organization-funded usage by the same actor', async () => {
    await seed('user-a', 50);
    await UsageEvent.create({
      ...baseEvent,
      requestId: 'org-funded-turn',
      userId: 'user-a',
      // Deliberate collision also pins ownerType; ownerId alone must not match.
      ownerId: 'user-a',
      ownerType: CreditHolderType.Organization,
      creditsCharged: 999,
    });

    expect(await usageEventRepository.findDailySpendByUser('user-a', today())).toBe(50);
  });

  it('counts by personal billing owner rather than the actor', async () => {
    await UsageEvent.create({
      ...baseEvent,
      requestId: 'different-actor-turn',
      userId: 'user-b',
      ownerId: 'user-a',
      creditsCharged: 75,
    });

    expect(await usageEventRepository.findDailySpendByUser('user-a', today())).toBe(75);
    expect(await usageEventRepository.findDailySpendByUser('user-b', today())).toBe(0);
  });
});

describe('UsageEventRepository.systemCostUsdByUserSince', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await connectTestDB();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB(mongoServer);
  }, 30000);

  beforeEach(async () => {
    await UsageEvent.deleteMany({});
  });

  const since = new Date('2026-10-30T00:00:00.000Z');
  let seedIndex = 0;
  const seed = (overrides: Record<string, unknown>) =>
    UsageEvent.create({
      requestId: `sys-${++seedIndex}`,
      userId: 'user-a',
      ownerId: 'user-a',
      ownerType: CreditHolderType.User,
      feature: 'operations',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      source: 'system',
      status: 'ok',
      costUsd: 0.02,
      creditsCharged: 0,
      createdAt: new Date('2026-10-30T06:00:00.000Z'),
      ...overrides,
    });

  it('returns 0 when the user has no system-sourced events', async () => {
    expect(await usageEventRepository.systemCostUsdByUserSince('user-a', since)).toBe(0);
  });

  it('sums cost of system-sourced events since the date, charged or not, for the acting user only', async () => {
    await seed({});
    await seed({ creditsCharged: 3, costUsd: 0.03 });
    await seed({ ownerId: 'org-1', ownerType: CreditHolderType.Organization, costUsd: 0.05 });
    await seed({ source: 'web', costUsd: 9 });
    await seed({ createdAt: new Date('2026-10-29T23:59:59.999Z'), costUsd: 9 });
    await seed({ userId: 'user-b', ownerId: 'user-b', costUsd: 9 });

    expect(await usageEventRepository.systemCostUsdByUserSince('user-a', since)).toBeCloseTo(0.1, 10);
  });
});
