import { describe, expect, it, vi, afterEach } from 'vitest';
import { isDevLogChord, type ChordInput } from './chord';
import { redact } from './redact';
import { DevLogSink, MAX_CHARS, MAX_MESSAGE_CHARS, MAX_RECORDS } from './DevLogSink';
// The window's own filter, reached across the layer boundary on purpose: the seam test below
// is only worth anything if it runs the code the window runs.
import { formatForCopy, visibleRecords } from '../../renderer/src/devlog/devLogView';
import { RATE_LIMIT, RATE_WINDOW_MS, createRendererErrorHandler, parseRendererErrorReport } from './rendererErrors';

describe('DevLogSink', () => {
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

    it('flattens a multi-line message so one record stays one line', () => {
      const sink = new DevLogSink();
      watching(sink);
      sink.publish(() => ({ tags: ['chat-stream'], message: 'downstream delta: one\ntwo\r\nthree\tfour' }));
      const { message } = sink.snapshot().records[0];
      expect(message).toBe('downstream delta: one\\ntwo\\nthree\\tfour');
      expect(message).not.toMatch(/[\n\r\t]/);
    });

    it('flattens a multi-line field value too', () => {
      const sink = new DevLogSink();
      watching(sink);
      sink.publish(() => ({ tags: ['chat-stream'], message: 'm', fields: { text: 'a\nb' } }));
      expect(sink.snapshot().records[0].fields).toEqual({ text: 'a\\nb' });
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

    describe('publishError', () => {
      it('retains an error with no window attached and arms no timer', () => {
        vi.useFakeTimers();
        try {
          const sink = new DevLogSink();
          sink.publishError(() => ({ tags: ['chat-stream', 'errors'], message: 'boom' }));
          expect(sink.snapshot().records.map(record => record.message)).toEqual(['boom']);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('pushes to a watcher when there is one', () => {
        const sink = new DevLogSink();
        const { batches } = watching(sink);
        sink.publishError(() => ({ tags: ['x'], message: 'boom' }));
        sink.flush();
        expect(batches).toHaveLength(1);
      });

      it('honours the caps while unwatched', () => {
        const sink = new DevLogSink();
        for (let index = 0; index < MAX_RECORDS + 5; index++) {
          sink.publishError(() => ({ tags: ['x'], message: `e${index}` }));
        }
        const { records, dropped } = sink.snapshot();
        expect(records).toHaveLength(MAX_RECORDS);
        expect(dropped).toBe(5);
        expect(records[0].message).toBe('e5');

        sink.publishError(() => ({ tags: ['x'], message: 'z'.repeat(MAX_MESSAGE_CHARS * 3) }));
        const last = sink.snapshot().records.at(-1)!;
        expect(last.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS + 3);
      });

      it('redacts the message and fields', () => {
        const sink = new DevLogSink();
        sink.publishError(() => ({
          tags: ['x'],
          message: 'failed with Authorization: Bearer abcdefghijklmnop1234567890',
          fields: { detail: 'api_key=sk-abcdefghijklmnop1234567890' },
        }));
        const [record] = sink.snapshot().records;
        expect(record.message).not.toContain('abcdefghijklmnop');
        expect(record.fields?.detail).not.toContain('abcdefghijklmnop');
      });

      it('always carries the errors tag, once', () => {
        const sink = new DevLogSink();
        sink.publishError(() => ({ tags: ['x'], message: 'a' }));
        sink.publishError(() => ({ tags: ['x', 'errors'], message: 'b' }));
        expect(sink.snapshot().records.map(record => record.tags)).toEqual([
          ['x', 'errors'],
          ['x', 'errors'],
        ]);
      });

      it('is selected by the errors filter across sources and copied when visible', () => {
        const sink = new DevLogSink();
        watching(sink);
        sink.publish(() => ({ tags: ['chat-stream'], message: 'upstream content' }));
        sink.publishError(() => ({ tags: ['chat-stream'], message: 'provider down', fields: { status: 502 } }));
        sink.publishError(() => ({ tags: ['renderer'], message: 'TypeError' }));
        const shown = visibleRecords(sink.snapshot().records, new Set(['errors']));
        expect(shown.map(record => record.message)).toEqual(['provider down', 'TypeError']);
        expect(formatForCopy(shown)).toContain('status=502');
      });
    });
  });
});

describe('chord', () => {
  const base: ChordInput = { type: 'keyDown', code: 'KeyL', control: false, meta: false, alt: false, shift: false };
  const platformModifier: Partial<ChordInput> =
    process.platform === 'darwin' ? { meta: true, alt: true } : { control: true, alt: true };

  describe('isDevLogChord', () => {
    it('matches the chord', () => {
      expect(isDevLogChord({ ...base, ...platformModifier })).toBe(true);
    });

    it('ignores key-up, so one press is one toggle', () => {
      expect(isDevLogChord({ ...base, ...platformModifier, type: 'keyUp' })).toBe(false);
    });

    it('needs alt, which is what keeps it clear of the sidebar and session bindings', () => {
      expect(isDevLogChord({ ...base, meta: true, control: true })).toBe(false);
      expect(isDevLogChord({ ...base, ...platformModifier, alt: false })).toBe(false);
    });

    it('does not fire with shift held, or on another key', () => {
      expect(isDevLogChord({ ...base, ...platformModifier, shift: true })).toBe(false);
      expect(isDevLogChord({ ...base, ...platformModifier, code: 'KeyK' })).toBe(false);
    });
  });
});

describe('redact', () => {
  describe('redact', () => {
    it('strips a bearer token out of a header line', () => {
      const scrubbed = redact('Authorization: Bearer sk-live-0123456789abcdefghij');
      expect(scrubbed).not.toContain('sk-live-0123456789abcdefghij');
      expect(scrubbed).toContain('[redacted]');
    });

    it('strips a jwt wherever it appears', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      expect(redact(`sending ${jwt} upstream`)).toBe('sending [redacted] upstream');
    });

    it('strips refresh tokens and device codes named as fields', () => {
      expect(redact('refresh_token=abc123def')).toBe('refresh_token=[redacted]');
      expect(redact('device_code: WDJB-MJHT')).toBe('device_code: [redacted]');
    });

    it('leaves ordinary prose and a session uuid alone', () => {
      expect(redact('authorization header missing')).toBe('authorization header missing');
      expect(redact('token refreshed')).toBe('token refreshed');
      const uuid = '8f14e45f-ceea-467a-9c8e-3f7a1c2b4d55';
      expect(redact(`session:${uuid} started`)).toBe(`session:${uuid} started`);
    });
  });
});

describe('renderer errors', () => {
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
});
