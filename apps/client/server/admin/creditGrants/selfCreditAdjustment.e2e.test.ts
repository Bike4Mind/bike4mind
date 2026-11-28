// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Request } from 'express';
import type { AdminApproval } from '@bike4mind/common';
import {
  User,
  CreditTransaction,
  AdminAuditLogModel,
  AdminGateReservationModel,
  userRepository,
  creditTransactionRepository,
  adminAuditLogRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../packages/database/src/__test__/createMongoServer';

const config = vi.hoisted(() => ({ ADMIN_SENIOR_GRANTER_IDS: 'bbbbbbbbbbbbbbbbbbbbbbbb,cccccccccccccccccccccccc' }));
vi.mock('@bike4mind/server-utils/utils/config', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/config')>()),
  Config: config,
}));

const auditHook = vi.hoisted(() => vi.fn(async (_action: string) => undefined));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>();
  return {
    ...actual,
    recordAdminActionFromRequest: async (...args: Parameters<typeof actual.recordAdminActionFromRequest>) => {
      await auditHook(args[1].action);
      return actual.recordAdminActionFromRequest(...args);
    },
  };
});

import { applyApprovedCreditGrant, applyApprovedSelfCreditAdjustment } from './selfCreditAdjustment';
import { checkCreditGrantCap } from './tierCap';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const RECIPIENT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const DELEGATE = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const FULL_ADMIN = 'cccccccccccccccccccccccc';
const REQUESTER = 'dddddddddddddddddddddddd';
const params = { userId: RECIPIENT, creditDelta: 300_000, creditReason: 'Approved account credit grant' };
const approval: AdminApproval = {
  id: 'eeeeeeeeeeeeeeeeeeeeeeee',
  action: 'user.credits.grant',
  paramsJson: JSON.stringify(params),
  paramsHash: 'approved-parameters',
  summary: 'Grant account credits',
  requestedBy: { id: REQUESTER, name: 'Requester', email: 'requester@example.test', selfIds: [REQUESTER] },
  reason: params.creditReason,
  requiredPermission: 'credits:approve_self_grant',
  requiresFullAdmin: false,
  status: 'approved',
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date(),
};
const request = (id: string, isAdmin: boolean): Request =>
  ({
    user: {
      id,
      isAdmin,
      name: 'Approver',
      email: 'approver@example.test',
      adminPermissions: ['credits:adjust', 'credits:approve_self_grant'],
    },
    headers: {},
    url: '/api/admin/approvals',
    requestId: 'approved-credit-executor-test',
    logger: { error: vi.fn() },
  }) as unknown as Request;

let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all(
    [User, CreditTransaction, AdminAuditLogModel, AdminGateReservationModel].map(model => model.createCollection())
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  auditHook.mockReset();
  await Promise.all([
    User.deleteMany({}),
    CreditTransaction.deleteMany({}),
    AdminAuditLogModel.collection.deleteMany({}),
    AdminGateReservationModel.deleteMany({}),
  ]);
  await User.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(RECIPIENT),
      email: 'recipient@example.test',
      name: 'Recipient',
      currentCredits: 10,
      isAdmin: false,
      adminPermissions: [],
      adminRoleIds: [],
    },
    {
      _id: new mongoose.Types.ObjectId(DELEGATE),
      email: 'delegate@example.test',
      currentCredits: 0,
      isAdmin: false,
      adminPermissions: ['credits:adjust', 'credits:approve_self_grant'],
      adminRoleIds: [],
    },
    {
      _id: new mongoose.Types.ObjectId(FULL_ADMIN),
      email: 'admin@example.test',
      currentCredits: 0,
      isAdmin: true,
      adminPermissions: [],
      adminRoleIds: [],
    },
  ]);
});

