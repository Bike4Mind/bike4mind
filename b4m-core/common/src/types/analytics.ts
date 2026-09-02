export interface IBaseEvent {
  type: string;
  /** ID of the user who triggered the event */
  userId?: string;
  counterValue?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Where a credit-bearing action originated. Used in analytics events
 * (CounterLog.metadata.source) and in the financial ledger
 * (CreditTransaction.source) so reports can break down usage by surface.
 *
 * - `web`:    User-driven action in the browser (web chat, image gen UI, etc.)
 * - `cli`:    Request from the B4M CLI (identified by `b4m-cli/<ver>` User-Agent)
 * - `api`:    Third-party API key holder hitting public endpoints (no CLI UA)
 * - `agent`:  Server-side agent execution (Quest agents, automation)
 * - `system`: Background/cron jobs, internal scripts
 */
export type CompletionSource = 'web' | 'cli' | 'api' | 'agent' | 'system';

export const COMPLETION_SOURCES = ['web', 'cli', 'api', 'agent', 'system'] as const;

/**
 * Response shape for the `/api/admin/usage-by-source` endpoint and any
 * consumer that surfaces counter-log activity grouped by `metadata.source`.
 * Hoisted here so the server handler and the client hook share one contract.
 */
export interface UsageBySourceBucket {
  source: CompletionSource;
  events: number;
  uniqueUsers: number;
}

export interface UsageBySourceResponse {
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  buckets: UsageBySourceBucket[];
}

/**
 * One endpoint+method's request/latency rollup from the API-key usage log
 * (ApiKeyUsageLog). Request counts and latency only - this collection carries no
 * credits/COGS/feature, so this section must stay distinct from the UsageEvent
 * (COGS/credits) cuts and never imply COGS-per-endpoint.
 */
export interface IEndpointUsageBucket {
  endpoint: string;
  method: string;
  requests: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  /** Fraction 0..1 of requests with statusCode >= 400. */
  errorRate: number;
}

/** Endpoint request count for one UTC day (over-time chart point). */
export interface IEndpointUsageDay {
  day: string; // YYYY-MM-DD (UTC)
  requests: number;
}

/**
 * Endpoint-level platform usage from ApiKeyUsageLog. This collection logs only
 * API-key-authed requests and has a 90-day TTL, so windows beyond 90d degrade to
 * credit/feature (UsageEvent) data only.
 */
export interface IPlatformEndpointUsage {
  byEndpoint: IEndpointUsageBucket[];
  overTime: IEndpointUsageDay[];
}

/**
 * One API key's observed traffic against a set of routes, from ApiKeyUsageLog.
 * The join key is `keyId`, which is the UserApiKey document id (set by
 * userApiKeyService/validate.ts).
 */
export interface IApiKeyEndpointTraffic {
  keyId: string;
  userId: string;
  requests: number;
  lastUsed: Date;
  /** Distinct endpoints this key hit under the prefix, capped for display. */
  endpoints: string[];
}

/**
 * What the scope gate WOULD decide for one key if a set of `requiredScopes`
 * were declared on the routes it has been calling.
 *
 * `outcome` mirrors ScopeGateDecision (apps/client/server/middlewares/apiKeyScopeGate.ts)
 * and is produced by calling that module's `decideScopeGate` - never by
 * reimplementing its rules here. A preflight that drifts from the runtime gate
 * reports a confidently wrong re-mint list, which is worse than no preflight.
 */
export interface IApiKeyScopePreflightRow extends IApiKeyEndpointTraffic {
  /** Scopes the key was actually minted with. */
  heldScopes: string[];
  /** 'deny' = 403s on enforcement. 'stagedAllow' = only surviving via staging. */
  outcome: 'allow' | 'stagedAllow' | 'deny';
}

/**
 * Result of a scope-enforcement preflight: who breaks if these scopes are
 * declared on these routes.
 */
export interface IApiKeyScopePreflight {
  endpointPrefix: string;
  requiredScopes: string[];
  /** Days of history examined. ApiKeyUsageLog's TTL caps real coverage at 90. */
  windowDays: number;
  /** Scopes currently staged, so a stagedAllow row is explicable. */
  stagedScopes: string[];
  /** Every key seen on these routes in the window, worst outcome first. */
  rows: IApiKeyScopePreflightRow[];
  /** True when the row cap was hit, so the caller knows the list is partial. */
  truncated: boolean;
}

/**
 * Resolves source for the /api/ai/v1/completions endpoint. This endpoint is
 * called only by CLI and 3rd-party API users (never by web chat - that uses a
 * different pipeline). We distinguish CLI from raw API by the `b4m-cli/`
 * User-Agent header set by the CLI's HTTP client.
 */
export function resolveApiCompletionSource(headers: Record<string, string | undefined>): CompletionSource {
  const lookup = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) return headers[key];
    }
    return undefined;
  };
  const ua = lookup('user-agent') ?? lookup('x-b4m-client') ?? '';
  return /^b4m-cli\//i.test(ua) ? 'cli' : 'api';
}
