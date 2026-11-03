import type { ServerResponse } from 'node:http';
import type { HostFacts, ModelHostRole } from '@bike4mind/common/modelHub';
import { roleAllows } from './router';
import { HttpError } from './server';

export interface HostEvent {
  event: string;
  data: unknown;
  /** The lowest role whose streams get it. */
  role: ModelHostRole;
}

export interface HostEventsOptions {
  facts: () => Promise<HostFacts>;
  /** Events a new stream gets right after the current facts, such as every job. */
  snapshot?: () => HostEvent[];
  /** How often facts are re-read while anyone listens; a stream that already has them gets a keepalive (ms). */
  intervalMs: number;
  /** Per subscriber key, so streams on one socket cannot lock out another's. */
  maxStreams: number;
  /** A stream whose client stopped reading is dropped past this much unsent data. */
  maxBufferedBytes: number;
  /** Told once when facts reads start failing; listeners only see keepalives meanwhile. */
  log?: (line: string) => void;
}

const frame = (event: HostEvent) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

interface Stream {
  key: string;
  role: ModelHostRole;
  /** The facts it was last sent. */
  sent: string | null;
}

/**
 * `GET /v1/events`: server-sent `host` events, the current facts first and then whenever they change, plus whatever
 * `publish` sends to streams whose role allows it.
 */
export class HostEvents {
  #streams = new Map<ServerResponse, Stream>();
  #timer: NodeJS.Timeout | null = null;
  #failing = false;

  constructor(private readonly options: HostEventsOptions) {}

  get size(): number {
    return this.#streams.size;
  }

  async #read(): Promise<string | null> {
    try {
      const data = JSON.stringify(await this.options.facts());
      this.#failing = false;
      return data;
    } catch (error) {
      if (!this.#failing) {
        this.#failing = true;
        this.options.log?.(
          `reading host facts for events failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  #write(res: ServerResponse, text: string): void {
    if (res.destroyed) return;
    res.write(text);
    if (res.writableLength > this.options.maxBufferedBytes) res.destroy();
  }

  #sendFacts(res: ServerResponse, data: string | null): void {
    const stream = this.#streams.get(res);
    if (!stream) return;
    const fresh = data !== null && data !== stream.sent;
    if (fresh) stream.sent = data;
    this.#write(res, fresh ? `event: host\ndata: ${data}\n\n` : ': keepalive\n\n');
  }

  async #tick(): Promise<void> {
    const data = await this.#read();
    for (const res of this.#streams.keys()) this.#sendFacts(res, data);
  }

  publish(event: HostEvent): void {
    const text = frame(event);
    for (const [res, stream] of this.#streams) if (roleAllows(stream.role, event.role)) this.#write(res, text);
  }

  async subscribe(res: ServerResponse, key: string, role: ModelHostRole): Promise<void> {
    const open = [...this.#streams.values()].filter(stream => stream.key === key).length;
    if (open >= this.options.maxStreams) {
      throw new HttpError(503, 'too-many-streams', 'Too many open event streams.');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write('retry: 5000\n\n');
    this.#streams.set(res, { key, role, sent: null });
    res.on('close', () => {
      this.#streams.delete(res);
      if (!this.#streams.size && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    });
    this.#timer ??= setInterval(() => void this.#tick(), this.options.intervalMs);
    this.#sendFacts(res, await this.#read());
    for (const event of this.options.snapshot?.() ?? []) {
      if (roleAllows(role, event.role)) this.#write(res, frame(event));
    }
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const res of this.#streams.keys()) res.end();
    this.#streams.clear();
  }
}
