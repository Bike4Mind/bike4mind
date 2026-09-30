import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { ChatModels } from '../../models';

// -- Data Lake Research Runs -------------------------------------------------------------------
//
// The acquisition queue's first real producer (#1682). A research run searches the web for one
// question, judges what it finds, and hands every survivor to `proposeDataLakeContent` - the same
// seam the e2e stand-in calls. It never writes a FabFile and never stamps a lake tag: a human
// approving a proposal is still the only thing that admits content.
//
// HOW THIS RELATES TO `ResearchTask`. The older `researchTaskService` subsystem models the same
// on-demand/periodic/scheduled trigger distinction (`ResearchTaskExecutionType`), and this reuses
// its vocabulary rather than inventing a parallel one - see `ResearchRunTrigger` below. It is NOT
// extended, for one disqualifying reason: a research task writes FabFiles directly
// (`researchTaskService/downloadRelevantLinks.ts` -> `createFabFile`) with tags from
// `prepareTagsForResearchTask`, and a tag matching a lake's `datalakeTag` admits the file. That is
// a direct lake write with no human in it - exactly the door this feature exists to route around -
// so grafting lake targeting onto that subsystem would inherit the bypass instead of replacing it.
// It also requires a `researchAgentId` and carries `ResearchData`, scrape and Salesforce shapes
// this has no use for.
//
// Types live in common rather than beside the producer for the same reason the proposal types do:
// the services that read them live in b4m-core/services, which cannot import @bike4mind/database.

/**
 * What starts a run. Deliberately the same three concepts as `ResearchTaskExecutionType`, in this
 * package's naming convention, so a reader who knows one knows the other.
 *
 * `on_demand` is a human pressing Run; `periodic` is a config with a `cadence`, fired by the
 * research scheduler (`runDueResearchSchedules`). `scheduled` - a one-off run at a set time - is
 * storable but refused: nothing fires it.
 */
export const RESEARCH_RUN_TRIGGERS = ['on_demand', 'periodic', 'scheduled'] as const;
export type ResearchRunTrigger = (typeof RESEARCH_RUN_TRIGGERS)[number];

/** The producer label stamped on every proposal a run creates. Matches the queue's own example. */
export const RESEARCH_RUN_PRODUCER = 'research_run';

/**
 * A run's lifecycle. `queued` is written by the API before the message is sent, so a run a user
 * started is visible immediately rather than appearing only once a worker picks it up.
 *
 * `completed` means the run finished its own loop, INCLUDING when it stopped early on a lever
 * (`stopReason`). A stopped-early run did the work it was allowed to do. `failed` is an unhandled
 * fault, an operator fact that makes the run impossible, or a judge that failed on every candidate
 * it tried - the last because "nothing proposed" would otherwise read as "the web had nothing".
 */
export const RESEARCH_RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

/**
 * Why a run's loop ended. Every value other than `exhausted` and `judge_unavailable` names a
 * LEVER that fired, which is what makes this field worth storing: a run that proposed two things
 * because its ceiling was $0.05 and a run that proposed two things because the web held nothing
 * else look identical without it, and only one of them is fixed by turning a dial.
 */
export const RESEARCH_RUN_STOP_REASONS = [
  /** The candidate list ran out - the run considered everything search returned. */
  'exhausted',
  'cost_ceiling',
  'proposal_limit',
  /** The worker was running out of Lambda time and stopped rather than being killed mid-candidate. */
  'time_budget',
  /**
   * The judge failed several times in a row before scoring anything, so the run stopped instead of
   * paying for a judgment on every remaining candidate. The rest are counted in `totals.notJudged`, or `totals.filteredBySource` if a source rule blocks them.
   */
  'judge_unavailable',
] as const;
export type ResearchRunStopReason = (typeof RESEARCH_RUN_STOP_REASONS)[number];

// -- Levers ------------------------------------------------------------------------------------
//
// Bounds live here, next to the fields they bound, because they are the "sane defaults and hard
// safety rails" half of this epic's levers-not-constants principle: a lever an operator can set to
// anything is not adjustable, it is unbounded. Every one of these is read on the path it governs -
// see `executeResearchRun`, which is where each is spent.

