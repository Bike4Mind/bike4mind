import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupMongoTest } from '../../../__test__/utils';
import { AdminAuditReviewModel, adminAuditReviewRepository } from './AdminAuditReviewModel';

const ADA = new Types.ObjectId().toHexString();
const GRACE = new Types.ObjectId().toHexString();

const newId = () => new Types.ObjectId().toHexString();
const reviewBy = (auditEntryId: string, userId: string, name = 'Reviewer') => ({
  auditEntryId,
  reviewer: { userId, name },
});

describe('AdminAuditReviewRepository', () => {
  setupMongoTest();

  it('inserts reviews and finds them by entry id', async () => {
    const [first, second] = [newId(), newId()];
    const inserted = await adminAuditReviewRepository.createMany([
      { ...reviewBy(first, ADA, 'Ada'), note: 'checked' },
      reviewBy(second, ADA, 'Ada'),
    ]);

    expect(inserted.sort()).toEqual([first, second].sort());
    const found = await adminAuditReviewRepository.findByEntryIds([first]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ auditEntryId: first, reviewer: { userId: ADA, name: 'Ada' }, note: 'checked' });
    expect(found[0]?.reviewedAt).toBeInstanceOf(Date);
  });

  it('skips entries that already have a review and returns only the ids it inserted', async () => {
    // The unique index is the guard, and the test DB does not build it on its own.
    await AdminAuditReviewModel.createIndexes();
    const [taken, fresh] = [newId(), newId()];
    await adminAuditReviewRepository.createMany([reviewBy(taken, GRACE, 'Grace')]);

    const inserted = await adminAuditReviewRepository.createMany([
      reviewBy(taken, ADA, 'Ada'),
      reviewBy(fresh, ADA, 'Ada'),
    ]);

    expect(inserted).toEqual([fresh]);
    const [kept] = await adminAuditReviewRepository.findByEntryIds([taken]);
    expect(kept?.reviewer.userId).toBe(GRACE);
  });

  it('returns nothing for an empty batch', async () => {
    expect(await adminAuditReviewRepository.createMany([])).toEqual([]);
  });

  it('stores a baseline review with a null reviewer', async () => {
    const id = newId();
    await adminAuditReviewRepository.createMany([
      { auditEntryId: id, reviewer: { userId: null, name: 'Baseline' }, baseline: true },
    ]);

    const [review] = await adminAuditReviewRepository.findByEntryIds([id]);
    expect(review).toMatchObject({ reviewer: { userId: null, name: 'Baseline' }, baseline: true });
  });

  it('deletes only the reviews the caller wrote', async () => {
    const [mine, theirs, baseline] = [newId(), newId(), newId()];
    await adminAuditReviewRepository.createMany([
      reviewBy(mine, ADA),
      reviewBy(theirs, GRACE),
      { auditEntryId: baseline, reviewer: { userId: null, name: 'Baseline' }, baseline: true },
    ]);

    const deleted = await adminAuditReviewRepository.deleteByReviewer([mine, theirs, baseline, newId()], ADA);

    expect(deleted).toEqual([mine]);
    const remaining = await adminAuditReviewRepository.findByEntryIds([mine, theirs, baseline]);
    expect(remaining.map(review => review.auditEntryId).sort()).toEqual([theirs, baseline].sort());
  });
});
