import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921236700_queue-held-signup-grants-for-risk-review';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await User.collection.deleteMany({});
});

const scored = (reviewState: string) => ({
  score: 12,
  signals: [{ signal: 'riskyDomain', points: 12, reason: 'fixture' }],
  computedAt: new Date('2026-01-01'),
  reviewState,
});

const seed = async (fields: Record<string, unknown>) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `u-${_id}`,
    name: 'fixture',
    email: `${_id}@example.test`,
    signupGrantAssessment: { band: 'review' },
    signupGrant: { stage: 'signup', signupCredits: 12, unlockCredits: 28, creditsReleased: 0 },
    ...fields,
  });
  return _id;
};

const riskScoreOf = async (_id: mongoose.Types.ObjectId) =>
  (await User.collection.findOne({ _id }, { projection: { riskScore: 1 } }))?.riskScore;

describe('queue-held-signup-grants-for-risk-review', () => {
  it('queues a held account scored before the hold, keeping its score', async () => {
    const id = await seed({ riskScore: scored('none') });

    await migration.up();

    expect(await riskScoreOf(id)).toEqual({ ...scored('pending') });
  });

  it('queues a held account that was never scored with an empty score', async () => {
    const id = await seed({});

    await migration.up();

    expect(await riskScoreOf(id)).toEqual({
      score: 0,
      signals: [],
      computedAt: expect.any(Date),
      reviewState: 'pending',
    });
  });

  it.each([
    ['an approved account', { riskScore: scored('approved') }, 'approved'],
    ['a banned account', { riskScore: scored('banned') }, 'banned'],
    ['a reduced-band tranche', { riskScore: scored('none'), signupGrantAssessment: { band: 'reduced' } }, 'none'],
    [
      'a paid tranche',
      {
        riskScore: scored('none'),
        signupGrant: { stage: 'signup', signupCredits: 12, unlockCredits: 28, creditsReleased: 12 },
      },
      'none',
    ],
    [
      'a tranche not yet assessed',
      {
        riskScore: scored('none'),
        signupGrant: { stage: 'pending_email', signupCredits: 12, unlockCredits: 28, creditsReleased: 0 },
      },
      'none',
    ],
  ])('leaves %s alone', async (_label, fields, reviewState) => {
    const id = await seed(fields);

    await migration.up();

    expect((await riskScoreOf(id))?.reviewState).toBe(reviewState);
  });
});
