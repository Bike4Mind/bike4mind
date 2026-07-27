import {
  isFieldGroup,
  type FieldGroup,
  type IDiscoveryJoinCoverage,
  type IDiscoverySourceReport,
  type IModelDiscoveryRun,
  type IModelDiscoveryRunDocument,
  type IModelDiscoveryState,
  type IModelCatalogRow,
  type IModelCatalogRowInput,
  type IModelPriceInput,
} from '@bike4mind/common';
import { resolveCatalogRecords, type ResolvedCatalogRecord } from '@bike4mind/llm-adapters';
import { applyAbsence, planAbsence, type AbsencePlan } from './absence';
import { limitConcurrency } from './concurrency';
import { planCatalogWrites, summarizeDiff, type CatalogWritePlan } from './catalogWrite';
import {
  detectParserRowShifts,
  planLifecycle,
  planLifecycleSignals,
  type LifecyclePlan,
  type ParserRowShift,
} from './lifecyclePlan';
import { describePriceRows, perTokenRatesInForce, planPriceWrites, type PricePlan } from './pricePlan';
import type {
  CatalogDiffEntry,
  DiscoveryAutoEnablePolicy,
  DiscoveryAutoRemapPolicy,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoveryLogger,
  DiscoveryMode,
  DiscoverySource,
  DiscoverySourceOk,
  DroppedSourceRecord,
  LifecycleDateChange,
  LifecycleSuggestion,
  LifecycleTransition,
  ModelDiscoveryAdapters,
  ModelDiscoveryMetrics,
  ModelDiscoveryRunResult,
  PriceFlag,
  RunModelDiscoveryOptions,
  SourceResult,
  SourceSkipReason,
} from './types';

/** One lease for every driver and host: cron, worker, startup and Run now share it. */
export const DISCOVERY_LEASE_KEY = 'model-discovery:lease';

/** Hosted lambda timeout (sec 6.1). Self-host drivers pass their own budget. */
export const DEFAULT_BUDGET_MS = 10 * 60_000;

/** Room inside the budget for the partial commit to finish before the runtime kills us. */
export const GLOBAL_DEADLINE_HEADROOM_MS = 60_000;

export const DEFAULT_SOURCE_DEADLINE_MS = 30_000;

/** Register a paginated source with this via sourceDeadlineMsByName (sec 6.3). */
export const PAGINATED_SOURCE_DEADLINE_MS = 60_000;

export const DEFAULT_CONCURRENCY = 4;

/**
 * Passes one run may make, the first included.
 *
 * A pass that writes changes what the next one computes: a model appended in
 * pass 1 is a join target in pass 2, and the enrichment and prices that arrive
 * then can promote or sunset it. The run therefore repeats itself until a pass
 * appends nothing, which is what settles a new model inside ONE run instead of
 * one 6h run per step. Steady state is three passes - one that writes, one that
 * writes the join-dependent remainder, one that verifies zero - and the cap is
 * what keeps a source that disagrees with itself on every fetch from turning
 * that into an unbounded loop.
 */
export const MAX_DISCOVERY_PASSES = 4;

/**
 * The retry attempt's own deadline. One retry per source, and it may not cost a
 * second full source deadline: a source is not worth a second run's worth of
 * latency, so the retry only catches the fast-failure class.
 */
export const RETRY_DEADLINE_MS = 2_000;

/** Two stages on the same 6h boundary otherwise hit every provider simultaneously. */
export const DEFAULT_MIN_SOURCE_INTERVAL_MS = 60 * 60_000;

/** How far back run reports are read for the interval guard and cached validators. */
const RUN_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** Applied when modelDiscoveryPriceBandPct is unset or unusable (sec 8). */
export const DEFAULT_PRICE_BAND_PCT = 50;

const LOG_PREFIX = '[model-discovery]';

/** Its own prefix (sec 10) so a flagged price move alarms without a log filter. */
const PRICE_BAND_PREFIX = '[PRICE_BAND]';

/** The repo's existing deprecation prefix, shared with the runtime sunset warnings. */
const SUNSET_PREFIX = '[model-sunset]';

const noopLogger: DiscoveryLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * One discovery run: resolve credentials, fetch every configured source under a
 * bounded budget, merge them into one candidate per model, diff against the rows
 * in force, and persist what changed.
 *
 * Single-flight through a cache lease, bounded by a global deadline with a
 * graceful partial commit, and diff-based so a second run over identical source
 * data writes nothing. In 'report' mode the entire calculation runs and only the
 * run document is written - the diff is reported, never applied.
 */
