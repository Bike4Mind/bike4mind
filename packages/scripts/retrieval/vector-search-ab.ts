#!/usr/bin/env tsx
/**
 * A/B the Atlas `$vectorSearch` cutover against the brute-force scan, on the one corpus that has
 * ground truth: the `system-help` lake plus the hand-authored questions in `corpus.ts`.
 *
 * Runs every probe question TWICE through `semanticDataLakeSearch` - once with
 * `vectorSearchEnabled: false` (scan) and once with `true` (ANN) - and diffs the ranked output.
 * Everything else about the two calls is identical, including the query embedding, which is
 * deterministic for a given model and input.
 *
 * WHY THE FLAG IS PASSED DIRECTLY, not toggled in Mongo:
 * `semanticDataLakeSearch` never reads settings itself - every real caller reads
 * `EnableDataLakeVectorSearch` once and passes the boolean in (knowledgeBaseSearch/index.ts:269,
 * data-lakes/semantic-search.ts:411). So passing it directly reproduces exactly what flipping the
 * setting would produce for this call, without mutating a setting on a SHARED stage where it would
 * change retrieval for everyone else mid-run. What this does NOT exercise is the settings read and
 * its cache; that is two lines at each of the two call sites, and it is covered by their own tests.
 * It also does not bypass the Atlas readiness gate (`supportsAtlasVectorSearch` plus a queryable
 * index), which is real infrastructure state and is reported in the preflight below.
 *
 * READ-ONLY. Writes nothing but its own report file.
 *
 * THE VACUITY TRAP this exists to avoid: every ANN failure mode in the read path degrades to the
 * scan on purpose - an unstamped file, a non-queryable index, a throw, a zero-hit file. So "the two
 * arms agree" is the expected result of ANN never having engaged at all, which is indistinguishable
 * from a clean pass unless you look. Hence `annFilesQueried` / `annHits` / `annModelsQueried` are
 * summed per arm and printed, and the scan arm is asserted to have queried no ANN. Read
 * `annEngaged` in the output BEFORE reading any metric.
 *
 * Usage (needs DB + an embedding key, which `sst shell` provides):
 *   for-env dev pnpm sst shell --stage dev -- \
 *     packages/scripts/node_modules/.bin/tsx packages/scripts/retrieval/vector-search-ab.ts \
 *     --userId <id> --label pre
 *
 * `--userId` MUST be the help lake's `createdByUserId`. That lake is gateless - no `isPublic`, no
 * `requiredUserTag`, no `organizationId` - so the owner bypass in `getDynamicDataLakeAccess`
 * (getDynamicDataLakeTags.ts:295-332) is the only arm that admits anyone, and no user carries its
 * meta-tag. The preflight fails loudly if the resolved scope does not contain the lake.
 *
 * CORPUS IS MIXED, AND THAT IS FINE HERE. Retrieval ranks the caller's own library alongside the
 * lake and there is no way to exclude it, so running as the owner pulls in that account's other
 * files too (94 vectorized ones on staging at the time of writing). For an A/B this is harmless:
 * both arms get byte-identical scope, so the divergence count and the rank changes - the things
 * this script exists to measure - are unaffected. What it does mean is that the absolute
 * recall/precision numbers are NOT comparable to `recall-probe.ts`, which measures a clean corpus.
 * `offCorpusFiles` in the report is how much non-lake material was served; read it before
 * comparing any absolute metric across scripts.
 *
 * Run it once before a backfill/flag change (`--label pre`) and again after (`--label post`), then
 * diff the two JSON reports.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import {
  adminSettingsRepository,
  apiKeyRepository,
  connectDB,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { apiKeyService, dataLakeService } from '@bike4mind/services';
import { isSupportedEmbeddingModel, type SupportedEmbeddingModel } from '@bike4mind/common';
import { PROBE_QUESTIONS, type ProbeQuestion } from './corpus.js';
import { aggregate, scoreQuestion, type Aggregate, type QuestionOutcome } from './metrics.js';

const logger = new Logger();

const HELP_LAKE_SLUG = 'system-help';
const HELP_TAG_PREFIX = 'help:';
const SEARCH_TOP_K = 10;
const SEARCH_MIN_SCORE = 0;

type ApiKeyTable = { openai?: string | null; voyageai?: string | null; ollama?: string | null };

type Arm = 'scan' | 'ann';

/** Per-arm retrieval telemetry, summed over every question. */
type ArmTelemetry = {
  annFilesQueried: number;
  annHits: number;
  annModelsQueried: number;
  chunksScanned: number;
  filesScanned: number;
  truncated: number;
};

