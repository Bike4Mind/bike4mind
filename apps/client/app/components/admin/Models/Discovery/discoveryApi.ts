import { useQuery } from '@tanstack/react-query';
import type { DiscoveryRunMode, DiscoveryRunStatus, PerMTokRate } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { runProgress } from './discoveryCopy';

/**
 * Wire shapes of GET /api/admin/model-discovery (status, and one run with ?runId=) and GET
 * /api/admin/model-deprecation-status. Dates arrive as strings. Must stay in sync with listRun, trimRun and fullRun
 * in pages/api/admin/model-discovery.ts.
 */

export interface DiscoveryChangeCounts {
  added: number;
  promoted: number;
  deprecated: number;
  repriced: number;
  flagged: number;
}

export interface DiscoveryRunListItem {
  id: string;
  startedAt: string;
  finishedAt?: string | null;
  trigger: string;
  host: string;
  status: DiscoveryRunStatus;
  /** Absent on runs written before the field existed; never read as either mode. */
  mode?: DiscoveryRunMode;
  changes: DiscoveryChangeCounts;
}

export interface DiscoverySkippedSource {
  name: string;
  reason: string;
}

export interface DiscoveryJoinCoverage {
  aggregator: string;
  matched: number;
  total: number;
}

export interface DiscoveryLastRun extends DiscoveryRunListItem {
  sources: Array<{ name: string; ok: boolean; durationMs: number; error?: string }>;
  skippedSources?: DiscoverySkippedSource[];
  joinCoverage: DiscoveryJoinCoverage[];
}

export interface DiscoveryStatus {
  lastRun: DiscoveryLastRun | null;
  /** Newest first; runs[0] is the same run as lastRun. */
  runs: DiscoveryRunListItem[];
  lastSuccessfulRunAt: string | null;
  enabled: boolean;
  mode: string;
  autoEnable: string;
  selfHost: boolean;
}

