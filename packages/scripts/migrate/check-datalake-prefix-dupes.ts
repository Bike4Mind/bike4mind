import { connectDB, DataLakeModel } from '@bike4mind/database';
import { normalizeTagPrefix } from '@bike4mind/common';
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
 * Excludes groups whose prefix normalizeTagPrefix rejects (no trailing colon, blank): those
 * values contribute no read-path arm today, so two lakes sharing one is inert junk, not a real
 * collision worth blocking a deploy over.
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
  ]).then(groups => groups.filter(g => normalizeTagPrefix(g._id.fileTagPrefix) !== null));

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
