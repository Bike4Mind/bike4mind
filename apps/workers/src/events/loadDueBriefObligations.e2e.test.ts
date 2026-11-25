import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AssistantBriefModel,
  ObligationModel,
  User,
  assistantBriefRepository,
  obligationDayToDate,
  obligationRepository,
} from '@bike4mind/database';
import type { ObligationStatus } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { composeBrief } from './briefCompose';
import { loadDueBriefObligations, toBriefObligation } from './loadDueBriefObligations';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryServer;
const userId = new mongoose.Types.ObjectId().toString();
const otherUserId = new mongoose.Types.ObjectId().toString();
// 23:30 UTC on the 25th is already the 26th in Tokyo.
const now = new Date('2026-11-25T23:30:00Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await ObligationModel.collection.deleteMany({});
  await AssistantBriefModel.collection.deleteMany({});
  await User.collection.deleteMany({});
});

async function obligation(due: string | null, status: ObligationStatus = 'confirmed', owner = userId, payee = due) {
  const { obligation: row } = await obligationRepository.create({
    userId: owner,
    fileId: new mongoose.Types.ObjectId().toString(),
    documentKind: 'invoice',
    amountValue: 184.37,
    currency: 'USD',
    payee,
    dueDate: due === null ? null : obligationDayToDate(due),
    destinationLakeId: null,
    destinationName: null,
    summary: 'Water bill',
    model: 'ops-model',
  });
  if (status !== 'pending') await obligationRepository.applyUpdate(row._id.toString(), owner, { status });
  return row._id.toString();
}

const setTimeZone = (timeZone: string) =>
  User.collection.insertOne({
    _id: new mongoose.Types.ObjectId(userId),
    preferences: { briefSchedule: { timeZone } },
  } as never);

const dueDays = async () =>
  (await loadDueBriefObligations(userId, now)).map(item => item.dueDate?.toISOString().slice(0, 10));

describe('loadDueBriefObligations against a real database', () => {
  it('returns confirmed obligations due from today through the lead window, soonest first', async () => {
    await obligation('2026-12-02');
    await obligation('2026-11-25');
    await obligation('2026-11-28');
    await obligation('2026-11-24');
    await obligation('2026-12-03');
    await obligation(null);
    await obligation('2026-11-27', 'pending');
    await obligation('2026-11-27', 'dismissed');
    await obligation('2026-11-27', 'confirmed', otherUserId);

    expect(await dueDays()).toEqual(['2026-11-25', '2026-11-28', '2026-12-02']);
  });

  it('counts the window from the calendar day in the brief time zone', async () => {
    await setTimeZone('Asia/Tokyo');
    await obligation('2026-11-25');
    await obligation('2026-12-03');

    expect(await dueDays()).toEqual(['2026-12-03']);
  });
});

describe('a composed brief with a confirmed obligation', () => {
  it('stores a ready brief carrying the obligation item, and leaves out one due later', async () => {
    const dueSoon = await obligation('2026-11-28', 'confirmed', userId, 'Acme Water Utility');
    await obligation('2026-12-10', 'confirmed', userId, 'Later Payee');
    const periodStart = new Date('2026-11-24T23:30:00Z');
    const brief = await assistantBriefRepository.createComposing({ userId, periodStart, periodEnd: now });

    await composeBrief(
      {
        now: () => now,
        users: { findById: async () => ({ id: userId }) },
        briefs: assistantBriefRepository,
        loadActivity: async () => ({
          periodStart,
          periodEnd: now,
          runs: [],
          approvals: [],
          questions: [],
          emails: [],
          delegations: [],
          reminders: [],
          obligations: (await loadDueBriefObligations(userId, now)).map(item => toBriefObligation(item, now)),
        }),
        canCompose: async () => 'ok',
        complete: async () => '{"headline":"A bill is due this week."}',
        push: async () => undefined,
        emails: { markBriefed: async () => 0, storedEmailIds: async () => [] },
        delegations: { markBriefed: async () => 0 },
        logger,
      },
      { briefId: brief._id.toString(), userId, scheduled: true }
    );

    const stored = await AssistantBriefModel.findById(brief._id).lean().orFail();
    expect(stored.status).toBe('ready');
    expect(stored.happened).toMatchObject([{ source: { kind: 'obligation', obligationId: dueSoon } }]);
    expect(stored.happened[0].text).toContain('Acme Water Utility');
    expect(JSON.stringify(stored)).not.toContain('Later Payee');
  });
});
