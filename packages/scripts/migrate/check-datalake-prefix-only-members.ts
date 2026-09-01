import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { connectDB, DataLakeModel, FabFile, buildDataLakeMembershipQuery, mongoose } from '@bike4mind/database';
import { DATA_LAKES, normalizeTagPrefix, isReservedTagPrefix } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import pLimit from 'p-limit';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import {
  classifyDynamicLakeMode,
  reconcilePrefixOnly,
  renderCensusReport,
  type ExampleFileListing,
  type LakeReport,
} from './prefixOnlyMembersReport';

/**
 * READ-ONLY pre-merge census for the dynamic-lake prefix-only-member gap (the defect fixed by
 * the lake-membership-retrieval-parity PR). Its own PR, merged and RUN before that fix, because
 * the fix changes which files retrieval reaches - this must measure the PRE-change world.
 *
 * `buildDataLakeMembershipFilter` (@bike4mind/database) is, for an OWNED lake, `metaTag OR
 * (fileTagPrefix AND lake.creatorUserId)`. Every lake this census routes through the builder is
 * owned (registry lakes are counted separately, below). Retrieval today only ever sees the
 * caller-anchored prefix arm, never the
 * creator-anchored one, so a creator-owned file carrying a lake's prefix but no meta-tag is
 * listed/counted/graded-healthy by membership and unreachable by retrieval for anyone but the
 * creator. This script sizes that population per lake, BOTH directions:
 *
 *  - WIDENING: the prefix-only population the fix makes newly reachable (three cross-checked
 *    counts: total, total-minus-metaTagged, and a direct prefix-regex-and-creator count, with a
 *    loud RECONCILE line if the cross-check disagrees).
 *  - NARROWING: the population the fix makes newly UNREACHABLE - a file carrying the lake's
 *    prefix that the lake's CREATOR DOES NOT OWN and that carries no meta-tag. Today it counts as
 *    lake content for whoever owns or is shared on it; after the fix it does not. This is an
 *    UPPER BOUND (the census cannot see per-caller reachability), and a nonzero value is CORRECT
 *    behaviour under the new predicate, not a defect - it exists so an owner is not surprised, not
 *    so anyone "fixes" it.
 *
 * `buildDataLakeMembershipFilter` fails closed to the meta-tag arm alone on three different
 * conditions (no prefix, reserved prefix, no creator), all of which would collapse to a bare
 * `prefixOnly = 0`. Only ONE of those is a genuine zero, so every lake is classified into an
 * explicit arm mode first (see prefixOnlyMembersReport.ts) rather than printing that bare zero.
 * Two of the three escalate on their own, separately from the widening/narrowing counts:
 *  - no creator on record: a data-quality defect in the row itself.
 *  - RESERVED prefix: retrieval honours such a prefix today and the fix drops it, so the lake
 *    loses its whole prefix arm. This is the largest movement the census can see and the one a
 *    collapsed zero would have hidden entirely, so it is its own arm mode, not a footnote.
 *
 * Registry (static) lakes have no creator to anchor to and use the OPEN arm at retrieval - already
 * fully reachable today - so they get one informational, un-anchored count and never escalate. A
 * DB row is classified as dynamic by PROVENANCE (it came from the DataLake collection), never by
 * whether its id/tag also happens to appear in the static registry (a "shadowed" row) - getting
 * that backwards would drop a shadowed row's user-controlled prefix out of the gate entirely.
 *
 * Shape: raw models only (FabFile, DataLakeModel), no repository import, no write method -
 * mechanically enforced by checkDatalakeCensusReadOnly.test.ts. One lake per query (never a
 * cross-lake $or); counts never materialise documents except a capped example listing for an
 * anchored finding (a `+1` probe to detect truncation). The JSON artifact this script writes
 * carries cross-tenant identity data - per-file owner ids and file names, plus each lake's name,
 * fileTagPrefix and creator id. Split it per owner before any of it leaves the operator; the
 * per-file `userId` is projected precisely so that split is possible. It is written to the OS
 * temp dir with mode 0600, NOT into the repo (override with DATALAKE_CENSUS_OUT_DIR, but never
 * point that at a git working tree - this is a public repo and history is permanent).
 *
 * Exit codes so CI/an operator can tell "found things" from "crashed": 0 clean, 2 findings need
 * owner sign-off (not an error), 1 the census itself failed (including a RECONCILE mismatch,
 * which means the two widening queries disagree and the output cannot be trusted). Never merge on
 * a 1 - an unrun census reads the same as a clean one.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts datalake:check-prefix-only-members
 */

const LIVE_CONJUNCT = { deletedAt: null, archivedAt: null };
/** Per-lake example-file listing cap; the (cap+1)-th result flips `truncated`. */
const FILE_LISTING_CAP = 500;
/** Small, so a large tenant does not put the whole lake table under concurrent scan at once. */
const LAKE_CONCURRENCY = 4;
/**
 * Server-side cap per query. The connection-wide socketTimeoutMS (db-core mongo.ts) is
 * CLIENT-side and does not stop work already running on the server, and `narrowingFilter`'s
 * leading `{userId: {$ne: ...}}` cannot be bounded to an index range - it relies on the planner
 * picking the `tags.name` index and applying the negation as a residual. Nothing pins that, and
 * this is a tool pointed at production.
 */