export async function runModelDiscovery(
  adapters: ModelDiscoveryAdapters,
  options: RunModelDiscoveryOptions
): Promise<ModelDiscoveryRunResult> {
  const logger = adapters.logger ?? noopLogger;
  const now = options.now ?? (() => new Date());
  const { db } = adapters;

  const mode = await readMode(adapters);
  if (!mode.enabled) {
    logger.info(`${LOG_PREFIX} skipped: enableModelDiscovery is off`);
    return skippedResult('disabled', mode.mode, mode.autoEnable);
  }

  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const globalDeadlineMs = Math.max(budgetMs - GLOBAL_DEADLINE_HEADROOM_MS, 1_000);
  // Twice the deadline: a driver killed mid-run must not hold the lease for a
  // window a healthy run could still be inside.
  const leaseTtlMs = 2 * globalDeadlineMs;

  const lease = await db.cache.claimDedup(
    DISCOVERY_LEASE_KEY,
    { claimedAt: now().toISOString(), host: options.host, trigger: options.trigger },
    leaseTtlMs
  );
  if (!lease.claimed) {
    // Not an error: a concurrent driver is already doing this work. Recording it
    // as a failed run would trip the consecutive-failure alarm on healthy dedup.
    logger.info(`${LOG_PREFIX} skipped: lease held by another run`);
    return skippedResult('lease-held', mode.mode, mode.autoEnable);
  }

  const startedAt = now();
  try {
    return await executeRun(adapters, options, { ...mode, startedAt, globalDeadlineMs, logger, now });
  } finally {
    // Release on EVERY terminal outcome. claimDedup has no release path other
    // than expiry, so a missed delete blocks the next genuine run for the TTL.
    await db.cache.deleteByKey(DISCOVERY_LEASE_KEY).catch((error: unknown) => {
      logger.error(`${LOG_PREFIX} failed to release lease: ${describe(error)}`);
    });
  }
}

interface RunContext {
  enabled: boolean;
  mode: DiscoveryMode;
  autoEnable: DiscoveryAutoEnablePolicy;
  autoRemap: DiscoveryAutoRemapPolicy;
  allowEgress: boolean;
  bandPct: number;
  startedAt: Date;
  globalDeadlineMs: number;
  logger: DiscoveryLogger;
  now: () => Date;
}

