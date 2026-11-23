import { describe, expect, it } from 'vitest';
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
});

describe('createRendererErrorHandler', () => {
  it('stores a redacted, clipped record tagged renderer + errors with only the route', () => {
    const sink = new DevLogSink();
    const handle = createRendererErrorHandler(sink);
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
    expect(record.fields).toMatchObject({ kind: 'unhandledrejection', name: 'TypeError', route: '#/chat/abc' });
  });

  it('ignores invalid input', () => {
    const sink = new DevLogSink();
    createRendererErrorHandler(sink)({ kind: 'nope' });
    expect(sink.snapshot().records).toHaveLength(0);
  });

  it('drops reports over the limit and summarises them when the window rolls over', () => {
    const sink = new DevLogSink();
    let time = 1_000_000;
    const handle = createRendererErrorHandler(sink, () => time);
    for (let index = 0; index <= RATE_LIMIT; index++) handle({ kind: 'error', message: `e${index}` });
    expect(sink.snapshot().records).toHaveLength(RATE_LIMIT);
    time += RATE_WINDOW_MS;
    handle({ kind: 'error', message: 'next' });
    const messages = sink.snapshot().records.map(record => record.message);
    expect(messages.at(-2)).toContain('1 renderer error reports dropped');
    expect(messages.at(-1)).toBe('next');
  });
});
