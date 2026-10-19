/**
 * Reassembles the chunk envelope the subscriber-fanout splits oversized pushes into:
 * `{ _chunked: true, _chunkId, _chunkIndex, _totalChunks, _data }`. Each `_data` piece is
 * independently valid UTF-8 (the fanout splits on code-point boundaries), so the parts are
 * plain-concatenated in index order and the caller JSON.parses only the joined string.
 * The envelope is owned by the fanout repo (`src/websocket.ts`, `sendToConnection`); keep this
 * in sync with it.
 */

export interface WsChunkFrame {
  _chunked: true;
  _chunkId: string;
  _chunkIndex: number;
  _totalChunks: number;
  _data: string;
}

export type WsChunkResult =
  { kind: 'pending' } | { kind: 'complete'; payload: string } | { kind: 'dropped'; reason: string };

export interface WsChunkReassemblerOptions {
  /** Most parts one message may claim; a larger `_totalChunks` is refused before anything is buffered. */
  maxChunks?: number;
  /** Most UTF-16 code units one reassembled message may hold. */
  maxMessageChars?: number;
  /** Most UTF-16 code units buffered across every incomplete message. */
  maxBufferedChars?: number;
  /** Most incomplete messages held at once; the oldest is evicted past this. */
  maxPending?: number;
  /** An incomplete message that has received no part for this long (ms) is evicted. */
  ttlMs?: number;
  now?: () => number;
  /** Called when a buffered incomplete message is evicted (TTL or a cap), so the loss is observable. */
  onDiscard?: (reason: string) => void;
}

const MAX_CHUNK_ID_LENGTH = 256;
const RECENTLY_FINISHED_LIMIT = 64;
export const WS_CHUNK_TTL_MS = 30_000;
export const ALREADY_FINISHED = 'already finished';

interface PendingMessage {
  total: number;
  parts: Map<number, string>;
  chars: number;
  lastPartAt: number;
}

export function isWsChunkEnvelope(value: unknown): value is { _chunked: true } {
  return typeof value === 'object' && value !== null && (value as { _chunked?: unknown })._chunked === true;
}

export class WsChunkReassembler {
  private readonly maxChunks: number;
  private readonly maxMessageChars: number;
  private readonly maxBufferedChars: number;
  private readonly maxPending: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onDiscard?: (reason: string) => void;
  private readonly pending = new Map<string, PendingMessage>();
  // Ids that just completed or were dropped, so a late part cannot open a buffer that never fills.
  private readonly finished = new Map<string, number>();
  private bufferedChars = 0;

  constructor(options: WsChunkReassemblerOptions = {}) {
    this.maxChunks = options.maxChunks ?? 256;
    this.maxMessageChars = options.maxMessageChars ?? 16 * 1024 * 1024;
    this.maxBufferedChars = options.maxBufferedChars ?? 32 * 1024 * 1024;
    this.maxPending = options.maxPending ?? 32;
    this.ttlMs = options.ttlMs ?? WS_CHUNK_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onDiscard = options.onDiscard;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get bufferedCharCount(): number {
    return this.bufferedChars;
  }

  clear(): void {
    this.pending.clear();
    this.finished.clear();
    this.bufferedChars = 0;
  }

  /** Evicts incomplete messages past their TTL. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, message] of this.pending) {
      if (message.lastPartAt <= cutoff) this.discard(id, 'timed out waiting for parts');
    }
    for (const [id, finishedAt] of this.finished) {
      if (finishedAt <= cutoff) this.finished.delete(id);
    }
  }

  accept(frame: unknown): WsChunkResult {
    this.sweep();

    const parsed = parseFrame(frame, this.maxChunks);
    if (typeof parsed === 'string') return { kind: 'dropped', reason: parsed };
    const { _chunkId: id, _chunkIndex: index, _totalChunks: total, _data: data } = parsed;

    if (this.finished.has(id)) return { kind: 'dropped', reason: ALREADY_FINISHED };

    let message = this.pending.get(id);
    if (message && message.total !== total) return this.drop(id, 'total changed mid-message');
    if (message?.parts.has(index)) return { kind: 'pending' };

    const messageChars = (message?.chars ?? 0) + data.length;
    if (messageChars > this.maxMessageChars) return this.drop(id, 'message too large');
    if (data.length > this.maxBufferedChars) return this.drop(id, 'part too large');
    while (this.bufferedChars + data.length > this.maxBufferedChars) {
      const oldest = this.oldestOtherThan(id);
      if (oldest === undefined) return this.drop(id, 'buffer full');
      this.discard(oldest, 'evicted to stay under the buffer cap');
    }

    if (!message) {
      while (this.pending.size >= this.maxPending) {
        const oldest = this.oldestOtherThan(id);
        if (oldest === undefined) break;
        this.discard(oldest, 'evicted to stay under the pending-message cap');
      }
      message = { total, parts: new Map(), chars: 0, lastPartAt: this.now() };
      this.pending.set(id, message);
    }

    message.parts.set(index, data);
    message.chars += data.length;
    message.lastPartAt = this.now();
    this.bufferedChars += data.length;

    if (message.parts.size < total) return { kind: 'pending' };

    const ordered: string[] = [];
    for (let i = 0; i < total; i++) ordered.push(message.parts.get(i) ?? '');
    this.finish(id);
    return { kind: 'complete', payload: ordered.join('') };
  }

  private drop(id: string, reason: string): WsChunkResult {
    this.finish(id);
    return { kind: 'dropped', reason };
  }

  private discard(id: string, reason: string): void {
    this.finish(id);
    this.onDiscard?.(reason);
  }

  private finish(id: string): void {
    const message = this.pending.get(id);
    if (message) {
      this.bufferedChars -= message.chars;
      this.pending.delete(id);
    }
    this.finished.delete(id);
    this.finished.set(id, this.now());
    if (this.finished.size > RECENTLY_FINISHED_LIMIT) {
      const oldestFinished = this.finished.keys().next().value;
      if (oldestFinished !== undefined) this.finished.delete(oldestFinished);
    }
  }

  private oldestOtherThan(id: string): string | undefined {
    for (const key of this.pending.keys()) {
      if (key !== id) return key;
    }
    return undefined;
  }
}

function parseFrame(frame: unknown, maxChunks: number): WsChunkFrame | string {
  if (!isWsChunkEnvelope(frame)) return 'not a chunk frame';
  const { _chunkId, _chunkIndex, _totalChunks, _data } = frame as Record<string, unknown>;
  if (typeof _chunkId !== 'string' || _chunkId.length === 0 || _chunkId.length > MAX_CHUNK_ID_LENGTH) {
    return 'bad chunk id';
  }
  if (typeof _totalChunks !== 'number' || !Number.isInteger(_totalChunks) || _totalChunks < 1) {
    return 'bad total';
  }
  if (_totalChunks > maxChunks) return 'too many chunks';
  if (
    typeof _chunkIndex !== 'number' ||
    !Number.isInteger(_chunkIndex) ||
    _chunkIndex < 0 ||
    _chunkIndex >= _totalChunks
  ) {
    return 'bad index';
  }
  if (typeof _data !== 'string') return 'bad data';
  return { _chunked: true, _chunkId, _chunkIndex, _totalChunks, _data };
}
