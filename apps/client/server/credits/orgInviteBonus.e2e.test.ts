import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteType, SIGNUP_UNLOCK_FORFEIT_CAUSES } from '@bike4mind/common';
import {
  AdminSettings,
  CreditTransaction,
  Invite,
  mongoose,
  Organization,
  User,
  userRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { retryOrgInviteBonus, payOrgInviteBonus, recordOrgSignupInvite } from './orgInviteBonus';

// Without the signup protection wiring the budget is unmetered; signupGrantBudget covers the pools.
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: undefined }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all(
    [User, Invite, Organization, CreditTransaction, AdminSettings].map(model => model.createCollection())
  );
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await Promise.all(
    [User, Invite, Organization, CreditTransaction, AdminSettings].map(model => model.collection.deleteMany({}))
  );
  await AdminSettings.collection.insertOne({ settingName: 'signupGrantInviteBonusCredits', settingValue: '2000' });
});

const organizationId = new mongoose.Types.ObjectId().toHexString();
const grant = { stage: 'signup', signupCredits: 10, unlockCredits: 20, creditsReleased: 10 };

async function createInvite(type = InviteType.Organization) {
  return Invite.create({
    type,
    documentId: organizationId,
    remaining: 0,
    recipients: { accepted: ['new@example.test'], pending: [], refused: [] },
  });
}

async function createUser(name: string, extra: Record<string, unknown> = {}) {
  return User.create({ name, username: name, email: `${name}@example.test`, signupGrant: grant, ...extra });
}

describe('recordOrgSignupInvite', () => {
  it('marks an account created after the invite once, even when replayed concurrently', async () => {
    const invite = await createInvite();
    const user = await createUser('new');
    const results = await Promise.all([
      recordOrgSignupInvite(user.id, invite.id),
      recordOrgSignupInvite(user.id, invite.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await User.findById(user.id).lean();
    expect(stored?.signupInvite).toEqual({
      source: 'organization',
      inviteId: invite.id,
      organizationId,
      at: expect.any(Date),
    });
  });

  it('does not mark an account that existed before the invite', async () => {
    const user = await createUser('old');
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date(0) } });
    const invite = await createInvite();
    expect(await recordOrgSignupInvite(user.id, invite.id)).toBe(false);
    expect((await User.findById(user.id).lean())?.signupInvite).toBeUndefined();
  });

  it('leaves the account unmarked, with a warning, when the invite has no creation date', async () => {
    const invite = await createInvite();
    await Invite.collection.updateOne({ _id: invite._id }, { $unset: { createdAt: '' } });
    const user = await createUser('new');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await recordOrgSignupInvite(user.id, invite.id)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no creation date'));
    expect((await User.findById(user.id).lean())?.signupInvite).toBeUndefined();
  });

  it('does not mark an account without a signup grant', async () => {
    const invite = await createInvite();
    const user = await createUser('sso', { signupGrant: undefined });
    expect(await recordOrgSignupInvite(user.id, invite.id)).toBe(false);
  });

  it('does not mark through a non-organization invite or overwrite an existing mark', async () => {
    const projectInvite = await createInvite(InviteType.Project);
    const user = await createUser('new');
    expect(await recordOrgSignupInvite(user.id, projectInvite.id)).toBe(false);

    const orgInvite = await createInvite();
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { signupInvite: { source: 'referral', inviteId: 'earlier', at: new Date() } } }
    );
    expect(await recordOrgSignupInvite(user.id, orgInvite.id)).toBe(false);
    expect((await User.findById(user.id).lean())?.signupInvite?.source).toBe('referral');
  });
});

