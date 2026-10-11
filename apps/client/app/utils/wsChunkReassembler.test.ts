// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isWsChunkEnvelope, WsChunkReassembler } from './wsChunkReassembler';

const frame = (id: string, index: number, total: number, data: string) => ({
  _chunked: true as const,
  _chunkId: id,
  _chunkIndex: index,
  _totalChunks: total,
  _data: data,
});

const split = (id: string, payload: string, parts: number) => {
  const size = Math.ceil(payload.length / parts);
  return Array.from({ length: parts }, (_, i) => frame(id, i, parts, payload.slice(i * size, (i + 1) * size)));
};

describe('isWsChunkEnvelope', () => {
  it('only matches frames flagged _chunked: true', () => {
    expect(isWsChunkEnvelope(frame('a', 0, 1, '{}'))).toBe(true);
    expect(isWsChunkEnvelope({ action: 'data_update' })).toBe(false);
    expect(isWsChunkEnvelope({ _chunked: 'true' })).toBe(false);
    expect(isWsChunkEnvelope(null)).toBe(false);
    expect(isWsChunkEnvelope('x')).toBe(false);
  });
});

describe('WsChunkReassembler', () => {
  const payload = JSON.stringify({ action: 'data_update', body: 'x'.repeat(50) + '\u00e9\u4e2d' });

  it('reassembles parts that arrive in order', () => {
    const r = new WsChunkReassembler();
    const [a, b, c] = split('m1', payload, 3);
    expect(r.accept(a)).toEqual({ kind: 'pending' });
    expect(r.accept(b)).toEqual({ kind: 'pending' });
    expect(r.accept(c)).toEqual({ kind: 'complete', payload });
    expect(r.pendingCount).toBe(0);
    expect(r.bufferedCharCount).toBe(0);
  });

  it('reassembles parts that arrive out of order', () => {
    const r = new WsChunkReassembler();
    const [a, b, c] = split('m1', payload, 3);
    expect(r.accept(c).kind).toBe('pending');
    expect(r.accept(a).kind).toBe('pending');
    expect(r.accept(b)).toEqual({ kind: 'complete', payload });
  });

  it('ignores duplicate parts, before and after completion', () => {
    const r = new WsChunkReassembler();
    const [a, b] = split('m1', payload, 2);
    r.accept(a);
    expect(r.accept(a)).toEqual({ kind: 'pending' });
    expect(r.bufferedCharCount).toBe(a._data.length);
    expect(r.accept(b)).toEqual({ kind: 'complete', payload });
    expect(r.accept(b).kind).toBe('dropped');
    expect(r.pendingCount).toBe(0);
  });

  it('keeps interleaved messages apart', () => {
    const r = new WsChunkReassembler();
    const other = JSON.stringify({ action: 'other', n: 1 });
    const [a1, a2] = split('a', payload, 2);
    const [b1, b2] = split('b', other, 2);
    expect(r.accept(a1).kind).toBe('pending');
    expect(r.accept(b2).kind).toBe('pending');
    expect(r.accept(b1)).toEqual({ kind: 'complete', payload: other });
    expect(r.accept(a2)).toEqual({ kind: 'complete', payload });
  });

  it('evicts an incomplete message once its TTL passes', () => {
    let now = 0;
    const r = new WsChunkReassembler({ ttlMs: 1000, now: () => now });
    const [a, b] = split('m1', payload, 2);
    r.accept(a);
    now = 1500;
    r.sweep();
    expect(r.pendingCount).toBe(0);
    expect(r.bufferedCharCount).toBe(0);
    // The surviving half alone can never complete the evicted message.
    expect(r.accept(b).kind).toBe('pending');
  });

  it('refuses an absurd _totalChunks before buffering anything', () => {
    const r = new WsChunkReassembler();
    expect(r.accept(frame('m1', 0, 1e9, 'x'))).toEqual({ kind: 'dropped', reason: 'too many chunks' });
    expect(r.accept(frame('m2', 0, Number.POSITIVE_INFINITY, 'x')).kind).toBe('dropped');
    expect(r.pendingCount).toBe(0);
  });

  it('rejects malformed frames', () => {
    const r = new WsChunkReassembler();
    expect(r.accept(frame('m', 2, 2, 'x')).kind).toBe('dropped');
    expect(r.accept(frame('m', -1, 2, 'x')).kind).toBe('dropped');
    expect(r.accept(frame('m', 0.5, 2, 'x')).kind).toBe('dropped');
    expect(r.accept(frame('', 0, 2, 'x')).kind).toBe('dropped');
    expect(r.accept(frame('m'.repeat(300), 0, 2, 'x')).kind).toBe('dropped');
    expect(r.accept({ ...frame('m', 0, 2, 'x'), _data: 42 }).kind).toBe('dropped');
    expect(r.pendingCount).toBe(0);
  });

  it('drops a message whose _totalChunks changes mid-stream', () => {
    const r = new WsChunkReassembler();
    r.accept(frame('m', 0, 3, 'a'));
    expect(r.accept(frame('m', 1, 2, 'b')).kind).toBe('dropped');
    expect(r.pendingCount).toBe(0);
  });

  it('drops a message that grows past the per-message cap', () => {
    const r = new WsChunkReassembler({ maxMessageChars: 10 });
    r.accept(frame('m', 0, 3, 'x'.repeat(6)));
    expect(r.accept(frame('m', 1, 3, 'x'.repeat(6)))).toEqual({ kind: 'dropped', reason: 'message too large' });
    expect(r.bufferedCharCount).toBe(0);
  });

  it('evicts the oldest incomplete message to stay under the global buffer cap', () => {
    const r = new WsChunkReassembler({ maxBufferedChars: 10 });
    r.accept(frame('old', 0, 2, 'x'.repeat(8)));
    expect(r.accept(frame('new', 0, 2, 'y'.repeat(8))).kind).toBe('pending');
    expect(r.pendingCount).toBe(1);
    expect(r.bufferedCharCount).toBe(8);
    expect(r.accept(frame('new', 1, 2, 'z'))).toEqual({ kind: 'complete', payload: 'y'.repeat(8) + 'z' });
  });

  it('evicts the oldest incomplete message past the pending-count cap', () => {
    const r = new WsChunkReassembler({ maxPending: 2 });
    r.accept(frame('a', 0, 2, 'a'));
    r.accept(frame('b', 0, 2, 'b'));
    r.accept(frame('c', 0, 2, 'c'));
    expect(r.pendingCount).toBe(2);
    expect(r.accept(frame('b', 1, 2, 'B'))).toEqual({ kind: 'complete', payload: 'bB' });
    expect(r.accept(frame('a', 1, 2, 'A')).kind).toBe('pending');
  });

  it('clear() drops every buffer', () => {
    const r = new WsChunkReassembler();
    r.accept(frame('a', 0, 2, 'a'));
    r.clear();
    expect(r.pendingCount).toBe(0);
    expect(r.bufferedCharCount).toBe(0);
    expect(r.accept(frame('a', 1, 2, 'A')).kind).toBe('pending');
  });
});
