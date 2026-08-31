import * as fs from 'node:fs';
import * as path from 'node:path';
import { connectDB, DataLakeModel, FabFile, buildDataLakeMembershipQuery } from '@bike4mind/database';
import { DATA_LAKES, normalizeTagPrefix, isReservedTagPrefix } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import pLimit from 'p-limit';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import {
  classifyDynamicLakeMode,
  reconcilePrefixOnly,
  renderCensusReport,
  type LakeReport,
} from './prefixOnlyMembersReport';

/**
 * READ-ONLY pre-merge census for the dynamic-lake prefix-only-member gap (the defect fixed by
 * the lake-membership-retrieval-parity PR). Its own PR, merged and RUN before that fix, because
 * the fix changes which files retrieval reaches - this must measure the PRE-change world.
 *
 * `buildDataLakeMembershipFilter` (@bike4mind/database) is `metaTag OR (fileTagPrefix AND
 * lake.creatorUserId)`. Retrieval today only ever sees the caller-anchored prefix arm, never the
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
 * conditions (no prefix, reserved prefix, no creator), all of which collapse to a bare
 * `prefixOnly = 0`. Only one of those is a genuine zero, so every lake is classified into an
 * explicit arm mode first (see prefixOnlyMembersReport.ts) rather than printing that bare zero.
 * A dynamic lake with no creator on record is a data-quality defect and escalates on its own,
 * separately from the widening/narrowing counts.
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
 * contains cross-tenant file names - split it per owner before any of it leaves the operator.
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

interface DataLakeRow {
  _id: unknown;
  name?: string;
  fileTagPrefix?: string | null;
  datalakeTag?: string;
  createdByUserId?: string | null;
}

const prefixRegexArm = (prefix: string) => ({ 'tags.name': { $regex: new RegExp(`^${escapeRegex(prefix)}`) } });
const notMetaTag = (datalakeTag: string) => ({ 'tags.name': { $ne: datalakeTag } });

async function listExampleFiles(filter: Record<string, unknown>): Promise<{ fileNames: string[]; truncated: boolean }> {
  const docs = await FabFile.find(filter, { fileName: 1 })
    .limit(FILE_LISTING_CAP + 1)
    .lean<{ fileName: string }[]>();
  const truncated = docs.length > FILE_LISTING_CAP;
  return { fileNames: docs.slice(0, FILE_LISTING_CAP).map(d => d.fileName), truncated };
}

async function buildDynamicLakeReport(row: DataLakeRow): Promise<LakeReport> {
  const id = String(row._id);
  const name = row.name ?? '(unnamed)';
  const datalakeTag = row.datalakeTag ?? '';
  const mode = classifyDynamicLakeMode(row);

  const scope = { datalakeTag, fileTagPrefix: row.fileTagPrefix, creatorUserId: row.createdByUserId };
  const [total, totalExcludingPending, metaTagged] = await Promise.all([
    FabFile.countDocuments(buildDataLakeMembershipQuery(scope, LIVE_CONJUNCT)),
    FabFile.countDocuments(buildDataLakeMembershipQuery(scope, { ...LIVE_CONJUNCT, status: { $ne: 'pending' } })),
    FabFile.countDocuments({ 'tags.name': datalakeTag, ...LIVE_CONJUNCT }),
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
    prefixOnlyFiles: { fileNames: [], truncated: false },
    narrowingFiles: { fileNames: [], truncated: false },
  };

  if (mode === 'no-prefix') return base;

  const prefix = normalizeTagPrefix(row.fileTagPrefix);
  if (!prefix) return base; // classifier already routed this to no-prefix; defensive only.

  if (mode === 'creator-less') {
    const unanchoredCount = await FabFile.countDocuments({
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
    FabFile.countDocuments(prefixOnlyFilter),
    FabFile.countDocuments(narrowingFilter),
  ]);
  const reconcile = reconcilePrefixOnly(total, metaTagged, prefixOnlyDirect);

  const [prefixOnlyFiles, narrowingFiles] = await Promise.all([
    prefixOnlyDirect > 0 ? listExampleFiles(prefixOnlyFilter) : Promise.resolve({ fileNames: [], truncated: false }),
    narrowingUpperBound > 0 ? listExampleFiles(narrowingFilter) : Promise.resolve({ fileNames: [], truncated: false }),
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
    prefixOnlyFiles: { fileNames: [], truncated: false },
    narrowingFiles: { fileNames: [], truncated: false },
  };
  const prefix = normalizeTagPrefix(lake.fileTagPrefix);
  if (!prefix || isReservedTagPrefix(prefix)) return base;

  const unanchoredCount = await FabFile.countDocuments({
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

  const dbLakes = await DataLakeModel.find({}, { name: 1, fileTagPrefix: 1, datalakeTag: 1, createdByUserId: 1 }).lean<
    DataLakeRow[]
  >();
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

  const artifactPath = path.resolve(process.cwd(), `datalake-prefix-only-census-${stage}-${Date.now()}.json`);
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ stage, generatedAt: new Date().toISOString(), findingsCount, lakes }, null, 2)
  );
  console.log(`\nFull per-lake detail written to ${artifactPath}.`);
  console.log('That file contains cross-tenant file names - split it per owner before any of it leaves the operator.');

  if (reconcileMismatchCount > 0) {
    throw new Error(
      `${reconcileMismatchCount} lake(s) failed the RECONCILE cross-check - the census cannot be trusted on this run.`
    );
  }

  process.exit(exitCode);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
