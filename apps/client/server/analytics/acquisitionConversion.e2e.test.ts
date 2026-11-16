import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { classifyFunnelCohort } from '@bike4mind/server-utils/analytics/activationFunnel';
import { acquisitionQuerySchema, ACQUISITION_UNATTRIBUTED_LABEL } from '@client/app/utils/acquisitionConversion';
import { getAcquisitionConversion } from './acquisitionConversionSummary';
import { toUserAcquisition } from './funnel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
const NOW = new Date('2026-06-15T12:00:00Z');
const signup = new Date('2026-06-10T10:00:00Z');
const query = (touch: 'first' | 'last') =>
  acquisitionQuerySchema.parse({ range: 'custom', from: '2026-06-01', to: '2026-06-15', signups: 'all', touch });

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

type Touch = { source: string; medium?: string; campaign?: string };
let seq = 0;

/** A signup whose acquisition is written by the same helper the signup path uses. */
const seedSignup = async (
  touches: { firstTouch?: Touch; lastTouch?: Touch },
  fields: Record<string, unknown> = {},
  verifiedTouch?: Parameters<typeof toUserAcquisition>[3]
) => {
  const name = `u${seq++}`;
  const acquisition = toUserAcquisition(touches, 'email', signup, verifiedTouch);
  return User.create({
    name,
    username: name,
    email: `${name}@${name}.customer.example.org`,
    emailVerified: true,
    createdAt: signup,
    ...(acquisition && { acquisition }),
    ...fields,
  });
};

const rowsOf = async (touch: 'first' | 'last') => {
  const result = await getAcquisitionConversion(query(touch), NOW);
  if (result.status !== 'ok') throw new Error(`unexpected status ${result.status}`);
  return result;
};

describe('getAcquisitionConversion', () => {
  it('groups by source/medium/campaign, case-folded, with an unattributed bucket and coverage', async () => {
    await User.createIndexes();
    await seedSignup({ firstTouch: { source: 'Google', medium: 'CPC', campaign: 'Spring' } });
    await seedSignup({ firstTouch: { source: ' google ', medium: 'cpc', campaign: 'spring' } });
    await seedSignup({ firstTouch: { source: 'newsletter' } });
    await seedSignup({});
    await seedSignup({ firstTouch: { source: '   ' } });
    await seedSignup({}, {}, { srcProductId: 'other-product', hopId: 'hop1', redeemedAt: signup });

    const result = await rowsOf('first');

    expect(result.rows).toEqual([
      expect.objectContaining({ kind: 'touch', key: 'google|cpc|spring', source: 'google', signups: 2 }),
      expect.objectContaining({ kind: 'touch', key: 'newsletter|(none)|(none)', medium: '(none)', signups: 1 }),
      expect.objectContaining({ kind: 'unattributed', key: 'unattributed', source: null, signups: 3 }),
    ]);
    expect(result.coverage).toEqual({ signups: 6, attributed: 3, pct: 50 });
    expect(result.truncated).toBe(false);
    expect(ACQUISITION_UNATTRIBUTED_LABEL).toMatch(/consent unknown/i);
  });

  it('leaves out internal, synthetic, admin and banned accounts', async () => {
    await User.createIndexes();
    const touch = { firstTouch: { source: 'ads' } };
    await seedSignup(touch);
    await seedSignup(touch, { isInternal: true });
    await seedSignup(touch, { isSynthetic: true });
    await seedSignup(touch, { isAdmin: true });
    await seedSignup(touch, { isBanned: true });

    const result = await rowsOf('first');

    expect(result.coverage).toEqual({ signups: 1, attributed: 1, pct: 100 });
    expect(result.rows).toEqual([expect.objectContaining({ key: 'ads|(none)|(none)', signups: 1 })]);
  });

  it('splits first and last touch, each falling back to the other when missing', async () => {
    await User.createIndexes();
    await seedSignup({ firstTouch: { source: 'blog' }, lastTouch: { source: 'ads', medium: 'cpc' } });
    await seedSignup({ firstTouch: { source: 'blog' } });
    await seedSignup({ lastTouch: { source: 'ads', medium: 'cpc' } });

    const first = await rowsOf('first');
    const last = await rowsOf('last');

    expect(first.rows.map(row => [row.key, row.signups])).toEqual([
      ['blog|(none)|(none)', 2],
      ['ads|cpc|(none)', 1],
    ]);
    expect(last.rows.map(row => [row.key, row.signups])).toEqual([
      ['ads|cpc|(none)', 2],
      ['blog|(none)|(none)', 1],
    ]);
    expect(first.coverage).toEqual(last.coverage);
  });

  it('keeps the top 50 touch rows and sums the rest into one other row', async () => {
    await User.createIndexes();
    await seedSignup({ firstTouch: { source: 'big' } });
    await seedSignup({ firstTouch: { source: 'big' } });
    for (let i = 0; i <= 50; i++) await seedSignup({ firstTouch: { source: `s${String(i).padStart(2, '0')}` } });

    const result = await rowsOf('first');

    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(51);
    expect(result.rows[0]).toMatchObject({ key: 'big|(none)|(none)', signups: 2 });
    expect(result.rows[49]).toMatchObject({ key: 's48|(none)|(none)' });
    expect(result.rows[50]).toMatchObject({ kind: 'other', key: 'other', signups: 2 });
    expect(result.coverage.signups).toBe(53);
  });

  it('reports an empty window with no rows and a null coverage rate', async () => {
    const result = await rowsOf('first');
    expect(result.rows).toEqual([]);
    expect(result.coverage).toEqual({ signups: 0, attributed: 0, pct: null });
  });

  it('refuses a range longer than the Users drill-down accepts', async () => {
    const result = await getAcquisitionConversion(acquisitionQuerySchema.parse({ range: '12m' }), NOW);
    expect(result).toEqual({ status: 'rangeTooLong', maxDays: 93 });
  });

  it('leaves the activation funnel cohort unchanged by the shared eligibility read', async () => {
    await User.createIndexes();
    const counted = await seedSignup(
      { firstTouch: { source: 'ads' } },
      { createdAt: new Date('2026-06-01T00:00:00Z') }
    );
    await seedSignup({}, { createdAt: new Date('2026-06-01T00:00:00Z'), isAdmin: true });

    const { members } = await classifyFunnelCohort(
      { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-02T00:00:00Z') },
      { now: NOW, deadlineMs: 10_000, needsPayments: false }
    );

    expect(members.map(member => member.id)).toEqual([String(counted._id)]);
  });
});
