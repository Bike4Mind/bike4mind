import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/** Only the known fields, a safe name each, no repeated name, and at most the data files and sources together. */
export function validRunData(raw: unknown): raw is CallableFunctionRunData[] {
  const maxEntries = CALLABLE_FUNCTION_DATA_LIMITS.maxPins + CALLABLE_FUNCTION_DATA_LIMITS.maxSources;
  if (!Array.isArray(raw) || raw.length > maxEntries) return false;
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
// Template literals, not path.join, in every path here: a join onto a runtime-only root makes the client's file
// tracer glob the app directory into the build (see apps/client/server/utils/spoolRequestToFile.ts).
export const defaultCallableFunctionDataDir = () => `${tmpdir()}/callable-function-data`;

/** Download time at most; the parent counts what it takes against the call's own limit (`runTimeoutAfterDownload`). */
export const CALLABLE_FUNCTION_DATA_DOWNLOAD_BUDGET_MS = 120_000;

/** The cache's share of the ephemeral storage; the rest is the runtime's own. */
export const CALLABLE_FUNCTION_DATA_CACHE_BYTES = CALLABLE_FUNCTION_DATA_LIMITS.cacheMb * 1024 * 1024;

interface CacheEntry {
  bytes: number;
  usedAt: number;
  /** False for a file found on disk at start: counted toward the cap, but hashed before it is served. */
  verified: boolean;
}

/** Every cache file by path, with its size: a file that no longer matches is downloaded again. */
const manifest = new Map<string, CacheEntry>();
/** Cache roots this process has already reconciled with the disk. */
const reconciled = new Set<string>();
/** Serializes the cache work of concurrent calls in one process (the self-host runner), so eviction and downloads never race. */
let cacheLock: Promise<unknown> = Promise.resolve();

function withCacheLock<T>(work: () => Promise<T>): Promise<T> {
  const run = cacheLock.then(work, work);
  cacheLock = run.catch(() => {});
  return run;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Removes a tree without following a symlink, making each directory writable first (call directories are 0555). */
async function removeTree(target: string): Promise<void> {
  const info = await lstat(target).catch(() => null);
  if (!info) return;
  if (!info.isDirectory()) {
    await unlink(target).catch(() => {});
    return;
  }
  await chmod(target, 0o700).catch(() => {});
  for (const name of await listDir(target)) await removeTree(`${target}/${name}`);
  await rmdir(target).catch(() => {});
}

/**
 * First use of a root in this process: a previous process killed mid-call may have left call directories, partial
 * downloads, and cache files it never accounted for. The first two go; the cache files are counted, unverified.
 */
async function reconcile(root: string): Promise<void> {
  if (reconciled.has(root)) return;
  reconciled.add(root);
  for (const name of await listDir(`${root}/calls`)) await removeTree(`${root}/calls/${name}`);
  for (const prefix of await listDir(`${root}/cache`)) {
    for (const name of await listDir(`${root}/cache/${prefix}`)) {
      const file = `${root}/cache/${prefix}/${name}`;
      const info = await lstat(file).catch(() => null);
      if (!info) continue;
      if (!info.isFile() || !SHA256.test(name)) {
        await removeTree(file);
        continue;
      }
      if (!manifest.has(file)) manifest.set(file, { bytes: info.size, usedAt: info.mtimeMs, verified: false });
    }
  }
}

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
  const reader = response.body.getReader();
  const handle = await open(partial, 'w', 0o600);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.length;
      // Past the pinned size the bytes cannot match, so stop reading and close the connection.
      if (written > entry.bytes) {
        await reader.cancel().catch(() => {});
        break;
      }
      hash.update(value);
      await handle.write(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
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
  const cacheDir = (entry: CallableFunctionRunData) => `${root}/cache/${entry.prefix}`;
  const cachePath = (entry: CallableFunctionRunData) => `${cacheDir(entry)}/${entry.sha256}`;
  const keep = new Set(data.map(cachePath));

  // Linking happens under the lock too, so no other call evicts a file this one verified before it is linked.
  return withCacheLock(async (): Promise<PreparedRunData> => {
    await reconcile(root);
    for (const entry of data) {
      const file = cachePath(entry);
      const known = manifest.get(file);
      const size = await sizeOf(file);
      if (known?.verified && size === entry.bytes && known.bytes === entry.bytes) {
        known.usedAt = now();
        continue;
      }
      // On disk but not verified by this process (or changed since): trusted only after a fresh hash.
      if (size !== null) {
        if (size === entry.bytes && (await hashFile(file)) === entry.sha256) {
          manifest.set(file, { bytes: entry.bytes, usedAt: now(), verified: true });
          continue;
        }
        await forget(file);
      }
      await makeRoom(entry.bytes, keep, capBytes);
      await mkdir(cacheDir(entry), { recursive: true, mode: 0o700 });
      let matched: boolean;
      try {
        matched = await download(entry, file, fetchData, signal);
      } catch {
        return { ok: false, reason: 'data_unavailable' };
      }
      if (!matched) return { ok: false, reason: 'data_hash_mismatch' };
      manifest.set(file, { bytes: entry.bytes, usedAt: now(), verified: true });
    }

    // A fresh directory per call, holding only this call's files, read-only once linked.
    const dir = `${root}/calls/${randomUUID()}`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const linked: string[] = [];
    const release = async () => {
      await chmod(dir, 0o700).catch(() => {});
      for (const file of linked) await unlink(file).catch(() => {});
      await rmdir(dir).catch(() => {});
    };
    try {
      for (const entry of data) {
        const target = `${dir}/${entry.name}`;
        await link(cachePath(entry), target);
        linked.push(target);
      }
      await chmod(dir, 0o555);
    } catch {
      await release();
      return { ok: false, reason: 'data_unavailable' };
    }
    return { ok: true, dir, release };
  });
}

/** Test hook: forgets the in-memory manifest, as a new runtime environment would. */
export function resetRunDataManifest(): void {
  manifest.clear();
  reconciled.clear();
}
