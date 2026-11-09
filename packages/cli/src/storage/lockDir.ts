// Cross-process lock directories, after proper-lockfile: mkdir to acquire, and the holder touches the directory's
// mtime every staleMs / 3 so a held lock never ages past its stale limit. The `owner` file inside names the holder;
// whoever's nonce it carries holds the lock. proper-lockfile itself is not used: it breaks a stale lock by rmdir then
// mkdir, which can let two breakers in, and its default on a lost lock is an uncaught throw from a timer.
import { promises as fs } from 'fs';
import { hostname } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface LockDirOptions {
  waitMs: number;
  staleMs: number;
  pollMs: number;
  heldMessage: string;
}

export interface HeldLock {
  /** Aborts once the lock is found taken from this holder. */
  readonly signal: AbortSignal;
  /** Rejects unless this holder still owns the lock. Call it right before the write the lock guards. */
  assertHeld(): Promise<void>;
}

export class LockLostError extends Error {
  constructor(lockPath: string) {
    super(`Lost the lock ${lockPath}: another b4m process may have taken it over`);
    this.name = 'LockLostError';
  }
}

const OWNER = 'owner';
const OWNER_READ_TRIES = 5;
const RELEASE_TRIES = 5;
const RETRY_PAUSE_MS = 20;

/** Nonces of the locks this process holds now, so a lock it left behind is told apart from one it still holds. */
const liveNonces = new Set<string>();

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** True when no process `pid` exists on this host. EPERM means one exists that this user cannot signal. */
function holderIsGone(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return codeOf(error) === 'ESRCH';
  }
}

interface Owner {
  pid?: unknown;
  hostname?: unknown;
  nonce?: unknown;
}

/** The lock's owner record, or null when there is none. Transient read errors (EBUSY on Windows) are retried, then thrown. */
async function readOwner(lockPath: string): Promise<Owner | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(lockPath, OWNER), 'utf-8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as Owner) : null;
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR' || error instanceof SyntaxError) return null;
      if (attempt >= OWNER_READ_TRIES) throw error;
      await pause(RETRY_PAUSE_MS);
    }
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(lockPath)).mtimeMs;
  } catch {
    return false;
  }
  const age = Date.now() - mtimeMs;
  // A touch far in the future (the clock was set back since) would otherwise never age out.
  if (age > staleMs || age < -staleMs) return true;
  // A pid on this hostname may belong to another pid namespace (flatpak, containers sharing $HOME), so an exited or
  // finished holder is stale early only once it has also missed a heartbeat.
  if (age <= (staleMs * 2) / 3) return false;
  const owner = await readOwner(lockPath).catch(() => null);
  if (!owner || owner.hostname !== hostname()) return false;
  if (owner.pid === process.pid) return typeof owner.nonce === 'string' && !liveNonces.has(owner.nonce);
  return holderIsGone(owner.pid);
}

/**
 * Moves a stale lock aside, then deletes it only if it is still stale there. One found fresh once moved (a new lock
 * made since the check) stays aside: its holder finds the lock lost at its next check instead of sharing it.
 * Returns whether the lock is gone, so the caller can retry without pausing.
 */
async function breakIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  if (!(await isStale(lockPath, staleMs))) return false;
  const aside = `${lockPath}.${uuidv4()}.stale`;
  try {
    await fs.rename(lockPath, aside);
  } catch (error) {
    return codeOf(error) === 'ENOENT';
  }
  if (await isStale(aside, staleMs)) await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/** Removes broken-aside locks, and the old scheme's `*.aside` files, that have outlived the stale limit. */