async function executeRun(
  adapters: ModelDiscoveryAdapters,
  options: RunModelDiscoveryOptions,
  ctx: RunContext
): Promise<ModelDiscoveryRunResult> {
  const { db, sources } = adapters;
  const env = adapters.env ?? process.env;
  const { logger, startedAt } = ctx;

  // The run document is created up front because every appended row carries its
  // id. 'failed' is the pessimistic placeholder: a run that never reaches the
  // final update must not read as ok or partial.
  const run = await db.discoveryRuns.create({
    startedAt,
    trigger: options.trigger,
    host: options.host,
    status: 'failed',
  } as Omit<IModelDiscoveryRunDocument, 'id' | 'createdAt' | 'updatedAt'>);
  const runId = run.id;

  const credentials = await adapters.resolveCredentials();
  const history = await recentRunHistory(adapters, startedAt);
  const minInterval = options.minSourceIntervalMs ?? DEFAULT_MIN_SOURCE_INTERVAL_MS;

  const skippedSources: Array<{ name: string; reason: SourceSkipReason }> = [];
  const attempts: DiscoverySource[] = [];
  for (const source of sources) {
    const reason = skipReasonFor(source, { credentials, env, ctx, history, minInterval, startedAt });
    if (reason) skippedSources.push({ name: source.name, reason });
    else attempts.push(source);
  }

  const globalDeadline = deadlineSignal(ctx.globalDeadlineMs);
  const limit = limitConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
  const results = new Map<string, { report: IDiscoverySourceReport; result: SourceResult }>();
  const fetchAll = (batch: readonly DiscoverySource[]): Promise<unknown> =>
    Promise.all(
      batch.map(source =>
        limit(async () => {
          const outcome = await fetchSource(source, {
            credentials,
            env,
            logger,
            startedAt,
            globalSignal: globalDeadline.signal,
            deadlineMs: options.sourceDeadlineMsByName?.[source.name] ?? DEFAULT_SOURCE_DEADLINE_MS,
            previous: history.validators.get(source.name),
            now: ctx.now,
          });
          results.set(source.name, outcome);
        })
      )
    );
  const succeeded = (): DiscoverySource[] => attempts.filter(source => results.get(source.name)?.result.ok === true);

  const passes: CompletedPass[] = [];
  let parserShifts: ParserRowShift[] = [];
  try {
    await fetchAll(attempts);

    // A parser whose row count moved is reading a restructured page, so this run
    // trusts nothing that source scraped - suggestions included (sec 5.10).
    // Decided once: only providers parse a rendered page and providers are
    // fetched once, so no later pass has a new row count to compare.
    parserShifts = detectParserRowShifts(parserRowsOf(succeeded(), results), history.parserRows);
    logParserShifts(parserShifts, logger);
    const droppedDocsSources = new Set(parserShifts.map(shift => shift.source));

    // The only sources whose answer this run's own writes can change: an
    // aggregator joins against the catalog. One that was skipped or failed in
    // pass 1 stays out - the convergence loop may not become a way around the
    // interval guard or a second chance for a broken feed.
    const rejoining = succeeded().filter(source => source.kind === 'aggregator');

    for (let pass = 1; pass <= MAX_DISCOVERY_PASSES; pass += 1) {
      if (pass > 1) {
        adapters.refreshCatalogView?.();
        await fetchAll(rejoining);
      }

      const plan = await planPass({
        adapters,
        ctx,
        options,
        runId,
        credentials,
        succeeded: succeeded(),
        results,
        droppedDocsSources,
        effectiveAt: new Date(startedAt.getTime() + pass - 1),
        statesBeforeRun: passes[0]?.plan.statesBeforeRun,
      });

      let appended = 0;
      let pricesAppended = 0;
      if (ctx.mode === 'write') {
        appended = await appendRows(plan.lifecycle.rows, adapters, logger);
        pricesAppended = await appendPriceRows(plan.prices.rows, adapters, logger);
        // Per pass rather than once at the end: recordSuggestion is a
        // same-content overwrite, so a queue item a later pass re-raises costs
        // one redundant write instead of a lost one when a pass throws.
        await recordSuggestions(plan.lifecycle.suggestions, adapters, startedAt, logger);
      }
      passes.push({ plan, appended, pricesAppended });
      if (pass > 1) {
        logger.info(
          `${LOG_PREFIX} convergence pass ${pass}: appended=${appended} priced=${pricesAppended} ` +
            `after refetching ${rejoining.length} aggregator(s)`
        );
      }

      if (ctx.mode !== 'write' || appended + pricesAppended === 0 || globalDeadline.signal.aborted) break;
      if (pass === MAX_DISCOVERY_PASSES) {
        logger.warn(
          `${LOG_PREFIX} convergence capped at ${MAX_DISCOVERY_PASSES} passes while pass ${pass} was still ` +
            `appending (${appended} rows, ${pricesAppended} prices); the remainder settles on the next run`
        );
      }
    }

    // Once per run, after the last pass. Sightings are provider-only and
    // providers are fetched once, so no later pass has anything different to
    // record, and deferring the apply keeps the counters the graduation plan
    // read (statesBeforeRun) valid for every pass.
    if (ctx.mode === 'write') await applyAbsence(passes[0].plan.absence, db.discoveryState, startedAt);
  } finally {
    globalDeadline.cancel();
  }

  const deadlineHit = globalDeadline.signal.aborted;
  const succeededCount = succeeded().length;
  const status = runStatus(attempts.length, succeededCount, deadlineHit, skippedSources.length > 0);
  const merged = aggregate(passes);
  const summary = summarizeDiff(merged.diff);
  const added = [...new Set(summary.added)];
  const promoted = [...new Set(summary.promoted)];
  const deprecated = merged.transitions.map(transition => transition.modelId);
  const sourceReports = [...results.values()].map(entry => entry.report);
  const finishedAt = ctx.now();

  logPriceFlags(merged.priceFlags, logger);
  logLifecycle(merged, logger);

  await db.discoveryRuns.update({
    id: runId,
    status,
    finishedAt,
    sources: sourceReports,
    joinCoverage: merged.joinCoverage,
    unmatchedIds: merged.unmatchedIds,
    changes: {
      added,
      promoted,
      deprecated,
      // The plan, not the writes, in both modes - same as `added`.
      repriced: [...new Set(merged.priceRows.map(row => row.modelId))],
      // Operator overlaps and price flags are one queue: both are "a human has
      // to look at this model", which is what report mode exists to surface.
      flagged: [...new Set([...summary.operatorConflicts, ...merged.priceFlags.map(flag => flag.modelId)])],
    },
  } as Partial<IModelDiscoveryRunDocument>);

  logger.info(
    `${LOG_PREFIX} run ${runId} ${status} mode=${ctx.mode} sources=${succeededCount}/${attempts.length} ` +
      `passes=${passes.length} changes=${merged.diff.length} appended=${merged.appended} ` +
      `dropped=${merged.droppedRecords.length} prices=${merged.priceRows.length} priced=${merged.pricesAppended} ` +
      `flagged=${merged.priceFlags.length} deprecated=${deprecated.length} suggested=${merged.suggestions.length}`
  );

  return {
    outcome: status,
    runId,
    mode: ctx.mode,
    autoEnable: ctx.autoEnable,
    sources: sourceReports,
    skippedSources,
    diff: merged.diff,
    droppedRecords: merged.droppedRecords,
    absence: passes[0].plan.absence,
    prices: { rows: describePriceRows(merged.priceRows), flags: merged.priceFlags },
    lifecycle: {
      transitions: merged.transitions,
      dateChanges: merged.dateChanges,
      suggestions: merged.suggestions,
      wouldDeprecate: merged.wouldDeprecate,
    },
    metrics: {
      ModelsDiscovered: added.length,
      ModelsPromoted: promoted.length,
      ModelsBlockedByDispatch: [...new Set(summary.blockedByDispatch)].length,
      ModelsDeprecated: deprecated.length,
      PriceRowsAppended: merged.pricesAppended,
      PriceFlagged: merged.priceFlags.length,
      CatalogRowsRejected: merged.rejected,
      DocsParserRowShift: parserShifts.length,
      AggregatorJoinCoverage: Object.fromEntries(
        merged.joinCoverage.map(entry => [entry.aggregator, entry.total === 0 ? 1 : entry.matched / entry.total])
      ),
      SourceFailures: Object.fromEntries(
        [...results.values()].map(entry => [entry.report.name, entry.report.ok ? 0 : 1])
      ),
      RunDuration: finishedAt.getTime() - startedAt.getTime(),
    },
    passes: passes.length,
  };
}

