import { describe, expect, it, vi } from 'vitest';
// The window's own filter, reached across the layer boundary on purpose: the seam test below
// is only worth anything if it runs the code the window runs.
import { visibleRecords } from '../../renderer/src/devlog/devLogView';
import { DevLogSink, MAX_CHARS, MAX_MESSAGE_CHARS, MAX_RECORDS } from './DevLogSink';

function watching(sink: DevLogSink) {
  const batches: unknown[][] = [];
  const detach = sink.attach(records => batches.push(records));
  return { batches, detach };
}

describe('DevLogSink', () => {
  it('does not build a draft when nothing is watching', () => {
    const sink = new DevLogSink();
    const build = vi.fn(() => ({ tags: ['chat-stream'], message: 'hello' }));
    for (let index = 0; index < 1000; index++) sink.publish(build);
    expect(build).not.toHaveBeenCalled();
    expect(sink.snapshot().records).toHaveLength(0);
  });

  it('keeps tags and fields on a published record', () => {
    const sink = new DevLogSink();
    watching(sink);
    sink.publish(() => ({ tags: ['chat-stream'], message: 'upstream content 12 chars', fields: { model: 'x' } }));
    const [record] = sink.snapshot().records;
    expect(record.tags).toEqual(['chat-stream']);
    expect(record.fields).toEqual({ model: 'x' });
  });

  it('drops a non-primitive field rather than stringifying it', () => {
    const sink = new DevLogSink();
    watching(sink);
    sink.publish(() => ({ tags: ['t'], message: 'm', fields: { nested: { secret: 'x' }, ok: 1 } }));
    expect(sink.snapshot().records[0].fields).toEqual({ ok: 1 });
  });

  it('redacts a token-shaped string before it reaches the buffer', () => {
    const sink = new DevLogSink();
    watching(sink);
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.KxwLm7Qd0b7xVQ0R2tYt3n8ZzFqfQ2wXyZ';
    sink.publish(() => ({
      tags: ['chat-stream'],
      message: `POST with Authorization: Bearer ${token}`,
      fields: { header: `Bearer ${token}` },
    }));
    const serialized = JSON.stringify(sink.snapshot());
    expect(serialized).not.toContain(token);
    expect(serialized).toContain('[redacted]');
  });

  it('truncates a long message at capture', () => {
    const sink = new DevLogSink();
    watching(sink);
    sink.publish(() => ({ tags: ['chat-stream'], message: 'a'.repeat(5000) }));
    expect(sink.snapshot().records[0].message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS + 3);
  });

  it('holds the line cap, evicting the oldest', () => {
    const sink = new DevLogSink();
    watching(sink);
    for (let index = 0; index < MAX_RECORDS + 500; index++) {
      sink.publish(() => ({ tags: ['chat-stream'], message: 'x' }));
    }
    const snapshot = sink.snapshot();
    expect(snapshot.records).toHaveLength(MAX_RECORDS);
    expect(snapshot.dropped).toBe(500);
    expect(snapshot.records[0].id).toBe(501);
    expect(snapshot.records[MAX_RECORDS - 1].id).toBe(MAX_RECORDS + 500);
  });

  it('holds the character cap even when the line cap is nowhere near', () => {
    const sink = new DevLogSink();
    watching(sink);
    // Words rather than one long run: a run of 40+ token characters is redacted on the way in,
    // which would leave nothing for this cap to bite on.
    const line = 'tool ran '.repeat(MAX_MESSAGE_CHARS / 9);
    for (let index = 0; index < MAX_RECORDS; index++) sink.publish(() => ({ tags: ['chat-stream'], message: line }));
    const snapshot = sink.snapshot();
    const retained = snapshot.records.reduce((total, record) => total + record.message.length, 0);
    expect(retained).toBeLessThanOrEqual(MAX_CHARS);
    expect(snapshot.records.length).toBeLessThan(MAX_RECORDS);
  });

  it('coalesces publishes into one batch per flush', () => {
    const sink = new DevLogSink();
    const { batches } = watching(sink);
    for (let index = 0; index < 50; index++) sink.publish(() => ({ tags: ['chat-stream'], message: 'x' }));
    expect(batches).toHaveLength(0);
    sink.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(50);
  });

  it('stops retaining once the last watcher detaches', () => {
    const sink = new DevLogSink();
    const { detach } = watching(sink);
    sink.publish(() => ({ tags: ['chat-stream'], message: 'while open' }));
    detach();
    const build = vi.fn(() => ({ tags: ['chat-stream'], message: 'after close' }));
    sink.publish(build);
    expect(build).not.toHaveBeenCalled();
    expect(sink.snapshot().records).toHaveLength(1);
  });

  it('clears the buffer', () => {
    const sink = new DevLogSink();
    watching(sink);
    sink.publish(() => ({ tags: ['chat-stream'], message: 'x' }));
    sink.clear();
    expect(sink.snapshot()).toEqual({ records: [], dropped: 0 });
  });

  /**
   * The seam. A second source is one call to publish: no new record field, no new channel, and
   * nothing added to the window - the filter below is the window's own, used unchanged.
   */
  it('shows and filters a second source with no window-side change', () => {
    const sink = new DevLogSink();
    watching(sink);
    sink.publish(() => ({ tags: ['chat-stream'], message: 'upstream content 4 chars' }));
    sink.publish(() => ({ tags: ['auth'], message: 'token refreshed', fields: { outcome: 'ok' } }));

    const { records } = sink.snapshot();
    const tags = new Set(records.flatMap(record => record.tags));
    expect(tags.has('auth')).toBe(true);

    expect(visibleRecords(records, new Set(['auth']))).toHaveLength(1);
    expect(visibleRecords(records, new Set(['auth']))[0].message).toBe('token refreshed');
    expect(visibleRecords(records, new Set(['auth', 'chat-stream']))).toHaveLength(2);
    expect(visibleRecords(records, new Set())).toHaveLength(2);
  });
});
