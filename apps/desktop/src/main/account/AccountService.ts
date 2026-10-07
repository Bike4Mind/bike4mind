import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AccountCredits, AccountPlan, AccountProfile, AccountTier } from '@shared/account';

/**
 * Built for exactly this: the route exempts its reads from the daily rate limit so a client
 * can ask its own balance between calls, and it answers `Cache-Control: private, no-store`.
 */
const ME_PATH = '/api/v1/me';

const TIERS: readonly AccountTier[] = ['free', 'basic', 'pro', 'other'];

/** The fields of `MeResponse` this client reads. Everything else on the wire is ignored. */
interface WireMe {
  credits?: { balance?: unknown };
  tier?: unknown;
  subscription?: { plan_name?: unknown; interval?: unknown; current_period_ends_at?: unknown } | null;
}

export interface AccountServiceLogger {
  warn(message: string): void;
}

export interface AccountServiceDeps {
  logger: AccountServiceLogger;
  /** Null when signed out; the balance is an authenticated read, so there is nothing to fetch. */
  getApiClient(): AuthenticatedApiClient | null;
}

/**
 * The signed-in account's commercial state, read on demand.
 *
 * Deliberately NOT cached with a TTL, unlike ModelCatalog. The caller asks at the one moment
 * the number can have changed - a turn just finished spending - so a TTL would serve the stale
 * figure at exactly the point it is wrong. Genuinely concurrent asks share one request, which
 * collapses a burst without ever holding an answer past the ask that wanted it.
 *
 * Balance and plan come off the same endpoint and therefore the same read: the profile screen
 * asks for both at once, and two calls would be two round-trips describing one account at two
 * instants.
 */
export class AccountService {
  private inFlight: Promise<AccountProfile> | null = null;

  constructor(private readonly deps: AccountServiceDeps) {}

  profile(): Promise<AccountProfile> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  credits(): Promise<AccountCredits> {
    return this.profile().then(profile => profile.credits);
  }

  private async read(): Promise<AccountProfile> {
    const api = this.deps.getApiClient();
    if (!api) return { credits: { balance: null, error: 'Sign in to see your balance.' }, plan: null, tier: null };

    try {
      const response = await api.get<WireMe>(ME_PATH);
      const balance = readBalance(response);
      if (balance === null) {
        this.deps.logger.warn('ACCOUNT: /api/v1/me answered without a credit balance');
        return {
          credits: { balance: null, error: 'This server did not report a balance.' },
          plan: readPlan(response),
          tier: readTier(response),
        };
      }
      return { credits: { balance }, plan: readPlan(response), tier: readTier(response) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`ACCOUNT: balance lookup failed: ${message}`);
      return {
        credits: { balance: null, error: 'Could not read your balance from this server.' },
        plan: null,
        tier: null,
      };
    }
  }
}

/**
 * The balance out of a `/api/v1/me` body, or null when the server did not state one.
 *
 * A non-finite number is treated as not stated rather than passed through: NaN formats as
 * "NaN credits", which reads like a figure the account really has.
 */
export function readBalance(wire: unknown): number | null {
  if (!wire || typeof wire !== 'object') return null;
  const balance = (wire as WireMe).credits?.balance;
  return typeof balance === 'number' && Number.isFinite(balance) ? balance : null;
}

/**
 * The active subscription out of a `/api/v1/me` body, or null when there is none to name.
 *
 * Every field is required for the plan to be worth drawing - a row reading "ends Invalid Date"
 * is worse than no row - so a partial subscription object comes back as no plan at all.
 */
export function readPlan(wire: unknown): AccountPlan | null {
  if (!wire || typeof wire !== 'object') return null;
  const subscription = (wire as WireMe).subscription;
  if (!subscription || typeof subscription !== 'object') return null;

  const { plan_name: name, interval, current_period_ends_at: endsAt } = subscription;
  if (typeof name !== 'string' || !name) return null;
  if (interval !== 'monthly' && interval !== 'yearly') return null;
  if (typeof endsAt !== 'string' || Number.isNaN(new Date(endsAt).getTime())) return null;

  return { name, interval, currentPeriodEndsAt: endsAt };
}

export function readTier(wire: unknown): AccountTier | null {
  if (!wire || typeof wire !== 'object') return null;
  const tier = (wire as WireMe).tier;
  return TIERS.includes(tier as AccountTier) ? (tier as AccountTier) : null;
}
