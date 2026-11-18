import type { Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSignupGrant, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import {
  AdminSettings,
  adminSettingsRepository,
  CreditLot,
  creditLotRepository,
  CreditTransaction,
  creditTransactionRepository,
  mongoose,
  signupProtectionRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';

const h = vi.hoisted(() => ({
  handlers: [] as Array<(req: Request, res: Response) => Promise<unknown>>,
  heldAdapters: null as userService.HeldGrantAdapters | null,
  audit: vi.fn(),
  logger: { error: vi.fn() },
}));
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
    const chain = {
      use: () => chain,
      post: (handler: (typeof h.handlers)[number]) => {
        h.handlers.push(handler);
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => undefined }));
vi.mock('@bike4mind/server-utils/auth/adminRoles', () => ({ resolveRoleAdminPermissions: (actor: unknown) => actor }));
// The real module binds Slack and CloudWatch through sst; the gate in releaseStage only needs the repository.
vi.mock('@bike4mind/server-utils/auth/signupProtection', async () => ({
  signupProtection: { repository: (await import('@bike4mind/database')).signupProtectionRepository },
}));
vi.mock('@bike4mind/server-utils/credits/heldSignupGrantAdapters', () => ({
  buildHeldGrantAdapters: () => h.heldAdapters,
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.audit,
}));

await import('../unlock-signup-grant');
const unlock = h.handlers.at(-1)!;
await import('../release-held-signup-grant');
const releaseHeld = h.handlers.at(-1)!;

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
let actorId: string;
const models = [User, CreditTransaction, CreditLot, AdminSettings];
const grant = {
  db: {
    users: userRepository,
    creditTransactions: creditTransactionRepository,
    creditLots: creditLotRepository,
    adminSettings: adminSettingsRepository,
    signupProtection: { repository: signupProtectionRepository },
  },
  reason: 'Synthetic release review',
  validators: { admin: async () => true },
  audit: async () => {},
};

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  for (const model of models) await model.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  for (const model of models) await model.collection.deleteMany({});
  await AdminSettings.insertMany([
    { settingName: 'signupGrantInitialCredits', settingValue: '12' },
    { settingName: 'signupGrantDripCap', settingValue: '28' },
  ]);
  const actor = await User.create({
    username: 'release-admin',
    name: 'Synthetic Admin',
    email: 'admin@example.test',
    isAdmin: true,
  });
  actorId = actor.id;
  h.heldAdapters = {
    grant: { ...grant, logger: h.logger },
    clearPending: (id: string) => userRepository.clearPendingFreeCreditGrant(id),
  };
});

async function invoke(handler: (typeof h.handlers)[number], userId: string) {
  const json = vi.fn();
  await handler(
    {
      query: { userId },
      user: { id: actorId, isAdmin: true },
      body: { reason: 'Synthetic release review' },
      logger: h.logger,
    } as unknown as Request,
    { json } as unknown as Response
  );
  return json;
}

describe('signup grant release route payout invariants', () => {
  it.each(['remainder', 'held'] as const)('%s route releases credits without conferring paid standing', async kind => {
    const user = await User.create({
      username: 'release-recipient',
      name: 'Synthetic Recipient',
      email: 'recipient@example.test',
      emailVerified: true,
      signupGrant: await newSignupGrant(adminSettingsRepository),
      ...(kind === 'held'
        ? {
            tags: [PENDING_FREE_CREDITS_TAG],
            signupGrantHeldReason: 'budget_exhausted',
            signupGrantHeldAt: new Date(),
          }
        : {}),
    });
    if (kind === 'remainder') await userService.releaseSignupTranche(user.id, grant);

    const json = await invoke(kind === 'remainder' ? unlock : releaseHeld, user.id);

    const credits = kind === 'remainder' ? 28 : 12;
    const total = kind === 'remainder' ? 40 : 12;
    expect(json).toHaveBeenCalledWith({ outcome: 'applied', credits });
    expect(h.logger.error).not.toHaveBeenCalled();
    const stored = await User.collection.findOne({ _id: user._id });
    expect(stored?.currentCredits).toBe(total);
    expect(stored?.lastCreditsPurchasedAt ?? null).toBeNull();
    expect(await CreditTransaction.countDocuments({ ownerId: user.id, type: 'purchase' })).toBe(0);
    const payout = await CreditTransaction.findOne({ ownerId: user.id, type: 'generic_add' }).sort({ _id: -1 }).lean();
    expect(payout).toMatchObject({
      credits,
      reason: kind === 'remainder' ? 'signup_unlock:admin' : 'signup_tranche',
    });
    const lots = await CreditLot.find({ ownerId: user.id }).lean();
    expect(lots.map(lot => lot.source)).toEqual(lots.map(() => 'promo'));
    expect(lots.reduce((sum, lot) => sum + lot.amount, 0)).toBe(total);
    expect(h.audit).toHaveBeenCalledOnce();

    const repeat = await invoke(kind === 'remainder' ? unlock : releaseHeld, user.id);

    expect(repeat.mock.calls[0]?.[0]).toMatchObject({ outcome: 'noop' });
    expect((await User.collection.findOne({ _id: user._id }))?.currentCredits).toBe(total);
    expect(await CreditTransaction.countDocuments({ ownerId: user.id, type: 'generic_add' })).toBe(
      kind === 'remainder' ? 2 : 1
    );
    expect(h.audit).toHaveBeenCalledOnce();
  });
});
