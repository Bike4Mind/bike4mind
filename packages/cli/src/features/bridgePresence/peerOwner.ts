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
 * `local_address` hex (upper-case) of a socket that receives connections to
 * `127.0.0.1`: loopback itself, the v4/v6 wildcard binds (a same-UID process
 * may legitimately hold `0.0.0.0`/`::`), and the v4-mapped-in-v6 forms. A row
 * on any other IP is a different socket that happens to share the port number
 * and must NOT be attributed to the loopback peer - see the port-only-match
 * fail-open this guards against.
 */
const LOOPBACK_OR_WILDCARD_HEX = new Set([
  '00000000', // 0.0.0.0
  '0100007F', // 127.0.0.1
  '00000000000000000000000000000000', // ::
  '00000000000000000000000001000000', // ::1
  '00000000000000000000FFFF00000000', // ::ffff:0.0.0.0
  '00000000000000000000FFFF0100007F', // ::ffff:127.0.0.1
]);

/**
 * Parse a `/proc/net/tcp`(6) dump for the UID of a LISTEN socket on the
 * loopback `port`. Row columns are whitespace-separated: sl(0)
 * local_address(1) rem_address(2) st(3) tx:rx(4) tr:when(5) retrnsmt(6)
 * uid(7). `local_address` is `HEXIP:HEXPORT`; `st` `0A` is TCP_LISTEN. The IP
 * must be loopback or wildcard, else a same-port listener on another interface
 * would be mis-attributed to the loopback peer.
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
    if (!LOOPBACK_OR_WILDCARD_HEX.has(local.slice(0, colon).toUpperCase())) continue;
    const uid = Number(cols[7]);
    if (Number.isInteger(uid)) return uid;
  }
  return null;
}

async function resolveViaLsof(port: number): Promise<number | null> {
  const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpun']);
  return parseLsofForUid(stdout);
}

/** Does an `lsof -nP` numeric socket name (`n` field, host:port) receive
 *  connections to `127.0.0.1`? Loopback, wildcard, or v4-mapped loopback. */
function isLoopbackLsofName(name: string): boolean {
  return (
    name.startsWith('127.') ||
    name.startsWith('*:') ||
    name.startsWith('[::1]:') ||
    name.startsWith('[::]:') ||
    name.startsWith('[::ffff:127.')
  );
}

/**
 * Parse `lsof -Fpun` output for the UID of a loopback listener. `-F` prints
 * one field per line prefixed by its type char; `u<uid>` is a process-level
 * field, `n<host:port>` a file-level one. We return the tracked UID only once
 * we see a loopback/wildcard name, so a same-port listener on another
 * interface is not mis-attributed to the loopback peer.
 */
export function parseLsofForUid(text: string): number | null {
  let uid: number | null = null;
  for (const line of text.split('\n')) {
    if (line[0] === 'u') {
      const parsed = Number(line.slice(1));
      uid = Number.isInteger(parsed) ? parsed : null;
    } else if (line[0] === 'n' && uid !== null && isLoopbackLsofName(line.slice(1))) {
      return uid;
    }
  }
  return null;
}
