import { connectDB, DataLakeBatchModel, DataLakeModel } from '@bike4mind/database';
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
 * A non-empty result is the trigger for a repair migration, not something to fix by hand one row
 * at a time - and that repair has THREE legs, which is why this reports more than a lake count:
 *
 *   1. the stored `fileTagPrefix` itself (trim it),
 *   2. the tags already written onto that lake's files under the raw prefix, which no read arm
 *      can see,
 *   3. the stored `taxonomySuggestions[].suffix` values on that lake's batches.
 *
 * Leg 3 is the non-obvious one. `deriveSuffix` used to compare an inferred tag name against the
 * RAW prefix, so for a lake stored as " acme:" it could not strip anything and banked the whole
 * name as the suffix ("acme:contract"). Applying such a batch now composes it against the
 * NORMALIZED prefix and yields `acme:acme:contract` - which, unlike the old " acme:acme:contract",
 * is visible in the tag tree and counted by the aggregates. Re-analyze re-derives suffixes with
 * the current code, so only batches sitting in a directly-appliable state carry live exposure;
 * the report flags those separately below.
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

interface BatchRow {
  _id: unknown;
  dataLakeId?: string;
  taxonomyStatus?: string;
  taxonomySuggestions?: { tags?: { suffix?: string }[] };
}

/**
 * A batch in one of these can be applied without re-analysis, so its stored suffixes compose into
 * tag names as-is. Every other taxonomy state has to pass through re-analyze first, which
 * re-derives them with the current `deriveSuffix`.
 */
const DIRECTLY_APPLIABLE = new Set(['ready', 'applying']);

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

  // Leg 3, only worth the query when leg 1 found something: a suffix that already starts with the
  // lake's normalized prefix is one the old raw comparison failed to strip, and applying it now
  // builds a visible double-prefixed tag.
  if (untrimmed.length > 0) {
    const lakeIds = untrimmed.map(l => String(l._id));
    const batches = await DataLakeBatchModel.find(
      { dataLakeId: { $in: lakeIds }, 'taxonomySuggestions.tags.0': { $exists: true } },
      { dataLakeId: 1, taxonomyStatus: 1, 'taxonomySuggestions.tags': 1 }
    ).lean<BatchRow[]>();

    const prefixByLakeId = new Map(untrimmed.map(l => [String(l._id), (l.fileTagPrefix ?? '').trim().toLowerCase()]));
    const affected = batches.flatMap(b => {
      const prefix = prefixByLakeId.get(String(b.dataLakeId)) ?? '';
      const stale = (b.taxonomySuggestions?.tags ?? []).filter(
        t => typeof t.suffix === 'string' && prefix.length > 0 && t.suffix.toLowerCase().startsWith(prefix)
      );
      return stale.length > 0 ? [{ batch: b, stale }] : [];
    });

    if (affected.length === 0) {
      console.log('\nNo batch on those lakes stores a suffix that would double-prefix on apply.');
    } else {
      const appliable = affected.filter(a => DIRECTLY_APPLIABLE.has(a.batch.taxonomyStatus ?? ''));
      console.log(`\nAlso ${affected.length} batch(es) on those lakes store suffixes that already carry the prefix.`);
      console.log(`${appliable.length} of them are directly appliable and would write a visible double-prefixed tag;`);
      console.log('the rest must pass through re-analyze, which re-derives the suffix and self-heals:');
      for (const { batch, stale } of affected) {
        const sample = stale
          .slice(0, 3)
          .map(t => quoteRaw(t.suffix))
          .join(', ');
        console.log(
          `  batch=${batch._id} lake=${batch.dataLakeId} taxonomyStatus=${batch.taxonomyStatus ?? '<none>'}` +
            ` stale=${stale.length} e.g. ${sample}`
        );
      }
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
