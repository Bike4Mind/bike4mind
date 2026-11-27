import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAIL_MB,
  WARN_MB,
  classify,
  formatReport,
  publishablePackages,
  measure,
  collectMeasurements,
} from '../check-npm-metadata-size.mjs';

const MB = 1024 * 1024;
const roots = [];

afterEach(() => {
  vi.useRealTimers();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function makeRepo(manifests) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-metadata-size-'));
  roots.push(root);
  for (const [dir, manifest] of Object.entries(manifests)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

describe('publishablePackages', () => {
  it('lists packages with a publishConfig that are not private, sorted', () => {
    const root = makeRepo({
      'b4m-core/utils': { name: '@scope/utils', publishConfig: { access: 'restricted' } },
      'packages/cli': { name: '@scope/cli', publishConfig: { access: 'public' } },
      'packages/config': { name: '@scope/config', private: true, publishConfig: { access: 'public' } },
      'packages/scripts': { name: '@scope/scripts' },
    });
    expect(publishablePackages(root)).toEqual(['@scope/cli', '@scope/utils']);
  });

  it('returns nothing when neither package root exists', () => {
    expect(publishablePackages(makeRepo({}))).toEqual([]);
  });
});

describe('classify', () => {
  it('is ok below the warning tier', () => {
    expect(classify(WARN_MB * MB - 1)).toBe('ok');
  });

  it('warns from the warning tier up to the failure tier', () => {
    expect(classify(WARN_MB * MB)).toBe('warn');
    expect(classify(FAIL_MB * MB - 1)).toBe('warn');
  });

  it('fails from the failure tier up', () => {
    expect(classify(FAIL_MB * MB)).toBe('fail');
  });
});

describe('formatReport', () => {
  it('orders by size and puts unreadable packages last', () => {
    const report = formatReport([
      { name: '@scope/small', bytes: 5 * MB, versions: 10, status: 'ok' },
      { name: '@scope/hidden', error: 'HTTP 404' },
      { name: '@scope/large', bytes: 95 * MB, versions: 9000, status: 'fail' },
    ]);
    const rows = report.split('\n').slice(2);
    expect(rows).toEqual([
      '| @scope/large | 95.0 MB | 9000 | fail |',
      '| @scope/small | 5.0 MB | 10 | ok |',
      '| @scope/hidden | - | - | unreadable: HTTP 404 |',
    ]);
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function observeSettlement(promise) {
  const state = { settled: false };
  const completion = (async () => {
    const result = await promise;
    state.settled = true;
    return result;
  })();
  return { state, completion };
}
const healthy = () => new globalThis.Response(JSON.stringify({ versions: { '1.0.0': {}, '1.1.0': {} } }));
function stalledBody() {
  const body = deferred();
  const cancel = vi.fn().mockResolvedValue(undefined);
  return { body, cancel, response: { ok: true, arrayBuffer: vi.fn(() => body.promise), body: { cancel } } };
}

describe('bounded metadata measurement', () => {
  it('preserves successful bytes/versions and passes a real abort signal with the read-only headers', async () => {
    const fetch = vi.fn().mockResolvedValue(healthy());
    const row = await measure('@scope/pkg', 'fixture-token', { fetch });
    expect(row).toEqual({
      name: '@scope/pkg',
      bytes: Buffer.byteLength(JSON.stringify({ versions: { '1.0.0': {}, '1.1.0': {} } })),
      versions: 2,
      status: 'ok',
    });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://registry.npmjs.org/@scope%2fpkg');
    expect(options.headers).toEqual({ accept: 'application/json', authorization: 'Bearer fixture-token' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });

  it('preserves unreadable network and malformed JSON rows', async () => {
    expect(await measure('network', undefined, { fetch: vi.fn().mockRejectedValue(new Error('Offline')) })).toEqual({
      name: 'network',
      error: 'Offline',
    });
    const row = await measure('json', undefined, {
      fetch: vi.fn().mockResolvedValue(new globalThis.Response('invalid JSON')),
    });
    expect(row.name).toBe('json');
    expect(row.error).toEqual(expect.any(String));
  });

  it('preserves HTTP errors while disposing the unused body, even when cancellation rejects', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('Already closed'));
    expect(
      await measure('hidden', undefined, {
        fetch: vi.fn().mockResolvedValue({ ok: false, status: 404, body: { cancel } }),
      })
    ).toEqual({ name: 'hidden', error: 'HTTP 404' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts stalled headers, measures the next package and produces a complete failing report', async () => {
    vi.useFakeTimers();
    let signal;
    const fetch = vi
      .fn()
      .mockImplementationOnce((_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
        );
      })
      .mockResolvedValue(healthy());
    const result = observeSettlement(
      collectMeasurements(['stalled', 'healthy'], undefined, {
        fetch,
        packageTimeoutMs: 100,
        collectionTimeoutMs: 500,
      })
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(result.state.settled).toBe(true);
    const { rows, failed } = await result.completion;
    expect(signal.aborted).toBe(true);
    expect(rows[0]).toEqual({ name: 'stalled', error: 'Metadata read timed out' });
    expect(rows[1]).toMatchObject({ name: 'healthy', status: 'ok', versions: 2 });
    expect(failed).toBe(true);
    expect(formatReport(rows)).toContain('| healthy |');
    expect(formatReport(rows)).toContain('| stalled | - | - | unreadable: Metadata read timed out |');
  });

  it('uses the original deadline when headers arrive late and a body remains pending', async () => {
    vi.useFakeTimers();
    const slow = stalledBody();
    let signal;
    const fetch = vi
      .fn()
      .mockImplementationOnce((_url, options) => {
        signal = options.signal;
        return new Promise(resolve => setTimeout(() => resolve(slow.response), 90));
      })
      .mockResolvedValue(healthy());
    const started = Date.now();
    const result = observeSettlement(
      collectMeasurements(['slow-body', 'healthy'], undefined, {
        fetch,
        packageTimeoutMs: 100,
        collectionTimeoutMs: 500,
      })
    );
    await vi.advanceTimersByTimeAsync(90);
    expect(slow.response.arrayBuffer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    expect(result.state.settled).toBe(true);
    const settled = await result.completion;
    expect(Date.now() - started).toBe(100);
    expect(signal.aborted).toBe(true);
    expect(slow.cancel).toHaveBeenCalledOnce();
    expect(settled.rows[0]).toEqual({ name: 'slow-body', error: 'Metadata read timed out' });
    expect(settled.rows[1]).toMatchObject({ name: 'healthy', status: 'ok' });
    const snapshot = JSON.stringify(settled);
    slow.body.reject(new Error('Late body failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(settled)).toBe(snapshot);
  });

  it.each(['resolve', 'reject'])(
    'observes late headers that %s after timeout without starting body work',
    async outcome => {
      vi.useFakeTimers();
      const headers = deferred();
      const slow = stalledBody();
      const fetch = vi.fn().mockReturnValueOnce(headers.promise).mockResolvedValue(healthy());
      const result = observeSettlement(
        collectMeasurements(['late', 'healthy'], undefined, {
          fetch,
          packageTimeoutMs: 100,
          collectionTimeoutMs: 500,
        })
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(result.state.settled).toBe(true);
      const settled = await result.completion;
      expect(settled.failed).toBe(true);
      expect(settled.rows[1]).toMatchObject({ name: 'healthy', status: 'ok' });
      if (outcome === 'resolve') headers.resolve(slow.response);
      else headers.reject(new Error('Late headers failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(slow.response.arrayBuffer).not.toHaveBeenCalled();
      expect(slow.cancel).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
    }
  );

  it('does not launch a body phase when the absolute deadline passes before its timer runs', async () => {
    vi.useFakeTimers();
    const headers = deferred();
    const slow = stalledBody();
    const fetch = vi.fn().mockReturnValue(headers.promise);
    const deadline = Date.now() + 100;
    const result = measure('late-phase', undefined, { fetch, deadline });
    vi.setSystemTime(deadline + 1);
    headers.resolve(slow.response);
    expect(await result).toEqual({ name: 'late-phase', error: 'Metadata read timed out' });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(slow.response.arrayBuffer).not.toHaveBeenCalled();
    expect(slow.cancel).toHaveBeenCalledOnce();
  });

  it('exhausts the collection budget without starting later requests or dropping their rows', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    const result = observeSettlement(
      collectMeasurements(['one', 'two', 'three'], undefined, {
        fetch,
        packageTimeoutMs: 200,
        collectionTimeoutMs: 100,
      })
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(result.state.settled).toBe(true);
    const { rows, failed } = await result.completion;
    expect(fetch).toHaveBeenCalledOnce();
    expect(rows).toEqual([
      { name: 'one', error: 'Metadata read timed out' },
      { name: 'two', error: 'Collection read budget exhausted' },
      { name: 'three', error: 'Collection read budget exhausted' },
    ]);
    expect(failed).toBe(true);
    expect(formatReport(rows)).toContain('| three | - | - | unreadable: Collection read budget exhausted |');
  });
});
