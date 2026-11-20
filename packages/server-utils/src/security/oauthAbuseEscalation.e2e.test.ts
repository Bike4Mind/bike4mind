import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { BlockedIP, blockedIPRepository, type IAuthFailLogDocument } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import { runOauthAbuseAutoBlock, type OauthAbusePolicy } from './oauthAbuseAutoBlock';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
beforeEach(async () => {
  await BlockedIP.deleteMany({});
  await mongoose.model<IAuthFailLogDocument>('AuthFailLog').deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const MIN = 60_000;
const policy: OauthAbusePolicy = {
  enabled: true,
  threshold: 20,
  windowMs: 10 * MIN,
  escalationMs: [10 * MIN, 60 * MIN, 1440 * MIN],
  lookbackMs: 24 * 60 * MIN,
};

it('keeps a persistent attacker at the last step with the default schedule', async () => {
  const ip = '7.7.7.7';
  let now = new Date('2026-01-01T00:00:00Z');
  const durations: number[] = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    const result = await runOauthAbuseAutoBlock({
      now,
      deps: {
        loadPolicy: async () => policy,
        getIPsWithHighAttempts: async () => [{ ip, attempts: 25 }],
        countAttemptsSince: async () => 25,
        findLatestBlock: i => blockedIPRepository.findLatestBlock(i),
        // Stamps the block at the simulated time; the repository's block() always uses the wall clock.
        block: async (i, reason, o) => {
          await BlockedIP.create({
            ip: i,
            reason,
            active: true,
            blockedAt: now,
            expiresAt: new Date(now.getTime() + o.durationMs),
            source: o.source,
            escalationLevel: o.escalationLevel,
          });
          return { created: true };
        },
      },
    });
    durations.push(result.blocked[0].durationMs / MIN);
    // The attacker returns one minute after the block lapses.
    now = new Date(now.getTime() + result.blocked[0].durationMs + MIN);
  }
  expect(durations).toEqual([10, 60, 1440, 1440, 1440, 1440]);
});

const reasonCases = [
  { reason: 'state_invalid', shouldBlock: false },
  { reason: 'state_missing', shouldBlock: false },
  { reason: 'registration_closed', shouldBlock: true },
  { reason: 'duplicate_account', shouldBlock: true },
  { reason: 'forbidden_system_user', shouldBlock: true },
] as const;

async function seedFailures(ip: string, reason: string, createdAt: Date, strategy = 'google'): Promise<void> {
  await mongoose
    .model<IAuthFailLogDocument>('AuthFailLog')
    .insertMany(Array.from({ length: policy.threshold }, () => ({ ip, reason, strategy, createdAt })));
}

it.each(['google', 'facebook', 'github'].flatMap(strategy => reasonCases.map(testCase => ({ strategy, ...testCase }))))(
  'initial query: $strategy $reason shouldBlock=$shouldBlock',
  async ({ strategy, reason, shouldBlock }) => {
    const now = new Date();
    const ip = '203.0.113.10';
    await seedFailures(ip, reason, new Date(now.getTime() - MIN), strategy);

    const result = await runOauthAbuseAutoBlock({ now, deps: { loadPolicy: async () => policy } });

    expect(result.blocked.map(block => block.ip)).toEqual(shouldBlock ? [ip] : []);
    expect(await BlockedIP.countDocuments({ ip, active: true })).toBe(shouldBlock ? 1 : 0);
  }
);

it.each(
  ['expired', 'admin-unblocked'].flatMap(previousState => reasonCases.map(testCase => ({ previousState, ...testCase })))
)('recount after $previousState: $reason shouldBlock=$shouldBlock', async ({ previousState, reason, shouldBlock }) => {
  const now = new Date();
  const ip = '203.0.113.20';
  const endedAt = new Date(now.getTime() - 3 * MIN);
  const expired = previousState === 'expired';
  await BlockedIP.create({
    ip,
    active: false,
    blockedAt: new Date(now.getTime() - 8 * MIN),
    expiresAt: expired ? endedAt : new Date(now.getTime() + 10 * MIN),
    ...(expired ? {} : { unblockedAt: endedAt }),
    source: 'auto',
    escalationLevel: 0,
  });
  // These older refusals force the candidate query to return this IP. Only the later rows may
  // trigger a new block, so the test also detects a missing reason filter in the recount query.
  await seedFailures(ip, 'registration_closed', new Date(now.getTime() - 5 * MIN));
  await seedFailures(ip, reason, new Date(now.getTime() - MIN));

  const result = await runOauthAbuseAutoBlock({ now, deps: { loadPolicy: async () => policy } });

  expect(result.blocked.map(block => block.ip)).toEqual(shouldBlock ? [ip] : []);
  expect(await BlockedIP.countDocuments({ ip, active: true })).toBe(shouldBlock ? 1 : 0);
  if (shouldBlock) {
    expect(result.blocked[0]).toMatchObject({ attempts: policy.threshold, escalationLevel: expired ? 1 : 0 });
  }
});
