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
  ModelBackend,
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
 * A price a source observed, in the one unit the promotion predicate compares.
 * Phase 2 never writes it: pricing rows are Phase 3, and this exists only to
 * answer "is this model priced by a trusted tier" and to show up on the report.
 */
export interface DiscoveredPrice {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

/** One model as a source saw it: our id plus the fields that source has authority for. */
export interface DiscoveredModel {
  /** Our canonical model id. Resolving an aggregator key to it is the source's job. */
  modelId: string;
  /** Sparse ModelRecord fragment. Keys this build does not know are dropped by the merge. */
  patch: Partial<ModelRecord>;
  pricing?: DiscoveredPrice;
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
 * Run counters named 1:1 for the sec 10 CloudWatch metrics. The service never
 * calls CloudWatch - drivers publish these numbers.
 */
export interface ModelDiscoveryMetrics {
  ModelsDiscovered: number;
  ModelsPromoted: number;
  ModelsBlockedByDispatch: number;
  ModelsDeprecated: number;
  /** Always 0 in Phase 2: pricing writes are Phase 3. */
  PriceRowsAppended: number;
  PriceFlagged: number;
  CatalogRowsRejected: number;
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
  metrics: ModelDiscoveryMetrics;
}

export interface ModelDiscoveryAdapters {
  db: {
    catalog: Pick<IModelCatalogRepository, 'append' | 'rowsInForceWithRejects'>;
    discoveryState: Pick<IModelDiscoveryStateRepository, 'recordSighting' | 'recordMiss'>;
    discoveryRuns: Pick<IModelDiscoveryRunRepository, 'create' | 'update' | 'find'>;
    /** claimDedup is the lease; deleteByKey is the only release path it has. */
    cache: Pick<ICacheRepository, 'claimDedup' | 'deleteByKey'>;
    adminSettings: Pick<IAdminSettingsRepository, 'getSettingsValue'>;
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
  /** Models the price catalog already covers. Phase 3 wires it; the predicate reads it. */
  knownPricedModelIds?: ReadonlySet<string>;
  /** Injectable clock. Tests drive deadlines with it; production leaves it unset. */
  now?: () => Date;
}