interface PassInput {
  adapters: ModelDiscoveryAdapters;
  ctx: RunContext;
  options: RunModelDiscoveryOptions;
  runId: string;
  credentials: DiscoveryCredentials;
  /** The sources whose fetch succeeded, in registration order. */
  succeeded: readonly DiscoverySource[];
  results: ReadonlyMap<string, { report: IDiscoverySourceReport; result: SourceResult }>;
  /** Sources whose docs-derived signals this run drops, decided from pass 1. */
  droppedDocsSources: ReadonlySet<string>;
  /**
   * When this pass's rows take effect: the run's startedAt plus one millisecond
   * per pass. Both collections hold (modelId[, unit], effectiveFrom) unique and
   * the read path keeps the newest row per (modelId, source), so a second row
   * for the same model at the same instant would be refused by the index - and
   * invisible to the merge even if it were not.
   */
  effectiveAt: Date;
  /** Pass 1's read; see LifecyclePlanInput.statesBeforeRun for why it is read once. */
  statesBeforeRun?: ReadonlyMap<string, IModelDiscoveryState>;
}

interface PassPlan {
  catalog: CatalogWritePlan;
  prices: PricePlan;
  lifecycle: LifecyclePlan;
  absence: AbsencePlan;
  statesBeforeRun: ReadonlyMap<string, IModelDiscoveryState>;
  joinCoverage: IDiscoveryJoinCoverage[];
  unmatchedIds: string[];
  rejected: number;
  /** Whether an aggregator contributed: the join coverage of a pass without one says nothing. */
  ranAggregators: boolean;
}

interface CompletedPass {
  plan: PassPlan;
  appended: number;
  pricesAppended: number;
}

/**
 * One pass: merge the sources that succeeded, diff them against the rows in
 * force AS OF this pass, and return everything the run would write.
 *
 * Reads the database and writes nothing, so report mode is this same
 * calculation with the caller declining to persist it - and so a second pass
 * over what the first one wrote proposes only what is genuinely still missing.
 */
