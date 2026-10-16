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
  private loading: Promise<ActivityEvent[]> | null = null;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: VaultFile,
    private readonly now: () => number = Date.now,
    private readonly logger: { warn(message: string): void } = console
  ) {}

  size(): Promise<number> {
    return this.ordered(async () => (await this.load()).length);
  }

  async push(events: readonly ActivityEvent[]): Promise<void> {
    if (events.length === 0) return;
    const snapshot = [...events];
    return this.ordered(async () => {
      const queued = await this.load();
      queued.push(...snapshot);
      if (queued.length > MAX_QUEUED_EVENTS) queued.splice(0, queued.length - MAX_QUEUED_EVENTS);
      await this.persist();
    });
  }

  /** The next batch Fleet would accept. Events Fleet would now refuse (too old) are dropped first. */
  peek(): Promise<ActivityBatch | null> {
    return this.ordered(async () => {
      const queued = await this.load();
      const now = this.now();
      const valid = queued.filter(event => isValidEvent(event, now));
      if (valid.length !== queued.length) {
        this.events = valid;
        await this.persist();
      }
      return nextBatch(valid);
    });
  }

  remove(eventIds: readonly string[]): Promise<void> {
    const drop = new Set(eventIds);
    return this.ordered(async () => {
      this.events = (await this.load()).filter(event => !drop.has(event.eventId));
      await this.persist();
    });
  }

  clear(): Promise<void> {
    return this.ordered(async () => {
      this.events = [];
      await this.persist();
    });
  }

  // Order mutations as well as writes, including callers waiting on the initial disk read.
  private ordered<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action);
    this.operation = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<ActivityEvent[]> {
    if (this.events) return this.events;
    return (this.loading ??= this.readFromDisk());
  }

  private async readFromDisk(): Promise<ActivityEvent[]> {
    let events: ActivityEvent[] = [];
    try {
      const raw = await this.file.read();
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) events = parsed as ActivityEvent[];
    } catch {
      this.logger.warn('FLEET: activity queue unreadable, starting empty');
      events = [];
    }
    this.events = events;
    return events;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.events ?? []);
    await this.file.write(snapshot).catch(() => {
      this.logger.warn('FLEET: failed to write activity queue');
    });
  }
}
