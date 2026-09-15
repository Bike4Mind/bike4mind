import { connectDB, DataLakeModel } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';

/**
 * READ-ONLY pre-flight for the { createdByUserId, fileTagPrefix } unique index.
 *
 * Run this BEFORE deploying to a stage that already has lakes (staging/prod). The deploy's
 * autoIndex build of the new index will FAIL if any duplicate (createdByUserId, fileTagPrefix)
 * groups exist - so we must confirm zero duplicates first. Exits non-zero (and prints the
 * offending ids) if any are found, so it can gate a deploy.
 *
 * Reports every raw duplicate, including a colon-less or blank prefix: the index has no
 * `sparse`/partial filter, so it compares the stored string as-is regardless of whether
 * normalizeTagPrefix would treat it as usable. This must predict the index build 1:1 - filtering
 * by read-path usability (as check-datalake-prefix-overlaps.ts correctly does for ITS job) would
 * report "safe to deploy" for rows the index build then rejects.
 *
 * Org-scope collisions are NOT checked here - there is no org-scope index (see the comment on
 * the index itself in DataLakeModel.ts for why) and existing org-scope overlaps, including exact
 * matches, are already reported non-blockingly by check-datalake-prefix-overlaps.ts.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts datalake:check-prefix-dupes
 */
async function main() {
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));

  console.log(`Checking DataLake (createdByUserId, fileTagPrefix) uniqueness on stage="${stage}"...`);

  const dupes = await DataLakeModel.aggregate<{
    _id: { createdByUserId: string; fileTagPrefix: string };
    ids: string[];
    n: number;
  }>([
    {
      $group: {
        _id: { createdByUserId: '$createdByUserId', fileTagPrefix: '$fileTagPrefix' },
        ids: { $push: '$_id' },
        n: { $sum: 1 },
      },
    },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
  ]);

  const total = await DataLakeModel.estimatedDocumentCount();
  console.log(`Scanned ~${total} data lakes.`);

  if (dupes.length === 0) {
    console.log('No duplicate (createdByUserId, fileTagPrefix) groups. Safe to deploy.');
    process.exit(0);
  }

  console.error(`Found ${dupes.length} duplicate (createdByUserId, fileTagPrefix) group(s) - RESOLVE BEFORE DEPLOY:`);
  for (const d of dupes) {
    console.error(
      `  creator=${d._id.createdByUserId} prefix=${d._id.fileTagPrefix} n=${d.n} ids=[${d.ids.join(', ')}]`
    );
  }
  process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