async function planPass(input: PassInput): Promise<PassPlan> {
  const { adapters, ctx, options, runId, credentials, results, succeeded, effectiveAt } = input;
  const { db } = adapters;

  const contributions = succeeded.map(source => ({
    name: source.name,
    kind: source.kind,
    records: (results.get(source.name)?.result as DiscoverySourceOk).records ?? [],
  }));
  const signals = planLifecycleSignals({ contributions, droppedDocsSources: input.droppedDocsSources });

  const { rows: inForce, rejected } = await db.catalog.rowsInForceWithRejects(effectiveAt);
  const base = resolveCatalogRecords(inForce.filter(row => row.source !== 'operator'));
  // The catalog as the runtime sees it. The catalog plan diffs against `base` so
  // it can never propose over an operator row, but the lifecycle constraints
  // have to read what an operator decided (sec 8 auto-remap).
  const resolvedInForce = resolveCatalogRecords(inForce);
  const operatorOwnedModelIds = new Set(inForce.filter(row => row.source === 'operator').map(row => row.modelId));
  const priorDiscoveryGroups = discoveryGroupsInForce(inForce);

  const priceRowsInForce = await db.prices.rowsInForce(effectiveAt);
  // A price the catalog already holds satisfies the promotion predicate, so a
  // model priced by an earlier run (or by an operator) is not re-blocked as
  // unpriced on a run where no source happened to quote it.
  const knownPricedModelIds = new Set([
    ...priceRowsInForce.filter(row => row.unit === 'per_token').map(row => row.modelId),
    ...(options.knownPricedModelIds ?? []),
  ]);

  const catalog = planCatalogWrites({
    contributions: signals.contributions,
    resolveDispatch: adapters.resolveDispatch,
    base,
    operatorOwnedModelIds,
    credentials,
    policy: ctx.autoEnable,
    knownPricedModelIds,
    runStartedAt: effectiveAt,
    runId,
  });

  const prices = planPriceWrites({
    contributions,
    rowsInForce: priceRowsInForce,
    // The models this run adds are known too: a new model's first price row
    // lands in the same run as the catalog row that makes it a model at all.
    knownModelIds: new Set([...base.keys(), ...operatorOwnedModelIds, ...catalog.rows.map(row => row.modelId)]),
    bandPct: ctx.bandPct,
    runStartedAt: effectiveAt,
  });

  const coveredBackends = new Set<string>();
  for (const source of succeeded) {
    const ok = results.get(source.name)?.result as DiscoverySourceOk;
    for (const backend of ok.authoritativeFor ?? []) coveredBackends.add(backend);
  }
  const absence = planAbsence({ coveredBackends, sightedModelIds: catalog.sightedModelIds, base });

  // Read BEFORE applyAbsence: planLifecycle adds this run's miss itself, so the
  // counters it reads must not already include it (the ordering invariant).
  const statesBeforeRun =
    input.statesBeforeRun ??
    new Map((await db.discoveryState.findByModelIds(absence.missed)).map(state => [state.modelId, state] as const));

  const lifecycle = planLifecycle({
    catalogPlan: catalog,
    base,
    resolvedInForce,
    docs: signals.docs,
    missed: absence.missed,
    statesBeforeRun,
    ratesInForce: perTokenRatesInForce(priceRowsInForce),
    priorDiscoveryGroups,
    autoRemap: ctx.autoRemap,
    operatorOwnedModelIds,
    runStartedAt: effectiveAt,
    runId,
  });

  return {
    catalog,
    prices,
    lifecycle,
    absence,
    statesBeforeRun,
    joinCoverage: computeJoinCoverage(contributions, base),
    unmatchedIds: unmatchedIds(contributions, base),
    rejected,
    ranAggregators: contributions.some(contribution => contribution.kind === 'aggregator'),
  };
}

interface RunAggregate {
  diff: CatalogDiffEntry[];
  droppedRecords: DroppedSourceRecord[];
  priceRows: IModelPriceInput[];
  priceFlags: PriceFlag[];
  transitions: LifecycleTransition[];
  dateChanges: LifecycleDateChange[];
  suggestions: LifecycleSuggestion[];
  wouldDeprecate: string[];
  joinCoverage: IDiscoveryJoinCoverage[];
  unmatchedIds: string[];
  rejected: number;
  appended: number;
  pricesAppended: number;
}

/**
 * Every pass as one report. The write plans concatenate - each pass proposes
 * only what the pass before it did not already write - while the queues a pass
 * did NOT settle (flags, refusals, suggestions) are re-raised verbatim by every
 * pass and collapse to one item each, newest kept.
 */
function aggregate(passes: readonly CompletedPass[]): RunAggregate {
  const plans = passes.map(pass => pass.plan);
  const last = plans[plans.length - 1];
  // The settled universe: a join measured before this run's own writes would
  // report coverage against a catalog that no longer exists.
  const joined = [...plans].reverse().find(plan => plan.ranAggregators) ?? last;

  return {
    diff: plans.flatMap(plan => plan.lifecycle.diff),
    droppedRecords: lastPerKey(
      plans.flatMap(plan => [...plan.catalog.dropped, ...plan.lifecycle.dropped]),
      dropped => `${dropped.source} ${dropped.modelId} ${dropped.reason}`
    ),
    priceRows: plans.flatMap(plan => plan.prices.rows),
    priceFlags: lastPerKey(
      plans.flatMap(plan => plan.prices.flags),
      flag => `${flag.modelId} ${flag.kind}`
    ),
    transitions: plans.flatMap(plan => plan.lifecycle.transitions),
    dateChanges: plans.flatMap(plan => plan.lifecycle.dateChanges),
    suggestions: lastPerKey(
      plans.flatMap(plan => plan.lifecycle.suggestions),
      suggestion => `${suggestion.modelId} ${suggestion.source}`
    ),
    wouldDeprecate: plans.flatMap(plan => plan.lifecycle.wouldDeprecate),
    joinCoverage: joined.joinCoverage,
    unmatchedIds: joined.unmatchedIds,
    // The settled read too: a row this run appended is one the count covers.
    rejected: last.rejected,
    appended: passes.reduce((total, pass) => total + pass.appended, 0),
    pricesAppended: passes.reduce((total, pass) => total + pass.pricesAppended, 0),
  };
}

/** One entry per key, the last writer's, in first-seen order. */
function lastPerKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);
  return [...byKey.values()];
}

