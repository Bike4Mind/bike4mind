import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Request } from 'express';
import { AdminApprovalModel, AdminAuditLogModel, adminApprovalRepository } from '@bike4mind/database';
import type { AdminApproval } from '@bike4mind/common';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../packages/database/src/__test__/createMongoServer';

const auditHook = vi.hoisted(() => vi.fn(async (_action: string) => undefined));
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  return {
    ...actual,
    recordAdminActionFromRequest: async (...parameters: Parameters<typeof actual.recordAdminActionFromRequest>) => {
      await auditHook(parameters[1].action);
      return actual.recordAdminActionFromRequest(...parameters);
    },
  };
});
vi.mock('./executors', () => ({ approvalExecutors: { 'users.bulk': async () => ({ updated: 2 }) } }));

import { approveApproval, requestApproval } from './service';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let replicaSet: MongoMemoryReplSet;
beforeAll(async () => {
  replicaSet = await createMongoReplSet();
  await mongoose.connect(replicaSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([AdminApprovalModel.createCollection(), AdminAuditLogModel.createCollection()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
});
afterEach(async () => {
  auditHook.mockReset();
  await Promise.all([AdminApprovalModel.deleteMany({}), AdminAuditLogModel.collection.deleteMany({})]);
});

const REQUESTER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const APPROVER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const reqFor = (id: string) =>
  ({
    user: { id, name: 'Admin', username: 'admin', email: 'admin@example.com', isAdmin: true },
    headers: {},
    url: '/api/admin/approvals',
    requestId: 'approval-transaction-test',
    logger: { error: vi.fn() },
  }) as unknown as Request;
const POLICY = { enabled: true, expiryHours: 24, bulkUserThreshold: 1, creditThreshold: 1000 };
const INPUT = {
  action: 'user.impersonate_admin',
  params: { targetUserId: 'target' },
  summary: 'Impersonate admin',
  reason: 'Investigating a reported issue',
  requiredPermission: 'users:impersonate',
  requiresFullAdmin: true,
} as const;

const deferred = () => {
  const state = { resolve: () => {} };
  const promise = new Promise<void>(resolve => {
    state.resolve = resolve;
  });
  return { promise, resolve: () => state.resolve() };
};

const pauseAudit = (action: string, fail: boolean) => {
  const reached = deferred();
  const released = deferred();
  auditHook.mockImplementation(async currentAction => {
    if (currentAction !== action) return;
    reached.resolve();
    await released.promise;
    if (fail) throw new Error('audit unavailable');
  });
  return { reached: reached.promise, release: released.resolve };
};

const pendingRequest = async (): Promise<AdminApproval> => {
  const requested = await requestApproval(reqFor(REQUESTER), INPUT, POLICY);
  const record = await adminApprovalRepository.findById(requested.approvalId);
  if (!record) throw new Error('Approval was not stored');
  return record;
};

describe('approval audit transactions on a real replica set', () => {
  it('publishes a pending request only with its committed requested audit', async () => {
    const pause = pauseAudit('admin.approval.requested', false);
    const operation = requestApproval(reqFor(REQUESTER), INPUT, POLICY);
    await pause.reached;
    try {
      expect(await AdminApprovalModel.countDocuments()).toBe(0);
      expect(await AdminAuditLogModel.countDocuments()).toBe(0);
    } finally {
      pause.release();
    }
    const result = await operation;
    expect((await adminApprovalRepository.findById(result.approvalId))?.status).toBe('pending');
    expect(await AdminAuditLogModel.countDocuments({ action: 'admin.approval.requested' })).toBe(1);
  });

  it('rolls back request creation when the requested audit fails', async () => {
    const pause = pauseAudit('admin.approval.requested', true);
    const operation = expect(requestApproval(reqFor(REQUESTER), INPUT, POLICY)).rejects.toThrow('audit unavailable');
    await pause.reached;
    try {
      expect(await AdminApprovalModel.countDocuments()).toBe(0);
    } finally {
      pause.release();
    }
    await operation;
    expect(await AdminApprovalModel.countDocuments()).toBe(0);
    expect(await AdminAuditLogModel.countDocuments()).toBe(0);
  });

  it('keeps an impersonation pending until its approved audit commits', async () => {
    const pending = await pendingRequest();
    const pause = pauseAudit('admin.approval.approved', false);
    const operation = approveApproval(reqFor(APPROVER), pending.id);
    await pause.reached;
    try {
      expect((await adminApprovalRepository.findById(pending.id))?.status).toBe('pending');
      expect(await AdminAuditLogModel.countDocuments({ action: 'admin.approval.approved' })).toBe(0);
    } finally {
      pause.release();
    }
    expect((await operation).approval.status).toBe('approved');
    expect(await AdminAuditLogModel.countDocuments({ action: 'admin.approval.approved' })).toBe(1);
  });

  it('rolls an approval claim back when the approved audit fails', async () => {
    const pending = await pendingRequest();
    const pause = pauseAudit('admin.approval.approved', true);
    const operation = expect(approveApproval(reqFor(APPROVER), pending.id)).rejects.toThrow('audit unavailable');
    await pause.reached;
    try {
      expect((await adminApprovalRepository.findById(pending.id))?.status).toBe('pending');
    } finally {
      pause.release();
    }
    await operation;
    expect(await adminApprovalRepository.findById(pending.id)).toMatchObject({ status: 'pending' });
    expect(await AdminAuditLogModel.countDocuments({ action: 'admin.approval.approved' })).toBe(0);
  });
});