type QuestionCapture = {
  id: string;
  question: string;
  supporting: string[];
  /** Ordered, deduped `help:<slug>` documents served - the unit ground truth is expressed in. */
  servedSlugs: string[];
  /** Ordered chunk ids, the finest-grained thing the two arms can disagree about. */
  servedChunkIds: string[];
  scores: number[];
  /** Served files carrying no `help:` tag. Non-zero means the corpus was not just the lake. */
  offCorpusFiles: number;
  outcome: QuestionOutcome;
  scan: ArmTelemetry;
};

/**
 * `fileTags` arrives as tag names; the ingest writes one `help:<slug>` per help document, so a
 * served file maps to exactly one slug. A file with no `help:` tag is not part of the ground-truth
 * corpus and is counted separately rather than silently scored as a miss.
 */
function slugOf(fileTags: readonly string[]): string | undefined {
  const tag = fileTags.find(t => typeof t === 'string' && t.startsWith(HELP_TAG_PREFIX));
  return tag ? tag.slice(HELP_TAG_PREFIX.length) : undefined;
}

function emptyTelemetry(): ArmTelemetry {
  return { annFilesQueried: 0, annHits: 0, annModelsQueried: 0, chunksScanned: 0, filesScanned: 0, truncated: 0 };
}

function addTelemetry(into: ArmTelemetry, scan: Record<string, unknown>): void {
  const num = (k: string): number => (typeof scan[k] === 'number' ? (scan[k] as number) : 0);
  into.annFilesQueried += num('annFilesQueried');
  into.annHits += num('annHits');
  into.annModelsQueried += num('annModelsQueried');
  into.chunksScanned += num('chunksScanned');
  into.filesScanned += num('filesScanned');
  if (scan.truncated === true) into.truncated += 1;
}

type Scope = {
  dataLakeTags: string[];
  dataLakeTagPrefixes: string[];
  lakeMemberships: ReturnType<typeof dataLakeService.lakeMembershipsFrom>;
  lakes: Parameters<typeof dataLakeService.semanticDataLakeSearch>[0]['lakes'];
};

/**
 * Same resolver the semantic-search route and the chat tool sit on, called directly for the probe
 * user so the lake scope matches what a real caller would get without needing a request to hang
 * it off.
 */
async function resolveScope(user: { id: string; tags?: string[] }): Promise<Scope> {
  const access = await dataLakeService.getDynamicDataLakeAccess({
    db: { dataLakes: dataLakeRepository, organizations: organizationRepository },
    user: { id: user.id, tags: user.tags ?? [] },
  });
  return {
    dataLakeTags: access.dataLakeTags,
    dataLakeTagPrefixes: access.dataLakeTagPrefixes,
    lakeMemberships: dataLakeService.lakeMembershipsFrom(access.lakes),
    lakes: access.lakes,
  };
}

async function resolveApiKeyTable(userId: string): Promise<ApiKeyTable> {
  const keys = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  return { openai: keys?.openai, voyageai: keys?.voyageai, ollama: keys?.ollama };
}

type Preflight = {
  lakeId: string;
  datalakeTag: string;
  embeddingModel: SupportedEmbeddingModel;
  helpFiles: number;
  helpFilesStamped: number;
  atlasQueryable: boolean;
  atlasStatus: string;
};

