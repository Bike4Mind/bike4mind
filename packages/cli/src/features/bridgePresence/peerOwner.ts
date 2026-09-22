import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Resolve the OS owner (UID) of the process holding the LISTEN socket on
 * `127.0.0.1:<port>`. This is the only pre-transmission trust signal the CLI
 * has over loopback TCP: the peer is whoever holds the port, so we confirm it
 * is the same UID as this process BEFORE handing it the bridge secret.
 *
 * Returns `null` whenever ownership cannot be determined (unsupported
 * platform, tool missing, spawn/read error, or no/ambiguous match). Callers
 * MUST treat `null` as untrusted (fail-closed).
 */
export async function resolveLoopbackListenerUid(port: number): Promise<number | null> {
  try {
    if (process.platform === 'linux') return await resolveViaProcNet(port);
    if (process.platform === 'darwin') return await resolveViaLsof(port);
    return null;
  } catch {
    return null;
  }
}

async function resolveViaProcNet(port: number): Promise<number | null> {
  const uids = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue; // tcp6 may be absent on IPv6-less kernels
    }
    const uid = parseProcNetForUid(text, port);
    if (uid !== null) uids.add(uid);
  }
  // Ambiguous (both v4 and v6 listeners owned by different UIDs) -> untrusted.
  return uids.size === 1 ? [...uids][0] : null;
}

/**
 * Parse a `/proc/net/tcp`(6) dump for the UID of a LISTEN socket on `port`.
 * Row columns are whitespace-separated: sl(0) local_address(1) rem_address(2)
 * st(3) tx:rx(4) tr:when(5) retrnsmt(6) uid(7). `local_address` is
 * `HEXIP:HEXPORT`; `st` `0A` is TCP_LISTEN.
 */
export function parseProcNetForUid(text: string, port: number): number | null {
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const local = cols[1];
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    if (parseInt(local.slice(colon + 1), 16) !== port) continue;
    if (cols[3] !== '0A') continue; // TCP_LISTEN
    const uid = Number(cols[7]);
    if (Number.isInteger(uid)) return uid;
  }
  return null;
}

async function resolveViaLsof(port: number): Promise<number | null> {
  const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpu']);
  return parseLsofForUid(stdout);
}

/**
 * Parse `lsof -Fpu` output for the listener's UID. `-F` prints one field per
 * line prefixed by its type char; `u<uid>` carries the owning UID.
 */
export function parseLsofForUid(text: string): number | null {
  for (const line of text.split('\n')) {
    if (line[0] !== 'u') continue;
    const uid = Number(line.slice(1));
    if (Number.isInteger(uid)) return uid;
  }
  return null;
}
