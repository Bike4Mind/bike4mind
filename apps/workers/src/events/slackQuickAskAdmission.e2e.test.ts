import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { EventBridgeEvent } from 'aws-lambda';
import type { ITokenizer } from '@bike4mind/utils';
import type { QuickAskRequestedDetail, ISlackServerDependencies, ISlackDatabaseDependencies } from '@bike4mind/slack';
import {
  createMongoServer,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const boundary = vi.hoisted(() => {
  process.env.APP_URL ??= 'https://example.invalid';
  return {
    open: vi.fn<(input: unknown) => Promise<unknown>>(),
    post: vi.fn<(input: unknown) => Promise<unknown>>(),
    update: vi.fn<(input: unknown) => Promise<unknown>>(),
    invoke: vi.fn<(input: unknown) => Promise<void>>(),
    workspace: vi.fn<(id: string) => Promise<{ id: string; slackBotToken: string } | null>>(),
    decrypt: vi.fn<(token: string) => string>(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
  };
});

vi.mock('@slack/web-api', async importOriginal => ({
  ...(await importOriginal<typeof import('@slack/web-api')>()),
  WebClient: class {
    conversations = { open: boundary.open };
    chat = { postMessage: boundary.post, update: boundary.update };
  },
}));
vi.mock('@bike4mind/services/llm/ChatCompletionInvoke', () => ({
  ChatCompletionInvoke: class {
    invoke = boundary.invoke;
  },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  // The actual processor constructs a queue before the fake paid boundary. No AWS calls here.
  SQSService: class {},
}));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  // Keep the real Cache, User, Session, Quest and authorization; isolate credentials only.
  slackDevWorkspaceRepository: { findByIdWithCredentials: boundary.workspace },
}));
vi.mock('@bike4mind/server-utils/lib/settings/registerContributedSettings', () => ({}));
vi.mock('@bike4mind/server-utils/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: boundary.decrypt }));
vi.mock('@workers/utils/eventContext', () => ({
  withEventContext:
    (callback: (event: { event: string; properties: unknown }, logger: typeof boundary.logger) => Promise<void>) =>
    (raw: EventBridgeEvent<string, unknown>) =>
      callback({ event: raw['detail-type'], properties: raw.detail }, boundary.logger),
}));

import { Cache, Quest, Session, User, cacheRepository, defineAbilitiesFor } from '@bike4mind/database';
import { configureSlackPackage } from '@bike4mind/slack';
import { addMessageToSession } from '@bike4mind/server-utils/managers/sessionManager';
import { handler } from './slackQuickAsk';
import { claimQuickAskDelivery, QUICK_ASK_CLAIM_TTL_MS, QUICK_ASK_MAX_EVENT_AGE_MS } from './slackQuickAskAdmission';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongo: MongoMemoryServer;
let ownerId: string;
let notebookId: string;
const workspaceA = 'workspace-a';
const workspaceB = 'workspace-b';
const unexpected = (): never => {
  throw new Error('Unexpected fixture dependency');
};
const tokenizer: ITokenizer = {
  countTokens: async () => 0,
  encodeTokens: async () => [],
  decodeTokens: async () => '',
};

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  // Unlike an in-memory fake, this must enforce both real key uniqueness and TTL schema.
  await Cache.createIndexes();
  const indexes = await Cache.collection.indexes();
  expect(indexes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: { key: 1 }, unique: true }),
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    ])
  );

  // Same narrow unused-DI boundary as sessionFilePersistence.e2e.test.ts. All dependencies
  // reached by this existing-notebook processor path are REAL except external transports.
  // In particular, do not replace addMessageToSession with a fake Quest.create wrapper.
  const server = {
    sessionManager: { createSession: unexpected, addMessageToSession },
    chatCompletionDefaults: { defaultChatCompletionOptions: {}, getSharedTokenizer: () => tokenizer },
    eventBus: { LLMEvents: { CompletionStart: { publish: unexpected } } },
  };
  const database = { User, Session, Quest, defineAbilitiesFor };
  configureSlackPackage(
    server as unknown as ISlackServerDependencies,
    database as unknown as ISlackDatabaseDependencies
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  // Remove physical fixtures; application deleteMany can soft-delete Quest/Session rows.
  await Promise.all([
    Cache.collection.deleteMany({}),
    Quest.collection.deleteMany({}),
    Session.collection.deleteMany({}),
    User.collection.deleteMany({}),
  ]);
  boundary.open.mockResolvedValue({ ok: true, channel: { id: 'D1' } });
  let timestamp = 0;
  boundary.post.mockImplementation(async () => ({ ok: true, ts: `${++timestamp}.000` }));
  boundary.update.mockResolvedValue({ ok: true });
  boundary.invoke.mockResolvedValue(undefined);
  boundary.workspace.mockImplementation(async id => ({ id, slackBotToken: 'encrypted-test-token' }));
  boundary.decrypt.mockReturnValue('xoxb-test-only');
  const owner = await User.create({ name: 'Owner', username: 'quick-ask-owner', email: 'quick-ask@example.com' });
  const notebook = await Session.create({
    userId: owner.id,
    name: 'Slack notebook',
    firstCreated: new Date(),
    lastUpdated: new Date(),
  });
  ownerId = owner.id;
  notebookId = notebook.id;
  await User.updateOne(
    { _id: ownerId },
    { $set: { slackSettings: { slackUserId: 'U1', defaultNotebookId: notebookId } } }
  );
});