/**
 * Fail before measuring rather than reporting a confidently wrong number. Each of these degrades
 * silently in a chat turn, which is correct there and ruinous for a measurement.
 */
async function preflight(scope: Scope): Promise<Preflight> {
  const lake = await dataLakeRepository.findBySlug(HELP_LAKE_SLUG);
  if (!lake) throw new Error(`No "${HELP_LAKE_SLUG}" lake on this stage; nothing to measure against.`);
  if (lake.status !== 'active') throw new Error(`Lake "${HELP_LAKE_SLUG}" is ${lake.status}, not active.`);

  if (!scope.dataLakeTags.includes(lake.datalakeTag)) {
    throw new Error(
      `Probe user cannot see "${HELP_LAKE_SLUG}" (${lake.datalakeTag}). Resolved lake tags: ` +
        `${scope.dataLakeTags.join(', ') || '(none)'}. This lake is gateless, so the owner bypass is ` +
        `the only arm that admits anyone: pass --userId ${String(lake.createdByUserId)}.`
    );
  }

  const fileIds = await fabFileRepository.findIdsByDataLakeTag({ kind: 'registry', datalakeTag: lake.datalakeTag });
  if (fileIds.length === 0) throw new Error(`Lake "${HELP_LAKE_SLUG}" holds no files.`);

  const configured = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (typeof configured !== 'string' || !isSupportedEmbeddingModel(configured)) {
    throw new Error(`defaultEmbeddingModel is "${String(configured)}", not a supported embedding model.`);
  }
  const embeddingModel = configured;

  // ANN serves only files carrying `chunkEmbeddingModelStampedAt` (vectorSearchEligibility.ts:21),
  // so this ratio is the ceiling on how much of the ann arm can differ from the scan at all. A run
  // at 0/N is a legitimate PRE capture, not a broken one - but it must be visible, not inferred.
  let helpFilesStamped = 0;
  for (const id of fileIds) {
    const file = await fabFileRepository.findById(id);
    if (file?.chunkEmbeddingModelStampedAt) helpFilesStamped++;
  }

  const status = await fabFileChunkRepository.getAtlasIndexStatus?.(embeddingModel);

  return {
    lakeId: String(lake.id),
    datalakeTag: lake.datalakeTag,
    embeddingModel,
    helpFiles: fileIds.length,
    helpFilesStamped,
    atlasQueryable: status?.queryable === true,
    atlasStatus: String(status?.status ?? 'unknown'),
  };
}

async function runArm(
  question: ProbeQuestion,
  arm: Arm,
  userId: string,
  userGroups: string[],
  scope: Scope,
  embeddingModel: SupportedEmbeddingModel,
  apiKeyTable: ApiKeyTable
): Promise<QuestionCapture> {
  const search = await dataLakeService.semanticDataLakeSearch(
    {
      userId,
      userGroups,
      query: question.question,
      topK: SEARCH_TOP_K,
      minScore: SEARCH_MIN_SCORE,
      embeddingModel,
      apiKeyTable,
      dataLakeTags: scope.dataLakeTags,
      dataLakeTagPrefixes: scope.dataLakeTagPrefixes,
      lakeMemberships: scope.lakeMemberships,
      lakes: scope.lakes,
      vectorSearchEnabled: arm === 'ann',
      logger,
    },
    { db: { fabfiles: fabFileRepository, fabfilechunks: fabFileChunkRepository } }
  );

  const servedSlugs: string[] = [];
  const seen = new Set<string>();
  let offCorpusFiles = 0;
  for (const hit of search.results) {
    const slug = slugOf((hit.fileTags ?? []) as string[]);
    if (!slug) {
      offCorpusFiles++;
      continue;
    }
    if (!seen.has(slug)) {
      seen.add(slug);
      servedSlugs.push(slug);
    }
  }

  const telemetry = emptyTelemetry();
  addTelemetry(telemetry, search.scan as unknown as Record<string, unknown>);

  return {
    id: question.id,
    question: question.question,
    supporting: question.supporting,
    servedSlugs,
    servedChunkIds: search.results.map(r => r.chunkId),
    scores: search.results.map(r => r.score),
    offCorpusFiles,
    outcome: scoreQuestion(servedSlugs, new Set(question.supporting)),
    scan: telemetry,
  };
}

