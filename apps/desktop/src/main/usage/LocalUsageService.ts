import type { LocalUsageResult, UsageWindowId } from '@shared/usage';
import { localUsageWindow, type LocalUsageBucket } from './localUsage';

/** The renderer names the window, so it is checked; UsageService has the same guard but also an API client. */
function isUsageWindow(value: unknown): value is UsageWindowId {
  return value === 'last-24-hours' || value === 'last-30-days';
}

/** Held briefly so flipping between the two windows does not re-stat every transcript. */
const CACHE_TTL_MS = 15_000;

export interface LocalUsageServiceDeps {
  logger: { warn(message: string): void };
  /** Every session's buckets in the current scope; see SessionStore.localUsageBuckets. */
  buckets(): Promise<LocalUsageBucket[]>;
  /** The conversation scope reads come from, so a cached answer never crosses a sign-in or sign-out. */
  scopeKey(): string | null;
  /** Saved model servers' names by id, read from this device's own settings. */
  serverNames(): Promise<ReadonlyMap<string, string>>;
  now?(): number;
}

/**
 * Usage of self-hosted models, computed from the conversations stored on this device.
 *
 * Makes no request of any kind: there is no API client here, and nothing it computes leaves main
 * except the aggregates handed to the renderer.
 */
export class LocalUsageService {
  private readonly cache = new Map<string, { at: number; result: LocalUsageResult }>();
  private readonly inFlight = new Map<string, Promise<LocalUsageResult>>();

  constructor(private readonly deps: LocalUsageServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  usage(window: UsageWindowId, force = false): Promise<LocalUsageResult> {
    if (!isUsageWindow(window)) return Promise.resolve({ ok: false, error: 'Unknown usage window.' });

    const key = `${this.deps.scopeKey() ?? ''}\n${window}`;
    const cached = this.cache.get(key);
    if (!force && cached && this.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.result);

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.read(window)
      .then(result => {
        if (result.ok) this.cache.set(key, { at: this.now(), result });
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async read(window: UsageWindowId): Promise<LocalUsageResult> {
    try {
      const [buckets, serverNames] = await Promise.all([this.deps.buckets(), this.deps.serverNames()]);
      const now = this.now();
      return { ok: true, usage: { ...localUsageWindow(buckets, window, now, serverNames), readAt: now } };
    } catch (err) {
      this.deps.logger.warn(`USAGE: local usage read failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: 'Could not read local model usage.' };
    }
  }
}
