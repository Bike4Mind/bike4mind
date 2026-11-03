import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const RUN_ROOT_PREFIX = 'b4m-desktop-run-';
export const STALE_ROOT_AGE_MS = 60 * 60 * 1000;

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
      if (await isStale(path)) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    })
  );
}
