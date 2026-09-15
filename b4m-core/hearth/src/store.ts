import type { AppendEventInput, HearthEvent } from './types';

export interface EventsSinceOptions {
  /** Max events to return; callers page by re-calling with the last seq. */
  limit?: number;
}

/**
 * Persistence contract for the Hearth event log. Implementations must
 * guarantee: (1) seq is monotonic and gap-free per channel, (2) appends with
 * a refs.externalId already present in the channel return the existing event
 * instead of duplicating (gateway echo-dedupe), (3) eventsSince returns
 * events strictly ordered by seq ascending.
 */
export interface HearthStore {
  appendEvent(input: AppendEventInput): Promise<HearthEvent>;
  eventsSince(channelId: string, sinceSeq: number, options?: EventsSinceOptions): Promise<HearthEvent[]>;
  getCursor(actorId: string, channelId: string): Promise<number>;
  setCursor(actorId: string, channelId: string, seq: number): Promise<void>;
}

/** In-memory HearthStore for tests and local development. Not durable. */
export class InMemoryHearthStore implements HearthStore {
  private eventsByChannel = new Map<string, HearthEvent[]>();
  private externalIdsByChannel = new Map<string, Map<string, HearthEvent>>();
  private cursors = new Map<string, number>();
  private nextId = 1;

  async appendEvent(input: AppendEventInput): Promise<HearthEvent> {
    const events = this.eventsByChannel.get(input.channelId) ?? [];

    if (input.refs.externalId) {
      const existing = this.externalIdsByChannel.get(input.channelId)?.get(input.refs.externalId);
      if (existing) return existing;
    }

    const event: HearthEvent = {
      ...input,
      id: String(this.nextId++),
      seq: events.length + 1,
      createdAt: new Date(),
    };

    events.push(event);
    this.eventsByChannel.set(input.channelId, events);

    if (input.refs.externalId) {
      const byExternalId = this.externalIdsByChannel.get(input.channelId) ?? new Map<string, HearthEvent>();
      byExternalId.set(input.refs.externalId, event);
      this.externalIdsByChannel.set(input.channelId, byExternalId);
    }

    return event;
  }

  async eventsSince(channelId: string, sinceSeq: number, options: EventsSinceOptions = {}): Promise<HearthEvent[]> {
    const events = this.eventsByChannel.get(channelId) ?? [];
    // seq is 1-based and dense, so slice by index instead of scanning.
    const from = Math.max(sinceSeq, 0);
    const slice = events.slice(from);
    return options.limit !== undefined ? slice.slice(0, options.limit) : slice;
  }

  async getCursor(actorId: string, channelId: string): Promise<number> {
    return this.cursors.get(`${actorId}:${channelId}`) ?? 0;
  }

  async setCursor(actorId: string, channelId: string, seq: number): Promise<void> {
    this.cursors.set(`${actorId}:${channelId}`, seq);
  }
}
