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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seed: partial usage event
  const seed = (userId: string, creditsCharged: number, writtenOff?: number, at?: Date): Promise<any> => {
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

  it('includes writtenOffCredits in the total', async () => {
    await seed('user-a', 100, 20);
    await seed('user-a', 50);
    const result = await usageEventRepository.findDailySpendByUser('user-a', today());
    expect(result).toBe(170); // 100+20 + 50
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
});