async function appendRows(
  rows: readonly IModelCatalogRowInput[],
  adapters: ModelDiscoveryAdapters,
  logger: DiscoveryLogger
): Promise<number> {
  let appended = 0;
  for (const row of rows) {
    try {
      // A null return is the unique-index race: another driver already wrote this
      // model for this run window, which is a skip rather than a failure.
      if (await adapters.db.catalog.append(row)) appended += 1;
    } catch (error) {
      logger.error(`${LOG_PREFIX} append failed for ${row.modelId}: ${describe(error)}`);
    }
  }
  return appended;
}

async function appendPriceRows(
  rows: readonly IModelPriceInput[],
  adapters: ModelDiscoveryAdapters,
  logger: DiscoveryLogger
): Promise<number> {
  let appended = 0;
  for (const row of rows) {
    try {
      if (await adapters.db.prices.append(row)) appended += 1;
    } catch (error) {
      // Unlike the catalog, ModelPrice surfaces its unique index as a thrown
      // E11000: another driver already priced this model for this run window,
      // which is a skip. Everything else is a real failure worth a log line.
      if (isDuplicateKey(error)) continue;
      logger.error(`${LOG_PREFIX} price append failed for ${row.modelId}: ${describe(error)}`);
    }
  }
  return appended;
}

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 11000 || describe(error).includes('E11000');

function logPriceFlags(flags: readonly PriceFlag[], logger: DiscoveryLogger): void {
  for (const flag of flags) {
    const prefix = flag.kind === 'band-exceeded' ? PRICE_BAND_PREFIX : LOG_PREFIX;
    logger.warn(`${prefix} ${flag.modelId} ${flag.kind}: ${flag.detail}`);
  }
}

/**
 * Persist the queue items. Best-effort per model: a suggestion is advisory, and
 * losing one must not fail a run that already committed its catalog rows.
 */
async function recordSuggestions(
  suggestions: readonly LifecycleSuggestion[],
  adapters: ModelDiscoveryAdapters,
  at: Date,
  logger: DiscoveryLogger
): Promise<void> {
  for (const suggestion of suggestions) {
    try {
      await adapters.db.discoveryState.recordSuggestion(
        suggestion.modelId,
        {
          status: suggestion.status,
          deprecationDate: suggestion.deprecationDate,
          retirementDate: suggestion.retirementDate,
          replacedBy: suggestion.replacedBy,
          source: suggestion.source,
        },
        at
      );
    } catch (error) {
      logger.error(`${LOG_PREFIX} suggestion for ${suggestion.modelId} failed: ${describe(error)}`);
    }
  }
}

function logLifecycle(
  lifecycle: Pick<LifecyclePlan, 'transitions' | 'dateChanges' | 'suggestions'>,
  logger: DiscoveryLogger
): void {
  const { transitions, dateChanges, suggestions } = lifecycle;
  for (const transition of transitions) {
    const dates = [
      transition.deprecationDate && `deprecated ${transition.deprecationDate}`,
      transition.retirementDate && `retired ${transition.retirementDate}`,
      transition.replacedBy && `replacedBy ${transition.replacedBy}`,
    ].filter(Boolean);
    logger.warn(
      `${SUNSET_PREFIX} ${transition.modelId} ${transition.from ?? 'unknown'} -> ${transition.to} ` +
        `via ${transition.signal} signal${dates.length > 0 ? ` (${dates.join(', ')})` : ''}`
    );
  }
  // Same prefix as a transition: a future deprecationDate hides the model on the
  // day it passes, so it is a sunset an operator has to see coming.
  for (const change of dateChanges) {
    logger.warn(
      `${SUNSET_PREFIX} ${change.modelId} stays ${change.status} but its dates moved via ${change.signal} signal: ` +
        `deprecation ${change.previousDeprecationDate ?? 'none'} -> ${change.deprecationDate ?? 'none'}, ` +
        `retirement ${change.previousRetirementDate ?? 'none'} -> ${change.retirementDate ?? 'none'}`
    );
  }
  for (const suggestion of suggestions) {
    logger.info(`${LOG_PREFIX} ${suggestion.modelId} suggestion from ${suggestion.source}: ${suggestion.detail}`);
  }
}

function logParserShifts(shifts: readonly ParserRowShift[], logger: DiscoveryLogger): void {
  for (const shift of shifts) {
    logger.warn(
      `${LOG_PREFIX} ${shift.source} parser "${shift.parser}" returned ${shift.current} rows against ` +
        `${shift.previous} last run; dropping that source's docs-derived signals this run`
    );
  }
}

/**
 * The groups the discovery row in force claims, per model. rowsInForce is
 * newest-first and holds one non-operator row per (modelId, source), so the
 * first discovery row seen for a model is the one an appended row supersedes.
 */
function discoveryGroupsInForce(rows: readonly IModelCatalogRow[]): Map<string, FieldGroup[]> {
  const groups = new Map<string, FieldGroup[]>();
  for (const row of rows) {
    if (row.source !== 'discovery' || groups.has(row.modelId)) continue;
    groups.set(row.modelId, row.ownedGroups.filter(isFieldGroup));
  }
  return groups;
}

