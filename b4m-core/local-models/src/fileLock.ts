import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { LocalRuntimeError, ModelFileBusyError, RuntimeStorageError } from './errors';

/** How often a held lock's mtime is refreshed (ms). */
export const LOCK_REFRESH_MS = 10_000;
/** A lock not refreshed for this long, or last refreshed before the machine booted, is taken over (ms). */
export const LOCK_STALE_MS = 30_000;

export type StorageOperation = 'read' | 'write';

export function storageError(
  runtimeId: string,
  path: string,
  error: unknown,
  operation: StorageOperation = 'write'
): unknown {
  if (error instanceof LocalRuntimeError) return error;
  const errno = error as NodeJS.ErrnoException | null;
  const code = errno?.code;
  if (typeof code !== 'string') return error;
  const where = typeof errno?.path === 'string' ? errno.path : path;
  const message = `${runtimeId} could not ${operation} ${where}: ${error instanceof Error ? error.message : String(error)}`;
  return new RuntimeStorageError(message, runtimeId, where, code, operation, { cause: error });
}

/** Runs a file operation, turning an errno failure into `RuntimeStorageError`. */
export async function onDisk<T>(
  runtimeId: string,
  path: string,
  operation: () => Promise<T>,
  kind: StorageOperation = 'write'
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw storageError(runtimeId, path, error, kind);
  }
}

export interface FileLock {
  /** Throws `ModelFileBusyError` once a refresh found the lock taken over. */
  assertHeld(): void;
  /** Reads the lock back and throws `ModelFileBusyError` unless it is still this one. */
  verify(): Promise<void>;
  /** Removes the lock if it is still this one. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** Take the lock over even from a live holder, whose next write then fails. */
  force?: boolean;
  refreshMs?: number;
  staleMs?: number;
}

interface Holder {
  text: string;
  ino: bigint;
  mtimeMs: number;
  pid: number | null;
}

function parse(text: string | null): { pid: number | null; nonce: string | null } {
  try {
    const holder = JSON.parse(text ?? '') as { pid?: unknown; nonce?: unknown };
    return {
      pid: typeof holder.pid === 'number' ? holder.pid : null,
      nonce: typeof holder.nonce === 'string' ? holder.nonce : null,
    };
  } catch {
    return { pid: null, nonce: null };
  }
}

async function readHolder(lockPath: string): Promise<Holder | null> {
  try {
    const info = await stat(lockPath, { bigint: true });
    const text = await readFile(lockPath, 'utf8');
    return { text, ino: info.ino, mtimeMs: Number(info.mtimeMs), pid: parse(text).pid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isStale(holder: Holder, staleMs: number): boolean {
  const bootedAt = Date.now() - uptime() * 1000;
  return holder.mtimeMs < bootedAt || Date.now() - holder.mtimeMs > staleMs;
}

const same = (a: Holder | null, b: Holder) => a !== null && a.ino === b.ino && a.text === b.text;

/**
 * Removes the lock judged stale unless it changed since; false when it was not removed. `<lock>.takeover` admits one
 * contender at a time, since one that moved a fresh lock aside would leave a gap for a third to create its own.
 */
async function takeOver(lockPath: string, judged: Holder, nonce: string, staleMs: number): Promise<boolean> {
  const guard = `${lockPath}.takeover`;
  for (let attempt = 0; ; attempt++) {
    try {
      await (await open(guard, 'wx')).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A guard outlives its takeover only if that process died within it.
      const left = await stat(guard).catch(() => null);
      if (attempt > 0 || (left && Date.now() - left.mtimeMs <= staleMs)) return false;
      if (left) await rm(guard, { force: true });
    }
  }
  try {
    if (!same(await readHolder(lockPath), judged)) return false;
    const aside = `${lockPath}.stale-${nonce}`;
    try {
      await rename(lockPath, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    // Only the old holder releasing between the read and the rename can make these differ.
    const moved = await readHolder(aside).catch(() => null);
    if (!same(moved, judged)) await link(aside, lockPath).catch(() => undefined);
    await rm(aside, { force: true });
    return same(moved, judged);
  } finally {
    await rm(guard, { force: true });
  }
}

function holding(lockPath: string, path: string, runtimeId: string, nonce: string, refreshMs: number): FileLock {
  let lost = false;
  let released = false;
  const check = async () => {
    const text = await readFile(lockPath, 'utf8').catch(() => null);
    if (parse(text).nonce !== nonce) lost = true;
    return !lost;
  };
  const timer = setInterval(() => {
    void check().then(async mine => {
      if (!mine) return clearInterval(timer);
      const now = new Date();
      await utimes(lockPath, now, now).catch(() => undefined);
    });
  }, refreshMs);
  timer.unref();
  const busy = () => new ModelFileBusyError(runtimeId, path, null);
  return {
    assertHeld: () => {
      if (lost) throw busy();
    },
    verify: async () => {
      if (!(await check())) throw busy();
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (await check()) await rm(lockPath, { force: true });
    },
  };
}

/**
 * Takes `<path>.lock` for writing `path` and its `.partial`, across processes, refreshing it while held. A lock that
 * stopped being refreshed is taken over; any other held lock throws `ModelFileBusyError`.
 */
export async function lockFile(path: string, runtimeId: string, options: LockOptions = {}): Promise<FileLock> {
  const lockPath = `${path}.lock`;
  const nonce = randomBytes(12).toString('hex');
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw storageError(runtimeId, lockPath, error);
      const holder = await onDisk(runtimeId, lockPath, () => readHolder(lockPath), 'read');
      if (!holder) continue;
      if (!options.force && !isStale(holder, staleMs)) throw new ModelFileBusyError(runtimeId, path, holder.pid);
      const removed = await onDisk(runtimeId, lockPath, () => takeOver(lockPath, holder, nonce, staleMs));
      if (!removed) throw new ModelFileBusyError(runtimeId, path, holder.pid);
      continue;
    }
    const failed = await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), nonce })).then(
      () => null,
      (error: unknown) => ({ error })
    );
    await handle.close();
    if (failed) {
      await rm(lockPath, { force: true });
      throw storageError(runtimeId, lockPath, failed.error);
    }
    return holding(lockPath, path, runtimeId, nonce, options.refreshMs ?? LOCK_REFRESH_MS);
  }
  throw new ModelFileBusyError(runtimeId, path, null);
}
