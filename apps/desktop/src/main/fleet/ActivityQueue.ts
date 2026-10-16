import type { VaultFile } from '../auth/tokenVault';
import { isValidEvent, nextBatch, type ActivityBatch, type ActivityEvent } from './activityContract';

/** Oldest events go first past this; a week offline at a busy pace stays well under it. */
export const MAX_QUEUED_EVENTS = 5000;

/**
 * Activity waiting to be sent, persisted so a quit or crash does not lose it and a retry after
 * a restart reuses the same event ids. Fleet dedupes on those ids, so a batch sent twice is
 * counted once.
 */
export class ActivityQueue {
  private events: ActivityEvent[] | null = null;

  constructor(
    private readonly file: VaultFile,
    private readonly now: () => number = Date.now
  ) {}

  async size(): Promise<number> {
    return (await this.load()).length;
  }

  async push(events: readonly ActivityEvent[]): Promise<void> {
    if (events.length === 0) return;
    const queued = await this.load();
    queued.push(...events);
    if (queued.length > MAX_QUEUED_EVENTS) queued.splice(0, queued.length - MAX_QUEUED_EVENTS);
    await this.persist();
  }

  /** The next batch Fleet would accept. Events Fleet would now refuse (too old) are dropped first. */
  async peek(): Promise<ActivityBatch | null> {
    const queued = await this.load();
    const now = this.now();
    const valid = queued.filter(event => isValidEvent(event, now));
    if (valid.length !== queued.length) {
      this.events = valid;
      await this.persist();
    }
    return nextBatch(valid);
  }

  async remove(eventIds: readonly string[]): Promise<void> {
    const drop = new Set(eventIds);
    this.events = (await this.load()).filter(event => !drop.has(event.eventId));
    await this.persist();
  }

  async clear(): Promise<void> {
    this.events = [];
    await this.persist();
  }

  private async load(): Promise<ActivityEvent[]> {
    if (this.events) return this.events;
    let events: ActivityEvent[] = [];
    try {
      const raw = await this.file.read();
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) events = parsed as ActivityEvent[];
    } catch {
      events = [];
    }
    this.events = events;
    return events;
  }

  private async persist(): Promise<void> {
    await this.file.write(JSON.stringify(this.events ?? [])).catch(() => undefined);
  }
}