/** This run's parser row counts per source, for the run-over-run comparison. */
function parserRowsOf(
  succeeded: readonly DiscoverySource[],
  results: ReadonlyMap<string, { result: SourceResult }>
): Map<string, Record<string, number>> {
  const counts = new Map<string, Record<string, number>>();
  for (const source of succeeded) {
    const parserRows = (results.get(source.name)?.result as DiscoverySourceOk).parserRows;
    if (parserRows) counts.set(source.name, parserRows);
  }
  return counts;
}

interface FetchArgs {
  credentials: DiscoveryCredentials;
  env: DiscoveryFetchContext['env'];
  logger: DiscoveryLogger;
  startedAt: Date;
  globalSignal: AbortSignal;
  deadlineMs: number;
  previous?: { etag?: string; contentHash?: string };
  now: () => Date;
}

async function fetchSource(
  source: DiscoverySource,
  args: FetchArgs
): Promise<{ report: IDiscoverySourceReport; result: SourceResult }> {
  const begunAt = args.now().getTime();
  const first = await attempt(source, args, args.deadlineMs);
  const result =
    first.ok || args.globalSignal.aborted
      ? first
      : await attempt(source, args, Math.min(RETRY_DEADLINE_MS, args.deadlineMs));

  const report: IDiscoverySourceReport = {
    name: source.name,
    ok: result.ok,
    durationMs: Math.max(args.now().getTime() - begunAt, 0),
    ...(result.ok
      ? {
          httpStatus: result.httpStatus,
          etag: result.etag,
          contentHash: result.contentHash,
          parserRows: result.parserRows,
        }
      : { httpStatus: result.httpStatus, error: result.error ?? 'source reported failure' }),
  };
  if (!result.ok) args.logger.warn(`${LOG_PREFIX} source ${source.name} failed: ${report.error}`);
  return { report, result };
}

async function attempt(source: DiscoverySource, args: FetchArgs, deadlineMs: number): Promise<SourceResult> {
  const deadline = deadlineSignal(deadlineMs);
  const signal = AbortSignal.any([args.globalSignal, deadline.signal]);
  const ctx: DiscoveryFetchContext = {
    credentials: args.credentials,
    env: args.env,
    signal,
    deadlineAt: new Date(args.now().getTime() + deadlineMs),
    logger: args.logger,
    runStartedAt: args.startedAt,
    previous: args.previous,
  };
  try {
    // Raced against the signal: aborting is a request, and a source that ignores
    // it would otherwise hold the whole run open past the global deadline.
    return await Promise.race([source.fetch(ctx), abortRejection(signal)]);
  } catch (error) {
    return { ok: false, error: describe(error) };
  } finally {
    deadline.cancel();
  }
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) return reject(new Error('deadline exceeded'));
    signal.addEventListener('abort', () => reject(new Error('deadline exceeded')), { once: true });
  });
}

function deadlineSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Never keep a lambda or a test worker alive waiting for a deadline that no
  // longer has anything to cancel.
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

interface SkipArgs {
  credentials: DiscoveryCredentials;
  env: DiscoveryFetchContext['env'];
  ctx: RunContext;
  history: RunHistory;
  minInterval: number;
  startedAt: Date;
}

function skipReasonFor(source: DiscoverySource, args: SkipArgs): SourceSkipReason | null {
  // Egress gates EVERY network source, provider APIs included: an operator who
  // forbids egress means it.
  if (!args.ctx.allowEgress) return 'egress-disabled';
  if (!source.isConfigured(args.credentials, args.env)) return 'not-configured';
  const lastOk = args.history.lastOkAt.get(source.name);
  if (lastOk && args.startedAt.getTime() - lastOk.getTime() < args.minInterval) return 'recently-fetched';
  return null;
}

interface RunHistory {
  /** Newest successful fetch per source, across every host. */
  lastOkAt: Map<string, Date>;
  /** Newest cached validators per source, for conditional GETs. */
  validators: Map<string, { etag?: string; contentHash?: string }>;
  /** Newest parser row counts per source, for the docs-parser shift guard. */
  parserRows: Map<string, Record<string, number>>;
}

async function recentRunHistory(adapters: ModelDiscoveryAdapters, startedAt: Date): Promise<RunHistory> {
  const since = new Date(startedAt.getTime() - RUN_LOOKBACK_MS);
  const runs = (await adapters.db.discoveryRuns.find({ startedAt: { $gte: since } })) as IModelDiscoveryRun[];
  const ordered = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const lastOkAt = new Map<string, Date>();
  const validators = new Map<string, { etag?: string; contentHash?: string }>();
  const parserRows = new Map<string, Record<string, number>>();
  for (const run of ordered) {
    for (const report of run.sources ?? []) {
      if (!report.ok || lastOkAt.has(report.name)) continue;
      lastOkAt.set(report.name, run.startedAt);
      if (report.etag || report.contentHash) {
        validators.set(report.name, { etag: report.etag, contentHash: report.contentHash });
      }
      if (report.parserRows) parserRows.set(report.name, report.parserRows);
    }
  }
  return { lastOkAt, validators, parserRows };
}