const QUERY_TIMEOUT_MS = 30_000;

const countLive = (filter: Record<string, unknown>) => FabFile.countDocuments(filter, { maxTimeMS: QUERY_TIMEOUT_MS });

const EMPTY_LISTING: ExampleFileListing = { files: [], truncated: false };

interface DataLakeRow {
  _id: unknown;
  name?: string;
  fileTagPrefix?: string | null;
  datalakeTag?: string;
  createdByUserId?: string | null;
}

const prefixRegexArm = (prefix: string) => ({ 'tags.name': { $regex: new RegExp(`^${escapeRegex(prefix)}`) } });
const notMetaTag = (datalakeTag: string) => ({ 'tags.name': { $ne: datalakeTag } });

async function listExampleFiles(filter: Record<string, unknown>): Promise<ExampleFileListing> {
  // userId is projected, not just fileName, because the docblock's mitigation ("split it per
  // owner") is otherwise unperformable on the half that needs it: the narrowing set is by
  // definition NOT the creator's, so with names alone there is no owner to split on.
  const docs = await FabFile.find(filter, { fileName: 1, userId: 1 })
    .limit(FILE_LISTING_CAP + 1)
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .lean<{ fileName: string; userId: string }[]>();
  const truncated = docs.length > FILE_LISTING_CAP;
  return {
    files: docs.slice(0, FILE_LISTING_CAP).map(d => ({ userId: d.userId, fileName: d.fileName })),
    truncated,
  };
}

async function buildDynamicLakeReport(row: DataLakeRow): Promise<LakeReport> {
  const id = String(row._id);
  const name = row.name ?? '(unnamed)';
  const datalakeTag = row.datalakeTag ?? '';
  const mode = classifyDynamicLakeMode(row);

  // `kind` is required on DataLakeMembershipScope once the predicate expresses registry lakes;
  // every lake reaching this function came from the DataLake collection, so it is always owned.
  // `as const` is load-bearing: `scope` is a standalone const, so without it `kind` widens to
  // `string` and no longer matches the union member.
  const scope = {
    kind: 'owned' as const,
    datalakeTag,
    fileTagPrefix: row.fileTagPrefix,
    creatorUserId: row.createdByUserId,
  };
  const [total, totalExcludingPending, metaTagged] = await Promise.all([
    countLive(buildDataLakeMembershipQuery(scope, LIVE_CONJUNCT)),
    countLive(buildDataLakeMembershipQuery(scope, { ...LIVE_CONJUNCT, status: { $ne: 'pending' } })),
    countLive({ 'tags.name': datalakeTag, ...LIVE_CONJUNCT }),
  ]);

  const base: LakeReport = {
    id,
    name,
    datalakeTag,
    fileTagPrefix: row.fileTagPrefix,
    createdByUserId: row.createdByUserId,
    mode,
    total,
    totalExcludingPending,
    metaTagged,
    prefixOnlyDirect: null,
    reconcileMismatch: false,
    narrowingUpperBound: null,
    unanchoredCount: null,
    prefixOnlyFiles: { files: [], truncated: false },
    narrowingFiles: { files: [], truncated: false },
  };

  if (mode === 'no-prefix') return base;

  const prefix = normalizeTagPrefix(row.fileTagPrefix);
  if (!prefix) return base; // classifier already routed this to no-prefix; defensive only.

  // Both fail-closed modes get the same un-anchored reach figure. For `reserved-prefix` it is
  // heavily inflated by construction (a `datalake:` regex matches every OTHER lake's membership
  // meta-tag), which is why renderLakeLines labels it over-match rather than narrowing.
  if (mode === 'creator-less' || mode === 'reserved-prefix') {
    const unanchoredCount = await countLive({
      $and: [prefixRegexArm(prefix), notMetaTag(datalakeTag)],
      ...LIVE_CONJUNCT,
    });
    return { ...base, unanchoredCount };
  }

  // mode === 'anchored'
  const creatorUserId = row.createdByUserId as string;
  const prefixOnlyFilter = {
    $and: [prefixRegexArm(prefix), { userId: creatorUserId }, notMetaTag(datalakeTag)],
    ...LIVE_CONJUNCT,
  };
  const narrowingFilter = {
    $and: [prefixRegexArm(prefix), { userId: { $ne: creatorUserId } }, notMetaTag(datalakeTag)],
    ...LIVE_CONJUNCT,
  };
  const [prefixOnlyDirect, narrowingUpperBound] = await Promise.all([
    countLive(prefixOnlyFilter),
    countLive(narrowingFilter),
  ]);
  const reconcile = reconcilePrefixOnly(total, metaTagged, prefixOnlyDirect);

  const [prefixOnlyFiles, narrowingFiles] = await Promise.all([
    prefixOnlyDirect > 0 ? listExampleFiles(prefixOnlyFilter) : Promise.resolve(EMPTY_LISTING),
    narrowingUpperBound > 0 ? listExampleFiles(narrowingFilter) : Promise.resolve(EMPTY_LISTING),
  ]);

  return {
    ...base,
    prefixOnlyDirect,
    reconcileMismatch: !reconcile.matches,
    narrowingUpperBound,
    prefixOnlyFiles,
    narrowingFiles,
  };
}

