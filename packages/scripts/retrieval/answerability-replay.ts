#!/usr/bin/env tsx
/**
 * Backfill `promptMeta.retrieval.answerability` over historical optional-path turns (#1394).
 *
 * WHAT IT ANSWERS. The optional-path retrieval rate says the model reaches for the corpus on about
 * a fifth of the turns where the tools are offered. It cannot say whether the other four fifths
 * were misses or turns with nothing to find, and those argue for opposite things - the first for
 * building per-turn routing, the second for leaving the optional path alone. This replays each
 * turn's prompt against the corpus and records what retrieval WOULD have found, which is the
 * denominator that separates them. `summarizeOptionalPathRetrieval` folds the result into a 2x2 and
 * the admin Retrieval Rate tab renders it.
 *
 * WHY OFFLINE. The population that matters is the turns where retrieval never ran, so measuring it
 * live would mean adding an embedding call and a brute-force chunk scan to exactly the turns that
 * pay nothing for retrieval today. That is a latency regression on the majority of traffic in
 * exchange for a metric. Run here instead, close to the window being measured.
 *
 * WHAT IT IS NOT. Not a measurement of the turn as it happened. Two drifts, both documented on
 * RetrievalSummarySchema.answerability and neither fixable here:
 *   1. The corpus CONTENT has moved since the turn. `probedAt` is stamped so a reader can see how
 *      far. A replay long after the window is weak evidence.
 *   2. The corpus SCOPE is reconstructed, because the seed writes `dataLakeTags: []` on a turn
 *      where retrieval never ran. Scope here is the session's `retrievalTags` intersected with the
 *      owner's CURRENT lake access, so a session whose lakes changed is replayed against a corpus
 *      the turn never had.
 *
 * IT UNDER-COUNTS ANSWERABLE TURNS, AND THAT IS THE SAFE DIRECTION. The knowledge tool's corpus is
 * the session's lakes plus the caller's own files; this sees only the lakes. A lake reachable at
 * the time through an admission path that has since lapsed is also missed. Both make a turn look
 * less answerable than it was, so the "missed retrievals" figure this feeds is a FLOOR. A metric
 * whose job is to justify building a classifier must not be the one arguing for itself - the same
 * reason MODEL_INITIATED_SURFACES is an allowlist.
 *
 * WRITES. One `$set` of `promptMeta.retrieval.answerability` per probed turn, and nothing else.
 * Idempotent: an already-probed turn is skipped unless `--force`. Use `--dry-run` first.
 *
 * Usage (needs DB + an embedding key, which `sst shell` provides):
 *   for-env dev pnpm sst shell --stage dev -- \
 *     packages/scripts/node_modules/.bin/tsx packages/scripts/retrieval/answerability-replay.ts \
 *     --start 2026-08-12 --end 2026-09-11 --dry-run
 */
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
  Quest,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { apiKeyService, dataLakeService } from '@bike4mind/services';
import {
  FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT,
  isSupportedEmbeddingModel,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import {
  buildAnswerabilityProbe,
  formatReplaySummary,
  selectReplayTargets,
  type ReplayRow,
  type ReplayTally,
} from './answerabilityReplay.js';

const logger = new Logger();

/**
 * Deep enough to see past the floor without paying for a long tail: the probe only needs the top
 * score and a count of what cleared the bar, and both are settled well inside this.
 */
const SEARCH_TOP_K = 20;

/**
 * The search itself must NOT filter. Passing the floor as `minScore` would collapse "the corpus
 * held nothing at all" and "the corpus held something weak" into the same empty result, and the
 * difference between those is exactly what a swept cutoff is meant to explore later.
 */
const SEARCH_MIN_SCORE = 0;

type ApiKeyTable = { openai?: string | null; voyageai?: string | null; ollama?: string | null };

type OwnerScope = {
  dataLakeTags: string[];
  dataLakeTagPrefixes: string[];
  lakeMemberships: ReturnType<typeof dataLakeService.lakeMembershipsFrom>;
  lakes: Awaited<ReturnType<typeof dataLakeService.getDynamicDataLakeAccess>>['lakes'];
  apiKeyTable: ApiKeyTable;
};

/**
 * Per-owner lake access and API keys, resolved once. A window is overwhelmingly a handful of heavy
 * users, so without this the run spends most of its time re-resolving the same access graph.
 */
async function resolveOwnerScope(userId: string, cache: Map<string, OwnerScope | null>): Promise<OwnerScope | null> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;

  const user = await userRepository.findById(userId);
  if (!user) {
    cache.set(userId, null);
    return null;
  }

  const access = await dataLakeService.getDynamicDataLakeAccess({
    db: { dataLakes: dataLakeRepository, organizations: organizationRepository },
    user: { id: String(user.id), tags: user.tags ?? [] },
  });
  const keys = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  const scope: OwnerScope = {
    dataLakeTags: access.dataLakeTags,
    dataLakeTagPrefixes: access.dataLakeTagPrefixes,
    lakeMemberships: dataLakeService.lakeMembershipsFrom(access.lakes),
    lakes: access.lakes,
    apiKeyTable: { openai: keys?.openai, voyageai: keys?.voyageai, ollama: keys?.ollama },
  };
  cache.set(userId, scope);
  return scope;
}

async function resolveEmbeddingModel(): Promise<SupportedEmbeddingModel> {
  const configured = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  // Unset is its own failure, and a loud one: falling back to a default model here would score the
  // whole window against embeddings the corpus was never built with, and report the resulting
  // near-zero cosines as a corpus that had nothing to offer.
  if (typeof configured !== 'string' || !isSupportedEmbeddingModel(configured)) {
    throw new Error(`defaultEmbeddingModel is "${String(configured)}", not a supported embedding model.`);
  }
  return configured;
}