/**
 * 'ok' only when everything attempted succeeded and nothing was cut short. A run
 * that verified nothing is 'partial', never 'ok': lastSuccessfulRun is derived
 * from this field, and an egress-disabled or keyless deployment must keep
 * reporting the fallback-seed banner rather than claiming live data.
 */
function runStatus(
  attempted: number,
  succeeded: number,
  deadlineHit: boolean,
  anySkipped: boolean
): 'ok' | 'partial' | 'failed' {
  if (attempted === 0) return 'partial';
  if (succeeded === 0) return 'failed';
  if (succeeded < attempted || deadlineHit || anySkipped) return 'partial';
  return 'ok';
}

function computeJoinCoverage(
  contributions: ReadonlyArray<{ name: string; kind: string; records: Array<{ modelId: string }> }>,
  base: ReadonlyMap<string, ResolvedCatalogRecord>
): IDiscoveryJoinCoverage[] {
  return contributions
    .filter(contribution => contribution.kind === 'aggregator')
    .map(contribution => ({
      aggregator: contribution.name,
      matched: contribution.records.filter(record => base.has(record.modelId)).length,
      total: base.size,
    }));
}

/** Ids in force no aggregator matched: a work item, not a log line (sec 5.6). */
function unmatchedIds(
  contributions: ReadonlyArray<{ kind: string; records: Array<{ modelId: string }> }>,
  base: ReadonlyMap<string, ResolvedCatalogRecord>
): string[] {
  const aggregated = contributions.filter(contribution => contribution.kind === 'aggregator');
  if (aggregated.length === 0) return [];
  const matched = new Set(aggregated.flatMap(contribution => contribution.records.map(record => record.modelId)));
  return [...base.keys()].filter(modelId => !matched.has(modelId)).sort();
}

async function readMode(adapters: ModelDiscoveryAdapters): Promise<{
  enabled: boolean;
  mode: DiscoveryMode;
  autoEnable: DiscoveryAutoEnablePolicy;
  autoRemap: DiscoveryAutoRemapPolicy;
  allowEgress: boolean;
  bandPct: number;
}> {
  const settings = adapters.db.adminSettings;
  const [enabled, mode, autoEnable, autoRemap, allowEgress, bandPct] = await Promise.all([
    settings.getSettingsValue('enableModelDiscovery'),
    settings.getSettingsValue('modelDiscoveryMode'),
    settings.getSettingsValue('modelDiscoveryAutoEnable'),
    settings.getSettingsValue('modelDiscoveryAutoRemap'),
    settings.getSettingsValue('modelDiscoveryAllowEgress'),
    settings.getSettingsValue('modelDiscoveryPriceBandPct'),
  ]);
  return {
    enabled: enabled !== false,
    // Unrecognized values fail safe to the read-only mode.
    mode: mode === 'write' ? 'write' : 'report',
    autoEnable: autoEnable === 'manual' || autoEnable === 'all' ? autoEnable : 'priced',
    autoRemap: autoRemap === 'apply' ? 'apply' : 'suggest',
    allowEgress: allowEgress !== false,
    // A band of 0 is legitimate ("flag every move"), so only an unusable value
    // falls back; NaN or a negative one would let every move through.
    bandPct: typeof bandPct === 'number' && Number.isFinite(bandPct) && bandPct >= 0 ? bandPct : DEFAULT_PRICE_BAND_PCT,
  };
}

function skippedResult(
  reason: 'disabled' | 'lease-held',
  mode: DiscoveryMode,
  autoEnable: DiscoveryAutoEnablePolicy
): ModelDiscoveryRunResult {
  return {
    outcome: 'skipped',
    skipReason: reason,
    mode,
    autoEnable,
    sources: [],
    skippedSources: [],
    diff: [],
    droppedRecords: [],
    absence: { sighted: [], missed: [], frozenBackends: [] },
    prices: { rows: [], flags: [] },
    lifecycle: { transitions: [], dateChanges: [], suggestions: [], wouldDeprecate: [] },
    metrics: emptyMetrics(),
    passes: 1,
  };
}

function emptyMetrics(): ModelDiscoveryMetrics {
  return {
    ModelsDiscovered: 0,
    ModelsPromoted: 0,
    ModelsBlockedByDispatch: 0,
    ModelsDeprecated: 0,
    PriceRowsAppended: 0,
    PriceFlagged: 0,
    CatalogRowsRejected: 0,
    DocsParserRowShift: 0,
    AggregatorJoinCoverage: {},
    SourceFailures: {},
    RunDuration: 0,
  };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
