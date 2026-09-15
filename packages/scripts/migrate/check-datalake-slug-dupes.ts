import { connectDB, DataLakeModel } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';

/**
 * READ-ONLY pre-flight for the org-scoped-slug migration.
 *
 * Run this BEFORE deploying the data-lake conformance code to a stage that already
 * has lakes (staging/prod). The deploy's autoIndex build of the new
 * `{ organizationId, slug }` UNIQUE index will FAIL if any duplicate (organizationId,
 * slug) groups exist - so we must confirm zero duplicates first. Exits non-zero (and
 * prints the offending ids) if any are found, so it can gate a deploy.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts datalake:check-slug-dupes
 */
async function main() {
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));

  console.log(`Checking DataLake (organizationId, slug) uniqueness on stage="${stage}"...`);

  const dupes = await DataLakeModel.aggregate<{
    _id: { organizationId: string | null; slug: string };
    ids: string[];
    n: number;
  }>([
    { $group: { _id: { organizationId: '$organizationId', slug: '$slug' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
  ]);

  const total = await DataLakeModel.estimatedDocumentCount();
  console.log(`Scanned ~${total} data lakes.`);

  if (dupes.length === 0) {
    console.log('✓ No duplicate (organizationId, slug) groups. Safe to deploy + run the migration.');
    process.exit(0);
  }

  console.error(`✗ Found ${dupes.length} duplicate (organizationId, slug) group(s) — RESOLVE BEFORE DEPLOY:`);
  for (const d of dupes) {
    console.error(`  org=${d._id.organizationId ?? '<none>'} slug=${d._id.slug} n=${d.n} ids=[${d.ids.join(', ')}]`);
  }
  process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