function envelope(
  detail: Partial<QuickAskRequestedDetail> = {},
  raw: Partial<Pick<EventBridgeEvent<string, unknown>, 'id' | 'time'>> = {}
): EventBridgeEvent<string, QuickAskRequestedDetail> {
  const now = new Date().toISOString();
  return {
    version: '0',
    id: 'event-1',
    'detail-type': 'slack.quickAsk.requested',
    source: 'test',
    account: '000000000000',
    time: now,
    region: 'us-east-1',
    resources: [],
    ...raw,
    detail: {
      workspaceId: workspaceA,
      slackUserId: 'U1',
      b4mUserId: ownerId,
      question: 'a private question',
      requestId: 'view-1',
      requestedAt: now,
      ...detail,
    },
  };
}

async function expectOnePersistedDelivery() {
  expect(boundary.open).toHaveBeenCalledTimes(1);
  expect(boundary.post).toHaveBeenCalledTimes(2);
  expect(boundary.post).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ channel: 'D1', text: expect.stringContaining('a private question') })
  );
  expect(boundary.post).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ text: '🤔 Thinking...', thread_ts: '1.000' })
  );
  const quests = await Quest.find({ sessionId: notebookId }).lean();
  expect(quests).toHaveLength(1);
  const quest = quests[0];
  expect(quest.prompt).toBe('a private question');
  expect(quest.slackNotification).toEqual(
    expect.objectContaining({ workspaceId: workspaceA, channelId: 'D1', threadTs: '1.000', messageTs: '2.000' })
  );
  expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      userId: ownerId,
      authOrigin: 'internal',
      body: expect.objectContaining({ questId: String(quest._id), sessionId: notebookId }),
    })
  );
}

