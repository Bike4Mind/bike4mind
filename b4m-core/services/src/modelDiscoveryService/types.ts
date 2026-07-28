import type {
  DiscoveryRunHost,
  DiscoveryRunStatus,
  DiscoveryRunTrigger,
  IAdminSettingsRepository,
  ICacheRepository,
  IDiscoverySourceReport,
  IModelCatalogRepository,
  IModelDiscoveryRunRepository,
  IModelDiscoveryStateRepository,
  IModelPriceRepository,
  ModelBackend,
  ModelPriceUnit,
  ModelRecord,
} from '@bike4mind/common';

/**
 * Environment a source may read, as a plain map rather than NodeJS.ProcessEnv so a
 * driver can hand sources a frozen snapshot and tests never mutate globals.
 */
export type DiscoveryEnv = Readonly<Record<string, string | undefined>>;

/** The three levels the runner emits; Logger satisfies it structurally. */
export interface DiscoveryLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Deployment-level credentials for discovery. Discovery has no user: every value
 * here comes from AdminSettings or the environment (sec 5.7), never from a
 * per-user ApiKey row, and the `'expired'` sentinel is normalized to null before
 * it lands in this shape.
 */
export interface DiscoveryCredentials {
  openai: string | null;
  anthropic: string | null;
  gemini: string | null;
  bfl: string | null;
  xai: string | null;
  voyageai: string | null;
  /** Base URL, not a key. */
  ollama: string | null;
  /** Base URL of a local image server, not a key. */
  imageGen: string | null;
  /** Its own admin setting: ElevenLabs is not part of getEffectiveLLMApiKeys. */
  elevenlabs: string | null;
  /**
   * Bedrock and the AWS backend are credential-free (IAM role). False under
   * B4M_SELF_HOST: a self-host install's AWS_ACCESS_KEY_ID is its local MinIO
   * credential, so listing those models offers choices that can only fail.
   */
  awsIam: boolean;
  isSelfHost: boolean;
}

/** Provider APIs are authoritative for availability; aggregators only fill in. */
export type DiscoverySourceKind = 'provider' | 'aggregator';

/**
 * A price a source observed, in the one unit the promotion predicate compares
 * and the price planner reasons in. ModelPrice tier rates are USD per SINGLE
 * token, so pricePlan divides by 1e6 at the write boundary - crossing the two
 * is a 1e6 billing error.
 */
export interface DiscoveredPrice {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cached-read input tokens, when the source publishes it. */
  cacheReadPerMTok?: number;
  /** USD per 1M cache-write input tokens, when the source publishes it. */
  cacheWritePerMTok?: number;
}

/**
 * How strong the evidence behind a `lifecycle` claim is (sec 5.10). 'typed' is a
 * field a feed publishes as data; 'docs' is a value scraped out of a rendered
 * page. Only 'typed' may hide a model on its own.
 */
export type LifecycleEvidence = 'typed' | 'docs';

/**
 * Sparse ModelRecord fragment as a source reports it. Keys this build does not
 * know are dropped by the merge. `lifecycle` is the one block a source may send
 * WITHOUT a status: a date is an announcement (litellm publishes
 * deprecation_date months ahead of the state change), and only the catalog knows
 * what the model is today. planCatalogWrites merges such dates onto the status in
 * force and refuses the block when there is no status to attach them to.
 */
export type DiscoveredPatch = Omit<Partial<ModelRecord>, 'lifecycle'> & {
  lifecycle?: Partial<NonNullable<ModelRecord['lifecycle']>>;
};

/** One model as a source saw it: our id plus the fields that source has authority for. */
export interface DiscoveredModel {
  /** Our canonical model id. Resolving an aggregator key to it is the source's job. */
  modelId: string;
  patch: DiscoveredPatch;
  pricing?: DiscoveredPrice;
  /**
   * Only meaningful when `patch.lifecycle` is set. Unmarked reads as 'docs': the
   * write policy treats unmarked evidence as weak evidence, so a source that
   * forgets to declare a typed feed loses a transition rather than hiding a
   * model on a parse artifact.
   */
  lifecycleEvidence?: LifecycleEvidence;
}

/**
 * One successful source's records, as both planners consume them. Order carries
 * meaning: the planners sort providers ahead of aggregators and keep
 * registration order within a kind, which is how models.dev stays ahead of
 * litellm without either planner naming a source.
 */
export interface SourceContribution {
  name: string;
  kind: DiscoverySourceKind;
  records: DiscoveredModel[];
}

