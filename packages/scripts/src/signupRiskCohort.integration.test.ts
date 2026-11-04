import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { UsageEvent, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { buildSignupRiskCohort, replayableSignals } from './signupRiskCohort';
import { replaySignupRisk } from './replaySignupRisk';

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
  await UsageEvent.collection.deleteMany({});
});

const DAY_MS = 24 * 60 * 60 * 1000;
const since = new Date('2026-10-01T00:00:00Z');
const until = new Date('2026-10-10T00:00:00Z');
const now = new Date('2026-10-20T00:00:00Z');

let sequence = 0;
async function insertSignup(overrides: Record<string, unknown> = {}, signals: unknown = { datacenter: false }) {
  sequence += 1;
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `synthetic-${sequence}`,
    email: `synthetic-${sequence}@example.test`,
    createdAt: new Date(since.getTime() + DAY_MS),
    emailVerified: true,
    isBanned: false,
    isModerated: false,
    signupGrant: { stage: 'signup', signupCredits: 10, unlockCredits: 0, creditsReleased: 10 },
    signupGrantAssessment: {
      band: 'full',
      credits: 10,
      score: null,
      reasons: [],
      missing: [],
      policyVersion: null,
      status: 'disabled',
      ...(signals === null ? {} : { signals }),
    },
    ...overrides,
  });
  return _id;
}

async function insertRequest(userId: mongoose.Types.ObjectId, createdAt: Date, status = 'ok') {
  await UsageEvent.collection.insertOne({ userId: String(userId), status, createdAt });
}

describe('buildSignupRiskCohort', () => {
  it('labels signups by the product definition and pairs them with recorded signals', async () => {
    const active = await insertSignup({}, { datacenter: false, ipSignups: 1 });
    await insertRequest(active, new Date(since.getTime() + 2 * DAY_MS));
    const banned = await insertSignup({ isBanned: true }, { datacenter: true, ipSignups: 6 });
    await insertRequest(banned, new Date(since.getTime() + 2 * DAY_MS));
    await insertSignup({}, { datacenter: true, ipSignups: 9 }); // never made a request
    const late = await insertSignup({}, { datacenter: false, ipSignups: 0 });
    await insertRequest(late, new Date(since.getTime() + 9 * DAY_MS)); // after the 7-day window
    const failed = await insertSignup({}, { datacenter: false });
    await insertRequest(failed, new Date(since.getTime() + 2 * DAY_MS), 'error');

    const { samples, skipped } = await buildSignupRiskCohort({ since, until, now, staffRegex: null });

    expect(skipped).toEqual({ noRecordedSignals: 0, undecided: 0, internal: 0 });
    expect(samples).toEqual([
      { cohort: 'legitimate', signupCredits: 10, signals: { datacenter: false, ipSignups: 1 } },
      { cohort: 'suspected', signupCredits: 10, signals: { datacenter: true, ipSignups: 6 } },
      { cohort: 'suspected', signupCredits: 10, signals: { datacenter: true, ipSignups: 9 } },
      { cohort: 'suspected', signupCredits: 10, signals: { datacenter: false, ipSignups: 0 } },
      { cohort: 'suspected', signupCredits: 10, signals: { datacenter: false } },
    ]);
  });

  it('skips unrecorded, undecided and internal signups and those outside the window', async () => {
    await insertSignup({}, null); // assessed before signals were recorded
    await insertSignup({ createdAt: new Date(now.getTime() - DAY_MS) }, { datacenter: false });
    await insertSignup({ email: 'someone@staff.example' });
    await insertSignup({ isAdmin: true });
    await insertSignup({ isSynthetic: true });
    await insertSignup({ createdAt: now }); // `until` is exclusive
    await insertSignup({ signupGrant: null, signupGrantAssessment: null }); // predates the staged grant
    await insertSignup({ createdAt: until }); // the only labelable one: window closed with no request

    const { samples, skipped } = await buildSignupRiskCohort({
      since,
      until: now,
      now,
      staffRegex: /@staff\.example$/,
    });

    expect(samples).toEqual([{ cohort: 'suspected', signupCredits: 10, signals: { datacenter: false } }]);
    expect(skipped).toEqual({ noRecordedSignals: 1, undecided: 1, internal: 1 });
  });

  it('produces input the replay accepts', async () => {
    const active = await insertSignup({}, { datacenter: false, ipSignups: 0, unknownSignal: true });
    await insertRequest(active, new Date(since.getTime() + DAY_MS + 1000));
    await insertSignup({}, { datacenter: true, ipSignups: 5 });
    const { samples } = await buildSignupRiskCohort({ since, until, now, staffRegex: null });
    const policy = {
      enabled: true,
      version: 'candidate',
      reducedAt: 2,
      reviewAt: 4,
      reducedFraction: 0.5,
      rules: [
        { signal: 'datacenter', comparison: 'eq', threshold: 1, weight: 2, missing: 'score', missingWeight: 0 },
        { signal: 'ipSignups', comparison: 'gte', threshold: 3, weight: 2, missing: 'score', missingWeight: 0 },
      ],
    };
    expect(replaySignupRisk({ policy, samples })).toEqual({
      legitimate: { samples: 1, full: 1, reduced: 0, review: 0, missingObservations: 0 },
      suspected: { samples: 1, full: 0, reduced: 0, review: 1, missingObservations: 0 },
    });
  });
});

describe('replayableSignals', () => {
  it('keeps known signals with replayable values only', () => {
    expect(
      replayableSignals({ datacenter: true, ipSignups: 3, challengeVerified: null, asnSignups: 'x', other: 1 })
    ).toEqual({ datacenter: true, ipSignups: 3, challengeVerified: null });
    expect(replayableSignals(undefined)).toBeNull();
    expect(replayableSignals([true])).toBeNull();
  });
});
