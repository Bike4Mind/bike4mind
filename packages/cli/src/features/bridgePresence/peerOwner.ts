import { promises as fs, constants } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const LSOF_TIMEOUT_MS = 2_000;
// Resolve an absolute path rather than trusting PATH; check X_OK before spawning
// (mirrors utils/ripgrepCheck.ts / tools/findDefinitionTool.ts).
const LSOF_CANDIDATES = ['/usr/sbin/lsof', '/usr/bin/lsof'];

/**
 * Ownership of the process holding the LISTEN socket on `127.0.0.1:<port>`,
 * discriminated so the caller can tell the security-relevant case apart from
 * the ordinary ones:
 *  - `owner`       - a single same-shape loopback listener; `uid` is its owner.
 *  - `no-listener` - nothing is listening on that loopback port yet (the common
 *                    "cc-bridge not started" case - not a security signal).
 *  - `unknown`     - ownership can't be determined: unsupported platform, the
 *                    lookup tool is missing/hung, a read/spawn error, or two
 *                    distinct owners (ambiguous). Callers MUST treat this as
 *                    untrusted (fail-closed), same as a mismatch.
 */
export type ListenerOwner = { kind: 'owner'; uid: number } | { kind: 'no-listener' } | { kind: 'unknown' };

/**
 * Resolve the OS owner of the process holding the LISTEN socket on
 * `127.0.0.1:<port>`. This is the only pre-transmission trust signal the CLI
 * has over loopback TCP: the peer is whoever holds the port, so we confirm it
 * is the same UID as this process BEFORE handing it the bridge secret.
 */
export async function resolveLoopbackListenerOwner(port: number): Promise<ListenerOwner> {
  try {
    if (process.platform === 'linux') return await resolveViaProcNet(port);
    if (process.platform === 'darwin') return await resolveViaLsof(port);
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

async function resolveViaProcNet(port: number): Promise<ListenerOwner> {
  const uids = new Set<number>();
  let readAny = false;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue; // tcp6 may be absent on IPv6-less kernels
    }
    readAny = true;
    for (const uid of parseProcNetForUid(text, port)) uids.add(uid);
  }
  if (!readAny) return { kind: 'unknown' }; // neither table readable
  if (uids.size === 0) return { kind: 'no-listener' };
  // Ambiguous (distinct owners across the loopback + wildcard rows) -> untrusted.
  return uids.size === 1 ? { kind: 'owner', uid: [...uids][0] } : { kind: 'unknown' };
}

/**
 * `local_address` hex (upper-case) of a socket that receives connections to
 * `127.0.0.1`: loopback itself, the v4/v6 wildcard binds (a same-UID process
 * may legitimately hold `0.0.0.0`/`::`), and the v4-mapped-in-v6 forms. A row
 * on any other IP is a different socket that happens to share the port number
 * and must NOT be attributed to the loopback peer.
 *
 * `/proc/net/tcp6` prints each 32-bit word of the address little-endian (no
 * `ntohl`), which is why `127.0.0.1` reads `0100007F` and the mapped third word
 * `00 00 ff ff` reads `FFFF0000`.
 */
const LOOPBACK_OR_WILDCARD_HEX = new Set([
  '00000000', // 0.0.0.0
  '0100007F', // 127.0.0.1
  '00000000000000000000000000000000', // ::
  '00000000000000000000000001000000', // ::1
  '0000000000000000FFFF000000000000', // ::ffff:0.0.0.0
  '0000000000000000FFFF00000100007F', // ::ffff:127.0.0.1
]);

/**
 * Parse a `/proc/net/tcp`(6) dump for the UIDs of LISTEN sockets on the
 * loopback `port`. Row columns are whitespace-separated: sl(0)
 * local_address(1) rem_address(2) st(3) tx:rx(4) tr:when(5) retrnsmt(6)
 * uid(7). `local_address` is `HEXIP:HEXPORT`; `st` `0A` is TCP_LISTEN. The IP
 * must be loopback or wildcard, else a same-port listener on another interface
 * would be mis-attributed to the loopback peer. Returns every match so the
 * caller can reject an ambiguous set (two distinct owners) rather than
 * silently taking the first.
 */
export function parseProcNetForUid(text: string, port: number): number[] {
  const uids: number[] = [];
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
    if (Number.isInteger(uid)) uids.push(uid);
  }
  return uids;
}

async function resolveViaLsof(port: number): Promise<ListenerOwner> {
  const lsof = await resolveLsofPath();
  if (!lsof) return { kind: 'unknown' }; // tool missing -> can't determine
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpun'], {
      timeout: LSOF_TIMEOUT_MS,
    }));
  } catch (err) {
    const e = err as { code?: number; killed?: boolean; stdout?: string };
    // lsof exits 1 with no output when nothing matches the filter (bridge not up).
    if (!e.killed && e.code === 1 && !e.stdout) return { kind: 'no-listener' };
    // A timeout (D-state/NFS hang) or any other spawn failure is indeterminate.
    if (e.killed || typeof e.stdout !== 'string') return { kind: 'unknown' };
    stdout = e.stdout;
  }
  const uids = new Set(parseLsofForUid(stdout));
  if (uids.size === 0) return { kind: 'no-listener' };
  return uids.size === 1 ? { kind: 'owner', uid: [...uids][0] } : { kind: 'unknown' };
}

async function resolveLsofPath(): Promise<string | null> {
  for (const candidate of LSOF_CANDIDATES) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Does an `lsof -nP` numeric socket name (`n` field, host:port) receive
 *  connections to `127.0.0.1`? Loopback, wildcard, or v4-mapped loopback -
 *  exact, to stay symmetric with the linux matcher (the CLI only dials
 *  `127.0.0.1`). */
function isLoopbackLsofName(name: string): boolean {
  return (
    name.startsWith('127.0.0.1:') ||
    name.startsWith('*:') ||
    name.startsWith('[::1]:') ||
    name.startsWith('[::]:') ||
    name.startsWith('[::ffff:127.0.0.1]:')
  );
}

/**
 * Parse `lsof -Fpun` output for the UIDs of loopback listeners. `-F` prints
 * one field per line prefixed by its type char; `u<uid>` is a process-level
 * field, `n<host:port>` a file-level one. `uid` resets on each `p<pid>` block
 * so a block without a `u` field can't inherit the prior block's owner. We
 * collect the UID for every loopback/wildcard name so the caller can reject an
 * ambiguous set rather than taking the first.
 */
export function parseLsofForUid(text: string): number[] {
  const uids: number[] = [];
  let uid: number | null = null;
  for (const line of text.split('\n')) {
    const tag = line[0];
    if (tag === 'p') {
      uid = null; // new process block: don't inherit the prior block's UID
    } else if (tag === 'u') {
      const parsed = Number(line.slice(1));
      uid = Number.isInteger(parsed) ? parsed : null;
    } else if (tag === 'n' && uid !== null && isLoopbackLsofName(line.slice(1))) {
      uids.push(uid);
    }
  }
  return uids;
}
