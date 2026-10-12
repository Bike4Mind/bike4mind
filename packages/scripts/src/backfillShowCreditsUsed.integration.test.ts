import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { backfillShowCreditsUsed } from './backfillShowCreditsUsed';

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
  await User.collection.insertMany([
    { username: 'missing' },
    { username: 'off', showCreditsUsed: false },
    { username: 'on', showCreditsUsed: true },
  ]);
});

const silent = () => undefined;

const valueOf = async (username: string) =>
  (await User.collection.findOne({ username }))?.showCreditsUsed as boolean | undefined;

describe('backfillShowCreditsUsed', () => {
  it('sets only missing values by default and keeps a stored false', async () => {
    const updated = await backfillShowCreditsUsed({ dryRun: false, includeFalse: false, log: silent });

    expect(updated).toBe(1);
    expect(await valueOf('missing')).toBe(true);
    expect(await valueOf('off')).toBe(false);
    expect(await valueOf('on')).toBe(true);
  });

  it('also flips stored false with includeFalse', async () => {
    const updated = await backfillShowCreditsUsed({ dryRun: false, includeFalse: true, log: silent });

    expect(updated).toBe(2);
    expect(await valueOf('missing')).toBe(true);
    expect(await valueOf('off')).toBe(true);
  });

  it('counts without writing in a dry run', async () => {
    const updated = await backfillShowCreditsUsed({ dryRun: true, includeFalse: true, log: silent });

    expect(updated).toBe(2);
    expect(await valueOf('missing')).toBeUndefined();
    expect(await valueOf('off')).toBe(false);
  });

  it('is a no-op on re-run', async () => {
    await backfillShowCreditsUsed({ dryRun: false, includeFalse: true, log: silent });

    expect(await backfillShowCreditsUsed({ dryRun: false, includeFalse: true, log: silent })).toBe(0);
  });
});
