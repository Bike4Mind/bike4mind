import {
  AccessContext,
  IDataLakeRepository,
  IFabFileRepository,
  IUserRepository,
  StorageBreakdownResponse,
  buildStorageBreakdownBuckets,
} from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { canAccessLake } from '../dataLakeService/assertLakeAccess';

const NAMEABLE_LAKE_STATUSES: ReadonlySet<string> = new Set(['draft', 'active']);

export interface GetUserStorageBreakdownAdapters {
  db: {
    users: IUserRepository;
    fabFiles: IFabFileRepository;
    dataLakes: IDataLakeRepository;
  };
}

/**
 * What uses a user's storage, grouped from the same charged rows `recalculateUserStorage` sums.
 * The buckets add up to `accountedBytes`; any drift of the incremental `currentStorageSize` counter
 * from that is reported as `unaccountedBytes` rather than hidden.
 */
export const getUserStorageBreakdown = async (
  accessContext: AccessContext,
  { db }: GetUserStorageBreakdownAdapters,
  options: { maxTimeMS?: number } = {}
): Promise<StorageBreakdownResponse> => {
  const { userId } = accessContext;
  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError(`User ${userId} not found`);

  const buckets = buildStorageBreakdownBuckets(await db.fabFiles.summarizeChargedStorageByUserId(userId, options));

  const lakeIds = [...new Set(buckets.flatMap(bucket => (bucket.lakeId ? [bucket.lakeId] : [])))];
  if (lakeIds.length > 0) {
    // findByIds is unscoped: name only live lakes the caller can still read (the lake manager's own gate,
    // so an org lake whose Drive a manager connected is named for them), so a lake they lost access to
    // (or one being torn down) is neither disclosed nor offered as a link. Grants are not loaded, so a
    // lake reachable only through a grant reads as unavailable.
    const names = new Map(
      (await db.dataLakes.findByIds(lakeIds))
        .filter(lake => NAMEABLE_LAKE_STATUSES.has(lake.status) && canAccessLake(lake, accessContext))
        .map(lake => [lake.id, lake.name])
    );
    for (const bucket of buckets) {
      if (bucket.lakeId) bucket.lakeName = names.get(bucket.lakeId) ?? null;
    }
  }

  const totalBytes = user.currentStorageSize ?? 0;
  const accountedBytes = buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
  return { totalBytes, accountedBytes, unaccountedBytes: totalBytes - accountedBytes, buckets };
};
