import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, mkdir, open, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CALLABLE_FUNCTION_DATA_LIMITS, CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN } from '@bike4mind/common';

/**
 * The runtime parent's side of pinned data: a cache keyed by function prefix and file hash, linked into a fresh
 * read-only directory per call that the child mounts at `/data`. The guest never sees a link.
 */

/** One data file as the dispatcher sends it: where to read it for this call and what it must hash to. */
export interface CallableFunctionRunData {
  name: string;
  /** The function-data key prefix, so one function's cache entries never serve another's. */
  prefix: string;
  sha256: string;
  bytes: number;
  url: string;
}

const PREFIX = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_URL_CHARS = 8192;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only the known fields, a safe name each, no repeated name, and at most the pin limit. */
export function validRunData(raw: unknown): raw is CallableFunctionRunData[] {
  if (!Array.isArray(raw) || raw.length > CALLABLE_FUNCTION_DATA_LIMITS.maxPins) return false;
  const names = new Set<string>();
  for (const entry of raw) {
    if (!isObject(entry)) return false;
    if (!Object.keys(entry).every(key => ['name', 'prefix', 'sha256', 'bytes', 'url'].includes(key))) return false;
    const { name, prefix, sha256, bytes, url } = entry;
    if (typeof name !== 'string' || names.has(name)) return false;
    if (!CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN.test(name)) return false;
    if (typeof prefix !== 'string' || !PREFIX.test(prefix)) return false;
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return false;
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS || !/^https?:\/\//.test(url)) return false;
    names.add(name);
  }
  return true;
}

/** Where downloaded files are kept between warm calls; under /tmp, which is the runtime Lambda's ephemeral storage. */
export const defaultCallableFunctionDataDir = () => path.join(tmpdir(), 'callable-function-data');

/** Download time at most; the parent counts what it takes against the call's ceiling (`runTimeoutAfterDownload`). */
export const CALLABLE_FUNCTION_DATA_DOWNLOAD_BUDGET_MS = 120_000;

/** The cache's share of the ephemeral storage; the rest is the runtime's own. */
export const CALLABLE_FUNCTION_DATA_CACHE_BYTES = CALLABLE_FUNCTION_DATA_LIMITS.cacheMb * 1024 * 1024;

interface CacheEntry {
  bytes: number;
  usedAt: number;
}

/** Size and hash recorded at download, by cache path: a file that no longer matches is downloaded again. */
const manifest = new Map<string, CacheEntry>();

export type DataFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type PreparedRunData =
  | { ok: true; dir: string | null; release: () => Promise<void> }
  | { ok: false; reason: 'data_hash_mismatch' | 'data_unavailable' };

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function forget(file: string): Promise<void> {
  manifest.delete(file);
  await chmod(file, 0o644).catch(() => {});
  await unlink(file).catch(() => {});
}

/** Evicts least-recently-used entries outside `keep` until `incoming` more bytes fit. */
async function makeRoom(incoming: number, keep: Set<string>, capBytes: number): Promise<void> {
  let total = [...manifest.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const oldest = [...manifest.entries()].filter(([file]) => !keep.has(file)).sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [file, entry] of oldest) {
    if (total + incoming <= capBytes) return;
    await forget(file);
    total -= entry.bytes;
  }
}

/** Streams one link to `target`, hashing as it writes; false when the bytes are not the pinned ones. */
async function download(entry: CallableFunctionRunData, target: string, fetchData: DataFetch, signal: AbortSignal) {
  const response = await fetchData(entry.url, { signal });
  if (!response.ok || !response.body) throw new Error(`data download answered ${response.status}`);
  const partial = `${target}.${randomUUID()}.part`;
  const hash = createHash('sha256');
  let written = 0;
  const handle = await open(partial, 'w', 0o600);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      written += chunk.length;
      // Past the pinned size the bytes cannot match, so stop reading.
      if (written > entry.bytes) break;
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close();
    await unlink(partial).catch(() => {});
    throw error;
  }
  await handle.close();
  if (written !== entry.bytes || hash.digest('hex') !== entry.sha256) {
    await unlink(partial).catch(() => {});
    return false;
  }
  await chmod(partial, 0o444);
  await rename(partial, target);
  return true;
}

/**
 * Makes every file of one call readable at `<dir>/<name>`, from the cache or a fresh download. A hash or size
 * mismatch refuses the call. `release` removes the call's directory, never the cache.
 */
export async function prepareRunData(
  data: CallableFunctionRunData[] | undefined,
  options: {
    cacheDir?: string;
    fetchData?: DataFetch;
    budgetMs?: number;
    capBytes?: number;
    now?: () => number;
  } = {}
): Promise<PreparedRunData> {
  const none = { ok: true as const, dir: null, release: async () => {} };
  if (!data?.length) return none;
  const root = options.cacheDir ?? defaultCallableFunctionDataDir();
  const fetchData: DataFetch = options.fetchData ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const capBytes = options.capBytes ?? CALLABLE_FUNCTION_DATA_CACHE_BYTES;
  const signal = AbortSignal.timeout(options.budgetMs ?? CALLABLE_FUNCTION_DATA_DOWNLOAD_BUDGET_MS);
  const cachePath = (entry: CallableFunctionRunData) => path.join(root, 'cache', entry.prefix, entry.sha256);
  const keep = new Set(data.map(cachePath));

  for (const entry of data) {
    const file = cachePath(entry);
    const known = manifest.get(file);
    const size = await sizeOf(file);
    if (known && size === entry.bytes && known.bytes === entry.bytes) {
      known.usedAt = now();
      continue;
    }
    // On disk but not in this process's manifest (or changed since): trusted only after a fresh hash.
    if (size !== null) {
      if (size === entry.bytes && (await hashFile(file)) === entry.sha256) {
        manifest.set(file, { bytes: entry.bytes, usedAt: now() });
        continue;
      }
      await forget(file);
    }
    await makeRoom(entry.bytes, keep, capBytes);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let matched: boolean;
    try {
      matched = await download(entry, file, fetchData, signal);
    } catch {
      return { ok: false, reason: 'data_unavailable' };
    }
    if (!matched) return { ok: false, reason: 'data_hash_mismatch' };
    manifest.set(file, { bytes: entry.bytes, usedAt: now() });
  }

  // A fresh directory per call, holding only this call's files, read-only once linked.
  const dir = path.join(root, 'calls', randomUUID());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const linked: string[] = [];
  const release = async () => {
    await chmod(dir, 0o700).catch(() => {});
    for (const file of linked) await unlink(file).catch(() => {});
    await rmdir(dir).catch(() => {});
  };
  try {
    for (const entry of data) {
      const target = path.join(dir, entry.name);
      await link(cachePath(entry), target);
      linked.push(target);
    }
    await chmod(dir, 0o555);
  } catch {
    await release();
    return { ok: false, reason: 'data_unavailable' };
  }
  return { ok: true, dir, release };
}

/** Test hook: forgets the in-memory manifest, as a new runtime environment would. */
export function resetRunDataManifest(): void {
  manifest.clear();
}