describe('raw worker delivery through actual processor and Quest persistence', () => {
  it('a sequential duplicate posts one question/thinking pair and persists/invokes once', async () => {
    const raw = envelope();
    await handler(raw);
    await handler(raw);
    await expectOnePersistedDelivery();
  });

  it('concurrent republication with the same new request pair admits exactly once', async () => {
    const raw = envelope();
    await Promise.all(Array.from({ length: 6 }, (_, index) => handler({ ...raw, id: `event-${index}` })));
    await expectOnePersistedDelivery();
  });

  it('distinct request IDs and workspaces do not suppress independent deliveries', async () => {
    await handler(envelope());
    await handler(envelope({ requestId: 'view-2' }, { id: 'event-2' }));
    await handler(envelope({ workspaceId: workspaceB }, { id: 'event-3' }));
    expect(await Quest.countDocuments({ sessionId: notebookId })).toBe(3);
    expect(boundary.invoke).toHaveBeenCalledTimes(3);
    expect(boundary.post).toHaveBeenCalledTimes(6);
    expect(await Cache.countDocuments({ key: /^slack-quick-ask:admission:/ })).toBe(3);
  });

  it('retains each invocation envelope when credential reads settle in reverse order', async () => {
    let releaseA: (() => void) | undefined;
    let enteredA: (() => void) | undefined;
    const entered = new Promise<void>(resolve => {
      enteredA = resolve;
    });
    const held = new Promise<void>(resolve => {
      releaseA = resolve;
    });
    boundary.workspace.mockImplementation(async id => {
      if (id === workspaceA) {
        enteredA?.();
        await held;
      }
      return { id, slackBotToken: 'encrypted-test-token' };
    });
    // Legacy identity specifically exercises raw.id capture rather than detail.requestId.
    const first = envelope({ requestId: undefined, requestedAt: undefined }, { id: 'raw-a' });
    const second = envelope({ workspaceId: workspaceB, requestId: undefined, requestedAt: undefined }, { id: 'raw-b' });
    const runningA = handler(first);
    try {
      await entered;
      await handler(second);
    } finally {
      releaseA?.();
    }
    await runningA;
    await handler(first);
    await handler(second);
    expect(await Quest.countDocuments({ sessionId: notebookId })).toBe(2);
    expect(boundary.invoke).toHaveBeenCalledTimes(2);
    for (const [workspaceId, eventId] of [
      [workspaceA, 'raw-a'],
      [workspaceB, 'raw-b'],
    ]) {
      const digest = createHash('sha256')
        .update(JSON.stringify([workspaceId, 'event', eventId]))
        .digest('hex');
      expect(await Cache.countDocuments({ key: `slack-quick-ask:admission:${digest}` })).toBe(1);
    }
  });

  it('legacy events deduplicate using their ORIGINAL raw id and time', async () => {
    const raw = envelope({ requestId: undefined, requestedAt: undefined });
    await handler(raw);
    await handler(raw);
    await expectOnePersistedDelivery();
  });

  it('failure after actual Quest insertion retains the admission claim', async () => {
    boundary.invoke.mockRejectedValueOnce(new Error('paid executor unavailable'));
    const raw = envelope();
    await handler(raw); // The actual processor catches this and sends an error notification.
    expect(await Quest.countDocuments({ sessionId: notebookId })).toBe(1);
    expect(boundary.invoke).toHaveBeenCalledTimes(1);
    const slackCalls = boundary.post.mock.calls.length;
    expect(slackCalls).toBeGreaterThanOrEqual(2);
    await handler({ ...raw, id: 'fresh-envelope-for-same-view' });
    expect(await Quest.countDocuments({ sessionId: notebookId })).toBe(1);
    expect(boundary.invoke).toHaveBeenCalledTimes(1);
    expect(boundary.post).toHaveBeenCalledTimes(slackCalls);
    expect(await Cache.countDocuments({ key: /^slack-quick-ask:admission:/ })).toBe(1);
  });

  it('missing legacy identity fails before Slack, Quest or paid work', async () => {
    const raw = envelope({ requestId: undefined, requestedAt: undefined }, { id: '' });
    await expect(handler(raw)).rejects.toThrow();
    expect(boundary.open).not.toHaveBeenCalled();
    expect(boundary.invoke).not.toHaveBeenCalled();
    expect(await Quest.countDocuments({})).toBe(0);
    expect(await Cache.countDocuments({})).toBe(0);
  });

  it('a cache failure is fail-closed before any processor side effect', async () => {
    vi.spyOn(cacheRepository, 'incrementCounterConditional').mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(handler(envelope())).rejects.toThrow('cache unavailable');
    expect(boundary.open).not.toHaveBeenCalled();
    expect(boundary.invoke).not.toHaveBeenCalled();
    expect(await Quest.countDocuments({})).toBe(0);
  });

  it('credential failure happens before claiming, preserving retry opportunity', async () => {
    boundary.decrypt.mockImplementationOnce(() => {
      throw new Error('cannot decrypt');
    });
    const raw = envelope();
    await expect(handler(raw)).rejects.toThrow('cannot decrypt');
    expect(await Cache.countDocuments({})).toBe(0);
    expect(boundary.open).not.toHaveBeenCalled();
    await handler(raw);
    await expectOnePersistedDelivery();
  });
});