async function sweepOrphans(lockPath: string, staleMs: number): Promise<void> {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.`;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix) || !(name.endsWith('.stale') || name.endsWith('.aside'))) continue;
    const entry = path.join(dir, name);
    try {
      if (Date.now() - (await fs.stat(entry)).mtimeMs > staleMs) await fs.rm(entry, { recursive: true, force: true });
    } catch {
      // Gone already, or another process is sweeping it.
    }
  }
}

/** Takes the lock, and returns a performance.now() reading from no later than its last touch. */
async function acquire(lockPath: string, nonce: string, opts: LockDirOptions): Promise<number> {
  const deadline = performance.now() + opts.waitMs;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await sweepOrphans(lockPath, opts.staleMs);
  for (;;) {
    let retryNow = false;
    const attemptAt = performance.now();
    try {
      await fs.mkdir(lockPath);
      try {
        const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), nonce });
        await fs.writeFile(path.join(lockPath, OWNER), owner, { flag: 'wx', mode: 0o600 });
        const now = new Date();
        await fs.utimes(lockPath, now, now).catch(() => undefined);
        return attemptAt;
      } catch (error) {
        // ENOENT/EEXIST: the new directory was moved aside, or another process claimed the one now in its place.
        const code = codeOf(error);
        if (code !== 'ENOENT' && code !== 'EEXIST') {
          await fs.rmdir(lockPath).catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      const code = codeOf(error);
      // Windows reports a lock still being deleted as EPERM/EACCES rather than EEXIST.
      const held = code === 'EEXIST' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
      if (!held) throw error;
      retryNow = await breakIfStale(lockPath, opts.staleMs);
    }
    if (performance.now() >= deadline) throw new Error(`${opts.heldMessage} (${lockPath} is held)`);
    if (!retryNow) await pause(opts.pollMs);
  }
}

/**
 * Deletes the lock if it is still this holder's, and returns false when it is not. Windows can refuse the delete
 * briefly while another process reads the lock.
 */
async function release(lockPath: string, nonce: string): Promise<boolean> {
  let owner: Owner | null;
  try {
    owner = await readOwner(lockPath);
  } catch {
    return true;
  }
  if (owner?.nonce !== nonce) return false;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rm(lockPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      const code = codeOf(error);
      // Left in place, it is stale once a heartbeat is missed: its nonce is no longer live in this process.
      if (attempt >= RELEASE_TRIES || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) return true;
      await pause(RETRY_PAUSE_MS * attempt);
    }
  }
}

/**
 * Runs `work` holding the lock directory `lockPath` against other processes. Not reentrant. Rejects with
 * LockLostError when the lock was taken from this holder while `work` ran, even if `work` itself succeeded.
 */
export async function withLockDir<T>(
  lockPath: string,
  work: (held: HeldLock) => Promise<T>,
  opts: LockDirOptions
): Promise<T> {
  const nonce = uuidv4();
  let lastTouch = await acquire(lockPath, nonce, opts);
  liveNonces.add(nonce);
  const lost = new AbortController();
  const assertHeld = async () => {
    // A holder suspended or stalled past two thirds of the stale limit may already have been judged stale.
    if (!lost.signal.aborted && performance.now() - lastTouch > (opts.staleMs * 2) / 3) {
      lost.abort(new LockLostError(lockPath));
    }
    if (!lost.signal.aborted && (await readOwner(lockPath))?.nonce !== nonce) lost.abort(new LockLostError(lockPath));
    if (lost.signal.aborted) throw lost.signal.reason;
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let beating: Promise<void> = Promise.resolve();
  const beat = async () => {
    try {
      await assertHeld();
      const touchedAt = performance.now();
      const now = new Date();
      await fs.utimes(lockPath, now, now);
      lastTouch = touchedAt;
    } catch {
      // A lost lock stops the heartbeat; a failed read or touch is retried on the next beat.
    }
    if (!stopped && !lost.signal.aborted) schedule();
  };
  const schedule = () => {
    timer = setTimeout(() => {
      beating = beat();
    }, opts.staleMs / 3);
    timer.unref?.();
  };
  schedule();
  let result: T;
  let stillHeld = true;
  try {
    result = await work({ signal: lost.signal, assertHeld });
  } finally {
    stopped = true;
    clearTimeout(timer);
    await beating;
    stillHeld = await release(lockPath, nonce);
    liveNonces.delete(nonce);
  }
  if (!stillHeld && !lost.signal.aborted) lost.abort(new LockLostError(lockPath));
  if (lost.signal.aborted) throw lost.signal.reason;
  return result;
}
