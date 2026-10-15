import type { DevLogRecord, DevLogSnapshot } from '@shared/devLog';
import { redact } from './redact';

/**
 * What a publisher hands over. Built lazily - see {@link DevLogSink.publish} - so a source on a
 * hot path pays nothing while nobody is watching.
 */
export interface DevLogDraft {
  tags: readonly string[];
  message: string;
  /** Named one by one by the publisher, never spread from an object. Non-primitives are dropped. */
  fields?: Readonly<Record<string, unknown>>;
}

/** Lines retained. A reply at full speed fills this in well under a minute, which is the point. */
export const MAX_RECORDS = 2000;

/**
 * Characters retained across all lines, which is the cap that actually bounds memory: 2000
 * lines of the length below would be four times this, so whichever bites first wins.
 */
export const MAX_CHARS = 512_000;

/** One line's message. A delta payload is truncated to this at CAPTURE and never retained whole. */
export const MAX_MESSAGE_CHARS = 300;

/** One field's value, same reason. */
export const MAX_FIELD_CHARS = 160;

/** How long records wait before being pushed, so a token-rate source cannot drive one IPC each. */
export const FLUSH_MS = 100;

type Listener = (records: DevLogRecord[]) => void;

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

/**
 * One record, one line.
 *
 * Streamed reply text arrives with its newlines in it, and the clipboard copy joins records
 * with a newline - so a raw break would turn one record into several lines over there, with no
 * way to tell which. Escaped rather than stripped because whether a delta ended a line is
 * exactly the kind of thing this window is opened to see.
 */
function oneLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t');
}

/** Primitives only, clipped and scrubbed. Anything else is dropped rather than stringified. */
function safeFields(fields: Readonly<Record<string, unknown>> | undefined): DevLogRecord['fields'] {
  if (!fields) return undefined;
  const safe: Record<string, string | number | boolean> = {};
  let any = false;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') safe[key] = clip(oneLine(redact(value)), MAX_FIELD_CHARS);
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'boolean') safe[key] = value;
    else continue;
    any = true;
  }
  return any ? safe : undefined;
}

function weigh(record: DevLogRecord): number {
  let chars = record.message.length;
  for (const tag of record.tags) chars += tag.length;
  for (const [key, value] of Object.entries(record.fields ?? {})) {
    chars += key.length + (typeof value === 'string' ? value.length : 8);
  }
  return chars;
}

/**
 * The one developer-log buffer. Publishers call {@link publish}; a window attaches with
 * {@link attach} and is pushed batches until it detaches.
 *
 * Three things live here rather than in any publisher, so that every future source inherits them
 * for free: the "is anyone watching" check, credential scrubbing, and the caps.
 */
export class DevLogSink {
  private readonly buffer: (DevLogRecord | undefined)[] = new Array<DevLogRecord | undefined>(MAX_RECORDS);
  private head = 0;
  private size = 0;
  private chars = 0;
  private dropped = 0;
  private nextId = 1;
  private readonly listeners = new Set<Listener>();
  private pending: DevLogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Whether anything would be retained. Read it only to avoid work that cannot be deferred into
   * a draft; {@link publish} checks it again, so no publisher has to be trusted to.
   */
  get watching(): boolean {
    return this.listeners.size > 0;
  }

  /**
   * Record one line, if anyone is watching.
   *
   * `build` is a thunk on purpose: with the window closed this returns after one `Set.size`
   * read, so a per-token publisher never formats a string, interpolates a message or allocates
   * a tag array for a line nobody will read.
   */
  publish(build: () => DevLogDraft): void {
    if (this.listeners.size === 0) return;
    const draft = build();
    const fields = safeFields(draft.fields);
    const record: DevLogRecord = {
      id: this.nextId++,
      at: Date.now(),
      tags: [...draft.tags],
      message: clip(oneLine(redact(draft.message)), MAX_MESSAGE_CHARS),
      ...(fields ? { fields } : {}),
    };
    this.retain(record);
    this.pending.push(record);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  attach(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTimer();
    };
  }

  snapshot(): DevLogSnapshot {
    const records: DevLogRecord[] = [];
    for (let index = 0; index < this.size; index++) {
      const record = this.buffer[(this.head + index) % MAX_RECORDS];
      if (record) records.push(record);
    }
    return { records, dropped: this.dropped };
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.size = 0;
    this.chars = 0;
    this.dropped = 0;
    this.pending = [];
    this.stopTimer();
  }

  /** Flush whatever is queued now. Only the timer and the tests need this. */
  flush(): void {
    this.stopTimer();
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const listener of this.listeners) listener(batch);
  }

  private retain(record: DevLogRecord): void {
    if (this.size === MAX_RECORDS) this.evict();
    this.buffer[(this.head + this.size) % MAX_RECORDS] = record;
    this.size++;
    this.chars += weigh(record);
    while (this.chars > MAX_CHARS && this.size > 1) this.evict();
  }

  private evict(): void {
    const oldest = this.buffer[this.head];
    if (oldest) this.chars -= weigh(oldest);
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % MAX_RECORDS;
    this.size--;
    this.dropped++;
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** The app's one sink. Importing this module is all a new source needs. */
export const devLog = new DevLogSink();
