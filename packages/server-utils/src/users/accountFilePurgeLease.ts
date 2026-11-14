import { randomUUID } from 'node:crypto';
import { User } from '@bike4mind/database';
import { OrganizationAuditEventModel } from '@bike4mind/database/infra';
import { z } from 'zod';
import type { Logger } from '@bike4mind/observability';

const objectId = z.string().regex(/^[a-f\d]{24}$/);
const progressSchema = z.object({
  startedAt: z.date(),
  initialized: z.boolean().optional(),
  throughAuditId: objectId.optional(),
  afterAuditId: objectId.optional(),
  complete: z.boolean().optional(),
});
type Progress = z.infer<typeof progressSchema>;
export type AccountFilePurgeLease = {
  assertActive: () => Promise<void>;
  loadProgress: () => Promise<Progress>;
  initialize: () => Promise<Progress>;
  advance: (previous: Progress, afterAuditId: string | undefined, complete: boolean) => Promise<Progress>;
  release: () => Promise<void>;
};

/** Private retry state lives with the User; its permanent marker also fences restored accounts. */
export async function claimAccountFilePurgeLease(
  userId: string,
  assertCallerLease: () => Promise<void>,
  logger: Pick<Logger, 'error'>
): Promise<AccountFilePurgeLease> {
  await assertCallerLease();
  const leaseId = randomUUID();
  const now = new Date();
  const claimed = await User.findOneAndUpdate(
    {
      _id: userId,
      $and: [
        { $or: [{ 'accountDataExportLease.expiresAt': null }, { 'accountDataExportLease.expiresAt': { $lte: now } }] },
        { $or: [{ 'accountFilePurge.leaseExpiresAt': null }, { 'accountFilePurge.leaseExpiresAt': { $lte: now } }] },
      ],
    },
    {
      $set: {
        'accountFilePurge.leaseId': leaseId,
        'accountFilePurge.leaseExpiresAt': new Date(now.getTime() + 15 * 60_000),
      },
    },
    { new: true, projection: { _id: 1 } }
  ).lean();
  if (!claimed) throw new Error('Account file purge is busy or its User retry anchor is missing');
  const filter = () => ({
    _id: userId,
    'accountFilePurge.leaseId': leaseId,
    'accountFilePurge.leaseExpiresAt': { $gt: new Date() },
  });
  const assertActive = async () => {
    await assertCallerLease();
    if (!(await User.exists(filter()))) throw new Error('Account file purge lease lost');
  };
  const update = async (changes: Record<string, unknown>, expected: Record<string, unknown> = {}) => {
    await assertActive();
    const result = await User.updateOne({ ...filter(), ...expected }, { $set: changes });
    if (result.matchedCount !== 1) throw new Error('Account file purge checkpoint lost its lease or cursor');
  };
  const release = async () => {
    await User.updateOne(
      { _id: userId, 'accountFilePurge.leaseId': leaseId },
      {
        $unset: { 'accountFilePurge.leaseId': 1, 'accountFilePurge.leaseExpiresAt': 1 },
      }
    );
  };
  try {
    // Export admission excludes both the live file lease and this permanent marker.
    await User.updateOne(
      { ...filter(), 'accountFilePurge.startedAt': null },
      {
        $set: { 'accountFilePurge.startedAt': now },
      }
    );
    await assertActive();
  } catch (error) {
    try {
      await release();
    } catch (releaseError) {
      logger.error('Failed to release account file purge admission lease', { releaseError });
    }
    throw error;
  }
  const loadProgress = async () => {
    await assertActive();
    const user = await User.findOne(filter()).select('+accountFilePurge').lean();
    if (!user) throw new Error('Account file purge retry anchor disappeared');
    return progressSchema.parse(user.accountFilePurge);
  };
  return {
    assertActive,
    loadProgress,
    initialize: async () => {
      const progress = await loadProgress();
      if (progress.initialized) return progress;
      const last = await OrganizationAuditEventModel.findOne({ actorUserId: userId, action: 'export.requested' })
        .sort({ _id: -1 })
        .select('_id')
        .lean();
      const throughAuditId = last ? String(last._id) : undefined;
      const changes = {
        'accountFilePurge.initialized': true,
        'accountFilePurge.complete': !throughAuditId,
        ...(throughAuditId ? { 'accountFilePurge.throughAuditId': throughAuditId } : {}),
      };
      await update(changes, { 'accountFilePurge.initialized': { $ne: true } });
      return { ...progress, initialized: true, throughAuditId, complete: !throughAuditId };
    },
    advance: async (previous, afterAuditId, complete) => {
      if (afterAuditId) objectId.parse(afterAuditId);
      await update(
        {
          ...(afterAuditId ? { 'accountFilePurge.afterAuditId': afterAuditId } : {}),
          'accountFilePurge.complete': complete,
        },
        { 'accountFilePurge.afterAuditId': previous.afterAuditId ?? null }
      );
      return { ...previous, afterAuditId, complete };
    },
    release,
  };
}
