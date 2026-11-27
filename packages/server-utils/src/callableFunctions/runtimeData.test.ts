import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALLABLE_FUNCTION_DATA_CACHE_BYTES,
  prepareRunData,
  resetRunDataManifest,
  validRunData,
  type CallableFunctionRunData,
} from './runtimeData';
import { CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB } from './runtimeLimits';

const CSV = Buffer.from('x,y\n1,2\n');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const entry = (overrides: Partial<CallableFunctionRunData> = {}): CallableFunctionRunData => ({
  name: 'points.csv',
  prefix: 'fn1',
  sha256: sha(CSV),
  bytes: CSV.length,
  url: 'https://data.example.com/signed',
  ...overrides,
});

const serving = (bytes: Buffer) => vi.fn(async () => new Response(new Uint8Array(bytes)));

describe('prepareRunData', () => {
  let cacheDir: string;
  beforeEach(() => {
    resetRunDataManifest();
    cacheDir = mkdtempSync(path.join(tmpdir(), 'fn-data-test-'));
  });

  it('downloads once, links the file read-only into a fresh directory, and serves the next call from the cache', async () => {
    const fetchData = serving(CSV);
    const first = await prepareRunData([entry()], { cacheDir, fetchData });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.dir) throw new Error('no directory');
    expect(readFileSync(path.join(first.dir, 'points.csv'))).toEqual(CSV);
    expect(statSync(first.dir).mode & 0o777).toBe(0o555);
    expect(statSync(path.join(first.dir, 'points.csv')).mode & 0o777).toBe(0o444);
    expect(() => writeFileSync(path.join(first.dir!, 'points.csv'), 'changed')).toThrow();
    expect(() => writeFileSync(path.join(first.dir!, 'new.csv'), 'added')).toThrow();
    await first.release();

    const second = await prepareRunData([entry()], { cacheDir, fetchData });
    expect(second.ok && second.dir).not.toBe(first.dir);
    expect(fetchData).toHaveBeenCalledTimes(1);
    if (second.ok) await second.release();
    expect(readdirSync(path.join(cacheDir, 'calls'))).toEqual([]);
  });

  it('refuses bytes that do not match the pinned hash and keeps nothing of them', async () => {
    const result = await prepareRunData([entry()], { cacheDir, fetchData: serving(Buffer.from('x,y\n9,9\n')) });
    expect(result).toEqual({ ok: false, reason: 'data_hash_mismatch' });
    expect(readdirSync(path.join(cacheDir, 'cache', 'fn1'))).toEqual([]);
  });

  it('refuses more bytes than were pinned', async () => {
    const result = await prepareRunData([entry()], { cacheDir, fetchData: serving(Buffer.concat([CSV, CSV])) });
    expect(result).toEqual({ ok: false, reason: 'data_hash_mismatch' });
  });

  it('never serves one function the cache entry of another, even for the same bytes', async () => {
    const fetchData = serving(CSV);
    const first = await prepareRunData([entry()], { cacheDir, fetchData });
    if (first.ok) await first.release();
    const other = await prepareRunData([entry({ prefix: 'fn2' })], { cacheDir, fetchData });
    if (other.ok) await other.release();
    expect(fetchData).toHaveBeenCalledTimes(2);
  });

  it('downloads again when the cached file no longer matches', async () => {
    const fetchData = serving(CSV);
    const first = await prepareRunData([entry()], { cacheDir, fetchData });
    if (first.ok) await first.release();
    resetRunDataManifest();
    const cached = path.join(cacheDir, 'cache', 'fn1', sha(CSV));
    const { chmodSync } = await import('node:fs');
    chmodSync(cached, 0o644);
    writeFileSync(cached, 'x,y\n7,7\n');
    const second = await prepareRunData([entry()], { cacheDir, fetchData });
    expect(second.ok).toBe(true);
    if (second.ok && second.dir) expect(readFileSync(path.join(second.dir, 'points.csv'))).toEqual(CSV);
    expect(fetchData).toHaveBeenCalledTimes(2);
  });

  it('reads an unreachable link as data_unavailable', async () => {
    const fetchData = vi.fn(async () => new Response('denied', { status: 403 }));
    expect(await prepareRunData([entry()], { cacheDir, fetchData })).toEqual({ ok: false, reason: 'data_unavailable' });
  });

  it('removes the partial file of a download that fails midway', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CSV.subarray(0, 4)));
        controller.error(new Error('connection reset'));
      },
    });
    const fetchData = vi.fn(async () => new Response(body));
    expect(await prepareRunData([entry()], { cacheDir, fetchData })).toEqual({ ok: false, reason: 'data_unavailable' });
    expect(readdirSync(path.join(cacheDir, 'cache', 'fn1'))).toEqual([]);
  });

  it('cancels the response body once a download passes the pinned size', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(CSV));
      },
      cancel,
    });
    const result = await prepareRunData([entry()], { cacheDir, fetchData: vi.fn(async () => new Response(body)) });
    expect(result).toEqual({ ok: false, reason: 'data_hash_mismatch' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled download at the budget', async () => {
    const fetchData = vi.fn(
      async (_url: string, { signal }: { signal: AbortSignal }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason));
            },
          })
        )
    );
    const started = Date.now();
    expect(await prepareRunData([entry()], { cacheDir, fetchData, budgetMs: 50 })).toEqual({
      ok: false,
      reason: 'data_unavailable',
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(readdirSync(path.join(cacheDir, 'cache', 'fn1'))).toEqual([]);
  });

  describe('eviction under capBytes', () => {
    const files = { a: Buffer.from('aaaaaaaa'), b: Buffer.from('bbbbbbbb'), c: Buffer.from('cccccccc') };
    const pinOf = (key: keyof typeof files) =>
      entry({ name: `${key}.bin`, sha256: sha(files[key]), bytes: files[key].length });
    const fetchData = vi.fn(async (url: string) => new Response(new Uint8Array(files[url.slice(-1) as 'a'])));
    const withUrl = (key: keyof typeof files) => ({ ...pinOf(key), url: `https://data.example.com/${key}` });
    const cached = () => readdirSync(path.join(cacheDir, 'cache', 'fn1')).sort();
    let clock = 0;
    const now = () => clock;
    const capBytes = 16;
    const prepare = async (keys: (keyof typeof files)[]) => {
      const result = await prepareRunData(keys.map(withUrl), { cacheDir, fetchData, capBytes, now });
      if (!result.ok) throw new Error(result.reason);
      await result.release();
    };

    beforeEach(() => {
      clock = 0;
      fetchData.mockClear();
    });

    it('evicts the least recently used file first', async () => {
      clock = 1;
      await prepare(['a']);
      clock = 2;
      await prepare(['b']);
      clock = 3;
      await prepare(['a']);
      clock = 4;
      await prepare(['c']);
      expect(cached()).toEqual([sha(files.a), sha(files.c)].sort());
      expect(fetchData).toHaveBeenCalledTimes(3);
    });

    it('never evicts a file the current call uses, even when it is the oldest', async () => {
      clock = 1;
      await prepare(['a']);
      clock = 2;
      await prepare(['b']);
      clock = 3;
      // c is placed while a is still the oldest entry; a stays because this call reads it too.
      await prepare(['c', 'a']);
      expect(cached()).toEqual([sha(files.a), sha(files.c)].sort());
      expect(fetchData).toHaveBeenCalledTimes(3);
    });
  });

  it('clears what a killed process left and counts its cache files toward the cap', async () => {
    const { chmodSync, mkdirSync } = await import('node:fs');
    const old = Buffer.from('oldoldol');
    const callDir = path.join(cacheDir, 'calls', 'left-over');
    mkdirSync(callDir, { recursive: true });
    writeFileSync(path.join(callDir, 'points.csv'), CSV);
    chmodSync(callDir, 0o555);
    const fnDir = path.join(cacheDir, 'cache', 'fn1');
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(path.join(fnDir, `${sha(old)}`), old);
    writeFileSync(path.join(fnDir, `${sha(CSV)}.partial-download.part`), CSV.subarray(0, 3));

    const result = await prepareRunData([entry()], { cacheDir, fetchData: serving(CSV), capBytes: CSV.length + 4 });
    expect(result.ok).toBe(true);
    if (result.ok) await result.release();
    expect(readdirSync(path.join(cacheDir, 'calls'))).toEqual([]);
    expect(readdirSync(fnDir)).toEqual([sha(CSV)]);
  });

  it('hashes a cache file found on disk before serving it', async () => {
    const { mkdirSync } = await import('node:fs');
    const fnDir = path.join(cacheDir, 'cache', 'fn1');
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(path.join(fnDir, sha(CSV)), 'x,y\n7,7\n');
    const fetchData = serving(CSV);
    const result = await prepareRunData([entry()], { cacheDir, fetchData });
    expect(result.ok && result.dir && readFileSync(path.join(result.dir, 'points.csv'))).toEqual(CSV);
    expect(fetchData).toHaveBeenCalledTimes(1);
    if (result.ok) await result.release();
  });

  it('downloads a file once when two calls in one process need it at the same time', async () => {
    const fetchData = serving(CSV);
    const [first, second] = await Promise.all([
      prepareRunData([entry()], { cacheDir, fetchData }),
      prepareRunData([entry()], { cacheDir, fetchData }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(fetchData).toHaveBeenCalledTimes(1);
    if (first.ok) await first.release();
    if (second.ok) await second.release();
  });
});

describe('CALLABLE_FUNCTION_DATA_CACHE_BYTES', () => {
  it('leaves the runtime 1 GB of its ephemeral storage', () => {
    expect(CALLABLE_FUNCTION_DATA_CACHE_BYTES).toBe(
      (CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB - 1024) * 1024 * 1024
    );
  });
});

describe('validRunData', () => {
  it('accepts the dispatcher shape and refuses an unsafe name, a repeated name, or an extra key', () => {
    expect(validRunData([entry()])).toBe(true);
    expect(validRunData([entry({ name: '../etc/passwd' })])).toBe(false);
    expect(validRunData([entry(), entry()])).toBe(false);
    expect(validRunData([{ ...entry(), bytesBase64: 'eA==' }])).toBe(false);
  });

  it('holds ten data files and ten sources together, and refuses one more', () => {
    const files = (count: number) => Array.from({ length: count }, (_, i) => entry({ name: `f${i}.csv` }));
    expect(validRunData(files(20))).toBe(true);
    expect(validRunData(files(21))).toBe(false);
  });
});
