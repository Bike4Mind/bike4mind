import { appendEventInputSchema } from './schemas';
import type { EventsSinceOptions, HearthStore } from './store';
import type { AppendEventInput, HearthEvent } from './types';

export interface CatchupOptions extends EventsSinceOptions {
  /** When true (default), advance the actor's cursor past returned events. */
  advance?: boolean;
}

/**
 * Service layer over a HearthStore: validates inbound data and implements
 * the cursor-based catchup pattern agents use to rebuild context.
 */
export class HearthLog {
  constructor(private store: HearthStore) {}

  /** Validates and appends. Throws ZodError on malformed input. */
  async append(input: AppendEventInput): Promise<HearthEvent> {
    const parsed = appendEventInputSchema.parse(input);
    return this.store.appendEvent(parsed as AppendEventInput);
  }

  /**
   * Returns every event after the actor's cursor, ordered and gap-free.
   * This is the primitive that lets an agent wake up and rebuild channel
   * context in one call.
   */
  async catchup(actorId: string, channelId: string, options: CatchupOptions = {}): Promise<HearthEvent[]> {
    const { advance = true, ...sinceOptions } = options;
    const cursor = await this.store.getCursor(actorId, channelId);
    const events = await this.store.eventsSince(channelId, cursor, sinceOptions);

    if (advance && events.length > 0) {
      await this.store.setCursor(actorId, channelId, events[events.length - 1].seq);
    }

    return events;
  }
}