export interface DiscoverySourceOk {
  ok: true;
  records: DiscoveredModel[];
  /**
   * Backends whose listing this response is EXHAUSTIVE for. Absence bookkeeping
   * runs only over these, so a model under a backend nobody listed successfully
   * is frozen rather than counted as missing (sec 5.10). Aggregators must never
   * set it: an aggregator alone can neither add nor retire a model.
   */
  authoritativeFor?: readonly ModelBackend[];
  httpStatus?: number;
  /** Recorded on the run report so "the aggregator changed under us" stays answerable. */
  etag?: string;
  contentHash?: string;
  /**
   * Rows each of this source's parsers produced, by parser name. Set only by
   * sources that parse a rendered page: the runner compares the counts against
   * the last successful run and drops that source's docs-derived signals when
   * one moves, which is what catches a page restructure BEFORE it is actioned.
   */
  parserRows?: Record<string, number>;
}

export interface DiscoverySourceFailure {
  ok: false;
  /** Defaulted by the runner when absent, so a bare `{ ok: false }` still reports. */
  error?: string;
  httpStatus?: number;
}

/**
 * Distinct from an empty success on purpose. A parser that finds valid input and
 * zero rows must return `{ ok: false }`: "the page rendered and I found nothing"
 * is the shape of a broken parser, not of a provider that retired everything.
 */
export type SourceResult = DiscoverySourceOk | DiscoverySourceFailure;

export interface DiscoveryFetchContext {
  credentials: DiscoveryCredentials;
  env: DiscoveryEnv;
  /**
   * Aborts at the earlier of this source's deadline and the global one. Sources
   * MUST forward it to fetch(); the runner cannot cancel work that ignores it, it
   * can only stop waiting.
   */
  signal: AbortSignal;
  /** Wall clock the signal fires at, so a paginating source can stop before it trips. */
  deadlineAt: Date;
  logger: DiscoveryLogger;
  /** The run's startedAt. Sources stamp from it rather than Date.now() so a run is one instant. */
  runStartedAt: Date;
  /** Validators from this source's last successful fetch, for conditional GETs. */
  previous?: { etag?: string; contentHash?: string };
}

/**
 * A source of model facts. Implementations live in ./sources and are handed to
 * the runner as data - adding one must never require editing the runner.
 */
export interface DiscoverySource {
  /** Report key and min-interval key: 'anthropic', 'models.dev', ... */
  name: string;
  kind: DiscoverySourceKind;
  /**
   * The source's own deadline, for the ones whose fetch is a page walk or a
   * per-model fan-out rather than a single request. Overridden by
   * sourceDeadlineMsByName; falls back to DEFAULT_SOURCE_DEADLINE_MS.
   */
  deadlineMs?: number;
  isConfigured(creds: DiscoveryCredentials, env: DiscoveryEnv): boolean;
  fetch(ctx: DiscoveryFetchContext): Promise<SourceResult>;
}

/**
 * Fills the dispatch group for a model no row covers yet. No feed may supply
 * `adapterFamily` or `dispatchProfile` (sec 5.5), but they are derivable from the
 * family the seed layer already knows how to shape requests for - which is what
 * lets a new model in an ALREADY DISPATCHED family become invocable without a
 * code change. Unset means no derivation: such a model stays metadata-only.
 *
 * MUST STAY IN SYNC WITH the request builders: the resolver may only claim a
 * family whose requests this build actually shapes correctly.
 */
export type DispatchResolver = (record: ModelRecord) => Pick<ModelRecord, 'adapterFamily' | 'dispatchProfile'> | null;

/** 'report' writes no catalog rows and no bookkeeping; it only reports the diff. */
export type DiscoveryMode = 'report' | 'write';

export type DiscoveryAutoEnablePolicy = 'priced' | 'manual' | 'all';

/** modelDiscoveryAutoRemap: whether a computed successor is written or queued. */
export type DiscoveryAutoRemapPolicy = 'suggest' | 'apply';

/** Why a source contributed nothing this run, when it was not a fetch failure. */
export type SourceSkipReason = 'not-configured' | 'egress-disabled' | 'recently-fetched' | 'global-deadline';

/** Machine-readable promotion denials (sec 5.4 items 1-4), one per failed clause. */
export type PromotionBlocker =
  | 'no-adapter-family'
  | 'family-not-dispatchable'
  | 'no-dispatch-profile'
  | 'incomplete-dispatch-profile'
  | 'no-trusted-price'
  | 'manual-approval-required'
  | 'no-credential-for-backend';

/** One model's proposed change, reported identically in both modes. */
export interface CatalogDiffEntry {
  modelId: string;
  /** 'added' is a model with no catalog row at all; 'updated' is a changed merged view. */
  kind: 'added' | 'updated';
  /** Field groups the appended row claims authority over. */
  ownedGroups: string[];
  /** Record keys whose merged value this run would change. */
  changedKeys: string[];
  lifecycleStatus: string;
  promoted: boolean;
  blockedBy: PromotionBlocker[];
  /** True when an operator row exists for this model (report-mode exit criterion 1). */
  operatorOwned: boolean;
}

