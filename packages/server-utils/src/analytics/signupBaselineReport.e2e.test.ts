import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { CounterLog, CreditTransaction, Quest, Session, UsageEvent, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import { runSignupBaselineReport } from './signupBaselineReport';

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
const at = (value: string) => new Date(value);
const signup = at('2026-10-02T10:00:00Z');
const idAt = (date: Date) =>
  new mongoose.Types.ObjectId(
    Math.floor(date.getTime() / 1000)
      .toString(16)
      .padStart(8, '0') + new mongoose.Types.ObjectId().toHexString().slice(8)
  );

it('runs the read-only census against persisted data without leaking content or counting API/copy activity', async () => {
  const active = new mongoose.Types.ObjectId();
  const silent = new mongoose.Types.ObjectId();
  const staff = new mongoose.Types.ObjectId();
  const api = new mongoose.Types.ObjectId();
  const copied = new mongoose.Types.ObjectId();
  const accountIds = [active, silent, staff, api, copied];
  await User.collection.insertMany(
    accountIds.map((_id, index) => ({
      _id,
      createdAt: signup,
      email: index === 2 ? 'person@staff.example.org' : `person${index}@example.org`,
      acquisition: { signupMethod: 'google', capturedAt: signup },
      currentCredits: 999999,
    }))
  );
  const session = new mongoose.Types.ObjectId();
  const apiSession = new mongoose.Types.ObjectId();
  await Session.collection.insertMany([
    { _id: session, userId: String(active), firstCreated: signup, name: 'SECRET_NOTEBOOK_TITLE' },
    { _id: apiSession, userId: String(api), firstCreated: signup, origin: { channel: 'api' } },
  ]);
  const messageAt = at('2026-10-02T10:02:00Z');
  await Quest.collection.insertMany([
    {
      _id: idAt(messageAt),
      type: 'error',
      timestamp: messageAt,
      sessionId: String(session),
      promptMeta: { session: { userId: String(active) } },
      prompt: 'SECRET_PROMPT',
      reply: 'SECRET_REPLY',
    },
    {
      _id: idAt(messageAt),
      type: 'message',
      timestamp: messageAt,
      sessionId: String(apiSession),
      promptMeta: { session: { userId: String(api) } },
    },
    {
      _id: idAt(at('2026-10-05T00:00:00Z')),
      type: 'message',
      timestamp: messageAt,
      sessionId: 'copied',
      promptMeta: { session: { userId: String(copied) } },
    },
  ]);
  const apiReturnAt = at('2026-10-12T10:00:00Z');
  await Quest.collection.insertOne({
    _id: idAt(apiReturnAt),
    type: 'message',
    timestamp: apiReturnAt,
    sessionId: String(apiSession),
    promptMeta: { session: { userId: String(api) } },
  });
  await UsageEvent.collection.insertMany([
    { userId: String(active), status: 'ok', source: 'web', createdAt: at('2026-10-12T00:00:00Z') },
    { userId: String(silent), status: 'ok', source: 'api', createdAt: at('2026-10-12T00:00:00Z') },
    { userId: String(silent), status: 'ok', source: 'web', createdAt: at('2026-10-22T00:00:00Z') },
  ]);
  await CreditTransaction.collection.insertMany([
    {
      ownerId: String(active),
      ownerType: 'User',
      type: 'generic_add',
      credits: 100,
      transactionId: `verify-grant:${active}`,
      createdAt: messageAt,
    },
    {
      ownerId: String(silent),
      ownerType: 'User',
      type: 'generic_add',
      credits: 5000,
      transactionId: 'unrelated',
      createdAt: messageAt,
    },
  ]);
  await CounterLog.collection.insertMany([
    {
      userId: String(active),
      counterName: 'User Login',
      datetime: signup,
      metadata: { prompt: 'SECRET_EVENT_METADATA' },
    },
    { userId: String(active), counterName: 'SECRET_EVENT_NAME', datetime: signup },
  ]);
  const collections = [User, Session, Quest, UsageEvent, CreditTransaction, CounterLog];
  const before = await Promise.all(collections.map(model => model.collection.countDocuments()));
  const result = await runSignupBaselineReport({
    since: at('2026-10-01T00:00:00Z'),
    until: at('2026-10-20T00:00:00Z'),
    staffDomains: 'staff.example.org',
  });
  expect(result.total.signups).toBe(4);
  expect(result.bySignupPath[0].signupPath).toBe('google');
  expect(result.total.sentFirstMessage.count).toBe(1);
  expect(result.total.firstSessionSent.count).toBe(1);
  expect(result.census.find(row => row.userId === String(active))?.timeline).toContainEqual(
    expect.objectContaining({ kind: 'message_sent', outcome: 'failed' })
  );
  // The existing report's public-chat API classification gap remains disclosed, but the census
  // can identify a known API notebook and never calls it a first session or first message.
  expect(result.census.find(row => row.userId === String(api))?.firstSession).toBeNull();
  expect(result.total.day7PlusActive).toMatchObject({ count: 1, total: 4 });
  expect(result.total.recordedSignupGrantCredits).toEqual({ '100': 1, unknown: 3 });
  expect(result.trailing90Days.signups).toBe(4);
  expect(JSON.stringify(result)).not.toContain('SECRET_');
  expect(JSON.stringify(result)).not.toContain('@example.org');
  expect(JSON.stringify(result)).not.toContain('999999');
  expect(await Promise.all(collections.map(model => model.collection.countDocuments()))).toEqual(before);
});

it('reads message attempts once across multiple account batches', async () => {
  const createdAt = at('2026-11-01T10:00:00Z');
  const accountIds = Array.from({ length: 501 }, () => new mongoose.Types.ObjectId());
  await User.collection.insertMany(accountIds.map(_id => ({ _id, createdAt, email: `${_id}@example.org` })));
  await Quest.collection.insertMany(
    [accountIds[0], accountIds[500]].map((userId, index) => ({
      _id: idAt(createdAt),
      type: index === 0 ? 'message' : 'error',
      timestamp: createdAt,
      sessionId: `batch-${index}`,
      promptMeta: { session: { userId: String(userId) } },
    }))
  );
  const questReads = vi.spyOn(Quest, 'find');
  try {
    const result = await runSignupBaselineReport({
      since: at('2026-11-01T00:00:00Z'),
      until: at('2026-11-10T00:00:00Z'),
      staffDomains: 'staff.example.org',
    });
    expect(result.total.signups).toBe(501);
    expect(result.total.sentFirstMessage.count).toBe(2);
    expect(result.census.find(row => row.userId === String(accountIds[500]))?.timeline).toContainEqual(
      expect.objectContaining({ kind: 'message_sent', outcome: 'failed' })
    );
    expect(questReads).toHaveBeenCalledTimes(1);
  } finally {
    questReads.mockRestore();
  }
});
