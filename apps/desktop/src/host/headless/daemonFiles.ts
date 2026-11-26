import { randomUUID } from 'node:crypto';
import { link, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';

export const SOCKET_FILE_NAME = 'host.sock';
export const LOCK_FILE_NAME = 'host.lock';

/** How long a live process may hold the lock before its socket answers; the daemon listens right after taking it. */
export const STARTUP_GRACE_MS = 10_000;

// sockaddr_un.sun_path is 104 bytes on macOS and 108 on Linux, including the terminator.
const MAX_SOCKET_PATH_BYTES = 103;

const lockRecordSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string(),
  startedAt: z.number(),
});
export type LockRecord = z.infer<typeof lockRecordSchema>;

export type DaemonPaths = { directory: string; socket: string; lock: string };

export function daemonPaths(directory: string): DaemonPaths {
  const socket = join(directory, SOCKET_FILE_NAME);
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`The socket path ${socket} is too long for a unix socket; use a shorter data directory`);
  }
  return { directory, socket, lock: join(directory, LOCK_FILE_NAME) };
}

/**
 * What the lock file says about the daemon, checked against the process and the socket rather
 * than trusted: a pid can be reused after a reboot, and a crash leaves both files behind.
 * - running: the recorded process is alive and the socket accepts connections.
 * - starting: alive, the socket not yet answering, and the lock still inside the startup grace.
 * - stale: left by a process that is gone or no longer listening; safe to replace.
 * - stopped: no lock at all.
 */
export type DaemonState =
  { state: 'stopped' } | { state: 'running' | 'starting'; record: LockRecord | null } | { state: 'stale'; raw: string };

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to someone else, so it is alive and not ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function socketAccepts(path: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path);
    const finish = (accepted: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(accepted);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function parseLock(raw: string): LockRecord | null {
  try {
    const parsed = lockRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function inspectDaemon(paths: DaemonPaths): Promise<DaemonState> {
  const raw = await readText(paths.lock);
  if (raw === null) return { state: 'stopped' };
  const record = parseLock(raw);
  if (record && !isProcessAlive(record.pid)) return { state: 'stale', raw };
  if (await socketAccepts(paths.socket)) return { state: 'running', record };
  // An unreadable lock gives no process to wait for, so only a listening socket keeps it.
  if (record && Date.now() - record.startedAt < STARTUP_GRACE_MS) return { state: 'starting', record };
  return { state: 'stale', raw };
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly record: LockRecord | null) {
    super(
      record
        ? `A b4m-host daemon is already running (pid ${record.pid}, version ${record.version})`
        : 'A b4m-host daemon is already running'
    );
  }
}

export type DaemonLock = {
  readonly record: LockRecord;
  /** Removes the lock if it is still this one. */
  release(): Promise<void>;
};

/** Removes `path` only while it still holds `expected`, so a lock another process just took survives. */
async function removeIfUnchanged(path: string, expected: string): Promise<void> {
  if ((await readText(path)) !== expected) return;
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Moves a stale lock aside and keeps it gone only if it is still the stale one. The rename is
 * atomic where read-then-unlink is not, so a fresh lock another starter linked in meanwhile is
 * put back instead of deleted.
 */
async function discardStaleLock(paths: DaemonPaths, stale: string): Promise<void> {
  const aside = join(paths.directory, `.${LOCK_FILE_NAME}.stale.${process.pid}.${randomUUID()}`);
  try {
    await rename(paths.lock, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    if ((await readText(aside)) === stale) return;
    try {
      await link(aside, paths.lock);
    } catch (err) {
      // A third starter linked its lock into the gap while this one was aside; that one stands.
      // The fresh lock we moved is then lost, so its owner runs lockless until it exits. Needs
      // three starters interleaving here, so it is accepted rather than locked against.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } finally {
    await unlink(aside).catch(() => undefined);
  }
}

/**
 * Takes the single-instance lock. The record is written to a private temporary file and linked
 * into place, so the lock appears whole or not at all and two daemons can never both create it.
 * A stale lock is removed and the take retried; a live one throws DaemonAlreadyRunningError.
 */
export async function acquireDaemonLock(paths: DaemonPaths, version: string): Promise<DaemonLock> {
  const record: LockRecord = { pid: process.pid, version, startedAt: Date.now() };
  const raw = `${JSON.stringify(record)}\n`;
  const temporary = join(paths.directory, `.${LOCK_FILE_NAME}.${process.pid}.${randomUUID()}`);
  await writeFile(temporary, raw, { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(temporary, paths.lock);
        return { record, release: () => removeIfUnchanged(paths.lock, raw) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const current = await inspectDaemon(paths);
      if (current.state === 'running' || current.state === 'starting') {
        throw new DaemonAlreadyRunningError(current.record);
      }
      if (current.state === 'stale') await discardStaleLock(paths, current.raw);
    }
    throw new Error(`Could not take ${paths.lock}; another daemon keeps replacing it`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readLockRecord(paths: DaemonPaths): Promise<LockRecord | null> {
  const raw = await readText(paths.lock);
  return raw === null ? null : parseLock(raw);
}
