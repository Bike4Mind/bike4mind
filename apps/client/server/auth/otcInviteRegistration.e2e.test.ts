import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { CURRENT_POLICY_VERSION, RegInviteStatusType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  User,
  RegistrationInvite,
  CreditTransaction,
  CreditLot,
  userRepository,
  registrationInviteRepository,
  adminSettingsRepository,
  creditTransactionRepository,
  creditLotRepository,
} from '@bike4mind/database';
import { registerViaOTC } from '../../../../b4m-core/services/src/userService/register';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const logger = new Logger();
const adapters = {
  db: {
    users: userRepository,
    registrationInvites: registrationInviteRepository,
    adminSettings: adminSettingsRepository,
    creditTransactions: creditTransactionRepository,
    creditLots: creditLotRepository,
  },
  logger,
};

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([User.createIndexes(), RegistrationInvite.createIndexes(), CreditTransaction.createIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  await RegistrationInvite.create({
    userId: new mongoose.Types.ObjectId().toHexString(),
    code: 'ONE-INVITE',
    status: RegInviteStatusType.open,
    startingCredits: 10,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    User.deleteMany({}),
    RegistrationInvite.deleteMany({}),
    CreditTransaction.deleteMany({}),
    CreditLot.deleteMany({}),
  ]);
});

const register = (name: string) =>
  withTransaction(() =>
    registerViaOTC(
      {
        username: name,
        name,
        email: `${name}@example.com`,
        password: '',
        inviteCode: 'ONE-INVITE',
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: true,
      },
      adapters
    )
  );

// Both first attempts must read the unused invite before either may create an account.
function raceInviteReads() {
  const findByCode = registrationInviteRepository.findByCode.bind(registrationInviteRepository);
  let readCount = 0;
  let releaseReads: () => void = () => {};
  const readsReady = new Promise<void>(resolve => {
    releaseReads = resolve;
  });
  vi.spyOn(registrationInviteRepository, 'findByCode').mockImplementation(async code => {
    const invite = await findByCode(code);
    readCount += 1;
    if (readCount === 2) releaseReads();
    if (readCount <= 2) await readsReady;
    return invite;
  });
}

describe('OTC invite registration in a real transaction', () => {
  it('admits one account and one credit grant for concurrent single-use redemptions', async () => {
    raceInviteReads();
    const results = await Promise.allSettled([register('first'), register('second')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ message: 'Invite code already used' });
    const users = await User.find({});
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ emailVerified: true, currentCredits: 10 });
    const invite = await RegistrationInvite.findOne({ code: 'ONE-INVITE' });
    expect(invite).toMatchObject({ usedbyId: users[0].id, status: RegInviteStatusType.used });
    expect(invite?.usageHistory).toHaveLength(1);
    expect(await CreditTransaction.countDocuments({})).toBe(1);
    expect(await CreditLot.countDocuments({})).toBe(1);
  });

  it('preserves both usage entries and grants for concurrent unlimited redemptions', async () => {
    await RegistrationInvite.updateOne({ code: 'ONE-INVITE' }, { $set: { unlimitedUse: true } });
    raceInviteReads();
    await Promise.all([register('first'), register('second')]);
    expect(await User.countDocuments({})).toBe(2);
    const invite = await RegistrationInvite.findOne({ code: 'ONE-INVITE' });
    expect(invite?.status).toBe(RegInviteStatusType.open);
    expect(invite?.usageHistory).toHaveLength(2);
    expect(await CreditTransaction.countDocuments({})).toBe(2);
  });

  it('rolls back account creation when marking the invite used fails', async () => {
    vi.spyOn(registrationInviteRepository, 'update').mockRejectedValueOnce(new Error('invite write failed'));
    await expect(register('first')).rejects.toThrow('invite write failed');
    expect(await User.countDocuments({})).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    const invite = await RegistrationInvite.findOne({ code: 'ONE-INVITE' });
    expect(invite?.used).toBeUndefined();
    expect(invite?.usageHistory).toHaveLength(0);
    await expect(register('first')).resolves.toMatchObject({ emailVerified: true });
  });
});
