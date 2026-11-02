import type { ServerResponse } from 'node:http';
import type { HostFacts } from '@bike4mind/common/modelHub';
import { HttpError } from './server';

export interface HostEventsOptions {
  facts: () => Promise<HostFacts>;
  /** How often facts are re-read while anyone listens; a stream that already has them gets a keepalive (ms). */
  intervalMs: number;
  /** Per subscriber key, so streams on one socket cannot lock out another's. */
  maxStreams: number;
  /** A stream whose client stopped reading is dropped past this much unsent data. */
  maxBufferedBytes: number;
  /** Told once when facts reads start failing; listeners only see keepalives meanwhile. */
  log?: (line: string) => void;
}

/** `GET /v1/events`: server-sent `host` events, the current facts first and then whenever they change. */
export class HostEvents {
  /** Each stream with its subscriber key and the facts it was last sent. */
  #streams = new Map<ServerResponse, { key: string; sent: string | null }>();
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

  #send(res: ServerResponse, data: string | null): void {
    const stream = this.#streams.get(res);
    if (res.destroyed || !stream) return;
    const fresh = data !== null && data !== stream.sent;
    if (fresh) stream.sent = data;
    res.write(fresh ? `event: host\ndata: ${data}\n\n` : ': keepalive\n\n');
    if (res.writableLength > this.options.maxBufferedBytes) res.destroy();
  }

  async #tick(): Promise<void> {
    const data = await this.#read();
    for (const res of this.#streams.keys()) this.#send(res, data);
  }

  async subscribe(res: ServerResponse, key: string): Promise<void> {
    const open = [...this.#streams.values()].filter(stream => stream.key === key).length;
    if (open >= this.options.maxStreams) {
      throw new HttpError(503, 'too-many-streams', 'Too many open event streams.');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write('retry: 5000\n\n');
    this.#streams.set(res, { key, sent: null });
    res.on('close', () => {
      this.#streams.delete(res);
      if (!this.#streams.size && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    });
    this.#timer ??= setInterval(() => void this.#tick(), this.options.intervalMs);
    this.#send(res, await this.#read());
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const res of this.#streams.keys()) res.end();
    this.#streams.clear();
  }
}
