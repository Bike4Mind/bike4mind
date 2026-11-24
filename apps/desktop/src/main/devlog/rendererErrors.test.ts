import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevLogSink, MAX_MESSAGE_CHARS } from './DevLogSink';
import { RATE_LIMIT, RATE_WINDOW_MS, createRendererErrorHandler, parseRendererErrorReport } from './rendererErrors';

describe('parseRendererErrorReport', () => {
  it('rejects non-objects, unknown kinds and non-string fields', () => {
    expect(parseRendererErrorReport(null)).toBeNull();
    expect(parseRendererErrorReport('boom')).toBeNull();
    expect(parseRendererErrorReport({ kind: 'weird', message: 'x' })).toBeNull();
    expect(parseRendererErrorReport({ kind: 'error', message: 42 })).toBeNull();
  });

  it('drops a non-string optional field and pre-clips long strings', () => {
    const report = parseRendererErrorReport({ kind: 'error', message: 'a'.repeat(1e6), name: { x: 1 } });
    expect(report?.message.length).toBe(2000);
    expect(report).not.toHaveProperty('name');
  });

  it('gives an empty message a fallback', () => {
    expect(parseRendererErrorReport({ kind: 'error', message: '' })?.message).toBe('(no message)');
  });
});

describe('createRendererErrorHandler', () => {
  it('stores a redacted, clipped record tagged renderer + errors with only the route', () => {
    const sink = new DevLogSink();
    const handle = createRendererErrorHandler(sink).report;
    handle(
      {
        kind: 'unhandledrejection',
        message: `Bearer abcdefghijklmnop1234567890 ${'z'.repeat(5000)}`,
        name: 'TypeError',
      },
      'file:///app/index.html?token=secret#/chat/abc?x=1'
    );
    const [record] = sink.snapshot().records;
    expect(record.tags).toEqual(['renderer', 'errors']);
    expect(record.message).not.toContain('abcdefghijklmnop');
    expect(record.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS + 3);
    expect(record.fields).toEqual({
      source: 'renderer',
      kind: 'unhandledrejection',
      name: 'TypeError',
      route: '#/chat/abc',
    });
  });

  it('ignores invalid input', () => {
    const sink = new DevLogSink();
    createRendererErrorHandler(sink).report({ kind: 'nope' });
    expect(sink.snapshot().records).toHaveLength(0);
  });

  it('drops reports over the limit and summarises them when the window rolls over', () => {
    const sink = new DevLogSink();
    let time = 1_000_000;
    const handle = createRendererErrorHandler(sink, () => time).report;
    for (let index = 0; index <= RATE_LIMIT; index++) handle({ kind: 'error', message: `e${index}` });
    expect(sink.snapshot().records).toHaveLength(RATE_LIMIT);
    time += RATE_WINDOW_MS;
    handle({ kind: 'error', message: 'next' });
    const messages = sink.snapshot().records.map(record => record.message);
    expect(messages.at(-2)).toBe('1 renderer error reports dropped (rate limit)');
    expect(messages.at(-1)).toBe('next');
  });

  describe('with fake timers', () => {
    afterEach(() => vi.useRealTimers());

    it('summarises the drops when the window ends, with no further report', () => {
      vi.useFakeTimers();
      const sink = new DevLogSink();
      const handle = createRendererErrorHandler(sink);
      for (let index = 0; index < RATE_LIMIT + 5; index++) handle.report({ kind: 'error', message: `e${index}` });
      expect(sink.snapshot().records).toHaveLength(RATE_LIMIT);
      vi.advanceTimersByTime(RATE_WINDOW_MS - 1);
      expect(sink.snapshot().records).toHaveLength(RATE_LIMIT);
      vi.advanceTimersByTime(1);
      const records = sink.snapshot().records;
      expect(records).toHaveLength(RATE_LIMIT + 1);
      expect(records.at(-1)?.message).toBe('5 renderer error reports dropped (rate limit)');
      expect(records.at(-1)?.fields).toEqual({ source: 'renderer', dropped: 5 });

      handle.report({ kind: 'error', message: 'later' });
      vi.advanceTimersByTime(RATE_WINDOW_MS * 2);
      const after = sink.snapshot().records;
      expect(after.at(-1)?.message).toBe('later');
      expect(after.filter(record => /dropped/.test(record.message))).toHaveLength(1);
    });

    it('re-arms the summary timer for a second burst', () => {
      vi.useFakeTimers();
      const sink = new DevLogSink();
      const handle = createRendererErrorHandler(sink);
      for (let index = 0; index < RATE_LIMIT + 5; index++) handle.report({ kind: 'error', message: `a${index}` });
      vi.advanceTimersByTime(RATE_WINDOW_MS);
      for (let index = 0; index < RATE_LIMIT + 3; index++) handle.report({ kind: 'error', message: `b${index}` });
      vi.advanceTimersByTime(RATE_WINDOW_MS);
      const summaries = sink.snapshot().records.filter(record => /dropped/.test(record.message));
      expect(summaries.map(record => record.fields?.dropped)).toEqual([5, 3]);
    });
  });

  describe('render', () => {
    it('stores one errors record with the route and without the stacks', () => {
      const sink = new DevLogSink();
      createRendererErrorHandler(sink).render({
        message: 'boom',
        stack: 'Error: boom\n    at Sidebar',
        componentStack: '\n    at Sidebar',
        route: '#/settings?tab=1',
      });
      const records = sink.snapshot().records;
      expect(records).toHaveLength(1);
      expect(records[0].tags).toEqual(['renderer', 'errors']);
      expect(records[0].message).toBe('boom');
      expect(records[0].fields).toEqual({ source: 'renderer', kind: 'render', route: '#/settings' });
    });

    it('gives an empty message a fallback', () => {
      const sink = new DevLogSink();
      createRendererErrorHandler(sink).render({ message: '' });
      expect(sink.snapshot().records[0].message).toBe('(no message)');
    });

    it('shares the rate limit with report', () => {
      const sink = new DevLogSink();
      const handle = createRendererErrorHandler(sink, () => 1_000_000);
      for (let index = 0; index < RATE_LIMIT; index++) handle.report({ kind: 'error', message: `e${index}` });
      handle.render({ message: 'over' });
      expect(sink.snapshot().records.map(record => record.message)).not.toContain('over');
    });
  });
});
