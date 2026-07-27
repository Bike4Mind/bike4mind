import type {
  IDiscoveryJoinCoverage,
  IDiscoverySourceReport,
  IModelDiscoveryRun,
  IModelDiscoveryRunDocument,
  IModelCatalogRowInput,
} from '@bike4mind/common';
import { resolveCatalogRecords, type ResolvedCatalogRecord } from '@bike4mind/llm-adapters';
import pLimit from 'p-limit';
import { applyAbsence, planAbsence } from './absence';
import { planCatalogWrites, summarizeDiff } from './catalogWrite';
import type {
  DiscoveryAutoEnablePolicy,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoveryLogger,
  DiscoveryMode,
  DiscoverySource,
  DiscoverySourceOk,
  ModelDiscoveryAdapters,
  ModelDiscoveryMetrics,
  ModelDiscoveryRunResult,
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
 * The retry attempt's own deadline. One retry per source, and it may not cost a
 * second full source deadline: a source is not worth a second run's worth of
 * latency, so the retry only catches the fast-failure class.
 */
export const RETRY_DEADLINE_MS = 2_000;

/** Two stages on the same 6h boundary otherwise hit every provider simultaneously. */
export const DEFAULT_MIN_SOURCE_INTERVAL_MS = 60 * 60_000;

/** How far back run reports are read for the interval guard and cached validators. */
const RUN_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

const LOG_PREFIX = '[model-discovery]';

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
  allowEgress: boolean;
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
  const results = new Map<string, { report: IDiscoverySourceReport; result: SourceResult }>();
  try {
    const limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
    await Promise.all(
      attempts.map(source =>
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
  } finally {
    globalDeadline.cancel();
  }

  const deadlineHit = globalDeadline.signal.aborted;
  const succeeded = attempts.filter(source => results.get(source.name)?.result.ok === true);

  const contributions = succeeded.map(source => ({
    name: source.name,
    kind: source.kind,
    records: (results.get(source.name)?.result as DiscoverySourceOk).records ?? [],
  }));

  const { rows: inForce, rejected } = await db.catalog.rowsInForceWithRejects(startedAt);
  const base = resolveCatalogRecords(inForce.filter(row => row.source !== 'operator'));
  const operatorOwnedModelIds = new Set(inForce.filter(row => row.source === 'operator').map(row => row.modelId));

  const plan = planCatalogWrites({
    contributions,
    resolveDispatch: adapters.resolveDispatch,
    base,
    operatorOwnedModelIds,
    credentials,
    policy: ctx.autoEnable,
    knownPricedModelIds: options.knownPricedModelIds,
    runStartedAt: startedAt,
    runId,
  });

  const coveredBackends = new Set<string>();
  for (const source of succeeded) {
    const ok = results.get(source.name)?.result as DiscoverySourceOk;
    for (const backend of ok.authoritativeFor ?? []) coveredBackends.add(backend);
  }
  const absence = planAbsence({ coveredBackends, sightedModelIds: plan.sightedModelIds, base });

  let appended = 0;
  if (ctx.mode === 'write') {
    appended = await appendRows(plan.rows, adapters, logger);
    await applyAbsence(absence, db.discoveryState, startedAt);
  }

  const status = runStatus(attempts.length, succeeded.length, deadlineHit, skippedSources.length > 0);
  const summary = summarizeDiff(plan.diff);
  const joinCoverage = computeJoinCoverage(contributions, base);
  const sourceReports = [...results.values()].map(entry => entry.report);
  const finishedAt = ctx.now();

  await db.discoveryRuns.update({
    id: runId,
    status,
    finishedAt,
    sources: sourceReports,
    joinCoverage,
    unmatchedIds: unmatchedIds(contributions, base),
    changes: {
      added: summary.added,
      promoted: summary.promoted,
      // Phase 2 has no lifecycle transitions and writes no prices; `flagged`
      // carries the operator-overlap work items report mode exists to surface.
      flagged: summary.operatorConflicts,
    },
  } as Partial<IModelDiscoveryRunDocument>);

  logger.info(
    `${LOG_PREFIX} run ${runId} ${status} mode=${ctx.mode} sources=${succeeded.length}/${attempts.length} ` +
      `changes=${plan.diff.length} appended=${appended} dropped=${plan.dropped.length}`
  );

  return {
    outcome: status,
    runId,
    mode: ctx.mode,
    autoEnable: ctx.autoEnable,
    sources: sourceReports,
    skippedSources,
    diff: plan.diff,
    droppedRecords: plan.dropped,
    absence,
    metrics: {
      ModelsDiscovered: summary.added.length,
      ModelsPromoted: summary.promoted.length,
      ModelsBlockedByDispatch: summary.blockedByDispatch.length,
      // Lifecycle transitions are Phase 4; Phase 2 only keeps the counters.
      ModelsDeprecated: 0,
      PriceRowsAppended: 0,
      PriceFlagged: 0,
      CatalogRowsRejected: rejected,
      AggregatorJoinCoverage: Object.fromEntries(
        joinCoverage.map(entry => [entry.aggregator, entry.total === 0 ? 1 : entry.matched / entry.total])
      ),
      SourceFailures: Object.fromEntries(
        [...results.values()].map(entry => [entry.report.name, entry.report.ok ? 0 : 1])
      ),
      RunDuration: finishedAt.getTime() - startedAt.getTime(),
    },
  };
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
      ? { httpStatus: result.httpStatus, etag: result.etag, contentHash: result.contentHash }
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
}

async function recentRunHistory(adapters: ModelDiscoveryAdapters, startedAt: Date): Promise<RunHistory> {
  const since = new Date(startedAt.getTime() - RUN_LOOKBACK_MS);
  const runs = (await adapters.db.discoveryRuns.find({ startedAt: { $gte: since } })) as IModelDiscoveryRun[];
  const ordered = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const lastOkAt = new Map<string, Date>();
  const validators = new Map<string, { etag?: string; contentHash?: string }>();
  for (const run of ordered) {
    for (const report of run.sources ?? []) {
      if (!report.ok || lastOkAt.has(report.name)) continue;
      lastOkAt.set(report.name, run.startedAt);
      if (report.etag || report.contentHash) {
        validators.set(report.name, { etag: report.etag, contentHash: report.contentHash });
      }
    }
  }
  return { lastOkAt, validators };
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

async function readMode(
  adapters: ModelDiscoveryAdapters
): Promise<{ enabled: boolean; mode: DiscoveryMode; autoEnable: DiscoveryAutoEnablePolicy; allowEgress: boolean }> {
  const settings = adapters.db.adminSettings;
  const [enabled, mode, autoEnable, allowEgress] = await Promise.all([
    settings.getSettingsValue('enableModelDiscovery'),
    settings.getSettingsValue('modelDiscoveryMode'),
    settings.getSettingsValue('modelDiscoveryAutoEnable'),
    settings.getSettingsValue('modelDiscoveryAllowEgress'),
  ]);
  return {
    enabled: enabled !== false,
    // Unrecognized values fail safe to the read-only mode.
    mode: mode === 'write' ? 'write' : 'report',
    autoEnable: autoEnable === 'manual' || autoEnable === 'all' ? autoEnable : 'priced',
    allowEgress: allowEgress !== false,
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
    metrics: emptyMetrics(),
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
    AggregatorJoinCoverage: {},
    SourceFailures: {},
    RunDuration: 0,
  };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
