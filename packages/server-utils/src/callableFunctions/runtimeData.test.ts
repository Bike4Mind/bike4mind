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
});

describe('CALLABLE_FUNCTION_DATA_CACHE_BYTES', () => {
  it('leaves the runtime 1 GB of its ephemeral storage', () => {
    expect(CALLABLE_FUNCTION_DATA_CACHE_BYTES).toBe(
      (CALLABLE_FUNCTION_LAMBDA_EPHEMERAL_STORAGE_MB - 1024) * 1024 * 1024
    );
  });
});

describe('validRunData', () => {
  it('accepts the dispatcher shape and refuses an unsafe name, a repeated name, an extra key, or an eleventh file', () => {
    expect(validRunData([entry()])).toBe(true);
    expect(validRunData([entry({ name: '../etc/passwd' })])).toBe(false);
    expect(validRunData([entry(), entry()])).toBe(false);
    expect(validRunData([{ ...entry(), bytesBase64: 'eA==' }])).toBe(false);
    expect(validRunData(Array.from({ length: 11 }, (_, i) => entry({ name: `f${i}.csv` })))).toBe(false);
  });
});