/** A source record the runner refused, counted rather than written. */
export interface DroppedSourceRecord {
  source: string;
  modelId: string;
  reason: string;
}

/**
 * Why a discovered price was not written. Each one is a guardrail from sec 8;
 * `band-exceeded` is the only one logged under the [PRICE_BAND] prefix.
 */
export type PriceFlagKind =
  | 'band-exceeded'
  | 'source-disagreement'
  | 'single-source-untrusted'
  | 'operator-owned-divergence'
  | 'tiered-pricing-manual';

/**
 * A price discovery declined to write, with everything an operator needs to
 * settle it. Report-mode exit criterion 2 is "every flag explainable line by
 * line", so `detail` is that line and is never left to the reader to infer.
 */
export interface PriceFlag {
  modelId: string;
  kind: PriceFlagKind;
  /** Per-MTok, the readable unit; the row it would have written is per token. */
  proposed: { inputPerMTok: number; outputPerMTok: number };
  /** The row in force, when there is one. */
  current?: { inputPerMTok: number; outputPerMTok: number };
  /** Every source that priced this model, so a disagreement names both sides. */
  sources: string[];
  detail: string;
}

/** Why a usable observation produced neither a row nor a flag. */
export type PriceSkipReason = 'unknown-model' | 'operator-owned' | 'tiered-pricing' | 'untrusted' | 'unchanged';

export interface PriceSkip {
  modelId: string;
  reason: PriceSkipReason;
}

/** A planned price row as the run report shows it, in per-MTok rather than per-token. */
export interface PlannedPriceRow {
  modelId: string;
  unit: ModelPriceUnit;
  inputPerMTok: number;
  outputPerMTok: number;
  effectiveFrom: Date;
  /** The sources whose observations produced the value. */
  sources: string[];
  note: string;
}

/** What moved a model's lifecycle: a feed that publishes it, or the K-miss protocol. */
export type LifecycleSignalKind = 'typed' | 'absence';

/** One model's lifecycle change, reported identically in both modes. */
export interface LifecycleTransition {
  modelId: string;
  /** Absent when no row in force carried a lifecycle for this model. */
  from?: string;
  to: string;
  signal: LifecycleSignalKind;
  deprecationDate?: string;
  retirementDate?: string;
  /** Present only when auto-remap applied it; otherwise the successor is a suggestion. */
  replacedBy?: string;
  autoApplied: boolean;
}

/**
 * A lifecycle date a typed feed moved without moving the status. It is NOT a
 * transition and must not count as one, but a catalog deprecationDate is a
 * delayed picker hide, so a date landing months ahead of its status change
 * cannot be invisible to the report.
 */
export interface LifecycleDateChange {
  modelId: string;
  /** The status the model keeps; a move into a sunset status is a transition instead. */
  status: string;
  signal: LifecycleSignalKind;
  previousDeprecationDate?: string;
  deprecationDate?: string;
  previousRetirementDate?: string;
  retirementDate?: string;
}

/**
 * A lifecycle change discovery is not allowed to apply, with everything an
 * operator needs to settle it. Same contract as PriceFlag.detail: the reason is
 * spelled out, never left to the reader to infer.
 */
export interface LifecycleSuggestion {
  modelId: string;
  status?: string;
  deprecationDate?: string;
  retirementDate?: string;
  replacedBy?: string;
  /** What raised it: a source name, or 'absence'. */
  source: string;
  detail: string;
}

/**
 * Run counters named 1:1 for the sec 10 CloudWatch metrics. The service never
 * calls CloudWatch - drivers publish these numbers.
 */
export interface ModelDiscoveryMetrics {
  ModelsDiscovered: number;
  ModelsPromoted: number;
  ModelsBlockedByDispatch: number;
  ModelsDeprecated: number;
  /** Rows actually appended, so report mode reports a plan and counts zero. */
  PriceRowsAppended: number;
  /** Counted in both modes: a flag is a work item whether or not writes are on. */
  PriceFlagged: number;
  CatalogRowsRejected: number;
  /** Parsers whose row count moved past the tolerance; their docs signals were dropped. */
  DocsParserRowShift: number;
  AggregatorJoinCoverage: Record<string, number>;
  SourceFailures: Record<string, number>;
  RunDuration: number;
}

/** A run can also decline to start, which is neither a status nor an error. */
export type DiscoveryRunOutcome = DiscoveryRunStatus | 'skipped';