function sumTelemetry(caps: readonly QuestionCapture[]): ArmTelemetry {
  const total = emptyTelemetry();
  for (const c of caps) {
    total.annFilesQueried += c.scan.annFilesQueried;
    total.annHits += c.scan.annHits;
    total.annModelsQueried += c.scan.annModelsQueried;
    total.chunksScanned += c.scan.chunksScanned;
    total.filesScanned += c.scan.filesScanned;
    total.truncated += c.scan.truncated;
  }
  return total;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function printComparison(scan: Aggregate, ann: Aggregate, scanT: ArmTelemetry, annT: ArmTelemetry): void {
  const rows: [string, string, string][] = [
    ['recall', pct(scan.recall), pct(ann.recall)],
    ['precision', pct(scan.precision), pct(ann.precision)],
    ['hitRate', pct(scan.hitRate), pct(ann.hitRate)],
    ['mrr', scan.mrr.toFixed(3), ann.mrr.toFixed(3)],
    ['meanDocsServed', scan.meanDocumentsServed.toFixed(2), ann.meanDocumentsServed.toFixed(2)],
    ['falsePositiveRate', pct(scan.falsePositiveRate), pct(ann.falsePositiveRate)],
  ];
  console.log('\n=== metrics (scan vs ann) ===');
  console.log('metric              scan        ann');
  for (const [name, a, b] of rows) {
    const flag = a === b ? '' : '   <-- differs';
    console.log(`${name.padEnd(20)}${a.padEnd(12)}${b}${flag}`);
  }

  console.log('\n=== ANN engagement (read this FIRST) ===');
  console.log(
    `scan arm: annFilesQueried=${scanT.annFilesQueried} annHits=${scanT.annHits} annModelsQueried=${scanT.annModelsQueried}`
  );
  console.log(
    `ann  arm: annFilesQueried=${annT.annFilesQueried} annHits=${annT.annHits} annModelsQueried=${annT.annModelsQueried}`
  );
  if (annT.annModelsQueried === 0) {
    console.log('\n  ANN NEVER ENGAGED in the ann arm. Every metric above is the scan measured twice.');
    console.log('  Expected when the corpus is unstamped (a PRE capture) or the index is not queryable.');
  }
  if (scanT.annModelsQueried !== 0) {
    console.log('\n  UNEXPECTED: the scan arm queried ANN. The arms are not isolated; do not trust this run.');
  }
}

function printDivergences(scan: readonly QuestionCapture[], ann: readonly QuestionCapture[]): number {
  console.log('\n=== per-question divergence ===');
  let diverged = 0;
  for (let i = 0; i < scan.length; i++) {
    const a = scan[i];
    const b = ann[i];
    const sameSlugs = a.servedSlugs.join('|') === b.servedSlugs.join('|');
    const sameChunks = a.servedChunkIds.join('|') === b.servedChunkIds.join('|');
    if (sameSlugs && sameChunks) continue;
    diverged++;
    console.log(`\n${a.id} recall ${a.outcome.recall.toFixed(2)} -> ${b.outcome.recall.toFixed(2)}`);
    if (!sameSlugs) {
      console.log(`  scan docs: ${a.servedSlugs.join(', ') || '(none)'}`);
      console.log(`  ann  docs: ${b.servedSlugs.join(', ') || '(none)'}`);
    }
    if (!sameChunks) {
      const lost = a.servedChunkIds.filter(id => !b.servedChunkIds.includes(id));
      const gained = b.servedChunkIds.filter(id => !a.servedChunkIds.includes(id));
      console.log(`  chunks lost by ann: ${lost.length}  gained: ${gained.length}`);
    }
  }
  if (diverged === 0) console.log('none - the two arms returned identical rankings for every question.');
  return diverged;
}

async function main(opts: { userId: string; label: string; outDir: string }): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);

  const user = await userRepository.findById(opts.userId);
  if (!user) throw new Error(`No user ${opts.userId} on stage ${Resource.App.stage}.`);

  const scope = await resolveScope({ id: String(user.id), tags: user.tags ?? [] });
  const pre = await preflight(scope);
  const apiKeyTable = await resolveApiKeyTable(String(user.id));

  console.log(`stage:              ${Resource.App.stage}`);
  console.log(`label:              ${opts.label}`);
  console.log(`lake:               ${HELP_LAKE_SLUG} (${pre.datalakeTag})`);
  console.log(`embedding model:    ${pre.embeddingModel}`);
  console.log(`atlas index:        status=${pre.atlasStatus} queryable=${pre.atlasQueryable}`);
  console.log(`help files:         ${pre.helpFiles}`);
  console.log(`  ANN-eligible:     ${pre.helpFilesStamped} (${pct(pre.helpFilesStamped / pre.helpFiles)})`);
  console.log(`questions:          ${PROBE_QUESTIONS.length}`);

  const scanCaps: QuestionCapture[] = [];
  const annCaps: QuestionCapture[] = [];

  for (const q of PROBE_QUESTIONS) {
    // Sequential and interleaved on purpose: the two arms of one question run back to back, so a
    // mid-run change to the corpus (a concurrent backfill, say) shifts both arms together rather
    // than showing up as a false divergence.
    const userGroups = user.groups ?? [];
    scanCaps.push(await runArm(q, 'scan', String(user.id), userGroups, scope, pre.embeddingModel, apiKeyTable));
    annCaps.push(await runArm(q, 'ann', String(user.id), userGroups, scope, pre.embeddingModel, apiKeyTable));
    process.stdout.write('.');
  }
  console.log('');

  const scanAgg = aggregate(scanCaps.map(c => c.outcome));
  const annAgg = aggregate(annCaps.map(c => c.outcome));
  const scanT = sumTelemetry(scanCaps);
  const annT = sumTelemetry(annCaps);

  printComparison(scanAgg, annAgg, scanT, annT);
  const diverged = printDivergences(scanCaps, annCaps);

  const offCorpus = [...scanCaps, ...annCaps].reduce((s, c) => s + c.offCorpusFiles, 0);
  if (offCorpus > 0) {
    console.log(`\nWARNING: ${offCorpus} served file(s) carried no ${HELP_TAG_PREFIX} tag, so the corpus was`);
    console.log('not the help lake alone. Metrics are still comparable between arms but not to other runs.');
  }

  mkdirSync(opts.outDir, { recursive: true });
  const outPath = path.join(opts.outDir, `vector-search-ab-${opts.label}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        label: opts.label,
        stage: Resource.App.stage,
        capturedAt: new Date().toISOString(),
        preflight: pre,
        annEngaged: annT.annModelsQueried > 0,
        divergedQuestions: diverged,
        offCorpusFiles: offCorpus,
        aggregate: { scan: scanAgg, ann: annAgg },
        telemetry: { scan: scanT, ann: annT },
        questions: { scan: scanCaps, ann: annCaps },
      },
      null,
      2
    )
  );
  console.log(`\nreport: ${outPath}`);

  // A non-zero exit means "do not trust this run", not "ANN is worse". Arm bleed is the only thing
  // that invalidates the measurement itself; a divergence is a finding to read, not an error.
  return scanT.annModelsQueried === 0 ? 0 : 1;
}

const argv = yargs(hideBin(process.argv))
  .option('userId', {
    type: 'string',
    demandOption: true,
    describe: "Probe user; must be the help lake's createdByUserId",
  })
  .option('label', { type: 'string', demandOption: true, describe: 'Names the report file, e.g. pre / post' })
  .option('out-dir', { type: 'string', default: 'packages/scripts/out', describe: 'Report directory' })
  .parseSync();

main({ userId: argv.userId, label: argv.label, outDir: argv['out-dir'] })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
