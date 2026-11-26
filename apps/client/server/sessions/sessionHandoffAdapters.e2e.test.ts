import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { Connection, pushTokenRepository } from '@bike4mind/database';
import { sessionHandoffAdapters } from './sessionHandoffAdapters';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  mongoServer = await createMongoReplSet();
  await mongoose.connect(mongoServer.getUri());
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Connection.collection.deleteMany({});
});

const future = () => new Date(Date.now() + 60_000);
const row = (connectionId: string, overrides: Record<string, unknown> = {}) => ({
  connectionId,
  userId: 'caller',
  source: 'web',
  sid: `sid-${connectionId}`,
  handoffPlatform: 'desktop',
  handoffName: 'My Mac',
  handoffClientId: `client-${connectionId}`,
  authExpiresAt: future(),
  ...overrides,
});

describe('sessionHandoffAdapters.destinations', () => {
  it("returns only the caller's live, session-bound, non-API-key web connections", async () => {
    vi.spyOn(pushTokenRepository, 'findByUser').mockResolvedValue([]);
    await Connection.insertMany([
      row('mine'),
      row('other-user', { userId: 'someone-else' }),
      row('api-key', { apiKeyId: 'key-1' }),
      row('cli', { source: 'cli' }),
      row('no-platform', { handoffPlatform: undefined }),
      row('ended', { endedAt: new Date() }),
    ]);

    const result = await sessionHandoffAdapters.destinations('caller');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      connectionId: 'mine',
      platform: 'desktop',
      clientId: 'client-mine',
      sid: 'sid-mine',
      available: true,
    });
  });

  it('omits a connection that has no session id', async () => {
    vi.spyOn(pushTokenRepository, 'findByUser').mockResolvedValue([]);
    await Connection.insertMany([row('mine'), row('no-sid', { sid: undefined })]);

    const result = await sessionHandoffAdapters.destinations('caller');

    expect(result.map(r => (r as { connectionId?: string }).connectionId)).toEqual(['mine']);
  });
});
