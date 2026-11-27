import { randomUUID } from 'node:crypto';
import type { ChatStreamEvent, EventCursor } from '@shared/chat';

export type SequencedEvent = ChatStreamEvent & { seq: number };

export type EventsSinceResult = { ok: true; events: SequencedEvent[] } | { ok: false; reason: 'snapshot-required' };

export type SessionEventLogOptions = {
  /** Names this process lifetime of the log; a cursor carrying another epoch predates a restart or a rotate. */
  epoch?: string;
  maxEvents?: number;
  maxBytes?: number;
};

type SessionLog = {
  /** The log's own epoch until the session's transcript is rewritten; see rotate. */
  epoch: string;
  lastSeq: number;
  events: Array<{ event: SequencedEvent; bytes: number }>;
  bytes: number;
};

const DEFAULT_MAX_EVENTS = 2000;
const DEFAULT_MAX_BYTES = 1_048_576;

/**
 * Numbers every stream event per session and keeps the current turn's events, so a client that
 * took a snapshot at cursor N can ask for exactly the events after N (ChatService.getSession hands
 * the cursor out beside the snapshot). Earlier turns are not kept: once a new 'start' arrives,
 * everything before it is in the stored transcript.
 */
export class SessionEventLog {
  readonly epoch: string;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly sessions = new Map<string, SessionLog>();

  constructor(options: SessionEventLogOptions = {}) {
    this.epoch = options.epoch ?? randomUUID();
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  append<E extends ChatStreamEvent>(event: E): E & { seq: number } {
    if (event.seq !== undefined) {
      throw new Error(`Stream event for ${event.sessionId} already carries seq ${event.seq}`);
    }
    const log = this.sessionLog(event.sessionId);
    const stamped = { ...event, seq: log.lastSeq + 1 };
    log.lastSeq = stamped.seq;
    if (event.type === 'start') {
      log.events = [];
      log.bytes = 0;
    }
    // An estimate of retained memory, not an exact count: JSON length is close enough to bound a
    // runaway turn and costs one serialisation per event.
    const bytes = JSON.stringify(stamped).length;
    log.events.push({ event: stamped, bytes });
    log.bytes += bytes;
    this.evict(log);
    return stamped;
  }

  cursor(sessionId: string): EventCursor {
    const log = this.sessions.get(sessionId);
    return { epoch: log?.epoch ?? this.epoch, seq: log?.lastSeq ?? 0 };
  }

  /**
   * Starts a new epoch for one session whose stored transcript was rewritten (an edit or a
   * regenerate dropped its end). Events only ever add to a transcript, so a client holding the
   * old one cannot be brought up to date by replay: its cursor stops resolving here, and the next
   * live event it sees carries an epoch it does not hold, which is its cue to read the session
   * again. `seq` keeps counting so no seq is ever reused within the session.
   */
  rotate(sessionId: string): void {
    const log = this.sessionLog(sessionId);
    log.epoch = randomUUID();
    log.events = [];
    log.bytes = 0;
  }

  since(sessionId: string, after: EventCursor): EventsSinceResult {
    const log = this.sessions.get(sessionId);
    const lastSeq = log?.lastSeq ?? 0;
    const epoch = log?.epoch ?? this.epoch;
    if (after.epoch !== epoch || !Number.isInteger(after.seq) || after.seq < 0 || after.seq > lastSeq)
      return { ok: false, reason: 'snapshot-required' };
    if (after.seq === lastSeq) return { ok: true, events: [] };
    // lastSeq > after.seq >= 0 here, so the log exists. Retained events are contiguous and end at
    // lastSeq, so the first one is the earliest seq that can still be replayed.
    const events = log?.events ?? [];
    const oldest = events[0]?.event.seq;
    if (oldest === undefined || oldest > after.seq + 1) return { ok: false, reason: 'snapshot-required' };
    return { ok: true, events: events.slice(after.seq + 1 - oldest).map(entry => entry.event) };
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private sessionLog(sessionId: string): SessionLog {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionLog = { epoch: this.epoch, lastSeq: 0, events: [], bytes: 0 };
    this.sessions.set(sessionId, created);
    return created;
  }

  private evict(log: SessionLog): void {
    let drop = 0;
    let bytes = log.bytes;
    while (drop < log.events.length && (log.events.length - drop > this.maxEvents || bytes > this.maxBytes)) {
      bytes -= log.events[drop].bytes;
      drop += 1;
    }
    if (drop === 0) return;
    log.events = log.events.slice(drop);
    log.bytes = bytes;
  }
}
