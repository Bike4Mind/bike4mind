import { format } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetClient, type FetchPort, type IngestOutcome } from './FleetClient';

const ORIGIN = 'https://fleet.example.test';
const KEY = 'fltk_test_telemetry_key_AAAA1111';

const respond = (status: number) => new Response(status === 204 ? null : '{}', { status });

describe('FleetClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('posts the body to the logs path with the bearer key', async () => {
    const fetch = vi.fn<FetchPort>(async () => respond(200));
    await new FleetClient(fetch).sendLogs(ORIGIN, KEY, { a: 1 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/v1/logs`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(init.body).toBe('{"a":1}');
  });

  it('never follows a redirect, so a 3xx cannot carry the bearer key elsewhere', async () => {
    const fetch = vi.fn<FetchPort>(async () => respond(200));
    await new FleetClient(fetch).sendLogs(ORIGIN, KEY, {});
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });

  it('maps each status to the outcome the queue acts on', async () => {
    const outcomes: Record<number, IngestOutcome> = {
      200: { kind: 'accepted' },
      204: { kind: 'accepted' },
      400: { kind: 'rejected', status: 400 },
      413: { kind: 'rejected', status: 413 },
      415: { kind: 'rejected', status: 415 },
      401: { kind: 'unauthorized', status: 401 },
      403: { kind: 'unauthorized', status: 403 },
      302: { kind: 'retry', status: 302 },
      404: { kind: 'retry', status: 404 },
      429: { kind: 'retry', status: 429 },
      500: { kind: 'retry', status: 500 },
      503: { kind: 'retry', status: 503 },
    };
    for (const [status, expected] of Object.entries(outcomes)) {
      const client = new FleetClient(async () => respond(Number(status)));
      expect(await client.sendLogs(ORIGIN, KEY, {}), `status ${status}`).toEqual(expected);
    }
  });

  it('never logs the API key when fetch throws, and retries with no status', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    );
    const client = new FleetClient(async () => {
      throw new TypeError(`redirect mode is set to error ${KEY}`);
    });
    const result = await client.sendLogs(ORIGIN, KEY, {});
    expect(result).toEqual({ kind: 'retry', status: null });
    expect(JSON.stringify(result)).not.toContain(KEY);
    // util.format renders an Error's message and stack, which JSON.stringify drops
    for (const spy of spies) expect(spy.mock.calls.map(call => format(...call)).join('\n')).not.toContain(KEY);
  });

  it('aborts a request still pending after 15 seconds and retries', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetch: FetchPort = (_url, init) => {
      signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };
    const result = new FleetClient(fetch).sendLogs(ORIGIN, KEY, {});
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await result).toEqual({ kind: 'retry', status: null });
  });

  it('clears the timeout once the request settles', async () => {
    vi.useFakeTimers();
    await new FleetClient(async () => respond(200)).sendLogs(ORIGIN, KEY, {});
    expect(vi.getTimerCount()).toBe(0);
  });
});
