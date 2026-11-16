import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { ConflictError, type AccessReviewDecision, type AccessReviewDecisionValue } from '@bike4mind/common';
import { setupMongoTest } from '../../../__test__/utils';
import { AdminAccessReviewModel, adminAccessReviewRepository } from './AdminAccessReviewModel';

const ADA = { userId: new Types.ObjectId().toHexString(), name: 'Ada' };
const GRACE = { userId: new Types.ObjectId().toHexString(), name: 'Grace' };

const decisionFor = (userId: string, decision: AccessReviewDecisionValue, reviewer = ADA): AccessReviewDecision => ({
  userId,
  email: `${userId}@example.com`,
  fullAdmin: false,
  permissions: ['users:read'],
  decision,
  reviewer,
  decidedAt: new Date(),
});

describe('AdminAccessReviewRepository', () => {
  setupMongoTest();

  it('creates one record when two first decisions race, holding both decisions', async () => {
    // The unique index is the guard, and the test DB does not build it on its own.
    await AdminAccessReviewModel.createIndexes();
    const [first, second] = [new Types.ObjectId().toHexString(), new Types.ObjectId().toHexString()];

    await Promise.all([
      adminAccessReviewRepository.recordDecision('2027-Q2', 90, ADA, decisionFor(first, 'confirmed', ADA)),
      adminAccessReviewRepository.recordDecision('2027-Q2', 90, GRACE, decisionFor(second, 'confirmed', GRACE)),
    ]);

    expect(await AdminAccessReviewModel.countDocuments({ quarter: '2027-Q2' })).toBe(1);
    const record = await adminAccessReviewRepository.findByQuarter('2027-Q2');
    expect(record?.decisions.map(({ userId }) => userId).sort()).toEqual([first, second].sort());
    expect(record?.completedAt).toBeNull();
  });

  it('lets a confirm become a revoke, replacing the decision in place', async () => {
    const target = new Types.ObjectId().toHexString();
    await adminAccessReviewRepository.recordDecision('2027-Q2', 90, ADA, decisionFor(target, 'confirmed'));
    const record = await adminAccessReviewRepository.recordDecision('2027-Q2', 90, GRACE, {
      ...decisionFor(target, 'revoked', GRACE),
      auditEntryId: 'audit-1',
    });

    expect(record.decisions).toHaveLength(1);
    expect(record.decisions[0]).toMatchObject({ decision: 'revoked', reviewer: GRACE, auditEntryId: 'audit-1' });
  });

  it('refuses to turn a revoke back into a confirm', async () => {
    const target = new Types.ObjectId().toHexString();
    await adminAccessReviewRepository.recordDecision('2027-Q2', 90, ADA, decisionFor(target, 'revoked'));

    await expect(
      adminAccessReviewRepository.recordDecision('2027-Q2', 90, GRACE, decisionFor(target, 'confirmed', GRACE))
    ).rejects.toBeInstanceOf(ConflictError);
    const record = await adminAccessReviewRepository.findByQuarter('2027-Q2');
    expect(record?.decisions).toEqual([expect.objectContaining({ userId: target, decision: 'revoked' })]);
  });

  it('treats a repeated decision as a no-op', async () => {
    const target = new Types.ObjectId().toHexString();
    await adminAccessReviewRepository.recordDecision('2027-Q2', 90, ADA, decisionFor(target, 'confirmed'));
    const record = await adminAccessReviewRepository.recordDecision(
      '2027-Q2',
      90,
      GRACE,
      decisionFor(target, 'confirmed', GRACE)
    );

    expect(record.decisions).toHaveLength(1);
    expect(record.decisions[0]?.reviewer).toEqual(ADA);
  });

  it('keeps the first completion and finds the most recently completed review', async () => {
    const target = new Types.ObjectId().toHexString();
    for (const quarter of ['2027-Q1', '2027-Q2', '2027-Q3']) {
      await adminAccessReviewRepository.recordDecision(quarter, 90, ADA, decisionFor(target, 'confirmed'));
    }
    await adminAccessReviewRepository.markCompleted('2027-Q2', new Date('2027-05-01T00:00:00.000Z'), ADA);
    await adminAccessReviewRepository.markCompleted('2027-Q1', new Date('2027-02-01T00:00:00.000Z'), ADA);
    const again = await adminAccessReviewRepository.markCompleted(
      '2027-Q2',
      new Date('2027-06-01T00:00:00.000Z'),
      GRACE
    );

    expect(again?.completedBy).toEqual(ADA);
    expect(again?.completedAt?.toISOString()).toBe('2027-05-01T00:00:00.000Z');
    const latest = await adminAccessReviewRepository.findLatestCompleted();
    expect(latest?.quarter).toBe('2027-Q2');
    expect(await adminAccessReviewRepository.markCompleted('2026-Q4', new Date(), ADA)).toBeNull();
  });
});