export interface PerMTokRates {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface RunPriceFlag {
  modelId: string;
  /** A service-owned union read as a free string, so a new kind still renders. */
  kind: string;
  proposed: PerMTokRates;
  current?: PerMTokRates;
  sources: string[];
  detail: string;
}

export interface RunPriceRow {
  modelId: string;
  unit: string;
  inputPerMTok: number;
  outputPerMTok: number;
  effectiveFrom: string;
  sources: string[];
  note: string;
}

export interface RunPriceOverride {
  modelId: string;
  source: string;
  dissenting: string[];
  applied: PerMTokRates;
  detail: string;
}

/** A flat row that a trusted source's published long-context ladder outruns; kept apart from the price flags. */
export interface RunLongContextGap {
  modelId: string;
  source: string;
  base: PerMTokRates;
  brackets: Array<PerMTokRates & { aboveTokens: number }>;
  detail: string;
}

export interface RunLifecycleTransition {
  modelId: string;
  from?: string;
  to: string;
  signal: string;
  deprecationDate?: string;
  retirementDate?: string;
  replacedBy?: string;
  autoApplied: boolean;
}

export interface RunCatalogDiffEntry {
  modelId: string;
  kind: string;
  ownedGroups: string[];
  changedKeys: string[];
  lifecycleStatus: string;
  promoted: boolean;
  blockedBy: string[];
  operatorOwned: boolean;
}

/** Present per array only when the runner cut it; the `changes` id arrays are never cut. */
export interface RunDetailTotals {
  priceFlags?: number;
  priceRows?: number;
  priceOverrides?: number;
  longContextGaps?: number;
  priceSkips?: number;
  lifecycleTransitions?: number;
  catalogDiff?: number;
}

export interface DiscoveryRun {
  id: string;
  startedAt: string;
  finishedAt?: string | null;
  trigger: string;
  host: string;
  status: DiscoveryRunStatus;
  mode?: DiscoveryRunMode;
  passes: number;
  sources: Array<{
    name: string;
    ok: boolean;
    durationMs: number;
    httpStatus?: number;
    recordCount?: number;
    error?: string;
  }>;
  skippedSources?: DiscoverySkippedSource[];
  joinCoverage: DiscoveryJoinCoverage[];
  changes: {
    added: string[];
    promoted: string[];
    deprecated: string[];
    repriced: string[];
    flagged: string[];
    operatorConflicts: string[];
    plannedRows: number;
    appendedRows: number;
    plannedPriceRows: number;
    appendedPriceRows: number;
  };
  priceFlags: RunPriceFlag[];
  priceRows: RunPriceRow[];
  /** Optional: runs written before provider prices could overrule a mirror carry none. */
  priceOverrides?: RunPriceOverride[];
  /** Optional: runs written before long-context gaps were reported carry none. */
  longContextGaps?: RunLongContextGap[];
  priceSkips: Array<{ modelId: string; reason: string }>;
  lifecycleTransitions: RunLifecycleTransition[];
  catalogDiff: RunCatalogDiffEntry[];
  detailTotals?: RunDetailTotals;
  unmatchedIds: string[];
  frozenProfileIds: string[];
  droppedRecords: Array<{ source: string; modelId: string; reason: string }>;
}

export interface LifecycleSuggestion {
  status?: string;
  deprecationDate?: string;
  retirementDate?: string;
  replacedBy?: string;
  source: string;
  suggestedAt: string;
  /** The run's own sentence about the suggestion; older queue rows have none. */
  detail?: string;
}

export interface LifecycleQueueItem {
  modelId: string;
  suggestion?: LifecycleSuggestion;
  /** The serving backend; only the full report resolves it, so the queue view reads it off the model index. */
  backend?: string;
  /** Consecutive misses, sent only for absence-raised suggestions. */
  missCount?: number;
}

/** Mirrors StaleReferenceProblem in @bike4mind/llm-adapters; a value added there must be added here by hand. */
export type StaleReferenceProblem = 'deprecated' | 'retired' | 'not-invocable' | 'unknown';

export interface StaleReference {
  surface: string;
  key: string;
  referencedId: string;
  problem: StaleReferenceProblem;
}

/** The GET's `view=queue` answer: read from the database alone, so loading it asks no provider. */
export interface LifecycleQueue {
  queue: LifecycleQueueItem[];
  /** Per-MTok rates in force by model id, for pricing a proposed successor. */
  perMTokRates?: Record<string, PerMTokRate>;
}

export interface LifecycleStatus extends LifecycleQueue {
  /** Null when the server could not build the report; staleReferencesError says why. */
  staleReferences: StaleReference[] | null;
  staleReferencesError?: string;
}

export const DISCOVERY_STATUS_PATH = '/api/admin/model-discovery';
export const LIFECYCLE_STATUS_PATH = '/api/admin/model-deprecation-status';

export const DISCOVERY_QUERY_KEY = ['admin', 'model-discovery'] as const;
export const DISCOVERY_STATUS_QUERY_KEY = [...DISCOVERY_QUERY_KEY, 'status'] as const;
export const discoveryRunQueryKey = (runId: string) => [...DISCOVERY_QUERY_KEY, 'run', runId] as const;
export const LIFECYCLE_STATUS_QUERY_KEY = ['admin', 'model-deprecation-status'] as const;
export const LIFECYCLE_QUEUE_QUERY_KEY = [...LIFECYCLE_STATUS_QUERY_KEY, 'queue'] as const;
/** The full GET fans out to every provider on platform credentials, so only "Check references" fetches it. */
export const STALE_REFERENCES_QUERY_KEY = [...LIFECYCLE_STATUS_QUERY_KEY, 'references'] as const;

/** True while the loaded report predates a lifecycle change; a completed check clears it. */
export const STALE_REFERENCES_OUTDATED_QUERY_KEY = [...LIFECYCLE_STATUS_QUERY_KEY, 'references-outdated'] as const;

export const fetchDiscoveryStatus = async (): Promise<DiscoveryStatus> =>
  (await api.get<DiscoveryStatus>(DISCOVERY_STATUS_PATH)).data;

export const useDiscoveryStatus = () =>
  useQuery({
    queryKey: DISCOVERY_STATUS_QUERY_KEY,
    queryFn: fetchDiscoveryStatus,
    // Polls only while the last run is unfinished. No structural sharing, so every poll re-renders the card and the
    // 20 minute limit is noticed even when the payload is unchanged.
    structuralSharing: false,
    refetchInterval: query =>
      query.state.data?.lastRun && runProgress(query.state.data.lastRun) === 'running' ? RUNNING_REFETCH_MS : false,
  });

export const useDiscoveryRun = (runId: string) =>
  useQuery({
    queryKey: discoveryRunQueryKey(runId),
    queryFn: async () => (await api.get<{ run: DiscoveryRun }>(DISCOVERY_STATUS_PATH, { params: { runId } })).data.run,
    // A 404 is the run having expired, and no retry brings it back.
    retry: (failureCount, error) => apiStatusOf(error) !== 404 && failureCount < 2,
    refetchInterval: query =>
      query.state.data && runProgress(query.state.data) === 'running' ? RUNNING_REFETCH_MS : false,
  });

const RUNNING_REFETCH_MS = 5_000;

export const useLifecycleQueue = (enabled: boolean) =>
  useQuery({
    queryKey: LIFECYCLE_QUEUE_QUERY_KEY,
    queryFn: async () => (await api.get<LifecycleQueue>(LIFECYCLE_STATUS_PATH, { params: { view: 'queue' } })).data,
    enabled,
  });

const fetchStaleReferences = async (): Promise<LifecycleStatus> =>
  (await api.get<LifecycleStatus>(LIFECYCLE_STATUS_PATH)).data;

/** Never fetched on mount or by an invalidation: `refetch()` from "Check references" is the only way in. */
export const useStaleReferences = () =>
  useQuery({
    queryKey: STALE_REFERENCES_QUERY_KEY,
    queryFn: fetchStaleReferences,
    enabled: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

export const useStaleReferencesOutdated = () =>
  useQuery({
    queryKey: STALE_REFERENCES_OUTDATED_QUERY_KEY,
    queryFn: async () => false,
    enabled: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  }).data === true;

type ErrorLike = { response?: { status?: number; data?: unknown }; message?: string };

const responseData = (error: unknown): Record<string, unknown> => {
  const data = (error as ErrorLike | null)?.response?.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
};

export const apiStatusOf = (error: unknown): number | undefined => (error as ErrorLike | null)?.response?.status;

export const apiCodeOf = (error: unknown): string | undefined => {
  const code = responseData(error).code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * The server's own sentence for a failed call. The error envelope names it `error`
 * (server/middlewares/errorHandler.ts); `message` covers the routes that answer outside it.
 */
export const apiServerMessage = (error: unknown): string | undefined => {
  const data = responseData(error);
  if (typeof data.error === 'string' && data.error) return data.error;
  if (typeof data.message === 'string' && data.message) return data.message;
  return undefined;
};

export const apiErrorMessage = (error: unknown, fallback: string): string => {
  const server = apiServerMessage(error);
  if (server) return server;
  const message = (error as ErrorLike | null)?.message;
  return typeof message === 'string' && message ? message : fallback;
};
