import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Realtime voice frames against a real replica set: the per-response debit and the closing
// settlement each commit with their hold update and ledger row, or not at all.

const state = vi.hoisted(() => ({ userId: '' }));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: (handler: (...args: unknown[]) => unknown) => (event: unknown) =>
    handler(event, {}, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  sendToClient: vi.fn(),
}));
vi.mock('@server/websocket/connectionScope', () => ({ connectionHoldsScope: () => true }));
vi.mock('@server/voice/realtimeVoicePricing', () => ({ pickRealtimeVoiceTier: () => ({ tier: {} }) }));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // One credit per audio output token keeps the arithmetic readable.
  computeRealtimeVoiceUsd: (_tier: unknown, usage: { audioOutputTokens: number }) => usage.audioOutputTokens,
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usdToCreditsStochastic: (usd: number) => usd,
  getSettingsMap: async () => ({}),
  getSettingsValue: () => true,
}));
vi.mock('@bike4mind/services', async () => {
  const { Session } = await import('@bike4mind/database');
  return {
    sessionService: {
      getSession: async (_userId: string, { id }: { id: string }) => {
        const doc = await Session.findById(id).lean();
        return doc ? { ...doc, id: doc._id.toString() } : null;
      },
    },
  };
});
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Connection: { findOne: async () => ({ userId: state.userId }) },
    modelPriceRepository: { rowsInForce: async () => [] },
    usageEventRepository: { record: () => Promise.resolve() },
  };
});

import { CreditTransaction, Session, User, creditTransactionRepository, userRepository } from '@bike4mind/database';
import { CreditHolderType } from '@bike4mind/common';
import { func } from './voiceSessionEnded';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await CreditTransaction.createIndexes();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

const HOLD = 100;
const STARTING_BALANCE = 1000;

