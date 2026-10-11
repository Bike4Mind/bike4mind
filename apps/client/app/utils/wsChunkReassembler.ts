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
  /** An incomplete message older than this (ms since its first part) is evicted. */
  ttlMs?: number;
  now?: () => number;
}

const MAX_CHUNK_ID_LENGTH = 256;
const RECENTLY_COMPLETED_LIMIT = 64;

interface PendingMessage {
  total: number;
  parts: Map<number, string>;
  chars: number;
  startedAt: number;
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
  private readonly pending = new Map<string, PendingMessage>();
  // Ids that just completed, so a late duplicate part cannot open a buffer that never fills.
  private readonly completed = new Map<string, number>();
  private bufferedChars = 0;

  constructor(options: WsChunkReassemblerOptions = {}) {
    this.maxChunks = options.maxChunks ?? 256;
    this.maxMessageChars = options.maxMessageChars ?? 16 * 1024 * 1024;
    this.maxBufferedChars = options.maxBufferedChars ?? 32 * 1024 * 1024;
    this.maxPending = options.maxPending ?? 32;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get bufferedCharCount(): number {
    return this.bufferedChars;
  }

  clear(): void {
    this.pending.clear();
    this.completed.clear();
    this.bufferedChars = 0;
  }

  /** Evicts incomplete messages past their TTL. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, message] of this.pending) {
      if (message.startedAt <= cutoff) this.evict(id);
    }
    for (const [id, completedAt] of this.completed) {
      if (completedAt <= cutoff) this.completed.delete(id);
    }
  }

  accept(frame: unknown): WsChunkResult {
    this.sweep();

    const parsed = parseFrame(frame, this.maxChunks);
    if (typeof parsed === 'string') return { kind: 'dropped', reason: parsed };
    const { _chunkId: id, _chunkIndex: index, _totalChunks: total, _data: data } = parsed;

    if (this.completed.has(id)) return { kind: 'dropped', reason: 'already complete' };

    let message = this.pending.get(id);
    if (message && message.total !== total) {
      this.evict(id);
      return { kind: 'dropped', reason: 'total changed mid-message' };
    }
    if (message?.parts.has(index)) return { kind: 'pending' };

    const messageChars = (message?.chars ?? 0) + data.length;
    if (messageChars > this.maxMessageChars) {
      this.evict(id);
      return { kind: 'dropped', reason: 'message too large' };
    }
    if (data.length > this.maxBufferedChars) {
      this.evict(id);
      return { kind: 'dropped', reason: 'part too large' };
    }
    while (this.bufferedChars + data.length > this.maxBufferedChars) {
      const oldest = this.oldestOtherThan(id);
      if (oldest === undefined) {
        this.evict(id);
        return { kind: 'dropped', reason: 'buffer full' };
      }
      this.evict(oldest);
    }

    if (!message) {
      while (this.pending.size >= this.maxPending) {
        const oldest = this.oldestOtherThan(id);
        if (oldest === undefined) break;
        this.evict(oldest);
      }
      message = { total, parts: new Map(), chars: 0, startedAt: this.now() };
      this.pending.set(id, message);
    }

    message.parts.set(index, data);
    message.chars += data.length;
    this.bufferedChars += data.length;

    if (message.parts.size < total) return { kind: 'pending' };

    const ordered: string[] = [];
    for (let i = 0; i < total; i++) ordered.push(message.parts.get(i) ?? '');
    this.evict(id);
    this.completed.set(id, this.now());
    if (this.completed.size > RECENTLY_COMPLETED_LIMIT) {
      const oldestCompleted = this.completed.keys().next().value;
      if (oldestCompleted !== undefined) this.completed.delete(oldestCompleted);
    }
    return { kind: 'complete', payload: ordered.join('') };
  }

  private evict(id: string): void {
    const message = this.pending.get(id);
    if (!message) return;
    this.bufferedChars -= message.chars;
    this.pending.delete(id);
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