export const RESEARCH_CONFIG_NAME_MAX_CHARS = 120;
export const RESEARCH_CONFIG_QUERY_MAX_CHARS = 500;

/**
 * The relevance judge used when a config names no model, or names one this deployment no longer
 * offers. Lives here rather than in the service so the config form can name it.
 */
export const RESEARCH_RELEVANCE_MODEL_DEFAULT: string = ChatModels.GPT4_1_MINI;

/** How many search hits a run may ask its provider for. */
export const RESEARCH_MAX_RESULTS_DEFAULT = 10;
export const RESEARCH_MAX_RESULTS_LIMIT = 50;

/** How many proposals one run may put in front of a reviewer. The queue is a human's inbox. */
export const RESEARCH_MAX_PROPOSALS_DEFAULT = 5;
export const RESEARCH_MAX_PROPOSALS_LIMIT = 25;

/**
 * Longest recency window a run may ask for, in days.
 *
 * A year, because that is the widest bucket either search provider can express (`recencyBucket`
 * maps to SerpAPI's `qdr:d|w|m|y` and SearXNG's `time_range`, and returns null past `year`).
 * Allowing more would let a manager save "last 730 days", see 730 on the config and on the run
 * card, and get a search with no date filter at all - the one direction `WebSearchOptions`
 * promises against, since it says the window WIDENS to the smallest containing bucket.
 */
export const RESEARCH_RECENCY_DAYS_LIMIT = 366;

/** How many domains an allow or deny list may hold. Bounded so one config cannot become a corpus. */
export const RESEARCH_DOMAIN_LIST_MAX = 50;

/**
 * How long a `queued` or `running` run keeps holding the one-at-a-time guard before it is read as
 * abandoned rather than in flight.
 *
 * Must stay ABOVE the research queue's visibility timeout plus its handler timeout
 * (`infra/queues.ts`: 10-minute Lambda, 12-minute redelivery), so a run that is genuinely still
 * working - or a message SQS has yet to redeliver - is never counted out from under itself. Past
 * that window nothing is left to resume the row, and without this bound a run killed hard (a
 * timeout, an OOM, a replaced container) would lock its lake out of research permanently.
 */
export const RESEARCH_RUN_STALE_AFTER_MS = 25 * 60 * 1000;

/**
 * Whether a run still holds the one-at-a-time guard shut, as of `now`.
 *
 * MUST STAY IN SYNC with `DataLakeResearchRunRepository.countActiveByLake`, which refuses a second
 * run on exactly this rule. That parity is the whole point of this living in `common`: a status-only
 * client predicate disagrees with the server precisely when a run was killed hard - its catch never
 * ran, so the row keeps a non-terminal status forever - and the disagreement disables "Run now" for
 * a lake the server would accept a run for, while the run history polls a row nothing will settle.
 *
 * A `running` row with no `startedAt` is NOT in flight, matching the server's query, which cannot
 * match a missing field.
 *
 * `now` is an OPTIONS BAG rather than a positional second argument on purpose: as a positional it
 * would accept the index `Array.prototype.some` passes, so `runs.some(isResearchRunInFlight)` would
 * typecheck and evaluate the bound against `now = 0` - reporting every run in flight forever. In
 * this shape that call is a compile error, so the bug cannot be written.
 */
export const isResearchRunInFlight = (
  run: { status: ResearchRunStatus; startedAt?: Date | string | null; createdAt?: Date | string | null },
  opts: { now?: number } = {}
): boolean => {
  const heldSince = run.status === 'running' ? run.startedAt : run.status === 'queued' ? run.createdAt : null;
  if (!heldSince) return false;
  const at = heldSince instanceof Date ? heldSince.getTime() : new Date(heldSince).getTime();
  return !Number.isNaN(at) && at >= (opts.now ?? Date.now()) - RESEARCH_RUN_STALE_AFTER_MS;
};

