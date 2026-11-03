import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const RUN_ROOT_PREFIX = 'b4m-desktop-run-';

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

// A killed run never reaches its teardown; the pid in the root's name tells a later run that it is dead.
export async function removeDeadRunRoots(parent: string): Promise<void> {
  const names = await readdir(parent);
  const dead = names.filter(name => {
    const pid = Number(name.match(new RegExp(`^${RUN_ROOT_PREFIX}(\\d+)-`))?.[1]);
    return pid > 0 && !isAlive(pid);
  });
  await Promise.all(dead.map(name => rm(join(parent, name), { recursive: true, force: true }).catch(() => undefined)));
}
