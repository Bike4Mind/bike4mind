import { chmod, mkdir, stat } from 'node:fs/promises';

const OWNER_ONLY_DIRECTORY = 0o700;

/**
 * Remove any permission bits outside `allowed` from an existing path; never adds bits. A missing
 * path is left alone, and any other failure (including a chmod refused because another account
 * owns the path) is thrown, so the host does not run with credentials it cannot protect.
 */
export async function restrictMode(path: string, allowed: number): Promise<void> {
  let current: number;
  try {
    current = (await stat(path)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if ((current & ~allowed) !== 0) await chmod(path, current & allowed);
}

/** Create `path` (and missing parents) as 0700, and tighten it if it already exists looser. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
  await restrictMode(path, OWNER_ONLY_DIRECTORY);
}