describe('real Cache admission identity, age and metadata', () => {
  const now = new Date('2026-11-15T00:00:00.000Z');
  const atAge = (age: number) => new Date(now.getTime() - age).toISOString();

  it.each([
    ['exact 30 hours', QUICK_ASK_MAX_EVENT_AGE_MS, true],
    ['30 hours plus 1ms', QUICK_ASK_MAX_EVENT_AGE_MS + 1, false],
    ['exact future tolerance', -5 * 60_000, true],
    ['future tolerance plus 1ms', -5 * 60_000 - 1, false],
  ])('%s', async (_label, age, allowed) => {
    const claim = claimQuickAskDelivery(
      { workspaceId: workspaceA, requestId: 'bounds', requestedAt: atAge(age) },
      {},
      cacheRepository,
      now
    );
    if (allowed) await expect(claim).resolves.toBe(true);
    else await expect(claim).rejects.toThrow('admission window');
    expect(await Cache.countDocuments({})).toBe(allowed ? 1 : 0);
  });

  it('new request time dominates fresh raw envelope time and survives TTL deletion', async () => {
    const old = { workspaceId: workspaceA, requestId: 'old-view', requestedAt: atAge(8 * 24 * 60 * 60_000) };
    const raw = { id: 'new-event', time: now.toISOString() };
    await expect(claimQuickAskDelivery(old, raw, cacheRepository, now)).rejects.toThrow('admission window');
    await Cache.deleteMany({}); // Model physical TTL removal; no timer monkeypatch.
    await expect(claimQuickAskDelivery(old, { ...raw, id: 'newer-event' }, cacheRepository, now)).rejects.toThrow(
      'admission window'
    );
    expect(await Cache.countDocuments({})).toBe(0);
  });

  it('legacy admission requires a valid original envelope time, including the same age cap', async () => {
    const detail = { workspaceId: workspaceA };
    await expect(
      claimQuickAskDelivery(
        detail,
        { id: 'legacy-old', time: atAge(QUICK_ASK_MAX_EVENT_AGE_MS + 1) },
        cacheRepository,
        now
      )
    ).rejects.toThrow('admission window');
    await expect(
      claimQuickAskDelivery(detail, { id: 'legacy-invalid', time: 'not-a-date' }, cacheRepository, now)
    ).rejects.toThrow();
    expect(await Cache.countDocuments({})).toBe(0);
    expect(
      await claimQuickAskDelivery(
        detail,
        { id: 'legacy-exact', time: atAge(QUICK_ASK_MAX_EVENT_AGE_MS) },
        cacheRepository,
        now
      )
    ).toBe(true);
  });

  it.each([
    { requestId: 'one-sided' },
    { requestedAt: now.toISOString() },
    { requestId: 'malformed-time', requestedAt: 'not-a-date' },
  ])('rejects invalid identity pairs before creating a cache row: %j', async pair => {
    await expect(
      claimQuickAskDelivery(
        { workspaceId: workspaceA, ...pair },
        { id: 'valid', time: now.toISOString() },
        cacheRepository,
        now
      )
    ).rejects.toThrow();
    expect(await Cache.countDocuments({})).toBe(0);
  });

  it('retains 7-day metadata-only claim expiry without extending it on duplicates', async () => {
    const request = { workspaceId: workspaceA, requestId: 'view-with-private-data', requestedAt: now.toISOString() };
    const before = Date.now();
    expect(await claimQuickAskDelivery(request, {}, cacheRepository, now)).toBe(true);
    const after = Date.now();
    const digest = createHash('sha256')
      .update(JSON.stringify([workspaceA, 'request', request.requestId]))
      .digest('hex');
    const key = `slack-quick-ask:admission:${digest}`;
    const first = await Cache.findOne({ key }).lean();
    if (!first) throw new Error('Expected real admission row');
    expect(first.result).toEqual({ count: 1 });
    expect(first.expiresAt.getTime()).toBeGreaterThanOrEqual(before + QUICK_ASK_CLAIM_TTL_MS);
    expect(first.expiresAt.getTime()).toBeLessThanOrEqual(after + QUICK_ASK_CLAIM_TTL_MS);
    expect(
      await claimQuickAskDelivery(request, { id: 're-emitted', time: now.toISOString() }, cacheRepository, now)
    ).toBe(false);
    const duplicate = await Cache.findOne({ key }).lean();
    expect(duplicate?.expiresAt).toEqual(first.expiresAt);
    expect(duplicate?.result).toEqual({ count: 1 });
    expect(JSON.stringify(duplicate)).not.toContain('a private question');
    expect(JSON.stringify(duplicate)).not.toContain('xoxb-test-only');
    expect(JSON.stringify(duplicate)).not.toContain(ownerId);
    expect(first.key).not.toContain(request.requestId);
  });

  it('uses separate namespaces for legacy envelope IDs and new request IDs', async () => {
    const raw = { id: 'same-id', time: now.toISOString() };
    expect(await claimQuickAskDelivery({ workspaceId: workspaceA }, raw, cacheRepository, now)).toBe(true);
    expect(
      await claimQuickAskDelivery(
        { workspaceId: workspaceA, requestId: 'same-id', requestedAt: now.toISOString() },
        raw,
        cacheRepository,
        now
      )
    ).toBe(true);
    expect(await Cache.countDocuments({})).toBe(2);
  });
});
