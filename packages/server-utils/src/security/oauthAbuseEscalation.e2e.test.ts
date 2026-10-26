import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { BlockedIP, blockedIPRepository } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import { runOauthAbuseAutoBlock, type OauthAbusePolicy } from './oauthAbuseAutoBlock';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
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
          const doc = await BlockedIP.create({
            ip: i,
            reason,
            active: true,
            blockedAt: now,
            expiresAt: new Date(now.getTime() + o.durationMs),
            source: o.source,
            escalationLevel: o.escalationLevel,
          });
          return doc;
        },
      },
    });
    durations.push(result.blocked[0].durationMs / MIN);
    // The attacker returns one minute after the block lapses.
    now = new Date(now.getTime() + result.blocked[0].durationMs + MIN);
  }
  expect(durations).toEqual([10, 60, 1440, 1440, 1440, 1440]);
});
