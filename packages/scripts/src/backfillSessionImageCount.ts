import { Quest, Session } from '@bike4mind/database';
import { Types } from 'mongoose';

export interface BackfillSessionImageCountOptions {
  dryRun: boolean;
  /** Sessions per bulkWrite. */
  batchSize?: number;
  log?: (message: string) => void;
}

export interface BackfillSessionImageCountResult {
  /** Sessions with at least one quest holding images. */
  sessionsWithImages: number;
  /** Sessions whose imageCount was (or, in a dry run, would be) raised. */
  updated: number;
}

/**
 * Sets each session's imageCount from the images already on its quests: the sum of the `images`
 * array sizes across the session's live quests. Written with `$max`, so it never lowers a counter
 * the app has already moved (a generation landing mid-run keeps its increment) and a re-run is a
 * no-op. Note that `images` also carries a few non-image attachments (audio/music/sheet tools), so
 * a backfilled count can overstate; the sidebar only reads it as zero / non-zero.
 */
export async function backfillSessionImageCounts(
  options: BackfillSessionImageCountOptions
): Promise<BackfillSessionImageCountResult> {
  const { dryRun, batchSize = 500, log = console.log } = options;

  const cursor = Quest.aggregate<{ _id: string; total: number }>([
    { $match: { deletedAt: null, 'images.0': { $exists: true } } },
    { $group: { _id: '$sessionId', total: { $sum: { $size: '$images' } } } },
  ])
    .allowDiskUse(true)
    .cursor({ batchSize });

  let sessionsWithImages = 0;
  let updated = 0;
  let batch: { sessionId: string; total: number }[] = [];

  const flush = async () => {
    if (!batch.length) return;
    const ids = batch.filter(row => Types.ObjectId.isValid(row.sessionId));
    batch = [];
    if (!ids.length) return;
    if (dryRun) {
      const stale = await Session.countDocuments({
        $or: ids.map(row => ({
          _id: new Types.ObjectId(row.sessionId),
          $or: [{ imageCount: { $exists: false } }, { imageCount: { $lt: row.total } }],
        })),
      });
      updated += stale;
    } else {
      // The raw collection, not the model: Mongoose would add an updatedAt $set to every op, making
      // a no-op $max count as modified and bumping timestamps a backfill should not touch.
      const result = await Session.collection.bulkWrite(
        ids.map(row => ({
          updateOne: {
            filter: { _id: new Types.ObjectId(row.sessionId) },
            update: { $max: { imageCount: row.total } },
          },
        })),
        { ordered: false }
      );
      updated += result.modifiedCount;
    }
  };

  for await (const row of cursor) {
    sessionsWithImages += 1;
    batch.push({ sessionId: String(row._id), total: row.total });
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  log(
    `[backfill-session-image-count] ${sessionsWithImages} session(s) with images; ` +
      `${dryRun ? 'would update' : 'updated'} ${updated}`
  );
  return { sessionsWithImages, updated };
}
