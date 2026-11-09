import { open, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { endianness } from 'node:os';
import { join } from 'node:path';
import { findOllamaProcesses, servesUrl } from '@bike4mind/local-models';

// Settings only an Ollama built with the WSL shared GPU memory change declares, the current patch's and an earlier
// one's. Neither name is in the sources of v0.30.0, v0.40.13, v0.40.15 or v0.40.16-rc0.
const SHARED_MEMORY_SETTING = 'OLLAMA_WSL_SHARED_GPU_MEMORY';
const SPILL_SETTING = 'OLLAMA_WSL_GPU_SPILL';
export const WSL_MEMORY_PATCH_MARKERS = [SHARED_MEMORY_SETTING, SPILL_SETTING] as const;

const PROBE_TIMEOUT_MS = 10_000;
const CHUNK_BYTES = 1 << 20;
const TCP_LISTEN = '0A';
// strconv.ParseBool's false spellings; any other value, an unparsable one included, leaves the patch on.
const FALSE_WORDS = new Set(['0', 'f', 'F', 'FALSE', 'false', 'False']);

export interface OllamaBuild {
  /** The server's process and the binary it runs; a new value means Ollama restarted or was replaced. */
  server: string;
  /** Whether that binary carries the WSL shared GPU memory change, turned on; null when it was not read in full. */
  patched: boolean | null;
}

/** `task`'s value, or null when it rejects or is still running at `deadline` (epoch ms), when `onLate` is called. */
async function beforeDeadline<T>(task: Promise<T>, deadline: number, onLate?: () => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => {
    timer = setTimeout(
      () => {
        onLate?.();
        resolve(null);
      },
      Math.max(0, deadline - Date.now())
    );
  });
  try {
    return await Promise.race([task.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function scanFile(
  path: string,
  markers: readonly string[],
  stop: { now: boolean },
  deadline: number,
  chunkBytes: number
): Promise<Set<string> | null> {
  const needles = markers.map(marker => ({ marker, bytes: Buffer.from(marker, 'latin1') }));
  const overlap = Math.max(0, ...needles.map(({ bytes }) => bytes.length - 1));
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const found = new Set<string>();
    const buffer = Buffer.alloc(chunkBytes + overlap);
    let carried = 0;
    for (;;) {
      if (stop.now || Date.now() > deadline) return null;
      const { bytesRead } = await handle.read(buffer, carried, chunkBytes, null);
      const filled = carried + bytesRead;
      const window = buffer.subarray(0, filled);
      for (const { marker, bytes } of needles) if (!found.has(marker) && window.includes(bytes)) found.add(marker);
      if (bytesRead === 0 || found.size === needles.length) return found;
      // A marker may straddle two reads, so the tail of this one leads the next.
      carried = Math.min(overlap, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Which of `markers` the file at `path` contains; null when it is not read to the end by `deadline` (epoch ms). An
 * open or read still blocked then is abandoned, and the file is closed once it returns.
 */
export function fileMarkers(
  path: string,
  markers: readonly string[],
  deadline: number,
  chunkBytes = CHUNK_BYTES
): Promise<Set<string> | null> {
  const stop = { now: false };
  return beforeDeadline(scanFile(path, markers, stop, deadline, chunkBytes), deadline, () => {
    stop.now = true;
  });
}

/** A /proc/net/tcp or tcp6 address, 32-bit words each in host byte order; null when malformed. */
export function decodeProcNetAddress(hex: string, littleEndian = endianness() === 'LE'): string | null {
  if (!/^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{32})$/.test(hex)) return null;
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    const group = [0, 2, 4, 6].map(at => parseInt(hex.slice(word + at, word + at + 2), 16));
    bytes.push(...(littleEndian ? group.reverse() : group));
  }
  if (bytes.length === 4) return bytes.join('.');
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[2 * i] << 8) | bytes[2 * i + 1]).toString(16));
  return new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1);
}

/** The addresses a name in `url` stands for: none for an IP literal; null for a name other than localhost. */
function namedAddresses(url: string): readonly string[] | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
  if (isIP(host)) return [];
  return host.toLowerCase() === 'localhost' ? ['127.0.0.1', '::1'] : null;
}

/** Inodes of the listening sockets in this network namespace that a connection to `url` reaches. */
async function listeningInodes(procDir: string, url: string): Promise<Set<string>> {
  const inodes = new Set<string>();
  const resolved = namedAddresses(url);
  if (!resolved) return inodes;
  for (const table of ['tcp', 'tcp6']) {
    const text = await readFile(join(procDir, 'net', table), 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const inode = fields[9];
      if (fields[3] !== TCP_LISTEN || !inode || !/^[1-9]\d*$/.test(inode)) continue;
      const [address = '', port = ''] = (fields[1] ?? '').split(':');
      const host = decodeProcNetAddress(address);
      if (host === null || !/^[0-9A-Fa-f]{4}$/.test(port)) continue;
      if (servesUrl({ host, port: parseInt(port, 16) }, url, resolved)) inodes.add(inode);
    }
  }
  return inodes;
}