/**
 * The relevance floor a candidate must clear to be fetched and proposed. This is a PRODUCER-side
 * filter on what is worth a human's attention, not an admission decision: everything that clears it
 * still lands as `pending` and still needs an explicit approval. It is emphatically not the
 * auto-approval threshold #1658 decision 10 rules out, and nothing downstream reads it.
 */
export const RESEARCH_MIN_RELEVANCE_DEFAULT = 0.6;

/**
 * The per-run spend ceiling, in micro-USD, over the run's own LLM relevance judgments.
 *
 * NOT to be confused with `DataLakeSpendLevers.perRunBudgetMicroUsd`, which is the EMBEDDING budget
 * for one upload batch at the vectorize gate (`enforceEmbeddingSpendGate`). Different meter,
 * different path, different money: that one is charged when content is indexed, this one when a run
 * decides whether content is worth proposing. Conflating them would let a generous embedding budget
 * silently fund an expensive research habit.
 */
export const RESEARCH_COST_CEILING_MICRO_USD_DEFAULT = 50_000; // $0.05
export const RESEARCH_COST_CEILING_MICRO_USD_LIMIT = 5_000_000; // $5.00

/**
 * The saved, reusable run configuration - the object this issue exists to make first-class. Every
 * field is a lever, and every lever is read in `executeResearchRun`.
 */
export interface ResearchRunLevers {
  /** The question the run answers. Sent to the search provider and to the relevance judge. */
  query: string;
  /**
   * The model that judges relevance. Optional: absent means the service's own default, so a config
   * saved before a model was retired does not become unrunnable.
   */
  model?: string;
  /** How many hits to ask the search provider for. */
  maxResults: number;
  /** How many proposals this run may create before it stops. */
  maxProposals: number;
  /**
   * Only consider pages the search provider dates within this many days. Passed to the provider
   * (SerpAPI `tbs=qdr:`, SearXNG `time_range`), not applied after the fact - a client-side filter
   * would need a publication date the hit does not carry. Absent = no recency constraint.
   */
  recencyDays?: number;
  /**
   * When non-empty, ONLY these domains are considered; every other hit is dropped before it costs
   * anything. Matched on registrable-suffix (`docs.example.com` matches an `example.com` entry).
   */
  allowedDomains: string[];
  /** Always dropped, and applied AFTER the allow list so a deny entry can carve out a subdomain. */
  blockedDomains: string[];
  /** 0..1. See RESEARCH_MIN_RELEVANCE_DEFAULT - a producer-side filter, never an admission gate. */
  minRelevance: number;
  /** Per-run LLM spend ceiling, micro-USD. See RESEARCH_COST_CEILING_MICRO_USD_DEFAULT. */
  costCeilingMicroUsd: number;
  /** Advisory tags the run suggests for anything it proposes. The queue sanitizes them. */
  proposedTags: string[];
}

// -- Schedule ----------------------------------------------------------------------------------
//
// A config with a cadence is fired by the research scheduler cron without a user present. The
// schedule is NOT a lever: levers are snapshotted onto the run, the schedule only decides whether
// a run starts at all.

export const RESEARCH_SCHEDULE_CADENCES = ['off', 'daily', 'weekly', 'monthly'] as const;
export type ResearchScheduleCadence = (typeof RESEARCH_SCHEDULE_CADENCES)[number];

/**
 * A due scheduled run is skipped while the lake holds this many pending proposals or more. Gathering
 * candidates nobody is reviewing spends money on a queue that only grows, so the scheduler waits for
 * a human instead. Run now only warns - a person pressing it has decided to spend.
 */
export const RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT = 25;
export const RESEARCH_REVIEW_BACKLOG_LIMIT_MAX = 500;

export const RESEARCH_SCHEDULE_SKIP_REASONS = [
  /** The lake's pending proposals were at or above the config's `reviewBacklogLimit`. */
  'review_backlog',
  /** Another run for this lake was still in flight. */
  'run_in_progress',
  /** The lake had already started its daily allowance of runs. */
  'daily_cap',
  /** The lake is not active (archived, deleted or missing). */
  'lake_inactive',
] as const;
export type ResearchScheduleSkipReason = (typeof RESEARCH_SCHEDULE_SKIP_REASONS)[number];

