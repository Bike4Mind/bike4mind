import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AccountCredits } from '@shared/account';

/**
 * Built for exactly this: the route exempts its reads from the daily rate limit so a client
 * can ask its own balance between calls, and it answers `Cache-Control: private, no-store`.
 */
const ME_PATH = '/api/v1/me';

/** The one field of `MeResponse` this client reads. Everything else on the wire is ignored. */
interface WireMe {
  credits?: { balance?: unknown };
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
 * The signed-in account's credit balance, read on demand.
 *
 * Deliberately NOT cached with a TTL, unlike ModelCatalog. The caller asks at the one moment
 * the number can have changed - a turn just finished spending - so a TTL would serve the stale
 * figure at exactly the point it is wrong. Genuinely concurrent asks share one request, which
 * collapses a burst without ever holding an answer past the ask that wanted it.
 */
export class AccountService {
  private inFlight: Promise<AccountCredits> | null = null;

  constructor(private readonly deps: AccountServiceDeps) {}

  credits(): Promise<AccountCredits> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async read(): Promise<AccountCredits> {
    const api = this.deps.getApiClient();
    if (!api) return { balance: null, error: 'Sign in to see your balance.' };

    try {
      const response = await api.get<WireMe>(ME_PATH);
      const balance = readBalance(response);
      if (balance === null) {
        this.deps.logger.warn('ACCOUNT: /api/v1/me answered without a credit balance');
        return { balance: null, error: 'This server did not report a balance.' };
      }
      return { balance };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`ACCOUNT: balance lookup failed: ${message}`);
      return { balance: null, error: 'Could not read your balance from this server.' };
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
