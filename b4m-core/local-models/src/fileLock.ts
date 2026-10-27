import { open, readFile, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { LocalRuntimeError, ModelFileBusyError, RuntimeStorageError } from './errors';

/** A lock whose holder never wrote its pid is taken over after this long (ms). */
const UNREADABLE_LOCK_STALE_MS = 60_000;

export function storageError(runtimeId: string, path: string, error: unknown): unknown {
  if (error instanceof LocalRuntimeError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== 'string') return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new RuntimeStorageError(`${runtimeId} could not write ${path}: ${reason}`, runtimeId, path, code, {
    cause: error,
  });
}

/** Runs a file operation, turning an errno failure into `RuntimeStorageError`. */
export async function onDisk<T>(runtimeId: string, path: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw storageError(runtimeId, path, error);
  }
}

export interface FileLock {
  release(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isStale(lockPath: string): Promise<{ stale: boolean; pid: number | null }> {
  const text = await readFile(lockPath, 'utf8').catch(() => null);
  if (text === null) return { stale: false, pid: null };
  try {
    const holder = JSON.parse(text) as { pid?: unknown; host?: unknown };
    const pid = typeof holder.pid === 'number' ? holder.pid : null;
    // Only a holder on this host can be checked; one on another host sharing the directory counts as live.
    return { stale: pid !== null && holder.host === hostname() && !alive(pid), pid };
  } catch {
    const age = Date.now() - ((await stat(lockPath).catch(() => null))?.mtimeMs ?? Date.now());
    return { stale: age > UNREADABLE_LOCK_STALE_MS, pid: null };
  }
}

/**
 * Takes `<path>.lock` exclusively for writing `path` (and its `.partial`), across processes. A lock left by a
 * process that died on this host is taken over; any other held lock throws `ModelFileBusyError`.
 */
export async function lockFile(path: string, runtimeId: string): Promise<FileLock> {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; ; attempt++) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw storageError(runtimeId, lockPath, error);
      const holder = await isStale(lockPath);
      if (!holder.stale || attempt > 0) throw new ModelFileBusyError(runtimeId, path, holder.pid);
      await onDisk(runtimeId, lockPath, () => rm(lockPath, { force: true }));
      continue;
    }
    const failed = await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() })).then(
      () => null,
      (error: unknown) => ({ error })
    );
    await handle.close();
    if (failed) {
      await rm(lockPath, { force: true });
      throw storageError(runtimeId, lockPath, failed.error);
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { force: true });
      },
    };
  }
}
