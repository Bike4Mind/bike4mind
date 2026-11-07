import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AuthSessionModel, authSessionRepository, PushTokenModel, pushTokenRepository } from '@bike4mind/database';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { deliverPush } from './sendPush';
import type { ApnsRequest, ApnsResponse, ApnsTransport } from './sendPush.apns';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const USER_ID = new mongoose.Types.ObjectId().toString();

const createSession = (sid: string, expiresAt: Date) =>
  AuthSessionModel.create({
    sid,
    userId: USER_ID,
    refreshTokenHash: `hash-${sid}`,
    createdVia: 'otc',
    lastUsedAt: new Date(),
    expiresAt,
  });

beforeEach(async () => {
  await PushTokenModel.deleteMany({});
  await AuthSessionModel.deleteMany({});
  const tomorrow = new Date(Date.now() + 86_400_000);
  await createSession('sid-1', tomorrow);
  await createSession('sid-2', tomorrow);
});

const logger = { info: vi.fn(), warn: vi.fn() };

const event = {
  userId: USER_ID,
  category: 'chat_completed' as const,
  title: 'Q3 plan',
  body: 'Here is the summary you asked for.',
  deepLink: 'https://app.example.test/notebooks/s1',
  questId: 'q1',
  sessionId: 's1',
};

const register = (token: string, overrides: Record<string, unknown> = {}) =>
  pushTokenRepository.upsert({
    userId: USER_ID,
    sid: 'sid-1',
    kind: 'device',
    platform: 'ios',
    environment: 'production',
    token,
    ...overrides,
  });

function mockTransport(respond: (request: ApnsRequest) => ApnsResponse = () => ({ status: 200 })) {
  const transport: ApnsTransport & { send: ReturnType<typeof vi.fn> } = {
    send: vi.fn(async (request: ApnsRequest) => respond(request)),
    close: vi.fn(),
  };
  return transport;
}

const depsWith = (transport: ApnsTransport) => ({
  tokens: pushTokenRepository,
  sessions: authSessionRepository,
  loadRecipient: async () => ({ preferences: undefined, redactContent: false }),
  transport,
  topic: 'com.example.client',
});

describe('deliverPush against stored push tokens', () => {
  it('succeeds as a no-op for a user with no device tokens', async () => {
    const transport = mockTransport();

    await expect(deliverPush(event, depsWith(transport), logger)).resolves.toEqual({
      status: 'skipped',
      reason: 'no_tokens',
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('ignores Live Activity tokens: only device tokens receive alerts', async () => {
    await register('activity-token', { kind: 'liveActivity', activityId: 'a1' });
    const transport = mockTransport();

    await expect(deliverPush(event, depsWith(transport), logger)).resolves.toMatchObject({ reason: 'no_tokens' });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('deletes a token APNs reports Unregistered and keeps the healthy one', async () => {
    await register('dead-token');
    await register('live-token', { environment: 'sandbox', sid: 'sid-2' });
    const transport = mockTransport(request =>
      request.deviceToken === 'dead-token' ? { status: 410, reason: 'Unregistered' } : { status: 200 }
    );

    await expect(deliverPush(event, depsWith(transport), logger)).resolves.toEqual({
      status: 'sent',
      delivered: 1,
      pruned: 1,
      failed: 1,
    });
    const remaining = await PushTokenModel.find({}).lean();
    expect(remaining.map(row => row.token)).toEqual(['live-token']);
    expect(transport.send.mock.calls.map(([request]) => [request.deviceToken, request.environment]).sort()).toEqual([
      ['dead-token', 'production'],
      ['live-token', 'sandbox'],
    ]);
  });

  it('prunes tokens of an expired or deleted session without sending to them', async () => {
    // Expired but not yet reaped by the TTL monitor, and already reaped (no row): both are ended sessions.
    await createSession('sid-expired', new Date(Date.now() - 1_000));
    await register('live-token');
    await register('expired-token', { sid: 'sid-expired' });
    await register('reaped-token', { sid: 'sid-reaped' });
    const transport = mockTransport();

    await expect(deliverPush(event, depsWith(transport), logger)).resolves.toEqual({
      status: 'sent',
      delivered: 1,
      pruned: 2,
      failed: 0,
    });
    expect(transport.send.mock.calls.map(([request]) => request.deviceToken)).toEqual(['live-token']);
    const remaining = await PushTokenModel.find({}).lean();
    expect(remaining.map(row => row.token)).toEqual(['live-token']);
  });

  it('prunes a revoked session and reports no tokens when none are left', async () => {
    await register('revoked-token');
    await AuthSessionModel.updateOne({ sid: 'sid-1' }, { $set: { revokedAt: new Date() } });
    const transport = mockTransport();

    await expect(deliverPush(event, depsWith(transport), logger)).resolves.toEqual({
      status: 'skipped',
      reason: 'no_tokens',
    });
    expect(transport.send).not.toHaveBeenCalled();
    expect(await PushTokenModel.countDocuments({})).toBe(0);
  });
});
