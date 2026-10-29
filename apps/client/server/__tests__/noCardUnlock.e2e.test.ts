import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { noCardUnlockTransactionId } from '@bike4mind/common';
import {
  AdminSettings,
  Cache,
  CreditLot,
  CreditTransaction,
  GithubUnlockClaim,
  User,
  adminSettingsRepository,
  cacheRepository,
  creditLotRepository,
  creditTransactionRepository,
  githubUnlockClaimRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { grantNoCardUnlock, githubValidator, workEmailValidator } = userService;

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
  await mongoose.connection.dropDatabase();
  await Promise.all(
    [User, CreditTransaction, CreditLot, AdminSettings, Cache, GithubUnlockClaim].map(model => model.createIndexes())
  );
});

const GITHUB = 11;
const WORK = 7;
const MAX = 15;

const seedSettings = async (over: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    noCardUnlockEnabled: true,
    noCardUnlockGithubCredits: GITHUB,
    noCardUnlockWorkEmailCredits: WORK,
    noCardUnlockMaxCredits: MAX,
    noCardUnlockGithubMinAgeDays: 30,
    noCardUnlockGithubMinRepos: 1,
    noCardUnlockWorkEmailDomainDailyCap: 2,
    ...over,
  };
  for (const [settingName, settingValue] of Object.entries(values)) {
    await AdminSettings.create({ settingName, settingValue });
  }
};

const seedUser = async (over: Record<string, unknown> = {}) => {
  const tag = Math.random().toString(36).slice(2, 10);
  const doc = await User.create({
    name: 'Dev',
    username: `dev-${tag}`,
    email: `dev-${tag}@acme-corp.test`,
    password: null,
    hasUsablePassword: false,
    emailVerified: true,
    currentCredits: 0,
    ...over,
  });
  return doc.id as string;
};

const ghProfile = (githubId: number, ageDays: number) => ({
  getUser: async () => ({
    id: githubId,
    login: 'octo',
    created_at: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
    public_repos: 3,
  }),
  getEmails: async () => [{ email: 'a@b.test', verified: true, primary: true }],
});

const build = async (githubId = 1, ageDays = 400) => {
  const settings = await userService.loadNoCardUnlockSettings(adminSettingsRepository);
  return {
    db: {
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
      users: userRepository,
    },
    withTransaction: <T>(fn: () => Promise<T>) => withTransaction(fn),
    validators: {
      github_verified: githubValidator({
        settings,
        github: ghProfile(githubId, ageDays),
        getAccessToken: async () => 'token',
        claimGithubId: (id, userId) => githubUnlockClaimRepository.claim(id, userId),
        releaseGithubId: (id, userId) => githubUnlockClaimRepository.release(id, userId),
      }),
      work_email_verified: workEmailValidator({
        settings,
        cache: cacheRepository,
        resolveMx: async () => [{ exchange: 'mx', priority: 1 }],
        catchAllProbe: async () => false,
        isDisposable: () => false,
      }),
    },
  };
};

const balance = async (id: string) => (await User.findById(id).lean())?.currentCredits;
const rows = (id: string) => CreditTransaction.countDocuments({ ownerId: id, transactionId: /^unlock-grant:/ });

