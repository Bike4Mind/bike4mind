import { randomBytes } from 'node:crypto';
import { link, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { LocalRuntimeError, ModelFileBusyError, RuntimeStorageError } from './errors';

/** How often a held lock's mtime is refreshed (ms). */
export const LOCK_REFRESH_MS = 10_000;
/** A lock not refreshed for this long, or last refreshed before the machine booted, is taken over (ms). */
export const LOCK_STALE_MS = 30_000;
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_MS = 100;
/** How FAT32 and exFAT, which have no hard links, refuse `link`. */
const NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
/** An empty takeover guard younger than this may be a contender's still being written (ms). */
const EMPTY_GUARD_GRACE_MS = 5_000;

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
  /** Throws `ModelFileBusyError` once a refresh or a read-back found the lock taken over. */
  assertHeld(): void;
  /** Reads the lock back: `ModelFileBusyError` if it was taken over; a lock unreadable for now passes. */
  check(): Promise<void>;
  /**
   * Reads the lock back, retrying a lock unreadable for now a few times: `ModelFileBusyError` unless it is still this
   * one, `RuntimeStorageError` if it stays unreadable.
   */
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

function isStale(holder: { mtimeMs: number }, staleMs: number): boolean {
  const bootedAt = Date.now() - uptime() * 1000;
  return holder.mtimeMs < bootedAt || Date.now() - holder.mtimeMs > staleMs;
}

const readText = (path: string) => readFile(path, 'utf8').catch(() => null);
/** A guard's draft, kept while its owner's takeover runs: its absence tells a clearStaleGuard the owner is done. */
const draftOf = (guard: string, nonce: string) => `${guard}.new-${nonce}`;
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';

/** Moves a file renamed aside back to `path`; without hard links, only while nothing else has taken `path`. */
async function putBack(aside: string, path: string): Promise<void> {
  try {
    await link(aside, path);
  } catch (error) {
    if (!NO_LINK_CODES.has(errno(error))) return;
    const taken = await stat(path).then(
      () => true,
      () => false
    );
    if (!taken) await rename(aside, path).catch(() => undefined);
  }
}

/** Moves a takeover guard left by a process that died during its takeover out of the way, once it is stale. */
async function clearStaleGuard(guard: string, nonce: string, staleMs: number): Promise<void> {
  const left = await stat(guard).catch(() => null);
  if (!left || !isStale(left, staleMs)) return;
  const text = await readText(guard);
  const aside = `${guard}.stale-${nonce}`;
  const renamed = await rename(guard, aside).then(
    () => true,
    () => false
  );
  if (!renamed) return;
  const moved = await readText(aside);
  const movedAt = (await stat(aside).catch(() => null))?.mtimeMs ?? 0;
  // Each guard holds its owner's nonce, so other text means a contender's guard replaced the stale one; so does an
  // empty one written just now, by a contender on a file system without hard links that has not written it yet.
  if (moved !== text || (moved === '' && Date.now() - movedAt < EMPTY_GUARD_GRACE_MS)) {
    await putBack(aside, guard);
    // An owner that finished while its guard was aside removed nothing, and checks for the guard only after its draft.
    const ownerDone = moved && !(await readText(draftOf(guard, moved)));
    if (ownerDone && (await readText(guard)) === moved) await rm(guard, { force: true });
  }
  await rm(aside, { force: true });
}

/** Creates `guard` holding `nonce`, and its draft, which the caller removes when done; false when another guard is there. */
async function createGuard(guard: string, nonce: string): Promise<boolean> {
  let placed = false;
  try {
    placed = await placeGuard(guard, nonce);
    return placed;
  } finally {
    if (!placed) await rm(draftOf(guard, nonce), { force: true });
  }
}

async function placeGuard(guard: string, nonce: string): Promise<boolean> {
  // Written aside and linked into place, so where links work a guard is never seen empty.
  const draft = draftOf(guard, nonce);
  try {
    await writeFile(draft, nonce, { flag: 'wx' });
    await link(draft, guard);
    return true;
  } catch (error) {
    if (errno(error) === 'EEXIST') return false;
    if (!NO_LINK_CODES.has(errno(error))) throw error;
  }
  let handle;
  try {
    handle = await open(guard, 'wx');
  } catch (error) {
    if (errno(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(nonce);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(guard, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

const same = (a: Holder | null, b: Holder) => a !== null && a.ino === b.ino && a.text === b.text;

/**
 * Removes the lock judged stale unless it changed since; false when it was not removed. `<lock>.takeover` admits one
 * contender at a time, since one that moved a fresh lock aside would leave a gap for a third to create its own.
 */
async function takeOver(
  lockPath: string,
  judged: Holder,
  nonce: string,
  options: { force: boolean; staleMs: number }
): Promise<boolean> {
  const guard = `${lockPath}.takeover`;
  if (!(await createGuard(guard, nonce))) {
    await clearStaleGuard(guard, nonce, options.staleMs);
    if (!(await createGuard(guard, nonce))) return false;
  }
  try {
    const current = await readHolder(lockPath);
    // A holder that woke up and refreshed since it was judged keeps its lock.
    if (!current || !same(current, judged) || (!options.force && !isStale(current, options.staleMs))) return false;
    const aside = `${lockPath}.stale-${nonce}`;
    try {
      await rename(lockPath, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    // Text, not inode: FAT and exFAT may renumber a file on rename. Only a release in between makes these differ.
    const moved = await readText(aside);
    if (moved !== judged.text) await putBack(aside, lockPath);
    await rm(aside, { force: true });
    return moved === judged.text;
  } finally {
    await rm(guard, { force: true });
    await rm(draftOf(guard, nonce), { force: true });
    // A clearStaleGuard may have put the guard back since; it looks for the draft only after putting back.
    if ((await readText(guard)) === nonce) await rm(guard, { force: true });
  }
}

/** Removes `.stale-<nonce>` and guard drafts a crash left behind, once they are past `staleMs`. */
async function sweepLeftovers(lockPath: string, staleMs: number): Promise<void> {
  const base = basename(lockPath);
  const prefixes = [`${base}.stale-`, `${base}.takeover.stale-`, `${base}.takeover.new-`];
  const names = await readdir(dirname(lockPath)).catch(() => []);
  for (const name of names) {
    if (!prefixes.some(prefix => name.startsWith(prefix))) continue;
    const path = join(dirname(lockPath), name);
    // ctime, not mtime: a rename keeps the stale lock's old mtime but sets ctime.
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.ctimeMs > staleMs) await rm(path, { force: true }).catch(() => undefined);
  }
}

type LockState = 'held' | 'lost' | { error: unknown };

function holding(
  lockPath: string,
  path: string,
  runtimeId: string,
  nonce: string,
  options: { refreshMs: number; staleMs: number }
): FileLock {
  let lost = false;
  let released = false;
  let confirmedAt = Date.now();
  const check = async (): Promise<LockState> => {
    if (lost) return 'lost';
    try {
      if (parse(await readFile(lockPath, 'utf8')).nonce !== nonce) lost = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') lost = true;
      // EACCES, EBUSY, EMFILE and the like pass; only a lock unconfirmed for the stale window counts as lost.
      else if (Date.now() - confirmedAt <= options.staleMs) return { error };
      else lost = true;
    }
    if (lost) return 'lost';
    confirmedAt = Date.now();
    return 'held';
  };
  const timer = setInterval(() => {
    void check().then(async state => {
      if (state === 'lost') return clearInterval(timer);
      if (state !== 'held') return;
      const now = new Date();
      await utimes(lockPath, now, now).catch(() => undefined);
    });
  }, options.refreshMs);
  timer.unref();
  const busy = () => new ModelFileBusyError(runtimeId, path, null);
  return {
    assertHeld: () => {
      if (lost) throw busy();
    },
    check: async () => {
      if ((await check()) === 'lost') throw busy();
    },
    verify: async () => {
      for (let attempt = 1; ; attempt++) {
        const state = await check();
        if (state === 'lost') throw busy();
        if (state === 'held') return;
        if (attempt >= VERIFY_ATTEMPTS) throw storageError(runtimeId, lockPath, state.error, 'read');
        await new Promise(done => setTimeout(done, VERIFY_RETRY_MS));
      }
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      if ((await check()) === 'held') await rm(lockPath, { force: true });
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
      const removed = await onDisk(runtimeId, lockPath, () =>
        takeOver(lockPath, holder, nonce, { force: options.force === true, staleMs })
      );
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
    await sweepLeftovers(lockPath, staleMs);
    return holding(lockPath, path, runtimeId, nonce, { refreshMs: options.refreshMs ?? LOCK_REFRESH_MS, staleMs });
  }
  throw new ModelFileBusyError(runtimeId, path, null);
}