/**
 * What the scheduler did the last time this config came due, shown on the config card. Execution
 * failures after a run starts are on the run row, not here - this records only the decision to
 * start, so a skipped or refused tick is visible even though it produced no run.
 */
export type ResearchScheduleOutcome =
  | { outcome: 'started'; at: Date; runId: string }
  | {
      outcome: 'skipped';
      at: Date;
      reason: ResearchScheduleSkipReason;
      /** Set for `review_backlog`: the count against the limit that caused the skip. */
      pendingProposals?: number;
      reviewBacklogLimit?: number;
    }
  | { outcome: 'failed'; at: Date; error: string };

export interface IDataLakeResearchConfig extends ResearchRunLevers {
  dataLakeId: string;
  /** What a human calls this config in the list. */
  name: string;
  /** Derived from `cadence`: `periodic` while a cadence is set, `on_demand` otherwise. */
  trigger: ResearchRunTrigger;
  cadence: ResearchScheduleCadence;
  /** Pending-proposal count at which a due scheduled run is skipped. See the default's comment. */
  reviewBacklogLimit: number;
  /** When the scheduler next fires this config. Null exactly when `cadence` is `off`. */
  nextRunAt?: Date | null;
  /**
   * The first slot of the current cadence, set with it. Every regular slot is this plus a whole
   * number of periods, so a retried tick cannot shift the cadence and a monthly config keeps its
   * day of the month past a short month. Null exactly when `cadence` is `off`.
   */
  scheduleAnchorAt?: Date | null;
  lastScheduledOutcome?: ResearchScheduleOutcome | null;
  createdByUserId: string;
  lastUpdatedByUserId?: string | null;
  /** When a run last STARTED from this config. The list's "when did I last use this" column. */
  lastRunAt?: Date | null;
}

export type IDataLakeResearchConfigDocument = IDataLakeResearchConfig & IMongoDocument;

/** What the run loop counted. Every candidate lands in exactly one of the outcome buckets. */
export interface ResearchRunTotals {
  /** Hits the search provider returned. */
  searchHits: number;
  /** Hits dropped by the allow/deny lists, before any model or network cost. */
  filteredBySource: number;
  /** Candidates the judge scored below `minRelevance`. */
  belowRelevance: number;
  /**
   * Candidates the judge could not score at all: the model call failed or its response was unusable. Counted apart
   * from `belowRelevance` even though the candidate meets the same fate: a run whose judge is down
   * reports "20 hits, 20 below relevance, 0 proposed", which reads as "the web had nothing" and
   * sends a manager off to retune a query that was never the problem.
   */
  judgeFailed: number;
  /** Candidates whose page could not be fetched or parsed. */
  fetchFailed: number;
  proposed: number;
  /** Already awaiting a human for this source. */
  duplicatePending: number;
  /** The lake already holds this, by prior approval or by text. */
  alreadyInLake: number;
  /** A human declined this source and it has not come back materially changed. */
  suppressedByTombstone: number;
  /** Nothing to key the source on (not an http(s) URL). */
  unusableSource: number;
  /**
   * Candidates never reached because the run stopped on `judge_unavailable`, which keeps that run's
   * buckets summing to `searchHits`. Unreached candidates a source rule blocks are still counted in
   * `filteredBySource`, since source rules are free and are checked for them. Only that stop fills it: `cost_ceiling`, `time_budget` and
   * `proposal_limit` leave it 0, so their buckets can fall short. Older stored runs read it as 0.
   */
  notJudged: number;
}

export const emptyResearchRunTotals = (): ResearchRunTotals => ({
  searchHits: 0,
  filteredBySource: 0,
  belowRelevance: 0,
  judgeFailed: 0,
  fetchFailed: 0,
  proposed: 0,
  duplicatePending: 0,
  alreadyInLake: 0,
  suppressedByTombstone: 0,
  unusableSource: 0,
  notJudged: 0,
});

