import { connectDB, DataLakeModel } from '@bike4mind/database';
import { tagPrefixesOverlap } from '@bike4mind/common';
import { Resource } from 'sst';
import { Config } from '../utils/config';

/**
 * READ-ONLY audit for data lakes whose `fileTagPrefix` overlaps another lake's in the same scope.
 *
 * Whole-lake archive and permanent delete match files by the lake's meta-tag OR by its
 * fileTagPrefix, so two lakes sharing a prefix share their prefix-tagged files: permanently
 * deleting one destroys files that only the other holds. Creating such a pair is now refused, but
 * `fileTagPrefix` never had a uniqueness constraint, so pairs created earlier still exist. Run
 * this to find them before anyone permanently deletes a lake.
 *
 * Scope matches the runtime guard: same creator, or same organization. Two org-less lakes owned by
 * different users are NOT a conflict - the prefix arm only matches files the lake's creator owns,
 * so neither can reach the other's files.
 *
 * Reports only; exits 0 even when overlaps exist, since a pre-existing pair is not a reason to
 * block a deploy - it is something to fix or to know about before a teardown.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts datalake:check-prefix-overlaps
 */
interface LakeRow {
  _id: unknown;
  name?: string;
  fileTagPrefix?: string;
  createdByUserId?: string;
  organizationId?: string | null;
}

const sharesScope = (a: LakeRow, b: LakeRow) =>
  (!!a.createdByUserId && a.createdByUserId === b.createdByUserId) ||
  (!!a.organizationId && a.organizationId === b.organizationId);

async function main() {
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));

  console.log(`Checking DataLake fileTagPrefix overlaps on stage="${stage}"...`);

  const lakes = await DataLakeModel.find({}, { name: 1, fileTagPrefix: 1, createdByUserId: 1, organizationId: 1 }).lean<
    LakeRow[]
  >();

  console.log(`Scanned ${lakes.length} data lakes.`);

  const pairs: string[] = [];
  for (let i = 0; i < lakes.length; i++) {
    for (let j = i + 1; j < lakes.length; j++) {
      const [a, b] = [lakes[i], lakes[j]];
      // Same predicate the runtime guard uses, so the audit cannot report a different answer.
      if (!tagPrefixesOverlap(a.fileTagPrefix, b.fileTagPrefix) || !sharesScope(a, b)) continue;
      pairs.push(
        `  "${a.name}" (${a.fileTagPrefix}, id=${a._id}) <-> "${b.name}" (${b.fileTagPrefix}, id=${b._id})` +
          ` [org=${a.organizationId ?? '<none>'} creator=${a.createdByUserId ?? '<none>'}]`
      );
    }
  }

  if (pairs.length === 0) {
    console.log('No overlapping fileTagPrefix pairs in a shared scope.');
    process.exit(0);
  }

  console.log(`Found ${pairs.length} overlapping pair(s). Permanently deleting either one takes the`);
  console.log('prefix-tagged files the other also holds:');
  for (const line of pairs) console.log(line);
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