async function buildRegistryLakeReport(lake: (typeof DATA_LAKES)[number]): Promise<LakeReport> {
  const base: LakeReport = {
    id: lake.id,
    name: lake.name,
    datalakeTag: lake.datalakeTag,
    fileTagPrefix: lake.fileTagPrefix,
    createdByUserId: null,
    mode: 'open',
    total: null,
    totalExcludingPending: null,
    metaTagged: null,
    prefixOnlyDirect: null,
    reconcileMismatch: false,
    narrowingUpperBound: null,
    unanchoredCount: null,
    prefixOnlyFiles: { files: [], truncated: false },
    narrowingFiles: { files: [], truncated: false },
  };
  const prefix = normalizeTagPrefix(lake.fileTagPrefix);
  if (!prefix || isReservedTagPrefix(prefix)) return base;

  const unanchoredCount = await countLive({
    $and: [prefixRegexArm(prefix), notMetaTag(lake.datalakeTag)],
    ...LIVE_CONJUNCT,
  });
  return { ...base, unanchoredCount };
}

async function main() {
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));

  console.log(`Checking dynamic-lake prefix-only membership on stage="${stage}"...`);

  const dbLakes = await DataLakeModel.find({}, { name: 1, fileTagPrefix: 1, datalakeTag: 1, createdByUserId: 1 })
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .lean<DataLakeRow[]>();
  console.log(`Scanned ${dbLakes.length} dynamic data lake(s).`);

  // A DB row can shadow a registry entry's datalakeTag; that row is still classified as dynamic
  // (see the docblock above) and is already covered by the loop below, so drop it from the
  // registry-only set to avoid reporting the same lake twice under two different modes.
  const dbDatalakeTags = new Set(dbLakes.map(l => l.datalakeTag).filter((t): t is string => !!t));
  const registryOnlyLakes = DATA_LAKES.filter(l => !dbDatalakeTags.has(l.datalakeTag));
  console.log(`Plus ${registryOnlyLakes.length} registry-only (static) lake(s), informational only.`);

  const limit = pLimit(LAKE_CONCURRENCY);
  const lakes = await Promise.all([
    ...dbLakes.map(row => limit(() => buildDynamicLakeReport(row))),
    ...registryOnlyLakes.map(lake => limit(() => buildRegistryLakeReport(lake))),
  ]);

  const { lines, exitCode, findingsCount, reconcileMismatchCount } = renderCensusReport(lakes, stage);
  for (const line of lines) console.log(line);

  // Deliberately NOT the working directory: under the documented `pnpm --filter scripts ...`
  // invocation that is packages/scripts, i.e. inside a PUBLIC repo's tree, where nothing in the
  // commit chain would stop `git add -A` from making tenant file names permanent. The temp dir is
  // world-readable on Linux (1777 /tmp), so the 0600 is load-bearing rather than decoration.
  // checkDatalakeCensusReadOnly.test.ts fails the build if this regresses.
  const outDir = process.env.DATALAKE_CENSUS_OUT_DIR ?? os.tmpdir();
  const artifactPath = path.resolve(outDir, `datalake-prefix-only-census-${stage}-${Date.now()}.json`);
  // `lines` and `exitCode` are serialized too: stdout is the only place the rendered ESCALATE /
  // RECONCILE lines and the sign-off summary exist, and it is the surface most likely to be lost.
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ stage, generatedAt: new Date().toISOString(), exitCode, findingsCount, lines, lakes }, null, 2),
    { mode: 0o600 }
  );
  console.log(`\nFull per-lake detail written to ${artifactPath} (mode 0600).`);
  console.log(
    'That file carries cross-tenant identity data - per-file owner ids and file names, plus each ' +
      "lake's name, fileTagPrefix and creator id. Split it per owner (the per-file userId is there " +
      'for exactly that) before any of it leaves the operator. Tmp reaping can remove it, so copy ' +
      'it deliberately if it is needed for sign-off.'
  );

  if (reconcileMismatchCount > 0) {
    throw new Error(
      `${reconcileMismatchCount} lake(s) failed the RECONCILE cross-check - the census cannot be trusted on this run.`
    );
  }

  return exitCode;
}

/**
 * `process.exitCode` + an explicit disconnect, never `process.exit()`. Node's stdout is
 * asynchronous when it is a pipe - which the documented `sst shell`/`pnpm` invocation guarantees -
 * and `process.exit()` does not drain it. The exposure is worst exactly where it matters most:
 * exit 2 is the findings case and also the longest output, and the last lines printed are the
 * artifact path and the cross-tenant-data warning. The same applies to the failure path, where
 * truncating console.error costs the operator the REASON the census could not be trusted.
 */
void (async () => {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
})();
