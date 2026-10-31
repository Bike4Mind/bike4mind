import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IUserDocument } from '@bike4mind/common';
import { AdminSettings, mongoose, UsageEvent, usageEventRepository } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { checkFreeTierDailySpendCap, isFreeTierDailyCapError } from './freeTierDailyCapGate';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The tier comes from subscription reads this suite is not about; the settings and usage reads are real.
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateTier: async () => 'free' }));

let mongoServer: Awaited<ReturnType<typeof createMongoServer>>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<
  typeof checkFreeTierDailySpendCap
>[0]['logger'];
const user = (id: string) =>
  ({ id, createdAt: new Date('2025-01-01T00:00:00Z'), isAdmin: false, tags: [] }) as unknown as IUserDocument;

let seedIndex = 0;
const seedSystemCost = (userId: string, costUsd: number, overrides: Record<string, unknown> = {}) =>
  UsageEvent.create({
    requestId: `gate-e2e-${++seedIndex}`,
    userId,
    ownerId: userId,
    ownerType: CreditHolderType.User,
    feature: 'operations',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    source: 'system',
    status: 'ok',
    costUsd,
    creditsCharged: 0,
    ...overrides,
  });

const gate = (id: string) =>
  checkFreeTierDailySpendCap({ user: user(id), usageEventRepository, logger, billingOrganizationId: null });

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  // Seeded before the first settings read, since the settings map is cached per process.
  await AdminSettings.create([
    { settingName: 'enforceCredits', settingValue: true },
    { settingName: 'freeTierDailySpendCapCredits', settingValue: 0 },
    { settingName: 'freeTierDailySystemCostCapUsd', settingValue: 0.1 },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('free-tier daily system cost cap against real settings and usage events', () => {
  it('admits a free user under the cap, counting only system-sourced cost since UTC midnight', async () => {
    await seedSystemCost('under', 0.05);
    await seedSystemCost('under', 5, { source: 'web' });
    await seedSystemCost('under', 5, { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });

    await expect(gate('under')).resolves.toBeUndefined();
  });

  it('refuses a free user whose uncharged system work reached the cap, with a Retry-After to UTC midnight', async () => {
    await seedSystemCost('over', 0.06);
    await seedSystemCost('over', 0.04, { ownerId: 'org-1', ownerType: CreditHolderType.Organization });

    const error = await gate('over').catch((caught: unknown) => caught);

    expect(isFreeTierDailyCapError(error)).toBe(true);
    const retryAfter = (error as { additionalInfo?: { retryAfter?: number } }).additionalInfo?.retryAfter ?? 0;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
  });
});