describe('payOrgInviteBonus', () => {
  const released = {
    emailVerified: true,
    signupGrantAssessment: {
      band: 'full',
      credits: 10,
      score: null,
      reasons: [],
      missing: [],
      policyVersion: null,
      status: 'disabled',
    },
  };

  async function createOrganization(paying: boolean) {
    await Organization.collection.insertOne({
      _id: new mongoose.Types.ObjectId(organizationId),
      name: 'Acme',
      seats: 5,
      ...(paying ? { lastCreditsPurchasedAt: new Date() } : {}),
    });
  }

  it('marks and pays a new account that accepted a paying organization invite, once', async () => {
    await createOrganization(true);
    const invite = await createInvite();
    const user = await createUser('new', released);
    expect(await payOrgInviteBonus(user.id, invite.id)).toBe(2000);
    expect(await payOrgInviteBonus(user.id, invite.id)).toBe(0);
    const stored = await User.findById(user.id).lean();
    expect(stored?.signupInvite?.source).toBe('organization');
    expect(stored?.signupGrant?.inviteBonusPaid).toBe(2000);
    expect(await CreditTransaction.countDocuments({ transactionId: `invite-bonus:${user.id}` })).toBe(1);
  });

  it('leaves an account uninvited and unpaid for an unpaid organization', async () => {
    await createOrganization(false);
    const invite = await createInvite();
    const user = await createUser('new', released);
    expect(await payOrgInviteBonus(user.id, invite.id)).toBe(0);
    expect((await User.findById(user.id).lean())?.signupInvite).toBeUndefined();
  });

  it.each(SIGNUP_UNLOCK_FORFEIT_CAUSES)('does not pay or reserve a bonus seat after a %s forfeiture', async cause => {
    await createOrganization(true);
    const invite = await createInvite();
    const user = await createUser('forfeited', {
      ...released,
      signupGrant: { ...grant, unlockForfeited: { cause, at: new Date() } },
    });

    expect(await payOrgInviteBonus(user.id, invite.id)).toBe(0);
    expect(await retryOrgInviteBonus(user.id)).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    const organization = await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(organizationId) });
    expect(organization?.signupInviteBonusCount).toBeUndefined();
  });

  it('does not use a later organization to fund a bonus attributed to another organization', async () => {
    await createOrganization(true);
    const invite = await createInvite();
    const originatingOrganizationId = new mongoose.Types.ObjectId().toHexString();
    await Organization.collection.insertOne({
      _id: new mongoose.Types.ObjectId(originatingOrganizationId),
      name: 'Origin',
      seats: 5,
    });
    const user = await createUser('earlier-org', {
      ...released,
      signupInvite: {
        source: 'organization',
        inviteId: 'earlier',
        organizationId: originatingOrganizationId,
        at: new Date(),
      },
    });

    expect(await payOrgInviteBonus(user.id, invite.id)).toBe(0);
    expect(await retryOrgInviteBonus(user.id)).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    const organization = await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(organizationId) });
    expect(organization?.signupInviteBonusCount).toBeUndefined();
    expect((await User.findById(user.id).lean())?.signupInvite?.organizationId).toBe(originatingOrganizationId);
  });

  it('does not spend an organization bonus seat on an account attributed to a referral', async () => {
    await createOrganization(true);
    const invite = await createInvite();
    const user = await createUser('referral', {
      ...released,
      signupInvite: { source: 'referral', inviteId: 'earlier', at: new Date() },
    });

    expect(await payOrgInviteBonus(user.id, invite.id)).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    const organization = await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(organizationId) });
    expect(organization?.signupInviteBonusCount).toBeUndefined();
  });

  it('caps bonuses at the organization seats without reserving a seat for an ineligible account', async () => {
    await createOrganization(true);
    await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(organizationId) },
      { $set: { seats: 1 } }
    );
    const invite = await createInvite();
    const pending = await createUser('pending', { ...released, signupGrant: { ...grant, stage: 'pending_email' } });
    expect(await payOrgInviteBonus(pending.id, invite.id)).toBe(0);
    const first = await createUser('first', released);
    const second = await createUser('second', released);
    expect(await payOrgInviteBonus(first.id, invite.id)).toBe(2000);
    expect(await payOrgInviteBonus(second.id, invite.id)).toBe(0);
    const org = await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(organizationId) });
    expect(org?.signupInviteBonusCount).toBe(1);
  });

  it('commits only one bonus when two invitees race for the final organization seat', async () => {
    await createOrganization(true);
    const organizationFilter = { _id: new mongoose.Types.ObjectId(organizationId) };
    await Organization.collection.updateOne(organizationFilter, { $set: { seats: 1 } });
    const invite = await createInvite();
    const first = await createUser('first', released);
    const second = await createUser('second', released);

    const results = await Promise.all([
      payOrgInviteBonus(first.id, invite.id),
      payOrgInviteBonus(second.id, invite.id),
    ]);
    expect(results.sort()).toEqual([0, 2000]);
    expect((await Organization.collection.findOne(organizationFilter))?.signupInviteBonusCount).toBe(1);
    expect(await CreditTransaction.countDocuments({})).toBe(1);
  });

  it('keeps the seat reservation uncommitted until its payout commits', async () => {
    await createOrganization(true);
    const organizationFilter = { _id: new mongoose.Types.ObjectId(organizationId) };
    const invite = await createInvite();
    const user = await createUser('interrupted', released);
    let signalPayoutStarted: () => void = () => {};
    const payoutStarted = new Promise<void>(resolve => {
      signalPayoutStarted = resolve;
    });
    let releasePayout: () => void = () => {};
    const payoutReleased = new Promise<void>(resolve => {
      releasePayout = resolve;
    });
    vi.spyOn(userRepository, 'claimFreeCreditGrant').mockImplementationOnce(async () => {
      signalPayoutStarted();
      await payoutReleased;
      throw new Error('interrupted payout');
    });
    const payoutFailure = expect(payOrgInviteBonus(user.id, invite.id)).rejects.toThrow('interrupted payout');
    try {
      await payoutStarted;
      expect((await Organization.collection.findOne(organizationFilter))?.signupInviteBonusCount ?? 0).toBe(0);
      expect(await CreditTransaction.countDocuments({})).toBe(0);
    } finally {
      releasePayout();
      await payoutFailure;
    }
    expect((await Organization.collection.findOne(organizationFilter))?.signupInviteBonusCount ?? 0).toBe(0);
  });

  it.each(['refused', 'failed'] as const)('rolls back the seat when the bonus payout is %s', async outcome => {
    await createOrganization(true);
    const organizationFilter = { _id: new mongoose.Types.ObjectId(organizationId) };
    await Organization.collection.updateOne(organizationFilter, { $set: { seats: 1 } });
    const invite = await createInvite();
    const user = await createUser('unpaid', released);
    const reserveSeat = vi.spyOn(Organization, 'updateOne');
    if (outcome === 'refused') {
      vi.spyOn(userRepository, 'markInviteBonusPaid').mockResolvedValueOnce(false);
      expect(await payOrgInviteBonus(user.id, invite.id)).toBe(0);
    } else {
      vi.spyOn(userRepository, 'claimFreeCreditGrant').mockRejectedValueOnce(new Error('payout failed'));
      await expect(payOrgInviteBonus(user.id, invite.id)).rejects.toThrow('payout failed');
    }

    expect(reserveSeat).toHaveBeenCalledWith(expect.objectContaining({ _id: organizationId }), {
      $inc: { signupInviteBonusCount: 1 },
    });
    expect((await Organization.collection.findOne(organizationFilter))?.signupInviteBonusCount ?? 0).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(0);
    const nextUser = await createUser('next', released);
    expect(await payOrgInviteBonus(nextUser.id, invite.id)).toBe(2000);
    expect((await Organization.collection.findOne(organizationFilter))?.signupInviteBonusCount).toBe(1);
  });

  it('retries a bonus left unpaid at acceptance only while the organization still pays', async () => {
    await createOrganization(true);
    const invite = await createInvite();
    const user = await createUser('new', { ...released, signupGrant: { ...grant, stage: 'pending_email' } });
    expect(await payOrgInviteBonus(user.id, invite.id)).toBe(0);
    await User.collection.updateOne({ _id: user._id }, { $set: { 'signupGrant.stage': 'signup' } });

    const orgFilter = { _id: new mongoose.Types.ObjectId(organizationId) };
    await Organization.collection.updateOne(orgFilter, { $unset: { lastCreditsPurchasedAt: '' } });
    expect(await retryOrgInviteBonus(user.id)).toBe(0);
    await Organization.collection.updateOne(orgFilter, { $set: { lastCreditsPurchasedAt: new Date() } });
    expect(await retryOrgInviteBonus(user.id)).toBe(2000);
    expect(await retryOrgInviteBonus(user.id)).toBe(0);
    expect(await CreditTransaction.countDocuments({ transactionId: `invite-bonus:${user.id}` })).toBe(1);
  });

  it('pays nothing to an account that existed before the invite', async () => {
    await createOrganization(true);
    const user = await createUser('old', released);
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date(0) } });
    const invite = await createInvite();
    expect(await payOrgInviteBonus(user.id, invite.id)).toBe(0);
    expect(await CreditTransaction.countDocuments({})).toBe(0);
  });
});
