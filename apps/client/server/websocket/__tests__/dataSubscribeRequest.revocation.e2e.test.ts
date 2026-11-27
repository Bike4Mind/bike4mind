import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  Connection,
  Session,
  User,
  fabFileRepository,
  projectRepository,
  realtimeConnectionRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { QuerySubscription } from '../../../../../packages/database/src/models/social/QuerySubscriptionModel';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../packages/database/src/__test__/createMongoServer';

const transport = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn() }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://websocket.example.test' } } }));
vi.mock('@bike4mind/server-utils/websocket/closeConnection', () => ({ closeConnection: transport.close }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({
  sendToConnection: transport.send,
  withWebSocketContext: (handler: unknown) => handler,
}));
vi.mock('@server/websocket/verifyWsAccessToken', () => ({ verifyWsSubscriberToken: vi.fn() }));

import { verifyWsSubscriberToken } from '../verifyWsAccessToken';
import { func } from '../dataSubscribeRequest';
import { rescopeUserSubscriptions } from '../rescopeUserSubscriptions';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let replSet: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;
const logger = Logger.globalInstance;
const connectionId = 'revocation-fixture';

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all([Connection, QuerySubscription, Session, User].map(model => model.collection.deleteMany({})));
});

function latch() {
  let release: () => void = () => {
    throw new Error('Latch not initialized');
  };
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  const ownerId = new mongoose.Types.ObjectId().toString();
  const recipientId = new mongoose.Types.ObjectId().toString();
  const sessionId = new mongoose.Types.ObjectId();
  await User.collection.insertMany(
    [ownerId, recipientId].map(id => ({
      _id: new mongoose.Types.ObjectId(id),
      username: id,
      name: 'fixture',
      email: `${id}@example.test`,
      groups: [],
    }))
  );
  await Session.collection.insertOne({
    _id: sessionId,
    userId: ownerId,
    name: 'Shared fixture',
    users: [{ userId: recipientId, permissions: ['read', 'write'] }],
    groups: [],
    knowledgeIds: [],
    __v: 0,
  });
  await Connection.create({ connectionId, userId: recipientId });
  const user = await User.findById(recipientId);
  if (!user) throw new Error('Missing fixture user');
  vi.mocked(verifyWsSubscriberToken).mockResolvedValue(user);
  transport.send.mockResolvedValue(undefined);
  transport.close.mockResolvedValue(undefined);
  const subscribe = (fetchInitialData: boolean) =>
    func(
      {
        requestContext: { connectionId },
        body: JSON.stringify({
          action: 'subscribe_query',
          accessToken: 'fixture',
          subscriptionId: 'fixture',
          collectionName: Session.collection.collectionName,
          query: { _id: sessionId.toString() },
          fields: {},
          fetchInitialData,
        }),
      } as never,
      {} as never,
      logger
    );
  const revoke = async () => {
    const actors = await withTransaction(async () => {
      const removed = new Set<string>();
      await sharingService.revoke(
        ownerId,
        { id: sessionId.toString(), type: 'sessions', userId: recipientId },
        {
          db: {
            users: userRepository,
            sessions: sessionRepository,
            fabFiles: fabFileRepository,
            projects: projectRepository,
          },
          onAccessRemoved: ids => ids.forEach(id => removed.add(id)),
        }
      );
      return [...removed];
    });
    expect(actors).toContain(recipientId);
    await rescopeUserSubscriptions(actors, logger);
  };
  return { subscribe, revoke };
}

describe('committed share loss fences real in-flight subscriptions', () => {
  it('keeps an admitted live subscription working before access removal', async () => {
    const { subscribe } = await fixture();
    await subscribe(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(await QuerySubscription.countDocuments({ 'subscribers.connectionId': connectionId })).toBe(1);
  });

  it('backs out a subscriber whose database write lands after the revoke fence', async () => {
    const { subscribe, revoke } = await fixture();
    const entered = latch();
    const resume = latch();
    const upsert = realtimeConnectionRepository.upsertSubscriber.bind(realtimeConnectionRepository);
    vi.spyOn(realtimeConnectionRepository, 'upsertSubscriber').mockImplementationOnce(async (...args) => {
      entered.release();
      await resume.promise;
      await upsert(...args);
    });
    const pending = subscribe(false);
    const outcome = pending.then(
      () => null,
      (error: unknown) => error
    );
    await entered.promise;
    try {
      await revoke();
    } finally {
      resume.release();
    }
    expect(await outcome).toMatchObject({ message: 'Connection is not registered to this user' });
    expect(await Connection.countDocuments({ connectionId })).toBe(0);
    expect(await QuerySubscription.countDocuments({ 'subscribers.connectionId': connectionId })).toBe(0);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('drops an initial read captured before revocation when it resolves after the fence', async () => {
    const { subscribe, revoke } = await fixture();
    const entered = latch();
    const resume = latch();
    const find = Session.find.bind(Session);
    vi.spyOn(Session, 'find').mockImplementationOnce((...args) => {
      const query = find(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        const result = await execute();
        expect(result).toHaveLength(1);
        entered.release();
        await resume.promise;
        return result;
      };
      return query;
    });
    const pending = subscribe(true);
    const outcome = pending.then(
      () => null,
      (error: unknown) => error
    );
    await entered.promise;
    try {
      await revoke();
    } finally {
      resume.release();
    }
    expect(await outcome).toMatchObject({ message: 'Connection is not registered to this user' });
    expect(transport.send).not.toHaveBeenCalled();
    expect(await QuerySubscription.countDocuments({ 'subscribers.connectionId': connectionId })).toBe(0);
  });
});