export interface IDataLakeResearchRun {
  dataLakeId: string;
  /**
   * The config this run executed. Kept even after the config is deleted (the id simply stops
   * resolving) so a proposal's `runId` always leads somewhere.
   */
  configId: string;
  /**
   * The levers AS EXECUTED, copied at start. Load-bearing rather than redundant: a config is
   * editable, and a proposal a reviewer is looking at weeks later was produced under whatever the
   * levers were THEN. Reading them off the live config would attribute the run to settings it never
   * ran with - the same reason the queue records provenance instead of recomputing it.
   */
  levers: ResearchRunLevers;
  trigger: ResearchRunTrigger;
  /** Who started it. Absent for a scheduled run, which has no human behind it. */
  startedByUserId?: string | null;
  status: ResearchRunStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  stopReason?: ResearchRunStopReason | null;
  /** What the run actually spent on relevance judgments, micro-USD. Reported next to the ceiling. */
  spentMicroUsd: number;
  totals: ResearchRunTotals;
  /**
   * The judge model the run actually resolved, which is not always `levers.model`: that lever is
   * absent on "Default" and falls back when the configured model is gone. Recorded so spend and
   * quality trace to a model, and so changing the default does not rewrite history. Absent on a run
   * that failed before resolving one.
   */
  judgeModel?: string | null;
  /**
   * Why a `failed` run failed, in terms a lake manager can act on. Never a raw stack. Also set on a
   * `completed` run whose judge failed on some candidates, so a degraded run carries its cause.
   */
  error?: string | null;
}

export type IDataLakeResearchRunDocument = IDataLakeResearchRun & IMongoDocument;

/** What a caller supplies to save a config. Ids, timestamps and `lastRunAt` are the server's. */
export type CreateDataLakeResearchConfigInput = Omit<
  IDataLakeResearchConfig,
  'lastUpdatedByUserId' | 'lastRunAt' | 'lastScheduledOutcome'
>;

/**
 * The editable half of a config. `dataLakeId` and `createdByUserId` are not editable.
 *
 * `recencyDays` and `model` are nullable here and nowhere else: they are the two levers a user can
 * CLEAR, and an update that merely omitted them would `$set` a partial and leave the old value in
 * place - so clearing either field would appear to work and then silently revert.
 */
export type UpdateDataLakeResearchConfigInput = Partial<Omit<ResearchRunLevers, 'recencyDays' | 'model'>> & {
  recencyDays?: number | null;
  model?: string | null;
  name?: string;
  trigger?: ResearchRunTrigger;
  cadence?: ResearchScheduleCadence;
  reviewBacklogLimit?: number;
  nextRunAt?: Date | null;
  scheduleAnchorAt?: Date | null;
  lastScheduledOutcome?: null;
  lastUpdatedByUserId: string;
};

/** What a run's terminal write records. Split from the input so a settle cannot widen into a patch. */
export interface SettleResearchRunInput {
  status: Extract<ResearchRunStatus, 'completed' | 'failed'>;
  completedAt: Date;
  stopReason?: ResearchRunStopReason;
  spentMicroUsd: number;
  totals: ResearchRunTotals;
  judgeModel?: string;
  error?: string;
}

