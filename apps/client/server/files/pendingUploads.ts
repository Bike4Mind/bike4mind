import { PENDING_UPLOAD_LIMIT, TooManyRequestsError, UnauthorizedError } from '@bike4mind/common';
import { adminSettingsRepository, FabFile } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { isDevelopment } from '@bike4mind/server-utils/utils/config';
import { Logger } from '@bike4mind/observability';
import type { ActiveSubscriptionsRequest } from '@server/entitlements/activeSubscriptions';
import { resolveUserRateTier, type RateTierUser } from '@server/utils/userRateTier';

// ms. The presigned PUT lives 10 minutes; the rest is slack for a slow PUT or a late S3 event.
// An older pending row is abandoned and stops counting.
export const PENDING_UPLOAD_WINDOW_MS = 30 * 60 * 1000;
export const PENDING_UPLOAD_LIMITED = 'pending_upload_limit';

export type PendingUploads = {
  /** The caller's own in-flight uploads, whichever pool they bill to. */
  count: number;
  /** Uncharged recent client-upload bytes: the caller's personal rows, or an org's rows from any uploader. */
  bytesFor: (organizationId: string | undefined) => number;
};

type PendingGroup = {
  _id: { organizationId: string | null; mine: boolean; pending: boolean };
  count: number;
  bytes: number;
  oldest: Date;
};

async function resolveLimit(user: RateTierUser, req: ActiveSubscriptionsRequest): Promise<number> {
  if (isDevelopment()) return Infinity;
  try {
    if ((await resolveUserRateTier(user, req)) === 'bypass') return Infinity;
    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['pendingUploadLimit'] }
    );
    // An explicit 0 is kept, and blocks presigned uploads.
    return getSettingsValue('pendingUploadLimit', settings, PENDING_UPLOAD_LIMIT);
  } catch (error) {
    // The default, never 0 or no cap: an outage must neither block uploads nor lift the limit.
    Logger.globalInstance.warn('[pendingUploads] limit resolution failed; applying the default', { error });
    return PENDING_UPLOAD_LIMIT;
  }
}

/** One aggregate: the caller's rows (for the count and personal bytes) plus every row in the named org pools. */
async function loadPendingGroups(userId: string, organizationIds: string[]): Promise<PendingGroup[]> {
  const recentClientUpload = {
    clientUpload: true,
    deletedAt: null,
    createdAt: { $gte: new Date(Date.now() - PENDING_UPLOAD_WINDOW_MS) },
  };
  return FabFile.aggregate<PendingGroup>([
    {
      $match: {
        $or: [
          { userId, ...recentClientUpload },
          // Restates the partial index's filter so the planner can use it.
          ...(organizationIds.length > 0
            ? [{ organizationId: { $in: organizationIds, $type: 'string' }, ...recentClientUpload }]
            : []),
        ],
      },
    },
    {
      $group: {
        _id: {
          organizationId: { $ifNull: ['$organizationId', null] },
          mine: { $eq: ['$userId', userId] },
          pending: { $eq: ['$status', 'pending'] },
        },
        count: { $sum: 1 },
        // Completion precedes the charge transaction, so status alone cannot release reserved bytes.
        bytes: {
          $sum: {
            $cond: [
              { $eq: [{ $ifNull: ['$storageChargedAt', null] }, null] },
              { $max: [{ $ifNull: ['$fileSize', 0] }, 0] },
              0,
            ],
          },
        },
        oldest: { $min: '$createdAt' },
      },
    },
  ]).exec();
}

/**
 * Refuses `requested` more presigned uploads when the caller would hold more than the pending cap,
 * then returns the in-flight snapshot the quota check reserves against. Pending means FabFile rows with
 * `clientUpload` still `pending`, not deleted, created within the window; recent uncharged bytes are reserved too.
 * Called by the presign doors (createPresignedUpload, generate-presigned-urls-batch, createFabFile without
 * content), after their admission gates and before consumeFileUploadBudget, so a refusal costs no hourly allowance.
 * `ownerOrganizationIds` are the org pools the new files bill to (undefined for personal files).
 * Count and bytes are snapshots, not atomic reservations; concurrent requests can share a reading.
 */
export async function admitPendingUploads(
  req: ActiveSubscriptionsRequest,
  requested: number,
  ownerOrganizationIds: Iterable<string | undefined>
): Promise<PendingUploads> {
  // Every door runs behind auth, so a missing user is a can't-happen; refuse rather than skip the cap.
  const { user } = req;
  if (!user) throw new UnauthorizedError('Sign in to upload files');

  const organizationIds = [...new Set([...ownerOrganizationIds].filter((id): id is string => !!id))];
  const [limit, groups] = await Promise.all([resolveLimit(user, req), loadPendingGroups(user.id, organizationIds)]);

  const mine = groups.filter(group => group._id.mine);
  const myPending = mine.filter(group => group._id.pending);
  const count = myPending.reduce((sum, group) => sum + group.count, 0);

  if (count + requested > limit) {
    const details = { limit, pending: count, requested };
    if (limit <= 0) {
      throw new TooManyRequestsError('File uploads are currently blocked for your account.', {
        code: PENDING_UPLOAD_LIMITED,
        details,
      });
    }
    // A request larger than the whole limit can never fit, so waiting would not help.
    if (requested > limit) {
      throw new TooManyRequestsError(
        `This upload has ${requested} files, more than the ${limit} uploads allowed in progress at once. Upload fewer files at a time.`,
        { code: PENDING_UPLOAD_LIMITED, details }
      );
    }
    // Reaching here means count > 0, so `myPending` is non-empty.
    // A lower bound when requested > 1: more than one slot must free up.
    const oldest = Math.min(...myPending.map(group => group.oldest.getTime()));
    const retryAfter = Math.max(1, Math.ceil((oldest + PENDING_UPLOAD_WINDOW_MS - Date.now()) / 1000));
    throw new TooManyRequestsError(
      `You have ${count} uploads in progress (limit ${limit}). Wait for them to finish, then try again.`,
      { code: PENDING_UPLOAD_LIMITED, retryAfter, details }
    );
  }

  const personalBytes = mine
    .filter(group => group._id.organizationId === null)
    .reduce((sum, group) => sum + group.bytes, 0);
  const orgBytes = new Map<string, number>();
  for (const { _id, bytes } of groups) {
    if (_id.organizationId !== null) orgBytes.set(_id.organizationId, (orgBytes.get(_id.organizationId) ?? 0) + bytes);
  }
  return {
    count,
    bytesFor: organizationId => (organizationId ? (orgBytes.get(organizationId) ?? 0) : personalBytes),
  };
}
