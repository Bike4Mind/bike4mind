import { readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

export const RUN_ROOT_PREFIX = 'b4m-desktop-run-';
export const RUN_ROOT_ENV = 'B4M_DESKTOP_TEST_RUN_ROOT';
export const STALE_ROOT_AGE_MS = 60 * 60 * 1000;
export const ROOT_HEARTBEAT_MS = 10 * 60 * 1000;

const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

// A Windows handle or child process can outlive its run; the next run's sweep removes what is left.
// Any other failure (e.g. a read-only subdirectory) is a leak in a test and rejects.
export async function removeRoot(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    if (!LOCKED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    console.warn(`Could not remove ${dir}; a later run will sweep it.`);
  }
}

// Keeps a live root's mtime fresh so a sweep in another pid namespace never reads it as stale.
export function startRootHeartbeat(dir: string, intervalMs = ROOT_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    const now = new Date();
    utimes(dir, now, now).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
export function redirectTmpdir(dir: string): void {
  process.env.TMPDIR = dir;
  process.env.TEMP = dir;
  process.env.TMP = dir;
}

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
export function redirectHomedir(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function isStale(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_ROOT_AGE_MS;
  } catch {
    return false;
  }
}

// A killed run never reaches its teardown; the pid in the root's name tells a later run that it is dead.
// A live run in another pid namespace sharing this tmpdir also reads as dead, so the root must be old too.
export async function removeDeadRunRoots(parent: string): Promise<void> {
  const names = await readdir(parent);
  const dead = names.filter(name => {
    const pid = Number(name.match(new RegExp(`^${RUN_ROOT_PREFIX}(\\d+)-`))?.[1]);
    return pid > 0 && !isAlive(pid);
  });
  await Promise.all(
    dead.map(async name => {
      const path = join(parent, name);
      if (!(await isStale(path))) return;
      await removeRoot(path).catch(error => console.warn(`Could not sweep ${path}: ${(error as Error).message}`));
    })
  );
}
