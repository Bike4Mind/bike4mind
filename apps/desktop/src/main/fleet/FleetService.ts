import type { FleetState } from '@shared/fleet';
import type { ActivityEvent } from './activityContract';
import { MAX_BATCH_EVENTS } from './activityContract';
import type { ActivityQueue } from './ActivityQueue';
import type { FleetClient } from './FleetClient';
import type { FleetConfig, FleetConfigResult } from './FleetConfig';
import type { FleetSettingsStore } from './FleetSettingsStore';
import { toOtlpLogs } from './otlp';

/** How long activity gathers before a send, unless a full batch is already waiting. */
export const FLUSH_DELAY_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export interface FleetServiceDeps {
  settings: FleetSettingsStore;
  queue: ActivityQueue;
  client: FleetClient;
  /** Reads Fleet's installer file; called at start and on every refresh. */
  readConfig(): Promise<FleetConfigResult>;
  /** The installer file's path for display, home as `~`. */
  configPath: string;
  appVersion: string;
  logger: { warn(message: string): void };
  onState(state: FleetState): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * Owns the Fleet integration in main: the installer file, the consent gate, and the send loop.
 *
 * Nothing is recorded, queued or sent while consent is off or the file is unusable, and turning
 * consent off empties the queue. A 401 or 403 stops sending until the file's key changes, which
 * is what rerunning the Fleet installer after a key rotation does.
 */
export class FleetService {
  private config: FleetConfigResult = { kind: 'not-installed' };
  private consent = false;
  private refusedKey: string | null = null;
  private pending = 0;
  private lastSentAt: number | null = null;
  private lastResult: FleetState['lastResult'] = null;
  private lastError: string | null = null;
  private timer: unknown = null;
  private flushing: Promise<void> | null = null;
  private failures = 0;

  constructor(private readonly deps: FleetServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async initialize(): Promise<void> {
    this.consent = (await this.deps.settings.read()).consent;
    this.config = await this.deps.readConfig();
    if (!this.consent) await this.clearQueue();
    this.pending = await this.deps.queue.size();
    this.publish();
    if (this.status() === 'active' && this.pending > 0) this.schedule(0);
  }

  getState(): FleetState {
    const usable = this.usable();
    return {
      connection: this.config.kind,
      configPath: this.deps.configPath,
      fleetUrl: 'config' in this.config ? this.config.config.endpoint : null,
      email: usable?.email ?? null,
      consent: this.consent,
      status: this.status(),
      pending: this.pending,
      lastSentAt: this.lastSentAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }

  /** Whether chat activity should be turned into events at all. */
  recording(): boolean {
    return this.consent && this.usable() !== null;
  }

  /** Read the installer file again, and resume sending if its key changed since Fleet refused one. */
  async refresh(): Promise<FleetState> {
    const before = this.usable()?.key ?? null;
    this.config = await this.deps.readConfig();
    const after = this.usable()?.key ?? null;
    if (after !== before) {
      this.failures = 0;
      if (this.refusedKey !== null && this.refusedKey !== after) this.lastError = null;
    }
    this.publish();
    if (this.status() === 'active' && this.pending > 0 && this.timer === null) this.schedule(0);
    return this.getState();
  }

  async setConsent(consent: boolean): Promise<FleetState> {
    // Re-enabling must not make a failed opt-out clear durable as consent=true.
    if (consent && !this.consent && !(await this.clearQueue())) {
      this.publish();
      return this.getState();
    }
    this.consent = consent === true;
    await this.deps.settings.setConsent(this.consent);
    if (!this.consent) {
      this.cancelTimer();
      await this.clearQueue();
    }
    this.publish();
    if (this.status() === 'active' && this.pending > 0) this.schedule(0);
    return this.getState();
  }

  /** Send everything waiting now, rather than at the next scheduled flush. */
  async sendNow(): Promise<FleetState> {
    this.cancelTimer();
    this.failures = 0;
    await this.flush();
    return this.getState();
  }

  async record(events: readonly ActivityEvent[]): Promise<void> {
    if (!this.recording() || events.length === 0) return;
    await this.deps.queue.push(events);
    this.pending = await this.deps.queue.size();
    this.publish();
    if (this.status() !== 'active') return;
    if (this.failures === 0 && this.pending >= MAX_BATCH_EVENTS) this.schedule(0);
    else if (this.timer === null) this.schedule(FLUSH_DELAY_MS);
  }

  dispose(): void {
    this.cancelTimer();
  }

  private async clearQueue(): Promise<boolean> {
    this.pending = 0;
    try {
      await this.deps.queue.clear();
      this.lastError = null;
      return true;
    } catch {
      this.lastError = 'Could not clear saved activity. Sharing stays off. Check available disk space and try again.';
      return false;
    }
  }

  /** The config only when Fleet could attribute what is sent: a file with no email would be dropped there. */
  private usable(): FleetConfig | null {
    return this.config.kind === 'connected' ? this.config.config : null;
  }

  private status(): FleetState['status'] {
    const config = this.usable();
    if (!config) return 'not-configured';
    if (this.refusedKey === config.key) return 'reconnect-needed';
    return this.consent ? 'active' : 'paused';
  }

  private flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.status() === 'active') {
      const config = this.usable();
      if (!config) break;
      const batch = await this.deps.queue.peek();
      this.pending = await this.deps.queue.size();
      if (!batch || this.status() !== 'active') break;
      const ids = batch.events.map(event => event.eventId);
      const body = toOtlpLogs(batch, {
        appVersion: this.deps.appVersion,
        email: config.email,
        installId: config.installId,
      });
      const outcome = await this.deps.client.sendLogs(config.endpoint, config.key, body);

      if (outcome.kind === 'accepted') {
        await this.deps.queue.remove(ids);
        this.failures = 0;
        this.lastSentAt = this.now();
        this.lastResult = { sent: ids.length };
        this.lastError = null;
      } else if (outcome.kind === 'rejected') {
        // Fleet will never take this batch, so retrying it would wedge everything behind it.
        await this.deps.queue.remove(ids);
        this.deps.logger.warn(`FLEET: Fleet rejected an activity batch (${outcome.status}); dropped it`);
        this.lastError = `Fleet rejected a batch (${outcome.status}); it was dropped.`;
      } else if (outcome.kind === 'unauthorized') {
        this.refusedKey = config.key;
        this.lastError = 'Fleet refused the installer key. Run the Fleet installer again to update it.';
        this.deps.logger.warn(`FLEET: Fleet refused the key (${outcome.status}); sending stopped`);
      } else {
        this.failures += 1;
        this.lastError = outcome.status
          ? `Fleet answered ${outcome.status}; will retry.`
          : 'Could not reach Fleet; will retry.';
        this.pending = await this.deps.queue.size();
        this.publish();
        this.schedule(Math.min(FLUSH_DELAY_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS));
        return;
      }
      this.pending = await this.deps.queue.size();
      this.publish();
    }
    this.publish();
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    const set = this.deps.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
    this.timer = set(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    const clear = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clear(this.timer);
    this.timer = null;
  }

  private publish(): void {
    this.deps.onState(this.getState());
  }
}
