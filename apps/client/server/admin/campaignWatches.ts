import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  CampaignWatchSchema,
  type CampaignWatch,
  type CampaignWatchChange,
  type CampaignWatchCreate,
} from '@bike4mind/common';
import { CampaignWatchModel, User, withTransaction } from '@bike4mind/database';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

export const WATCH_PAGE_SIZE = 25;
const MAX_TIME_MS = 10_000;
const toWatch = (row: object & { _id: unknown }) => CampaignWatchSchema.parse({ ...row, id: String(row._id) });

export async function listCampaignWatches(status: 'open' | 'closed', cursor?: string) {
  const rows = await CampaignWatchModel.find({ status, ...(cursor ? { _id: { $lt: cursor } } : {}) })
    .sort({ _id: -1 })
    .limit(WATCH_PAGE_SIZE + 1)
    .maxTimeMS(MAX_TIME_MS)
    .lean();
  return {
    items: rows.slice(0, WATCH_PAGE_SIZE).map(toWatch),
    nextCursor: rows.length > WATCH_PAGE_SIZE ? String(rows[WATCH_PAGE_SIZE - 1]._id) : null,
  };
}

export async function campaignWatchDetail(id: string) {
  const row = await CampaignWatchModel.findById(id).maxTimeMS(MAX_TIME_MS).lean();
  if (!row) throw new NotFoundError('Watch not found');
  const watch = toWatch(row);
  const ids = [...new Set([...watch.userIds, ...(watch.ownerId ? [watch.ownerId] : [])])];
  const users = await User.find({ _id: { $in: ids }, deletedAt: null })
    .select('_id name username currentCredits isBanned')
    .maxTimeMS(MAX_TIME_MS)
    .lean();
  const byId = new Map(users.map(user => [String(user._id), user]));
  const nameOf = (id: string) => {
    const user = byId.get(id);
    return user?.name || user?.username || null;
  };
  return {
    watch,
    ownerName: watch.ownerId ? nameOf(watch.ownerId) : null,
    members: watch.userIds.map(id => ({
      id,
      name: nameOf(id),
      available: byId.has(id),
      suspended: byId.get(id)?.isBanned === true,
      credits: byId.get(id)?.currentCredits ?? null,
    })),
  };
}

const actorId = (req: Request): string => {
  if (!req.user || req.user.impersonatedBy) throw new ForbiddenError('Watches require an administrator session');
  return req.user.id;
};

// A deletion can finish its purge while a watch transaction still holds an older user snapshot.
async function removeUnavailableMembers(watch: CampaignWatch): Promise<CampaignWatch> {
  const ids = [...new Set([...watch.userIds, ...(watch.ownerId ? [watch.ownerId] : [])])];
  const available = await User.find({ _id: { $in: ids }, deletedAt: null })
    .select('_id')
    .maxTimeMS(MAX_TIME_MS)
    .lean();
  const present = new Set(available.map(user => String(user._id)));
  const missing = watch.userIds.filter(id => !present.has(id));
  if (missing.length > 0)
    await CampaignWatchModel.updateOne(
      { _id: watch.id },
      { $pull: { userIds: { $in: missing } }, $inc: { revision: 1 } }
    );
  const missingOwner = watch.ownerId && !present.has(watch.ownerId);
  if (missingOwner)
    await CampaignWatchModel.updateOne(
      { _id: watch.id, ownerId: watch.ownerId },
      { $set: { ownerId: null }, $inc: { revision: 1 } }
    );
  if (missing.length === 0 && !missingOwner) return watch;
  const current = await CampaignWatchModel.findById(watch.id).maxTimeMS(MAX_TIME_MS).lean();
  if (!current) throw new NotFoundError('Watch not found');
  return toWatch(current);
}

export async function createCampaignWatch(
  req: Request,
  input: CampaignWatchCreate
): Promise<{ watch: CampaignWatch; created: boolean }> {
  const ownerId = actorId(req);
  const userIds = [...input.userIds].sort();
  const cohortKey = createHash('sha256').update(userIds.join(',')).digest('hex');
  try {
    const result = await withTransaction(async () => {
      const users = await User.find({ _id: { $in: userIds }, deletedAt: null })
        .select('_id')
        .maxTimeMS(MAX_TIME_MS)
        .lean();
      if (users.length !== userIds.length)
        throw new BadRequestError('Some selected accounts are unavailable. Refresh before watching them.');
      const row = await CampaignWatchModel.create({
        name: input.name,
        userIds,
        cohortKey,
        ownerId,
        sourceDetectionId: input.sourceDetectionId ?? null,
        status: 'open',
        revision: 0,
      });
      const watch = toWatch(row.toObject());
      await recordAdminActionFromRequest(req, {
        action: 'security.watch.created',
        target: { kind: 'system', id: `campaign-watch:${watch.id}`, displayName: watch.name },
        reason: input.reason,
        summary: 'Created an account watch',
        details: { memberCount: userIds.length, watchId: watch.id },
      });
      return { watch, created: true };
    });
    return { ...result, watch: await removeUnavailableMembers(result.watch) };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await CampaignWatchModel.findOne({ cohortKey, status: 'open' }).maxTimeMS(MAX_TIME_MS).lean();
    if (!existing) throw new ConflictError('Watch changed. Refresh and try again.');
    return { watch: await removeUnavailableMembers(toWatch(existing)), created: false };
  }
}

export async function changeCampaignWatch(
  req: Request,
  id: string,
  input: CampaignWatchChange
): Promise<CampaignWatch> {
  const adminId = actorId(req);
  try {
    const watch = await withTransaction(async () => {
      const now = new Date();
      const change =
        input.action === 'close'
          ? { status: 'closed', closedAt: now }
          : input.action === 'reopen'
            ? { status: 'open', closedAt: null }
            : input.action === 'claim'
              ? { ownerId: adminId }
              : { lastCheckedAt: now };
      const row = await CampaignWatchModel.findOneAndUpdate(
        { _id: id, revision: input.expectedRevision, status: input.action === 'reopen' ? 'closed' : 'open' },
        { $set: change, $inc: { revision: 1 } },
        { new: true, runValidators: true }
      ).lean();
      if (!row) throw new ConflictError('Watch changed or is unavailable. Reload it before trying again.');
      const watch = toWatch(row);
      await recordAdminActionFromRequest(req, {
        action: 'security.watch.updated',
        target: { kind: 'system', id: `campaign-watch:${id}`, displayName: watch.name },
        reason: input.reason,
        summary: `Account watch: ${input.action}`,
        details: { watchId: id, action: input.action },
      });
      return watch;
    });
    return removeUnavailableMembers(watch);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new ConflictError('An open watch already contains this account snapshot.');
    throw error;
  }
}