describe('grantNoCardUnlock on a real replica set', () => {
  it('credits once with the per-reason ledger id and treats a replay as already granted', async () => {
    await seedSettings();
    const id = await seedUser();
    const adapters = await build();

    expect(await grantNoCardUnlock(id, 'github_verified', adapters)).toMatchObject({ granted: true, credits: GITHUB });
    expect(await CreditLot.countDocuments({ ownerId: id, source: 'promo' })).toBe(1);
    expect(await grantNoCardUnlock(id, 'github_verified', adapters)).toEqual({
      granted: false,
      refusal: 'already_granted',
    });
    expect(await balance(id)).toBe(GITHUB);
    expect(
      await CreditTransaction.countDocuments({ transactionId: noCardUnlockTransactionId('github_verified', id) })
    ).toBe(1);
  });

  it('refuses a young GitHub account and leaves the balance unchanged', async () => {
    await seedSettings();
    const id = await seedUser();
    expect(await grantNoCardUnlock(id, 'github_verified', await build(1, 3))).toEqual({
      granted: false,
      refusal: 'github_too_new',
    });
    expect(await balance(id)).toBe(0);
    expect(await rows(id)).toBe(0);
  });

  it('unlocks one GitHub id for one account only', async () => {
    await seedSettings();
    const [a, b] = [await seedUser(), await seedUser()];
    expect(await grantNoCardUnlock(a, 'github_verified', await build(42))).toMatchObject({ granted: true });
    expect(await grantNoCardUnlock(b, 'github_verified', await build(42))).toEqual({
      granted: false,
      refusal: 'github_already_claimed',
    });
    expect(await balance(b)).toBe(0);
  });

  it('refuses when disabled, unverified or banned, and writes nothing', async () => {
    await seedSettings({ noCardUnlockEnabled: false });
    const id = await seedUser();
    expect(await grantNoCardUnlock(id, 'github_verified', await build())).toEqual({
      granted: false,
      refusal: 'disabled',
    });

    await AdminSettings.updateOne({ settingName: 'noCardUnlockEnabled' }, { settingValue: true });
    const unverified = await seedUser({ emailVerified: false });
    const banned = await seedUser({ isBanned: true });
    for (const target of [unverified, banned]) {
      expect(await grantNoCardUnlock(target, 'github_verified', await build(Math.random()))).toMatchObject({
        granted: false,
      });
      expect(await balance(target)).toBe(0);
    }
  });

  it('caps the combined unlocks at the maximum, trimming the second grant', async () => {
    await seedSettings();
    const id = await seedUser();
    const adapters = await build();
    expect(await grantNoCardUnlock(id, 'github_verified', adapters)).toMatchObject({ credits: GITHUB });
    expect(await grantNoCardUnlock(id, 'work_email_verified', adapters)).toMatchObject({
      granted: true,
      credits: MAX - GITHUB,
    });
    expect(await balance(id)).toBe(MAX);
  });

  it('refuses with cap_reached once the maximum is spent by the other reason', async () => {
    await seedSettings({ noCardUnlockMaxCredits: GITHUB });
    const id = await seedUser();
    const adapters = await build();
    await grantNoCardUnlock(id, 'github_verified', adapters);
    expect(await grantNoCardUnlock(id, 'work_email_verified', adapters)).toEqual({
      granted: false,
      refusal: 'cap_reached',
    });
    expect(await balance(id)).toBe(GITHUB);
  });

  it('never exceeds the maximum when both reasons race across many users', async () => {
    await seedSettings({ noCardUnlockMaxCredits: 12, noCardUnlockWorkEmailDomainDailyCap: 100 });
    for (let i = 0; i < 12; i++) {
      const adapters = await build(i + 1);
      const id = await seedUser();
      const results = await Promise.all([
        grantNoCardUnlock(id, 'github_verified', adapters),
        grantNoCardUnlock(id, 'work_email_verified', adapters),
      ]);
      const credited = results.reduce((sum, r) => sum + (r.granted ? r.credits : 0), 0);
      expect(credited).toBeLessThanOrEqual(12);
      expect(await balance(id)).toBe(credited);
      expect(credited).toBeGreaterThan(0);
    }
  });

  it('does not spend a domain slot when the grant is capped', async () => {
    await seedSettings({ noCardUnlockMaxCredits: GITHUB, noCardUnlockWorkEmailDomainDailyCap: 1 });
    const id = await seedUser();
    const adapters = await build(77);
    await grantNoCardUnlock(id, 'github_verified', adapters);
    expect(await grantNoCardUnlock(id, 'work_email_verified', adapters)).toEqual({
      granted: false,
      refusal: 'cap_reached',
    });
    expect(await Cache.countDocuments({ key: /no-card-unlock:domain:/ })).toBe(0);
  });

  it('does not burn the GitHub id when the work-email grant already reached the maximum', async () => {
    await seedSettings({ noCardUnlockMaxCredits: WORK });
    const second = await seedUser();
    expect(await grantNoCardUnlock(second, 'work_email_verified', await build())).toMatchObject({ granted: true });
    expect(await grantNoCardUnlock(second, 'github_verified', await build(78))).toEqual({
      granted: false,
      refusal: 'cap_reached',
    });
    expect(await GithubUnlockClaim.countDocuments({ githubId: 78 })).toBe(0);
  });

  it('frees a GitHub id after release so another account can claim it', async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    expect(await githubUnlockClaimRepository.claim(90, a)).toMatchObject({ claimed: true });
    expect(await githubUnlockClaimRepository.claim(90, b)).toMatchObject({ claimed: false });
    await githubUnlockClaimRepository.release(90, a);
    expect(await githubUnlockClaimRepository.claim(90, b)).toMatchObject({ claimed: true });
  });

  it('keys the domain cap on the registrable domain so subdomains share it', async () => {
    await seedSettings({ noCardUnlockWorkEmailDomainDailyCap: 1 });
    const a = await seedUser({ email: 'a@mail.acme-corp.test' });
    const b = await seedUser({ email: 'b@eng.acme-corp.test' });
    const adapters = await build();
    expect(await grantNoCardUnlock(a, 'work_email_verified', adapters)).toMatchObject({ granted: true });
    expect(await grantNoCardUnlock(b, 'work_email_verified', adapters)).toEqual({
      granted: false,
      refusal: 'domain_cap_reached',
    });
  });

  it('refuses the GitHub unlock until the age and repo minimums are configured', async () => {
    await seedSettings({ noCardUnlockGithubMinAgeDays: '', noCardUnlockGithubMinRepos: 'abc' });
    const id = await seedUser();
    expect(await grantNoCardUnlock(id, 'github_verified', await build(5, 1))).toEqual({
      granted: false,
      refusal: 'disabled',
    });
    expect(await balance(id)).toBe(0);
  });

  it('credits once when the same reason races with itself', async () => {
    await seedSettings();
    const id = await seedUser();
    const adapters = await build();
    const results = await Promise.all([
      grantNoCardUnlock(id, 'github_verified', adapters),
      grantNoCardUnlock(id, 'github_verified', adapters),
    ]);
    expect(results.filter(r => r.granted)).toHaveLength(1);
    expect(await balance(id)).toBe(GITHUB);
    // The losing request must not release the claim the winner relies on.
    expect(await GithubUnlockClaim.countDocuments({ githubId: 1, userId: id })).toBe(1);
    const other = await seedUser();
    expect(await grantNoCardUnlock(other, 'github_verified', adapters)).toEqual({
      granted: false,
      refusal: 'github_already_claimed',
    });
  });

  it('releases the claim and rethrows when the credit write fails', async () => {
    await seedSettings();
    const id = await seedUser();
    const adapters = await build();
    const failing = {
      ...adapters,
      withTransaction: async () => {
        throw new Error('boom');
      },
    };
    await expect(grantNoCardUnlock(id, 'github_verified', failing)).rejects.toThrow('boom');
    expect(await GithubUnlockClaim.countDocuments({ githubId: 1 })).toBe(0);
    expect(await balance(id)).toBe(0);
    expect(await grantNoCardUnlock(id, 'github_verified', adapters)).toMatchObject({ granted: true });
  });

  it('refuses an alias of an inbox that already holds the free-credit claim', async () => {
    await seedSettings();
    const first = await seedUser({ email: 'x.y@gmail.com' });
    const alias = await seedUser({ email: 'xy+1@gmail.com' });

    expect(await grantNoCardUnlock(first, 'github_verified', await build(51))).toMatchObject({ granted: true });
    expect(await grantNoCardUnlock(alias, 'github_verified', await build(52))).toEqual({
      granted: false,
      refusal: 'inbox_already_claimed',
    });
    expect(await balance(alias)).toBe(0);
    expect(await rows(alias)).toBe(0);
    // A refused unlock must not burn the alias's GitHub id: it is released for a later, legitimate use.
    expect(await GithubUnlockClaim.countDocuments({ githubId: 52 })).toBe(0);
  });

  it('claims the inbox on the first unlock, so a sibling alias cannot earn a signup grant later', async () => {
    await seedSettings();
    const id = await seedUser({ email: 'a.b@gmail.com' });

    expect(await grantNoCardUnlock(id, 'github_verified', await build(61))).toMatchObject({ granted: true });
    expect((await User.findById(id).lean())?.freeCreditClaimEmail).toBe('ab@gmail.com');
  });

  it('lets the account that already holds its own claim unlock both reasons', async () => {
    await seedSettings();
    const id = await seedUser({ email: 'solo@gmail.com' });
    expect(await userRepository.claimFreeCreditGrant(id)).toBe(true);

    expect(await grantNoCardUnlock(id, 'github_verified', await build(71))).toMatchObject({ granted: true });
    expect(await balance(id)).toBe(GITHUB);
  });

  it('enforces the per-domain daily cap across accounts', async () => {
    await seedSettings();
    const users = [await seedUser(), await seedUser(), await seedUser()];
    const adapters = await build();
    const results = [];
    for (const id of users) results.push(await grantNoCardUnlock(id, 'work_email_verified', adapters));
    expect(results.map(r => r.granted)).toEqual([true, true, false]);
    expect(results[2]).toEqual({ granted: false, refusal: 'domain_cap_reached' });
  });
});