async function seedCall() {
  const user = await User.create({
    name: 'Caller',
    username: `caller-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    // The bootstrap already took the hold out of the balance.
    currentCredits: STARTING_BALANCE - HOLD,
  });
  state.userId = user.id;
  const startedAt = new Date(Date.now() - 60_000);
  const session = await Session.create({
    name: 'Voice',
    userId: user.id,
    firstCreated: startedAt,
    lastUpdated: startedAt,
    voiceReservedCredits: HOLD,
    voiceSessionStartedAt: startedAt,
    voiceBilledCredits: 0,
  });
  return { userId: user.id as string, sessionId: session.id as string };
}

const send = (call: { userId: string; sessionId: string }, audioOutputTokens: number, responseId?: string) =>
  (func as unknown as (event: unknown) => Promise<unknown>)({
    requestContext: { connectionId: 'c1', domainName: 'ws.example', stage: 'test' },
    body: JSON.stringify({
      action: 'voice_session_ended',
      userId: call.userId,
      sessionId: call.sessionId,
      model: 'gpt-realtime',
      ...(responseId ? { responseId } : {}),
      usage: {
        audioInputTokens: 0,
        audioCachedInputTokens: 0,
        audioOutputTokens,
        textInputTokens: 0,
        textCachedInputTokens: 0,
        textOutputTokens: 0,
      },
    }),
  });

const charged = async (userId: string) =>
  STARTING_BALANCE - ((await User.findById(userId).lean())?.currentCredits ?? 0);
const ledger = (sessionId: string) => CreditTransaction.find({ sessionId }).lean();
const hold = async (sessionId: string) => Session.findById(sessionId).lean();

describe('voiceSessionEnded on a real replica set', () => {
  it('replaying the same response debits once', async () => {
    const call = await seedCall();

    await send(call, 130, 'resp-1');
    await send(call, 130, 'resp-1');

    // 100 from the hold, 30 past it from the balance.
    expect(await charged(call.userId)).toBe(130);
    expect(await ledger(call.sessionId)).toHaveLength(1);
    expect((await hold(call.sessionId))?.voiceBilledCredits).toBe(130);
  });

  it('a failed response debit leaves the ledger, billed total and balance unchanged, so a retry bills it once', async () => {
    const call = await seedCall();
    vi.spyOn(userRepository, 'decrementCreditsFloored').mockRejectedValueOnce(new Error('balance write failed'));

    await expect(send(call, 130, 'resp-1')).rejects.toThrow('balance write failed');
    expect(await ledger(call.sessionId)).toHaveLength(0);
    expect((await hold(call.sessionId))?.voiceBilledCredits).toBe(0);
    expect(await charged(call.userId)).toBe(HOLD);

    await send(call, 130, 'resp-1');
    expect(await charged(call.userId)).toBe(130);
    expect(await ledger(call.sessionId)).toHaveLength(1);
  });

  it('never takes the balance below zero inside the transaction when usage outruns it', async () => {
    const call = await seedCall();
    await User.updateOne({ _id: call.userId }, { $set: { currentCredits: 10 } });

    await send(call, HOLD + 50, 'resp-1');

    expect((await User.findById(call.userId).lean())?.currentCredits).toBe(0);
    expect(await ledger(call.sessionId)).toHaveLength(1);
  });

  it('persists a fully unpaid closing shortfall once with a zero debit', async () => {
    const call = await seedCall();
    await send(call, HOLD, 'resp-1');
    await User.updateOne({ _id: call.userId }, { $set: { currentCredits: 0 } });

    await send(call, 30);
    await send(call, 30);

    const rows = await ledger(call.sessionId);
    const closingRow = rows.find(row => row.transactionId?.startsWith('realtime-voice-close:'));
    expect(rows).toHaveLength(2);
    expect(closingRow).toMatchObject({ credits: -0, metadata: { shortfallCredits: 30 } });
    expect((await User.findById(call.userId).lean())?.currentCredits).toBe(0);
    expect((await hold(call.sessionId))?.voiceSessionStartedAt ?? null).toBeNull();
  });

  it('closing the session settles the hold exactly once', async () => {
    const call = await seedCall();
    await send(call, 30, 'resp-1');

    await Promise.all([send(call, 5), send(call, 5)]);
    await send(call, 5);

    // Every response billed plus the closing frame, with the rest of the hold refunded.
    expect(await charged(call.userId)).toBe(35);
    const rows = await ledger(call.sessionId);
    expect(rows.map(r => r.credits).sort((a, b) => a - b)).toEqual([-30, -5]);
    expect((await hold(call.sessionId))?.voiceSessionStartedAt ?? null).toBeNull();
  });

  it('a failed closing ledger row leaves the balance and the hold unchanged', async () => {
    const call = await seedCall();
    await send(call, 30, 'resp-1');
    vi.spyOn(creditTransactionRepository, 'createTransaction').mockRejectedValueOnce(new Error('ledger write failed'));

    await expect(send(call, 5)).rejects.toThrow('ledger write failed');

    expect(await charged(call.userId)).toBe(HOLD);
    const open = await hold(call.sessionId);
    expect(open?.voiceReservedCredits).toBe(HOLD);
    expect(open?.voiceBilledCredits).toBe(30);

    await send(call, 5);
    expect(await charged(call.userId)).toBe(35);
  });

  // The commit lands but its acknowledgement never reaches the handler; the frame is then retried.
  const loseNextCommitAck = () => {
    const realTransaction = mongoose.connection.transaction.bind(mongoose.connection);
    vi.spyOn(mongoose.connection, 'transaction').mockImplementationOnce(async (fn, options) => {
      await realTransaction(fn, options);
      throw new Error('connection reset after commit');
    });
  };

  it('a response retried after a committed debit does not debit again', async () => {
    const call = await seedCall();
    loseNextCommitAck();

    await expect(send(call, 130, 'resp-1')).rejects.toThrow('connection reset after commit');
    await send(call, 130, 'resp-1');

    expect(await charged(call.userId)).toBe(130);
    expect(await ledger(call.sessionId)).toHaveLength(1);
    expect((await hold(call.sessionId))?.voiceBilledCredits).toBe(130);
  });

  it('a closing frame retried after a committed settlement does not move the balance again', async () => {
    const call = await seedCall();
    await send(call, 30, 'resp-1');
    loseNextCommitAck();

    await expect(send(call, 5)).rejects.toThrow('connection reset after commit');
    await send(call, 5);

    expect(await charged(call.userId)).toBe(35);
    expect(await ledger(call.sessionId)).toHaveLength(2);
    expect((await hold(call.sessionId))?.voiceSessionStartedAt ?? null).toBeNull();
  });

  // The duplicate key is the last write in the close transaction, so its abort is what has to undo
  // the claim and the refund that went before it.
  it('a duplicate closing ledger key rolls the claim and the balance move back', async () => {
    const call = await seedCall();
    const startedAt = (await hold(call.sessionId))?.voiceSessionStartedAt;
    if (!startedAt) throw new Error('seeded hold has no start');
    await creditTransactionRepository.createTransaction('realtime_voice_usage', {
      ownerId: call.userId,
      ownerType: CreditHolderType.User,
      credits: -5,
      description: 'Voice usage',
      model: 'gpt-realtime',
      sessionId: call.sessionId,
      transactionId: `realtime-voice-close:${call.sessionId}:${startedAt.toISOString()}`,
    });

    const res = await send(call, 5);

    expect(res).toMatchObject({ statusCode: 200 });
    expect(await charged(call.userId)).toBe(HOLD);
    const open = await hold(call.sessionId);
    expect(open?.voiceSessionStartedAt ?? null).not.toBeNull();
    expect(open?.voiceReservedCredits).toBe(HOLD);
    expect(await ledger(call.sessionId)).toHaveLength(1);
  });
});
