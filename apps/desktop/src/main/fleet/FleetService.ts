import type { FleetConnectionCheck, FleetSettingsInput, FleetState } from '@shared/fleet';
import type { ActivityEvent } from './activityContract';
import { MAX_BATCH_EVENTS } from './activityContract';
import type { ActivityQueue } from './ActivityQueue';
import { fleetOrigin, type FleetClient } from './FleetClient';
import type { FleetSettingsStore } from './FleetSettingsStore';

/** How long activity gathers before a send, unless a full batch is already waiting. */
export const FLUSH_DELAY_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const KEY_RE = /^flmt_[0-9a-f]{12}_[0-9a-f]{48}$/;

export interface FleetServiceDeps {
  settings: FleetSettingsStore;
  queue: ActivityQueue;
  client: FleetClient;
  defaultUrl: string;
  logger: { warn(message: string): void };
  onState(state: FleetState): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export type SaveResult = { ok: true; state: FleetState } | { ok: false; error: string };

/**
 * Owns the Fleet integration in main: settings, the consent gate, and the send loop.
 *
 * Nothing is recorded, queued or sent while consent is off, and turning it off empties the
 * queue. A 401 or 403 from Fleet stops sending until the key or URL changes, since retrying a
 * refused key only fills Fleet's deny log.
 */
export class FleetService {
  private url: string;
  private consent = false;
  private key: string | null = null;
  private reconnectNeeded = false;
  private pending = 0;
  private lastSentAt: number | null = null;
  private lastResult: FleetState['lastResult'] = null;
  private lastError: string | null = null;
  private lastCheck: FleetConnectionCheck | null = null;
  private timer: unknown = null;
  private flushing: Promise<void> | null = null;
  private failures = 0;

  constructor(private readonly deps: FleetServiceDeps) {
    this.url = deps.defaultUrl;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async initialize(): Promise<void> {
    const stored = await this.deps.settings.read();
    this.url = stored.url ?? this.deps.defaultUrl;
    this.consent = stored.consent;
    this.key = stored.key;
    this.pending = await this.deps.queue.size();
    this.publish();
    if (this.status() === 'active' && this.pending > 0) this.schedule(0);
  }

  getState(): FleetState {
    return {
      url: this.url,
      defaultUrl: this.deps.defaultUrl,
      keyConfigured: this.key !== null,
      keyStorage: this.deps.settings.keyStorage(),
      consent: this.consent,
      status: this.status(),
      pending: this.pending,
      lastSentAt: this.lastSentAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      lastCheck: this.lastCheck,
    };
  }

  /** Whether chat activity should be turned into events at all. */
  recording(): boolean {
    return this.consent && this.key !== null;
  }

  async save(input: FleetSettingsInput): Promise<SaveResult> {
    const raw = typeof input?.url === 'string' ? input.url.trim() : '';
    const origin = raw === '' ? fleetOrigin(this.deps.defaultUrl) : fleetOrigin(raw);
    if (!origin) return { ok: false, error: 'Enter an https:// Fleet URL.' };

    let key = this.key;
    if (typeof input.key === 'string' && input.key.trim() !== '') {
      key = input.key.trim();
      if (!KEY_RE.test(key)) return { ok: false, error: 'That does not look like a Fleet machine key (flmt_...).' };
    }

    const changed = origin !== this.url || key !== this.key;
    this.url = origin;
    await this.deps.settings.setUrl(origin === fleetOrigin(this.deps.defaultUrl) ? null : origin);
    if (key !== this.key) {
      this.key = key;
      await this.deps.settings.setKey(key);
    }
    if (changed) {
      this.reconnectNeeded = false;
      this.lastError = null;
      this.lastCheck = null;
      this.failures = 0;
    }
    if (this.key) await this.check();
    this.publish();
    if (this.status() === 'active' && this.pending > 0) this.schedule(0);
    return { ok: true, state: this.getState() };
  }

  async forgetKey(): Promise<FleetState> {
    this.key = null;
    this.reconnectNeeded = false;
    this.lastCheck = null;
    await this.deps.settings.setKey(null);
    this.cancelTimer();
    this.publish();
    return this.getState();
  }

  async setConsent(consent: boolean): Promise<FleetState> {
    this.consent = consent === true;
    await this.deps.settings.setConsent(this.consent);
    if (!this.consent) {
      this.cancelTimer();
      await this.deps.queue.clear();
      this.pending = 0;
    }
    this.publish();
    if (this.status() === 'active' && this.pending > 0) this.schedule(0);
    return this.getState();
  }

  async testConnection(): Promise<FleetState> {
    await this.check();
    this.publish();
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
    if (this.pending >= MAX_BATCH_EVENTS) this.schedule(0);
    else if (this.timer === null) this.schedule(FLUSH_DELAY_MS);
  }

  dispose(): void {
    this.cancelTimer();
  }

  private status(): FleetState['status'] {
    if (!this.key) return 'not-configured';
    if (this.reconnectNeeded) return 'reconnect-needed';
    return this.consent ? 'active' : 'paused';
  }

  private async check(): Promise<void> {
    if (!this.key) return;
    this.lastCheck = await this.deps.client.status(this.url, this.key, this.now());
    if (this.lastCheck.ok) this.reconnectNeeded = false;
    else if (this.lastCheck.refused) this.reconnectNeeded = true;
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
    while (this.status() === 'active' && this.key) {
      const batch = await this.deps.queue.peek();
      this.pending = await this.deps.queue.size();
      if (!batch) break;
      const ids = batch.events.map(event => event.eventId);
      const outcome = await this.deps.client.ingest(this.url, this.key, batch);

      if (outcome.kind === 'accepted') {
        await this.deps.queue.remove(ids);
        this.failures = 0;
        this.lastSentAt = this.now();
        this.lastResult = { accepted: outcome.accepted, duplicates: outcome.duplicates };
        this.lastError = null;
      } else if (outcome.kind === 'rejected') {
        // Fleet will never take this batch, so retrying it would wedge everything behind it.
        await this.deps.queue.remove(ids);
        this.deps.logger.warn(`FLEET: Fleet rejected an activity batch (${outcome.status}); dropped it`);
        this.lastError = `Fleet rejected a batch (${outcome.status}); it was dropped.`;
      } else if (outcome.kind === 'unauthorized') {
        this.reconnectNeeded = true;
        this.lastError = 'Fleet refused the key. Paste a new one to resume.';
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
