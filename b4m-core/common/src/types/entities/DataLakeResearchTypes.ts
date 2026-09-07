import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

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
 * v1 accepts `on_demand` ONLY - `startResearchRun` rejects the other two. They exist in the union
 * now because the whole point of making configuration a saved object is that v2 is a scheduling
 * change: a scheduler enqueues the same run against the same stored config, and nothing here or
 * downstream has to move.
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
 * (`stopReason`). A stopped-early run did the work it was allowed to do; only an unhandled failure
 * is `failed`.
 */
export const RESEARCH_RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

/**
 * Why a run's loop ended. Every value other than `exhausted` names a LEVER that fired, which is
 * what makes this field worth storing: a run that proposed two things because its ceiling was
 * $0.05 and a run that proposed two things because the web held nothing else look identical
 * without it, and only one of them is fixed by turning a dial.
 */
export const RESEARCH_RUN_STOP_REASONS = [
  /** The candidate list ran out - the run considered everything search returned. */
  'exhausted',
  'cost_ceiling',
  'proposal_limit',
  /** The worker was running out of Lambda time and stopped rather than being killed mid-candidate. */
  'time_budget',
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

export interface IDataLakeResearchConfig extends ResearchRunLevers {
  dataLakeId: string;
  /** What a human calls this config in the list. */
  name: string;
  /**
   * v1 writes `on_demand` and `startResearchRun` refuses anything else. Stored rather than implied
   * so a v2 scheduler has a field to select on instead of a schema migration.
   */
  trigger: ResearchRunTrigger;
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
   * Candidates the judge could not score at all, because the model was unreachable. Counted apart
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
  /** Who started it. Absent for a future scheduled run with no human behind it. */
  startedByUserId?: string | null;
  status: ResearchRunStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  stopReason?: ResearchRunStopReason | null;
  /** What the run actually spent on relevance judgments, micro-USD. Reported next to the ceiling. */
  spentMicroUsd: number;
  totals: ResearchRunTotals;
  /** Why a `failed` run failed, in terms a lake manager can act on. Never a raw stack. */
  error?: string | null;
}

export type IDataLakeResearchRunDocument = IDataLakeResearchRun & IMongoDocument;

/** What a caller supplies to save a config. Ids, timestamps and `lastRunAt` are the server's. */
export type CreateDataLakeResearchConfigInput = Omit<IDataLakeResearchConfig, 'lastUpdatedByUserId' | 'lastRunAt'>;

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
  lastUpdatedByUserId: string;
};

/** What a run's terminal write records. Split from the input so a settle cannot widen into a patch. */
export interface SettleResearchRunInput {
  status: Extract<ResearchRunStatus, 'completed' | 'failed'>;
  completedAt: Date;
  stopReason?: ResearchRunStopReason;
  spentMicroUsd: number;
  totals: ResearchRunTotals;
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
  settleRun(id: string, input: SettleResearchRunInput): Promise<void>;
  /** Live progress while the loop runs, so the panel is not blank for a minute. */
  recordProgress(id: string, spentMicroUsd: number, totals: ResearchRunTotals): Promise<void>;
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
