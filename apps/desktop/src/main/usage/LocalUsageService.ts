import { localUsageReadFailed, type LocalUsageResult, type LocalUsageScope, type UsageWindowId } from '@shared/usage';
import { localUsageWindow, type LocalUsageBucket } from './localUsage';

/** The renderer names the window, so it is checked; UsageService has the same guard but also an API client. */
function isUsageWindow(value: unknown): value is UsageWindowId {
  return value === 'last-24-hours' || value === 'last-30-days';
}

/** The scan is held briefly so flipping between the two windows does not re-stat every transcript. */
const CACHE_TTL_MS = 15_000;

type Scanned = Awaited<ReturnType<LocalUsageServiceDeps['scan']>>;
type ScanOutcome = { ok: true; scanned: Scanned } | { ok: false; error: string };

export interface LocalUsageServiceDeps {
  logger: { warn(message: string): void };
  /** Every session's buckets in the current scope, and its kind; see SessionStore.localUsage. */
  scan(force: boolean): Promise<{ scope: LocalUsageScope; account?: string; buckets: LocalUsageBucket[] }>;
  /** The conversation scope reads come from, so a cached answer never crosses a sign-in or sign-out. */
  scopeKey(): string | null;
  /** Saved model servers' names by id, read from this device's own settings. */
  serverNames(): Promise<ReadonlyMap<string, string>>;
  now?(): number;
}

/**
 * Usage of self-hosted models, computed from the conversations stored on this device. Makes no
 * request: there is no API client here, and only aggregates leave main.
 */
export class LocalUsageService {
  private readonly scans = new Map<string, { at: number; outcome: ScanOutcome }>();
  private readonly scanning = new Map<string, Promise<{ at: number; outcome: ScanOutcome }>>();

  constructor(private readonly deps: LocalUsageServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** `force` starts a new scan even where one is in flight, and only the newest scan is kept. */
  private scan(key: string, force: boolean): Promise<{ at: number; outcome: ScanOutcome }> {
    const cached = this.scans.get(key);
    if (!force && cached && this.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached);
    const existing = this.scanning.get(key);
    if (!force && existing) return existing;

    const pending: Promise<{ at: number; outcome: ScanOutcome }> = (async () => this.deps.scan(force))()
      .then(
        (scanned): ScanOutcome => ({ ok: true, scanned }),
        (err): ScanOutcome => {
          const reason = err instanceof Error ? err.message : String(err);
          this.deps.logger.warn(`USAGE: local usage read failed: ${reason}`);
          return { ok: false, error: localUsageReadFailed(reason) };
        }
      )
      .then(outcome => {
        const entry = { at: this.now(), outcome };
        if (this.scanning.get(key) === pending) {
          this.scans.set(key, entry);
          this.scanning.delete(key);
        }
        return entry;
      });
    this.scanning.set(key, pending);
    return pending;
  }

  async usage(window: UsageWindowId, force = false): Promise<LocalUsageResult> {
    if (!isUsageWindow(window)) return { ok: false, error: 'Unknown usage window.' };
    const { at, outcome } = await this.scan(this.deps.scopeKey() ?? '', force);
    if (!outcome.ok) return outcome;
    const { scope, account, buckets } = outcome.scanned;
    const serverNames = await this.readServerNames();
    return {
      ok: true,
      usage: {
        ...localUsageWindow(buckets, window, this.now(), serverNames),
        scope,
        ...(account ? { account } : {}),
        readAt: at,
      },
    };
  }

  /** Null when the saved servers cannot be read; the breakdown then names servers by runtime id. */
  private async readServerNames(): Promise<ReadonlyMap<string, string> | null> {
    try {
      return await this.deps.serverNames();
    } catch (err) {
      this.deps.logger.warn(`USAGE: could not read server names: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
