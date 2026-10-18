import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AccountUsageResult, UsageWindowId } from '@shared/usage';
import {
  dailyBars,
  featureRows,
  hourlyBars,
  modelRows,
  sourceRows,
  sumBars,
  type LedgerRow,
  type SpendDay,
} from './usageBuckets';

/** One owner's spend rolled up by day, model, feature and source. Clamps `days` to 1..365. */
const USAGE_PATH = '/api/usage';
/** The raw ledger. The only read fine-grained enough to bucket by hour. */
const LEDGER_PATH = '/api/credits/transactions';

const WINDOW_DAYS: Record<UsageWindowId, number> = {
  'last-24-hours': 1,
  'last-30-days': 30,
};

/** The renderer names the window, so it is checked rather than trusted to index the table. */
export function isUsageWindow(value: unknown): value is UsageWindowId {
  return typeof value === 'string' && value in WINDOW_DAYS;
}

/**
 * How long an answer stays good.
 *
 * Cached, unlike the balance next door in AccountService, and for the opposite reason. The
 * balance is read at the one moment it can have changed, so a TTL would serve a stale figure
 * exactly when it is wrong. This is several aggregations over a month of events answering
 * "where did it go" - a question about the past, which a minute cannot materially change. The
 * cache is what stops re-opening the screen, or flipping between the two windows, from
 * re-running those aggregations every time. Someone who just spent credits and wants to watch
 * it land comes through `force`, which the screen's Refresh wires straight to.
 */
const CACHE_TTL_MS = 60_000;

interface WireUsage {
  overTime?: SpendDay[];
  byModel?: Record<string, unknown>[];
  byFeature?: Record<string, unknown>[];
  bySource?: Record<string, unknown>[];
}

export interface UsageServiceLogger {
  warn(message: string): void;
}

export interface UsageServiceDeps {
  logger: UsageServiceLogger;
  /** Null when signed out; every read here is authenticated, so there is nothing to fetch. */
  getApiClient(): AuthenticatedApiClient | null;
  /** The signed-in account's id. `/api/usage` refuses any id but the caller's own. */
  getUserId(): string | null;
  now?(): number;
}

/**
 * The signed-in account's spend history, read on demand and held briefly.
 *
 * Reads only the caller's own usage: `ownerId` is the id main already holds for the signed-in
 * account, and the route rejects a non-admin asking for anyone else's.
 */
export class UsageService {
  private readonly cache = new Map<UsageWindowId, { at: number; result: AccountUsageResult }>();
  private readonly inFlight = new Map<UsageWindowId, Promise<AccountUsageResult>>();

  constructor(private readonly deps: UsageServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  history(window: UsageWindowId, force = false): Promise<AccountUsageResult> {
    if (!isUsageWindow(window)) return Promise.resolve({ ok: false, error: 'Unknown usage window.' });

    const cached = this.cache.get(window);
    if (!force && cached && this.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.result);

    const existing = this.inFlight.get(window);
    if (existing) return existing;

    const pending = this.read(window)
      .then(result => {
        // Only a good answer is held. A cached failure would leave the screen's own Retry doing
        // nothing for the minute the user is most likely to press it.
        if (result.ok) this.cache.set(window, { at: this.now(), result });
        return result;
      })
      .finally(() => this.inFlight.delete(window));

    this.inFlight.set(window, pending);
    return pending;
  }

  private async read(window: UsageWindowId): Promise<AccountUsageResult> {
    const api = this.deps.getApiClient();
    const userId = this.deps.getUserId();
    if (!api || !userId) return { ok: false, error: 'Sign in to see your usage.' };

    const days = WINDOW_DAYS[window];
    const hourly = window === 'last-24-hours';

    try {
      const query = new URLSearchParams({ ownerType: 'User', ownerId: userId, days: String(days) });
      const [usage, ledger] = await Promise.all([
        api.get<WireUsage>(`${USAGE_PATH}?${query.toString()}`),
        hourly ? api.get<LedgerRow[]>(`${LEDGER_PATH}?days=1&type=deducted`) : Promise.resolve(null),
      ]);

      if (hourly && !Array.isArray(ledger)) {
        this.deps.logger.warn('USAGE: the credit ledger answered without rows');
        return { ok: false, error: 'This server did not report your recent credit usage.' };
      }

      const now = new Date(this.now());
      const bars = hourly ? hourlyBars(ledger as LedgerRow[], now) : dailyBars(usage?.overTime ?? [], now, days);

      return {
        ok: true,
        usage: {
          window,
          granularity: hourly ? 'hour' : 'day',
          bars,
          ...sumBars(bars),
          byModel: modelRows(usage?.byModel ?? []),
          byFeature: featureRows(usage?.byFeature ?? []),
          bySource: sourceRows(usage?.bySource ?? []),
          readAt: this.now(),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`USAGE: history lookup failed: ${message}`);
      return { ok: false, error: 'Could not read your usage from this server.' };
    }
  }
}
