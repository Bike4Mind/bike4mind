import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResponse } from 'node-mocks-http';
import { z } from 'zod';
import { mongoose, User } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const controls = vi.hoisted(() => ({ cap: '10', emit: vi.fn<(event: unknown) => Promise<boolean>>() }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({ ReferralLinkSignupsPerMonth: controls.cap }),
}));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', () => ({
  HOST_PRODUCT_ID: 'bike4mind',
  emitProductEvent: controls.emit,
}));

import { creditShareLinkSignup } from './shareLink';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-11-19T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const CODE = 'abcd2345';
const referrerId = new mongoose.Types.ObjectId();
let server: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;

const gate = () => {
  let release: () => void = () => {
    throw new Error('Gate was not initialized');
  };
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
};

async function withinDeadline(promise: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function seedAccount(index: number, attributedAt?: Date) {
  const id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: id,
    email: `friend-${index}@example.com`,
    signupMeta: { ip: `203.0.113.${index + 1}` },
    ...(attributedAt ? { referredByUserId: referrerId, referredViaLinkAt: attributedAt } : {}),
  });
  return id;
}

const credit = (id: mongoose.Types.ObjectId, code = CODE) =>
  creditShareLinkSignup({
    req: { headers: { cookie: `b4m_ref=${code}` } },
    res: createResponse(),
    userId: id.toString(),
    method: 'otc',
    isSynthetic: false,
    now: NOW,
  });

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false, monitorCommands: true });
  await settleAutoIndexBuilds(mongoose);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  controls.cap = '10';
  controls.emit.mockReset();
  controls.emit.mockResolvedValue(true);
  await User.collection.deleteMany({});
  await User.collection.insertOne({
    _id: referrerId,
    email: 'sharer@example.com',
    emailVerified: true,
    referralCode: CODE,
    signupMeta: { ip: '198.51.100.1' },
    updatedAt: NOW,
    __v: 0,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('share-link attribution over real transactions', () => {
  it('serializes distinct new accounts competing for the last rolling-window slot', async () => {
    for (let index = 0; index < 9; index++) await seedAccount(index, NOW);
    const firstId = await seedAccount(20);
    const secondId = await seedAccount(21);
    const firstCount = gate();
    const resumeFirst = gate();
    const countDocuments = User.countDocuments.bind(User);
    let counts = 0;
    let fences = 0;
    const fenceCommand = z.object({
      updates: z.array(z.object({ u: z.object({ $inc: z.object({ __v: z.literal(1) }) }) })),
    });
    const client = mongoose.connection.getClient();
    const observeFence = (event: { command: unknown }) => {
      if (!fenceCommand.safeParse(event.command).success) return;
      fences++;
      if (fences === 2) resumeFirst.release();
    };
    client.on('commandStarted', observeFence);
    vi.spyOn(User, 'countDocuments').mockImplementation((filter, options) => {
      const query = countDocuments(filter, options);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        const count = await execute();
        counts++;
        if (counts === 1) {
          expect(count).toBe(9);
          firstCount.release();
          await withinDeadline(resumeFirst.promise, 'the competing fence or unfenced count');
        } else if (counts === 2) {
          // This also releases the deliberately unfenced negative control; waiting
          // for both counts alone would deadlock the correctly serialized version.
          resumeFirst.release();
        }
        return count;
      };
      return query;
    });
    const first = credit(firstId);
    let second: ReturnType<typeof credit> | undefined;
    try {
      await withinDeadline(firstCount.promise, 'the first actual Mongo count');
      second = credit(secondId);
      expect((await Promise.all([first, second])).sort()).toEqual(['credited', 'monthly_cap']);
    } finally {
      resumeFirst.release();
      await Promise.allSettled(second ? [first, second] : [first]);
      client.off('commandStarted', observeFence);
      vi.restoreAllMocks();
    }
    expect(await User.countDocuments({ referredByUserId: referrerId })).toBe(10);
    const credited = z.object({ metadata: z.object({ outcome: z.literal('credited') }) });
    expect(controls.emit.mock.calls.filter(([event]) => credited.safeParse(event).success)).toHaveLength(1);
    expect((await User.collection.findOne({ _id: referrerId }))?.updatedAt).toEqual(NOW);
  });

  it('attributes concurrent retries for the same account once', async () => {
    const id = await seedAccount(1);
    expect((await Promise.all([credit(id), credit(id)])).sort()).toEqual(['already_referred', 'credited']);
    expect(await credit(id)).toBe('already_referred');
    expect(await User.countDocuments({ referredByUserId: referrerId })).toBe(1);
  });

  it('keeps one attribution when two referrers compete for the same new account', async () => {
    const otherReferrer = new mongoose.Types.ObjectId();
    const otherCode = 'bcde3456';
    await User.collection.insertOne({
      _id: otherReferrer,
      email: 'other-sharer@example.com',
      emailVerified: true,
      referralCode: otherCode,
      signupMeta: { ip: '198.51.100.2' },
    });
    const id = await seedAccount(1);
    expect((await Promise.all([credit(id), credit(id, otherCode)])).sort()).toEqual(['already_referred', 'credited']);
    expect(await User.countDocuments({ referredByUserId: { $in: [referrerId, otherReferrer] } })).toBe(1);
  });

  it('re-reads both accounts after a transient transaction failure before counting', async () => {
    const id = await seedAccount(1);
    const referrerReads = vi.spyOn(User, 'findOne');
    const accountReads = vi.spyOn(User, 'findById');
    vi.spyOn(User, 'countDocuments').mockImplementationOnce(() => {
      throw new mongoose.mongo.MongoServerError({
        message: 'deliberate transient write conflict',
        code: 112,
        errorLabels: ['TransientTransactionError'],
      });
    });
    expect(await credit(id)).toBe('credited');
    expect(referrerReads.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(accountReads.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await User.collection.findOne({ _id: referrerId }))?.__v).toBe(1);
    expect(controls.emit).toHaveBeenCalledTimes(1);
  });

  it('keeps the inclusive rolling boundary across calendar months', async () => {
    controls.cap = '1';
    const boundary = await seedAccount(1, new Date(NOW.getTime() - 30 * DAY_MS));
    const candidate = await seedAccount(2);
    expect(await credit(candidate)).toBe('monthly_cap');
    await User.collection.updateOne(
      { _id: boundary },
      {
        $set: { referredViaLinkAt: new Date(NOW.getTime() - 30 * DAY_MS - 1) },
      }
    );
    expect(await credit(candidate)).toBe('credited');
  });

  it('rolls back the shared revision when attribution storage fails', async () => {
    const id = await seedAccount(1);
    vi.spyOn(User, 'countDocuments').mockImplementation(() => {
      throw new Error('deliberate storage failure');
    });
    expect(await credit(id)).toBeNull();
    expect((await User.collection.findOne({ _id: referrerId }))?.__v).toBe(0);
    expect((await User.collection.findOne({ _id: id }))?.referredByUserId).toBeUndefined();
    expect(controls.emit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await credit(id)).toBe('credited');
  });

  it('preserves retained versus physically deleted account quota behavior', async () => {
    controls.cap = '1';
    const previous = await seedAccount(1, NOW);
    const candidate = await seedAccount(2);
    await User.collection.updateOne({ _id: previous }, { $set: { deletedAt: NOW } });
    expect(await credit(candidate)).toBe('monthly_cap');
    await User.collection.deleteOne({ _id: previous });
    expect(await credit(candidate)).toBe('credited');
  });

  it('does not stamp a disabled or ineligible attribution', async () => {
    const id = await seedAccount(1);
    controls.cap = '0';
    expect(await credit(id)).toBe('disabled');
    controls.cap = '10';
    await User.collection.updateOne({ _id: referrerId }, { $set: { isBanned: true } });
    expect(await credit(id)).toBe('referrer_ineligible');
    expect((await User.collection.findOne({ _id: id }))?.referredByUserId).toBeUndefined();
  });
});