/** Inodes of the sockets a process holds open; empty when its descriptors cannot be read. */
async function heldSockets(procDir: string, pid: number): Promise<Set<string>> {
  const dir = join(procDir, String(pid), 'fd');
  const fds = await readdir(dir).catch((): string[] => []);
  const links = await Promise.all(fds.map(fd => readlink(join(dir, fd)).catch(() => null)));
  return new Set(links.flatMap(link => /^socket:\[(\d+)\]$/.exec(link ?? '')?.slice(1, 2) ?? []));
}

/** Whether `pid` holds every listening socket a connection to `url` reaches, and there is at least one. */
async function holdsAll(procDir: string, url: string, pid: number): Promise<boolean> {
  const inodes = await listeningInodes(procDir, url);
  if (inodes.size === 0) return false;
  const held = await heldSockets(procDir, pid);
  return [...inodes].every(inode => held.has(inode));
}

/**
 * The `ollama serve` holding the listening socket a connection to `url` reaches; null when none or several do, or one
 * holds only some of them. A container's own socket is in another network namespace, so it never matches.
 */
export async function servingOllamaPid(url: string, root = '/'): Promise<number | null> {
  const procDir = join(root, 'proc');
  const inodes = await listeningInodes(procDir, url);
  if (inodes.size === 0) return null;
  const servers = await findOllamaProcesses(root);
  const holders: Array<{ pid: number; held: Set<string> }> = [];
  for (const { pid } of servers) {
    const held = await heldSockets(procDir, pid);
    if ([...inodes].some(inode => held.has(inode))) holders.push({ pid, held });
  }
  if (holders.length !== 1) return null;
  return [...inodes].every(inode => holders[0].held.has(inode)) ? holders[0].pid : null;
}

/** Field 22 of /proc/<pid>/stat, the process start in clock ticks after boot; null when it cannot be read. */
function startTime(text: string): string | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const value = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return value && /^\d+$/.test(value) ? value : null;
}

/** Whether the setting is turned off in a process environment (NUL-separated), as the patch's envconfig reads it. */
function turnedOff(environ: string, key: string): boolean {
  // Go keeps a variable's first assignment.
  const entry = environ.split('\0').find(assignment => assignment.startsWith(`${key}=`));
  if (!entry) return false;
  return FALSE_WORDS.has(
    entry
      .slice(key.length + 1)
      .trim()
      .replace(/^["']+|["']+$/g, '')
  );
}

function carriesFix(markers: ReadonlySet<string>, environ: string | null): boolean {
  if (markers.has(SHARED_MEMORY_SETTING)) return environ === null || !turnedOff(environ, SHARED_MEMORY_SETTING);
  return markers.has(SPILL_SETTING);
}

export interface OllamaWslPatchProbeOptions {
  /** The folder `/proc` is read under; tests point it at a fixture tree. */
  root?: string;
  /** The pid of the `ollama serve` answering at `url`; null when it cannot be told. */
  serverPid?: (url: string) => Promise<number | null>;
  timeoutMs?: number;
}

/**
 * The Ollama serving `url` and whether it carries the WSL shared GPU memory change, read from its process: null when
 * that process cannot be told, as for another user's server or one outside this Linux. Linux only.
 */
export function createOllamaWslPatchProbe(
  options: OllamaWslPatchProbeOptions = {}
): (url: string) => Promise<OllamaBuild | null> {
  const root = options.root ?? '/';
  const procDir = join(root, 'proc');
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const serverPid = options.serverPid ?? ((url: string) => servingOllamaPid(url, root));
  let last: { url: string; pid: number; build: OllamaBuild } | null = null;
  let running: { url: string; read: Promise<OllamaBuild | null> } | null = null;

  const identity = async (pid: number): Promise<string | null> => {
    const dir = join(procDir, String(pid));
    const [image, started] = await Promise.all([
      stat(join(dir, 'exe')).catch(() => null),
      readFile(join(dir, 'stat'), 'utf8').then(startTime, () => null),
    ]);
    return image && started ? `${pid}:${started}:${image.dev}:${image.ino}:${image.size}:${image.mtimeMs}` : null;
  };

  const read = async (url: string, deadline: number): Promise<OllamaBuild | null> => {
    const cached = last?.url === url ? last : null;
    if (cached && (await holdsAll(procDir, url, cached.pid)) && (await identity(cached.pid)) === cached.build.server) {
      return cached.build;
    }
    const pid = await serverPid(url);
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return null;
    const server = await identity(pid);
    if (!server) return null;
    if (last?.build.server === server) return last.build;
    const dir = join(procDir, String(pid));
    const [markers, environ] = await Promise.all([
      fileMarkers(join(dir, 'exe'), WSL_MEMORY_PATCH_MARKERS, deadline),
      readFile(join(dir, 'environ'), 'latin1').catch(() => null),
    ]);
    const build = { server, patched: markers === null ? null : carriesFix(markers, environ) };
    if (build.patched !== null) last = { url, pid, build };
    return build;
  };

  return url => {
    if (running?.url === url) return running.read;
    const deadline = Date.now() + timeoutMs;
    const pending: Promise<OllamaBuild | null> = beforeDeadline(read(url, deadline), deadline).finally(() => {
      if (running?.read === pending) running = null;
    });
    running = { url, read: pending };
    return pending;
  };
}
