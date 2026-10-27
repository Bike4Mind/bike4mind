import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  AdminSettings,
  CreditLot,
  CreditTransaction,
  GithubUnlockClaim,
  User,
  creditTransactionRepository,
  mcpServerRepository,
  signupProtectionRepository,
} from '@bike4mind/database';
import { runNoCardUnlock } from './runNoCardUnlock';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptEnvVariables: () => [{ key: 'GITHUB_ACCESS_TOKEN', value: 'token' }],
}));

const GITHUB = 11;
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

const githubFetch = (githubId: number) =>
  vi.fn(async (url: string) => {
    const body = url.endsWith('/user/emails')
      ? [{ email: 'a@b.test', verified: true, primary: true }]
      : {
          id: githubId,
          login: 'octo',
          created_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
          public_repos: 3,
        };
    return new Response(JSON.stringify(body), { status: 200 });
  });

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Promise.all(
    [User, CreditTransaction, CreditLot, AdminSettings, GithubUnlockClaim].map(model => model.createIndexes())
  );
  const settings: Record<string, unknown> = {
    noCardUnlockEnabled: true,
    noCardUnlockGithubCredits: GITHUB,
    noCardUnlockWorkEmailCredits: 7,
    noCardUnlockMaxCredits: 15,
    noCardUnlockGithubMinAgeDays: 30,
    noCardUnlockGithubMinRepos: 1,
  };
  for (const [settingName, settingValue] of Object.entries(settings)) {
    await AdminSettings.create({ settingName, settingValue });
  }
  vi.spyOn(mcpServerRepository, 'findOne').mockResolvedValue({ enabled: true, envVariables: [] } as never);
  vi.stubGlobal('fetch', githubFetch(1));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const seedUser = async () => {
  const tag = Math.random().toString(36).slice(2, 10);
  const doc = await User.create({
    name: 'Dev',
    username: `dev-${tag}`,
    email: `dev-${tag}@acme-corp.test`,
    password: null,
    hasUsablePassword: false,
    emailVerified: true,
    currentCredits: 0,
  });
  return doc.id as string;
};

describe('runNoCardUnlock', () => {
  it('grants the credits, stamps a lot and reports the new balance', async () => {
    const id = await seedUser();
    expect(await runNoCardUnlock('github_verified', id)).toEqual({ creditsGranted: GITHUB, currentCredits: GITHUB });
    expect(await CreditLot.countDocuments({ ownerId: id, source: 'promo' })).toBe(1);
  });

  it('refuses a GitHub id another account already claimed and leaves the balance unchanged', async () => {
    const first = await seedUser();
    const second = await seedUser();
    await runNoCardUnlock('github_verified', first);

    expect(await runNoCardUnlock('github_verified', second)).toEqual({
      creditsGranted: 0,
      currentCredits: 0,
      refusal: 'github_already_claimed',
    });
    expect((await User.findById(second).lean())?.currentCredits).toBe(0);
  });

  it('refuses with a rate-limit code, not a reauthorize prompt, when GitHub rate limits with a 403', async () => {
    const id = await seedUser();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    );

    expect(await runNoCardUnlock('github_verified', id)).toEqual({
      creditsGranted: 0,
      currentCredits: 0,
      refusal: 'github_rate_limited',
    });
  });

  it('refuses without crediting or claiming when the signup domain is held', async () => {
    const id = await seedUser();
    vi.spyOn(signupProtectionRepository, 'findReview').mockResolvedValue({ status: 'held_pending_review' } as never);

    expect(await runNoCardUnlock('github_verified', id)).toEqual({
      creditsGranted: 0,
      currentCredits: 0,
      refusal: 'signup_held',
    });
    expect(await GithubUnlockClaim.countDocuments({ githubId: 1 })).toBe(0);
  });

  it('releases the claim and rethrows when the credit write fails', async () => {
    const id = await seedUser();
    vi.spyOn(creditTransactionRepository, 'createTransaction').mockRejectedValueOnce(new Error('boom'));

    await expect(runNoCardUnlock('github_verified', id)).rejects.toThrow('boom');
    expect(await GithubUnlockClaim.countDocuments({ githubId: 1 })).toBe(0);
    expect(await runNoCardUnlock('github_verified', id)).toMatchObject({ creditsGranted: GITHUB });
  });
});
