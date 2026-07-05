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