type Options = {
  start?: string;
  end?: string;
  limit: number;
  floor: number;
  dryRun: boolean;
  force: boolean;
};

async function main(opts: Options): Promise<number> {
  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));

  const timestamp: Record<string, Date> = {};
  if (opts.start) timestamp.$gte = new Date(opts.start);
  if (opts.end) timestamp.$lte = new Date(opts.end);

  const found = (await Quest.find({
    'promptMeta.retrieval.mode': 'optional',
    ...(opts.start || opts.end ? { timestamp } : {}),
  })
    .select('prompt sessionId userId promptMeta.retrieval.mode promptMeta.retrieval.answerability')
    .sort({ timestamp: -1 })
    .limit(opts.limit)
    .lean()) as unknown as (Omit<ReplayRow, '_id'> & { _id: unknown; userId?: string })[];

  // `_id` arrives as an ObjectId. Stringified once, here, so the id that reaches the target list
  // and the id that keys the lookup below are the same value - comparing an ObjectId against its
  // own string silently matches nothing.
  const rows = found.map(row => ({ ...row, _id: String(row._id) }));
  const selection = selectReplayTargets(rows, { force: opts.force });
  const byId = new Map(rows.map(row => [row._id, row]));
  const embeddingModel = await resolveEmbeddingModel();
  const scopeCache = new Map<string, OwnerScope | null>();
  const tally: ReplayTally = { probed: 0, written: 0, failed: 0, skipped: selection.skipped };

  console.log(`stage:     ${Resource.App.stage}`);
  console.log(`window:    ${opts.start ?? 'all'} to ${opts.end ?? 'now'}`);
  console.log(`model:     ${embeddingModel}`);
  console.log(`floor:     ${opts.floor}`);
  console.log(`targets:   ${selection.targets.length} of ${rows.length} scanned`);
  if (opts.dryRun) console.log('DRY RUN - probing without writing.');
  if (opts.force) console.log('FORCE - overwriting probes that already exist.');
  console.log('');

  // Sequential on purpose: every target is an embedding call plus a vector scan, and this runs
  // against a live stage whose interactive traffic has a stronger claim on both than a backfill.
  for (const target of selection.targets) {
    const ownerId = byId.get(target.questId)?.userId;
    const scope = ownerId ? await resolveOwnerScope(ownerId, scopeCache) : null;
    if (!ownerId || !scope) {
      // An anomaly, not a routine skip: a turn whose owner cannot be resolved means the quest
      // outlived its user record. Counted as a failure so it cannot hide inside a skip tally.
      tally.failed += 1;
      console.error(`  no resolvable owner for quest ${target.questId} (userId ${String(ownerId)})`);
      continue;
    }

    const session = await sessionRepository.findById(target.sessionId);
    const sessionTags = session?.retrievalTags ?? [];
    // The turn's own lakes, not everything the owner can reach now: a session is scoped to what
    // was selected in it, and searching the owner's whole library would answer a question no turn
    // ever asked.
    const dataLakeTags = scope.dataLakeTags.filter(tag => sessionTags.includes(tag));
    if (dataLakeTags.length === 0) {
      tally.skipped.no_lake_scope += 1;
      continue;
    }

    try {
      const search = await dataLakeService.semanticDataLakeSearch(
        {
          userId: ownerId,
          query: target.prompt,
          topK: SEARCH_TOP_K,
          minScore: SEARCH_MIN_SCORE,
          embeddingModel,
          apiKeyTable: scope.apiKeyTable,
          dataLakeTags,
          dataLakeTagPrefixes: scope.dataLakeTagPrefixes,
          lakeMemberships: scope.lakeMemberships,
          lakes: scope.lakes,
          logger,
        },
        { db: { fabfiles: fabFileRepository, fabfilechunks: fabFileChunkRepository } }
      );

      const probe = buildAnswerabilityProbe(search.results, search.scan, {
        floor: opts.floor,
        probedAt: new Date(),
      });
      tally.probed += 1;

      if (!opts.dryRun) {
        await Quest.updateOne({ _id: target.questId }, { $set: { 'promptMeta.retrieval.answerability': probe } });
        tally.written += 1;
      }
    } catch (err) {
      // One unanswerable turn must not end the run - a single bad lake or a rate limit would
      // otherwise throw away every probe before it. Counted, named, and carried on from.
      tally.failed += 1;
      console.error(`  probe failed for quest ${target.questId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(formatReplaySummary(tally));
  // Nonzero only when NOTHING was probed and something failed - a wholesale failure (bad stage,
  // no embedding key) rather than a few unlucky turns, which are reported in the tally above and
  // are a normal outcome for a backfill. A caller that needs to react to partial failure should
  // read `failed` in the summary, not the exit code.
  return tally.failed > 0 && tally.probed === 0 ? 1 : 0;
}

const argv = yargs(hideBin(process.argv))
  .option('start', { type: 'string', describe: 'Inclusive start of the turn window, e.g. 2026-08-12' })
  .option('end', { type: 'string', describe: 'Inclusive end of the turn window' })
  .option('limit', { type: 'number', default: 1000, describe: 'Maximum turns to scan, newest first' })
  .option('floor', {
    type: 'number',
    default: FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT / 100,
    describe: 'Cosine floor for candidatesAboveFloor; defaults to the forced-retrieval floor',
  })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Probe and report without writing' })
  .option('force', { type: 'boolean', default: false, describe: 'Re-probe turns that already carry a probe' })
  .strict()
  .parseSync();

main({
  start: argv.start,
  end: argv.end,
  limit: argv.limit,
  floor: argv.floor,
  dryRun: argv['dry-run'],
  force: argv.force,
})
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
