import { realpathSync } from 'node:fs';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SESSION_ID = /^[\w-]+$/;

let resolved: { temp: string; parent: string } | undefined;

/**
 * Physical, as the path tools compare roots: macOS's tmpdir() is under /var, a symlink to /private/var.
 * Under the temp folder so the shell scan already counts it as inside (see shellScan's shellHome).
 */
function scratchParent(): string {
  const temp = tmpdir();
  if (resolved?.temp !== temp) {
    let physical = temp;
    try {
      physical = realpathSync(temp);
    } catch {
      // Left as written; a root that does not resolve is refused by the path tools rather than widened.
    }
    resolved = { temp, parent: join(physical, 'b4m-scratch') };
  }
  return resolved.parent;
}

/** The folder a Code session keeps throwaway scripts and files in. */
export function scratchDirectory(sessionId: string): string | null {
  return SESSION_ID.test(sessionId) ? join(scratchParent(), sessionId) : null;
}

export function isScratchDirectory(path: string): boolean {
  return dirname(path) === scratchParent();
}

/** Owned by this user and not a link: on a shared /tmp another user could create either first. */
async function ownedFolder(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isDirectory()) return false;
  const uid = process.getuid?.();
  return uid === undefined || stats.uid === uid;
}

/** The session's scratch folder, created if needed; null when it cannot be made safely. */
export async function ensureScratchDirectory(sessionId: string): Promise<string | null> {
  const path = scratchDirectory(sessionId);
  if (!path) return null;
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return (await ownedFolder(dirname(path))) && (await ownedFolder(path)) ? path : null;
}

export async function removeScratchDirectory(sessionId: string): Promise<void> {
  const path = scratchDirectory(sessionId);
  if (path && (await ownedFolder(dirname(path)))) await rm(path, { recursive: true, force: true });
}
