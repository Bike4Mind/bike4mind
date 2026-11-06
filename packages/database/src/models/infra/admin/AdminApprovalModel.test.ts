import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { approvalParamsHash, canonicalApprovalJson, type NewAdminApproval } from '@bike4mind/common';
import { setupMongoTest } from '../../../__test__/utils';
import { adminApprovalRepository } from './AdminApprovalModel';

const REQUESTER = new Types.ObjectId().toHexString();
const APPROVER = new Types.ObjectId().toHexString();
const HOUR = 60 * 60 * 1000;

const newApproval = (overrides: Partial<NewAdminApproval> = {}): NewAdminApproval => {
  const paramsJson = canonicalApprovalJson({ userIds: ['a', 'b'] });
  return {
    action: 'users.bulk',
    paramsJson,
    paramsHash: approvalParamsHash(paramsJson),
    summary: 'Suspend 2 users',
    requestedBy: { id: REQUESTER, name: 'Ada', email: 'ada@example.com', selfIds: [REQUESTER] },
    reason: 'spam wave',
    requiredPermission: 'users:moderate',
    requiresFullAdmin: false,
    expiresAt: new Date(Date.now() + HOUR),
    ...overrides,
  };
};

describe('AdminApprovalRepository', () => {
  setupMongoTest();

  it('creates a pending record and reads it back', async () => {
    const created = await adminApprovalRepository.create(newApproval());
    expect(created).toMatchObject({ status: 'pending', action: 'users.bulk', requestedBy: { id: REQUESTER } });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await adminApprovalRepository.findById(created.id)).toMatchObject({ id: created.id, status: 'pending' });
  });

  it('returns null for an unknown or malformed id', async () => {
    expect(await adminApprovalRepository.findById(new Types.ObjectId().toHexString())).toBeNull();
    expect(await adminApprovalRepository.findById('not-an-id')).toBeNull();
    expect(await adminApprovalRepository.claim('not-an-id', 'pending', 'executing', { now: new Date() })).toBeNull();
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const { id } = await adminApprovalRepository.create(newApproval());
    const now = new Date();
    const results = await Promise.all([
      adminApprovalRepository.claim(id, 'pending', 'executing', { now, notRequestedBy: APPROVER }),
      adminApprovalRepository.claim(id, 'pending', 'executing', { now, notRequestedBy: APPROVER }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await adminApprovalRepository.findById(id))?.status).toBe('executing');
  });

  it('does not claim an expired record', async () => {
    const { id } = await adminApprovalRepository.create(newApproval({ expiresAt: new Date(Date.now() - 1000) }));
    expect(await adminApprovalRepository.claim(id, 'pending', 'executing', { now: new Date() })).toBeNull();
    expect((await adminApprovalRepository.findById(id))?.status).toBe('pending');
  });

  it('applies the requester guard in both directions', async () => {
    const { id } = await adminApprovalRepository.create(newApproval());
    const now = new Date();
    expect(
      await adminApprovalRepository.claim(id, 'pending', 'approved', { now, notRequestedBy: REQUESTER })
    ).toBeNull();
    expect(await adminApprovalRepository.claim(id, 'pending', 'approved', { now, requestedBy: APPROVER })).toBeNull();
    const claimed = await adminApprovalRepository.claim(id, 'pending', 'approved', { now, requestedBy: REQUESTER });
    expect(claimed?.status).toBe('approved');
  });

  it('records the outcome with finish only from the expected status', async () => {
    const { id } = await adminApprovalRepository.create(newApproval());
    expect(await adminApprovalRepository.finish(id, 'executing', 'executed')).toBeNull();
    await adminApprovalRepository.claim(id, 'pending', 'executing', { now: new Date() });
    const done = await adminApprovalRepository.finish(id, 'executing', 'executed', { result: { updated: 2 } });
    expect(done).toMatchObject({ status: 'executed', result: { updated: 2 } });
  });

  it('clears fields passed as undefined when rolling a decision back', async () => {
    const { id } = await adminApprovalRepository.create(newApproval());
    const decision = { decidedBy: { id: APPROVER, name: 'B' }, decidedAt: new Date(), decisionReason: 'no' };
    await adminApprovalRepository.claim(id, 'pending', 'rejected', { now: new Date() }, decision);
    const restored = await adminApprovalRepository.finish(id, 'rejected', 'pending', {
      decidedBy: undefined,
      decidedAt: undefined,
      decisionReason: undefined,
    });
    expect(restored?.status).toBe('pending');
    expect(restored).not.toHaveProperty('decidedBy');
    expect(restored).not.toHaveProperty('decidedAt');
    expect(restored).not.toHaveProperty('decisionReason');
  });

  it('lists newest first, filtered by status and cursor', async () => {
    const older = await adminApprovalRepository.create(newApproval({ summary: 'older' }));
    const newer = await adminApprovalRepository.create(newApproval({ summary: 'newer' }));
    await adminApprovalRepository.finish(older.id, 'pending', 'rejected');
    const pending = await adminApprovalRepository.list({ status: 'pending', limit: 50 });
    expect(pending.map(({ id }) => id)).toContain(newer.id);
    expect(pending.map(({ id }) => id)).not.toContain(older.id);
    const page = await adminApprovalRepository.list({ before: newer.createdAt, limit: 50 });
    expect(page.every(({ createdAt }) => createdAt < newer.createdAt)).toBe(true);
  });
});
