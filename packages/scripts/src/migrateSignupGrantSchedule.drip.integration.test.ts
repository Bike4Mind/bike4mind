import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dripSignupGrant } from '../../../b4m-core/services/src/userService/stagedSignupGrant';
import {
  mongoose,
  AdminSettings,
  adminSettingsRepository,
  CreditTransaction,
  creditTransactionRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../database/src/__test__/createMongoServer';
import { migrateSignupGrantSchedule } from './migrateSignupGrantSchedule';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
let dir: string;

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await CreditTransaction.createCollection();
  await AdminSettings.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
  dir = mkdtempSync(join(tmpdir(), 'signup-grant-drip-'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const setSetting = (settingName: string, settingValue: string) =>
  AdminSettings.collection.updateOne({ settingName }, { $set: { settingName, settingValue } }, { upsert: true });

beforeEach(async () => {
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await AdminSettings.collection.deleteMany({});
  await setSetting('signupGrantDailyCredits', '1000');
  await setSetting('signupGrantDripCap', '9000');
});

const adapters = {
  db: {
    users: userRepository,
    creditTransactions: creditTransactionRepository,
    adminSettings: adminSettingsRepository,
  },
  reason: 'migration drip test',
  bypassBudget: true,
};

/** Tranche plus two drip payouts in the ledger (700 dripped), but a grant that still records only the tranche. */
async function insertLaggingAccount() {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `u-${_id}`,
    email: `${_id}@drip.example`,
    emailVerified: true,
    currentCredits: 1700,
    signupGrant: {
      stage: 'signup',
      signupCredits: 1000,
      unlockCredits: 9000,
      creditsReleased: 1000,
      nextCondition: 'verification',
    },
  });
  for (const [transactionId, credits] of [
    [`verify-grant:${_id}`, 1000],
    [`unlock-grant:activity:${_id}:2026-11-01`, 400],
    [`unlock-grant:activity:${_id}:2026-11-02`, 300],
  ] as const) {
    await CreditTransaction.collection.insertOne({
      ownerId: String(_id),
      ownerType: 'User',
      type: 'generic_add',
      transactionId,
      credits,
      createdAt: new Date(),
    });
  }
  return _id;
}

const migrate = () =>
  migrateSignupGrantSchedule({
    apply: true,
    maxUsers: 10,
    maxCredits: 1_000_000,
    reportPath: join(dir, `report-${Date.now()}-${Math.random()}.json`),
    log: () => undefined,
  });

describe('a migrated account drips toward the live cap', () => {
  it('pays the daily amount on the next heartbeat day and counts it against cap minus dripped', async () => {
    const id = await insertLaggingAccount();
    await migrate();

    const paid = await dripSignupGrant(String(id), '2026-11-05', adapters);

    expect(paid.creditsGranted).toBe(1000);
    const grant = (await User.collection.findOne({ _id: id }))?.signupGrant;
    expect(grant).toMatchObject({ creditsReleased: 2700, dripCredits: 1700, lastDripDay: '2026-11-05' });
  });

  it('stops at the cap: only the headroom left after what was already dripped is paid', async () => {
    await setSetting('signupGrantDripCap', '1000');
    const id = await insertLaggingAccount();
    await migrate();

    const first = await dripSignupGrant(String(id), '2026-11-05', adapters);
    const second = await dripSignupGrant(String(id), '2026-11-06', adapters);

    expect(first.creditsGranted).toBe(300);
    expect(second.creditsGranted).toBe(0);
    expect((await User.collection.findOne({ _id: id }))?.signupGrant).toMatchObject({ dripCredits: 1000 });
  });
});
