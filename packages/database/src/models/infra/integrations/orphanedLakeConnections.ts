import mongoose from 'mongoose';
import { DataLakeModel } from '../../ai/DataLakeModel';

const SCAN_PAGE_SIZE = 500;

// The connector rows store the lake id as a string, DataLake._id is an ObjectId. Lowercased because
// an uppercase-hex string casts to the same ObjectId but String(ObjectId) is lowercase. A value that is
// not an ObjectId at all can never name a lake document, so it has no key and reads as an orphan.
const lakeKey = (targetDataLakeId: string): string | null =>
  mongoose.isObjectIdOrHexString(targetDataLakeId) ? targetDataLakeId.toLowerCase() : null;

/**
 * Keys of the lakes, among these stored ids, that still have a DataLake document in ANY status: a
 * soft-deleted lake keeps its document until the purge, so only a missing document is an orphan.
 */
async function existingLakeKeys(targetDataLakeIds: readonly string[]): Promise<Set<string>> {
  const keys = targetDataLakeIds.map(lakeKey).filter((key): key is string => key !== null);
  if (keys.length === 0) return new Set();
  const docs = await DataLakeModel.find({ _id: { $in: keys } })
    .select('_id')
    .lean();
  return new Set(docs.map(doc => String(doc._id)));
}

/**
 * Up to `limit` connector rows whose lake document is gone, scanning the connector collection in _id
 * order. Two queries per page rather than a $lookup, which would need a per-row string-to-ObjectId
 * conversion inside the pipeline (no index, and a malformed id throws) - and both collections hold
 * about one row per lake.
 * `fetchPage` returns rows after `afterId` (all rows when undefined), ascending by _id.
 */
export async function findOrphanedLakeConnections<T extends { id: string; targetDataLakeId: string }>(
  limit: number,
  fetchPage: (afterId: string | undefined, pageSize: number) => Promise<T[]>,
  pageSize = SCAN_PAGE_SIZE
): Promise<T[]> {
  const orphans: T[] = [];
  let afterId: string | undefined;
  while (orphans.length < limit) {
    const page = await fetchPage(afterId, pageSize);
    if (page.length === 0) break;
    const existing = await existingLakeKeys(page.map(row => row.targetDataLakeId));
    for (const row of page) {
      if (orphans.length >= limit) break;
      const key = lakeKey(row.targetDataLakeId);
      if (key === null || !existing.has(key)) orphans.push(row);
    }
    if (page.length < pageSize) break;
    afterId = page[page.length - 1].id;
  }
  return orphans;
}