export interface ModelDiscoveryRunResult {
  outcome: DiscoveryRunOutcome;
  /** Set only when outcome is 'skipped'. */
  skipReason?: 'disabled' | 'lease-held';
  /** Absent for a skipped run: no run document is written for one. */
  runId?: string;
  mode: DiscoveryMode;
  autoEnable: DiscoveryAutoEnablePolicy;
  sources: IDiscoverySourceReport[];
  /** Sources that never ran, and why. */
  skippedSources: Array<{ name: string; reason: SourceSkipReason }>;
  diff: CatalogDiffEntry[];
  droppedRecords: DroppedSourceRecord[];
  /** Bookkeeping this run applied (or would have applied, in report mode). */
  absence: {
    sighted: string[];
    missed: string[];
    /** Backends no successful source listed: their counters are frozen this run. */
    frozenBackends: string[];
  };
  /** The price plan, reported identically in both modes; only writes differ. */
  prices: {
    rows: PlannedPriceRow[];
    flags: PriceFlag[];
  };
  /** The lifecycle plan, likewise: report mode declines to persist it, nothing more. */
  lifecycle: {
    transitions: LifecycleTransition[];
    /** Date moves with no status transition behind them; never counted as deprecations. */
    dateChanges: LifecycleDateChange[];
    suggestions: LifecycleSuggestion[];
    /** Models the absence protocol graduated this run, a subset of `transitions`. */
    wouldDeprecate: string[];
  };
  metrics: ModelDiscoveryMetrics;
  /**
   * Convergence passes this run made (see MAX_DISCOVERY_PASSES). Always 1 in
   * report mode and for a run that declined to start; more than 2 means a pass
   * wrote something the pass before it could not have known about.
   */
  passes: number;
}

export interface ModelDiscoveryAdapters {
  db: {
    catalog: Pick<IModelCatalogRepository, 'append' | 'rowsInForceWithRejects'>;
    discoveryState: Pick<
      IModelDiscoveryStateRepository,
      'recordSighting' | 'recordMiss' | 'findByModelIds' | 'recordSuggestion'
    >;
    discoveryRuns: Pick<IModelDiscoveryRunRepository, 'create' | 'update' | 'find'>;
    /** claimDedup is the lease; deleteByKey is the only release path it has. */
    cache: Pick<ICacheRepository, 'claimDedup' | 'deleteByKey' | 'findByKey'>;
    adminSettings: Pick<IAdminSettingsRepository, 'getSettingsValue'>;
    /** Prices are appended to the EXISTING ModelPrice collection (sec 5.8). */
    prices: Pick<IModelPriceRepository, 'append' | 'rowsInForce'>;
  };
  sources: readonly DiscoverySource[];
  /** Step 1 of the run (sec 5.7). A thunk so a driver wires its own auth adapters once. */
  resolveCredentials: () => Promise<DiscoveryCredentials>;
  /**
   * Derives the dispatch group for models no row covers. Without it a newly
   * discovered model has no adapterFamily or dispatchProfile and stays
   * metadata-only, which is the fail-closed default (see DispatchResolver).
   */
  resolveDispatch?: DispatchResolver;
  /**
   * Drops the driver's memoized catalog view, called between convergence passes.
   * A driver reads the rows in force ONCE per adapters object so its sources
   * share one read; without an invalidation hook every extra pass would join
   * against the catalog as it stood at run start and could only repeat the pass
   * before it. Unset is safe: the extra passes degenerate to a re-plan over the
   * same targets, which is what the multi-run convergence already did.
   */
  refreshCatalogView?: () => void;
  logger?: DiscoveryLogger;
  env?: DiscoveryEnv;
}

export interface RunModelDiscoveryOptions {
  trigger: DiscoveryRunTrigger;
  host: DiscoveryRunHost;
  /**
   * Wall-clock budget for the whole run, normally the function timeout. The
   * global deadline sits 60 s inside it so the partial commit has room to finish
   * before the runtime kills the process.
   */
  budgetMs?: number;
  /** Per-source deadline overrides by source name; paginated sources register 60 s. */
  sourceDeadlineMsByName?: Readonly<Record<string, number>>;
  concurrency?: number;
  /** Skip a source any host fetched successfully this recently (sec 6.1). */
  minSourceIntervalMs?: number;
  /**
   * Extra ids to treat as priced, unioned with the models that have a per_token
   * row in force. A driver pricing a model outside the ModelPrice collection is
   * the only reason to set it.
   */
  knownPricedModelIds?: ReadonlySet<string>;
  /** Injectable clock. Tests drive deadlines with it; production leaves it unset. */
  now?: () => Date;
}
