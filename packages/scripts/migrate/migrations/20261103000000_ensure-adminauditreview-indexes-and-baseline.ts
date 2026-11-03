import type { Types } from 'mongoose';
import { AUDIT_REVIEW_BASELINE_DAYS, type NewAuditReview } from '@bike4mind/common';
import { AdminAuditLogModel, AdminAuditReviewModel, adminAuditReviewRepository } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[ensure-adminauditreview-indexes-and-baseline]';
const BATCH_SIZE = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const BASELINE_REVIEW = { userId: null, name: 'Baseline' } as const;

/**
 * Build the AdminAuditReview indexes (`autoIndex` is off in the deployed environments), then mark every
 * critical entry older than the baseline window as reviewed so the queue starts with the last week, not
 * the whole history. Idempotent: entries that already have a review are skipped, and createMany ignores
 * a concurrent duplicate.
 */
const migration: MigrationFile = {
  id: 20261103000000,
  name: 'ensure adminauditreview indexes and baseline',

  up: async () => {
    await AdminAuditReviewModel.createIndexes();

    const cutoff = new Date(Date.now() - AUDIT_REVIEW_BASELINE_DAYS * MS_PER_DAY);
    const cursor = AdminAuditLogModel.find({ severity: 'critical', occurredAt: { $lt: cutoff } })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .cursor({ batchSize: BATCH_SIZE });

    let baselined = 0;
    let batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const existing = await adminAuditReviewRepository.findByEntryIds(batch);
      const reviewed = new Set(existing.map(review => review.auditEntryId));
      const reviews: NewAuditReview[] = batch
        .filter(id => !reviewed.has(id))
        .map(auditEntryId => ({ auditEntryId, reviewer: BASELINE_REVIEW, baseline: true }));
      baselined += (await adminAuditReviewRepository.createMany(reviews)).length;
      batch = [];
    };

    for await (const entry of cursor) {
      batch.push(entry._id.toString());
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();

    console.log(`${LOG} baselined ${baselined} critical entries older than ${AUDIT_REVIEW_BASELINE_DAYS} days`);
  },

  down: async () => {
    const { deletedCount } = await AdminAuditReviewModel.deleteMany({ baseline: true });
    console.log(`${LOG} removed ${deletedCount} baseline reviews`);
  },
};

export default migration;