export interface IDataLakeResearchConfigRepository extends IBaseRepository<IDataLakeResearchConfigDocument> {
  createConfig(input: CreateDataLakeResearchConfigInput): Promise<IDataLakeResearchConfigDocument>;
  /** One lake's saved configs, newest first. */
  listByLake(dataLakeId: string): Promise<IDataLakeResearchConfigDocument[]>;
  /**
   * Fetch a config only if it belongs to the named lake. Scoped rather than a bare findById so a
   * caller cannot reach another lake's config by id through a route that only gated the lake.
   */
  findByIdInLake(id: string, dataLakeId: string): Promise<IDataLakeResearchConfigDocument | null>;
  updateConfig(
    id: string,
    dataLakeId: string,
    input: UpdateDataLakeResearchConfigInput
  ): Promise<IDataLakeResearchConfigDocument | null>;
  /** Stamp the start of a run. Separate from updateConfig so it needs no actor and no levers. */
  recordRunStarted(id: string, at: Date): Promise<void>;
  /**
   * Atomically claim up to `limit` configs whose `nextRunAt <= now`, pushing each one's `nextRunAt`
   * out to `leaseUntil` so an overlapping scheduler tick cannot claim it again. Returns the configs
   * as they were BEFORE the claim, so the caller still sees the slot that came due.
   */
  claimDueConfigs(now: Date, leaseUntil: Date, limit: number): Promise<IDataLakeResearchConfigDocument[]>;
  /**
   * Record what a scheduler tick decided and when the config is next due. Applied only while the
   * config still has the cadence it was claimed with: a user who switched the schedule off or
   * changed it mid-tick has already set the next slot, and this must not overwrite it.
   */
  recordScheduleOutcome(
    id: string,
    claimedCadence: ResearchScheduleCadence,
    outcome: ResearchScheduleOutcome,
    nextRunAt: Date
  ): Promise<void>;
  deleteConfig(id: string, dataLakeId: string): Promise<boolean>;
  /** Drop a deleted lake's configs. */
  deleteForLake(dataLakeId: string): Promise<number>;
}

export interface IDataLakeResearchRunRepository extends IBaseRepository<IDataLakeResearchRunDocument> {
  createRun(
    input: Omit<IDataLakeResearchRun, 'status' | 'spentMicroUsd' | 'totals'>
  ): Promise<IDataLakeResearchRunDocument>;
  /** One lake's run history, newest first. */
  listByLake(dataLakeId: string, options?: { limit?: number }): Promise<IDataLakeResearchRunDocument[]>;
  findByIdInLake(id: string, dataLakeId: string): Promise<IDataLakeResearchRunDocument | null>;
  /**
   * Atomically move a QUEUED run to `running`, returning null when it was not queued. The whole
   * redelivery guard: SQS is at-least-once, so without the compare-and-set an ordinary redelivery
   * of a run that already finished would run the whole search-judge-propose loop a second time and
   * spend a second ceiling's worth of money.
   */
  claimForExecution(id: string, startedAt: Date): Promise<IDataLakeResearchRunDocument | null>;
  /**
   * The executor's own settle - matches `queued` or `running`. Returns false when the row was
   * already terminal (settle was a no-op), true when it settled. A caller that does not hold the
   * execution claim must use `settleQueuedRun` instead.
   */
  settleRun(id: string, input: SettleResearchRunInput): Promise<boolean>;
  /**
   * Settle for a caller that has NOT claimed the run - matches `queued` ONLY, so it can never
   * overwrite a run the executor has already claimed (`running`) or resolved. Returns false when
   * the row was not queued (the executor now owns it), true when it settled.
   */
  settleQueuedRun(id: string, input: SettleResearchRunInput): Promise<boolean>;
  /**
   * Live progress while the loop runs, so the panel is not blank for a minute. When given, also
   * stamps the resolved judge model, so an in-flight run's card can name its judge before the run
   * settles. Optional so existing callers keep compiling; an omitted model leaves the field as is.
   */
  recordProgress(id: string, spentMicroUsd: number, totals: ResearchRunTotals, judgeModel?: string): Promise<void>;
  /** How many runs a lake started since `since`. Backs the per-lake daily spend cap. */
  countStartedSince(dataLakeId: string, since: Date): Promise<number>;
  /**
   * Runs for this lake that are `queued` or `running`. Backs the one-at-a-time guard, which is the
   * spend control that matters most: a double-clicked Run button is two ceilings, and two runs of
   * the same config race each other into the queue's pending-uniqueness index for every source they
   * both find.
   */
  countActiveByLake(dataLakeId: string): Promise<number>;
  deleteForLake(dataLakeId: string): Promise<number>;
}