describe('approved credit execution on a real replica set', () => {
  it.each([
    ['a full administrator', FULL_ADMIN, true],
    ['a listed delegated approver', DELEGATE, false],
  ] as const)(
    'credits an ordinary recipient as %s without changing profile privileges',
    async (_label, actorId, isAdmin) => {
      const result = await applyApprovedCreditGrant(request(actorId, isAdmin), params, approval);

      expect(result).toEqual({ userId: RECIPIENT, appliedCreditDelta: 300_000, currentCredits: 300_010 });
      expect(await User.collection.findOne({ _id: new mongoose.Types.ObjectId(RECIPIENT) })).toMatchObject({
        currentCredits: 300_010,
        name: 'Recipient',
        isAdmin: false,
        adminPermissions: [],
        adminRoleIds: [],
      });
      expect((await userRepository.findById(RECIPIENT))?.lastCreditsPurchasedAt ?? null).toBeNull();
      const rows = await CreditTransaction.find({ ownerId: RECIPIENT }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'generic_add',
        credits: 300_000,
        reason: 'admin_adjustment',
        metadata: expect.objectContaining({ actorId }),
      });
      const audits = await AdminAuditLogModel.find({ action: 'user.credits.adjusted' }).lean();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ related: { creditTransactionId: String(rows[0]._id) } });
      expect(await AdminGateReservationModel.countDocuments()).toBe(0);
    }
  );
  it('rolls the ledger and balance back when the grant audit fails', async () => {
    auditHook.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(applyApprovedCreditGrant(request(FULL_ADMIN, true), params, approval)).rejects.toThrow(
      'audit unavailable'
    );

    expect((await userRepository.findById(RECIPIENT))?.currentCredits).toBe(10);
    expect(await CreditTransaction.countDocuments()).toBe(0);
    expect(await AdminAuditLogModel.countDocuments()).toBe(0);
    expect(await AdminGateReservationModel.countDocuments()).toBe(0);
  });

  it.each([false, true])('restores paid standing only for an unreversed purchase (reversed %s)', async reversed => {
    await CreditTransaction.collection.insertOne({
      ownerId: RECIPIENT,
      ownerType: 'User',
      type: 'purchase',
      credits: 10,
      status: 'completed',
      ...(reversed ? { reversedAt: new Date() } : {}),
    });

    await applyApprovedCreditGrant(request(FULL_ADMIN, true), params, approval);

    const user = await userRepository.findById(RECIPIENT);
    if (reversed) expect(user?.lastCreditsPurchasedAt ?? null).toBeNull();
    else expect(user?.lastCreditsPurchasedAt).toBeInstanceOf(Date);
  });

  it('preserves an intervening spend when its transaction is retried', async () => {
    const createTransaction = creditTransactionRepository.createTransaction.bind(creditTransactionRepository);
    vi.spyOn(creditTransactionRepository, 'createTransaction').mockImplementationOnce(async (...args) => {
      await User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(RECIPIENT) },
        { $inc: { currentCredits: -5 } },
        { session: null }
      );
      return createTransaction(...args);
    });

    const result = await applyApprovedCreditGrant(request(FULL_ADMIN, true), params, approval);

    expect(result.currentCredits).toBe(300_005);
    expect((await userRepository.findById(RECIPIENT))?.currentCredits).toBe(300_005);
    expect(await CreditTransaction.countDocuments({ type: 'generic_add' })).toBe(1);
    expect(await AdminAuditLogModel.findOne({ action: 'user.credits.adjusted' }).lean()).toMatchObject({
      changes: [{ field: 'currentCredits', before: 5, after: 300_005 }],
    });
    expect(await AdminGateReservationModel.countDocuments()).toBe(0);
  });
  it('applies an approved self grant with the real deciding actor', async () => {
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(RECIPIENT) },
      { $set: { adminPermissions: ['credits:adjust'] } }
    );
    const selfApproval: AdminApproval = {
      ...approval,
      action: 'user.credits.self_grant',
      requestedBy: { ...approval.requestedBy, id: RECIPIENT, selfIds: [RECIPIENT] },
    };

    await applyApprovedSelfCreditAdjustment(request(DELEGATE, false), params, selfApproval);

    expect((await userRepository.findById(RECIPIENT))?.currentCredits).toBe(300_010);
    expect(await CreditTransaction.findOne({ ownerId: RECIPIENT }).lean()).toMatchObject({
      metadata: expect.objectContaining({ actorId: DELEGATE }),
    });
    expect(await AdminAuditLogModel.findOne({ action: 'user.credits.adjusted' }).lean()).toMatchObject({
      details: expect.objectContaining({ selfGrant: true }),
    });
    expect(await AdminGateReservationModel.countDocuments()).toBe(0);
  });

  it('releases a real reservation when only the post-hold history read rejects', async () => {
    const failure = new Error('post-hold history unavailable');
    vi.spyOn(adminAuditLogRepository, 'sumCreditsGrantedTo')
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(failure);
    const req = request(DELEGATE, false);
    const capRequest = {
      actor: req.user!,
      recipient: { id: RECIPIENT, displayName: 'Recipient' },
      credits: 60_000,
      targetsSelf: false,
      approvalAvailable: true,
      reason: params.creditReason,
      attemptedAction: 'user.credits.adjusted' as const,
    };
    const writeAudit = (input: Parameters<typeof recordAdminActionFromRequest>[1]) =>
      recordAdminActionFromRequest(req, input);

    await expect(checkCreditGrantCap(capRequest, writeAudit)).rejects.toBe(failure);

    expect(await AdminGateReservationModel.countDocuments()).toBe(0);
    const retry = await checkCreditGrantCap(capRequest, writeAudit);
    expect(retry.outcome).toBe('immediate');
    expect(await AdminGateReservationModel.countDocuments()).toBe(1);
    if (retry.outcome === 'immediate') await retry.release();
    expect(await AdminGateReservationModel.countDocuments()).toBe(0);
  });
});
