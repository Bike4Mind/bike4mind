import { connectDB, DataLakeModel } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';

/**
 * READ-ONLY census of data lakes whose stored `fileTagPrefix` is not already its own
 * `normalizeTagPrefix` form - i.e. it carries edge whitespace (#2467).
 *
 * The gate every tag-write door runs (`decideStampPrefix`) hands back the TRIMMED prefix, and
 * every read arm - `satisfiesTagPrefix`, the tag-tree roots, the tag-count aggregates - trims
 * before matching. A row storing " acme:" therefore reads under `acme:` everywhere, and any
 * writer that appended a suffix to the raw value produced a name nothing could see. The tag
 * builders now normalize (`ensureColon` in dataLakeTaxonomy.ts), so no NEW tag can land on the
 * wrong side of the trim; this script answers the remaining question - how many rows are on the
 * wrong side already, and therefore whether the tags written for them BEFORE that change need a
 * backfill.
 *
 * Expected to report zero: `CreateDataLakeRequestInput` has trimmed `fileTagPrefix` for some
 * time and there is no update path for the field, so only rows predating that trim can qualify.
 * A non-empty result is the trigger for a repair migration (trim the stored prefix, rewrite the
 * files' raw-prefix tags), not something to fix by hand one row at a time.
 *
 * Reports only; exits 0 either way. An un-trimmed prefix is a legacy-data question, not a reason
 * to block a deploy.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts datalake:check-prefix-whitespace
 */
interface LakeRow {
  _id: unknown;
  name?: string;
  slug?: string;
  fileTagPrefix?: string;
  createdByUserId?: string;
  organizationId?: string | null;
}

/** Render the raw value so leading/trailing space is visible in the output at all. */
const quoteRaw = (value: string | undefined) => JSON.stringify(value ?? null);

async function main() {
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));

  console.log(`Checking DataLake fileTagPrefix normalization on stage="${stage}"...`);

  // Matched in JS rather than by a `$expr` trim comparison: the set is small, the raw value has
  // to be printed anyway, and this keeps the predicate identical to normalizeTagPrefix's own.
  const lakes = await DataLakeModel.find(
    {},
    { name: 1, slug: 1, fileTagPrefix: 1, createdByUserId: 1, organizationId: 1 }
  ).lean<LakeRow[]>();

  console.log(`Scanned ${lakes.length} data lakes.`);

  const untrimmed = lakes.filter(
    l => typeof l.fileTagPrefix === 'string' && l.fileTagPrefix !== l.fileTagPrefix.trim()
  );

  // Separate bucket: a prefix that survives trimming but still is not usable (blank, or missing
  // its trailing colon) is refused by the gate outright rather than silently written past, so it
  // is a different problem from this one - counted here only so the census is not read as a
  // clean bill of health for the field as a whole.
  const unusable = lakes.filter(l => {
    const trimmed = (l.fileTagPrefix ?? '').trim();
    return trimmed.length === 0 || !trimmed.endsWith(':');
  });

  if (untrimmed.length === 0) {
    console.log('No lake stores an un-trimmed fileTagPrefix - stored prefixes already equal their normalized form.');
  } else {
    console.log(`Found ${untrimmed.length} lake(s) whose stored fileTagPrefix is not trimmed. Tags written for these`);
    console.log('before the builders normalized are under the RAW prefix and invisible to every read arm:');
    for (const l of untrimmed) {
      console.log(
        `  "${l.name}" (slug=${l.slug}, id=${l._id}) prefix=${quoteRaw(l.fileTagPrefix)} -> ${quoteRaw(
          l.fileTagPrefix?.trim()
        )} [org=${l.organizationId ?? '<none>'} creator=${l.createdByUserId ?? '<none>'}]`
      );
    }
  }

  if (unusable.length > 0) {
    console.log(`\nAlso ${unusable.length} lake(s) with a prefix that is unusable even trimmed (blank, or no trailing`);
    console.log('colon). These are refused by decideStampPrefix rather than mis-written - separate problem:');
    for (const l of unusable) {
      console.log(`  "${l.name}" (slug=${l.slug}, id=${l._id}) prefix=${quoteRaw(l.fileTagPrefix)}`);
    }
  }

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
