import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { lockFile, ModelFileBusyError, OllamaRuntime, probeModelHost } from '@bike4mind/local-models';
import { createHostApp, type HostApp } from './app';
import { defaultSocketDir, defaultStateDir, lookupGroupId, socketSpecs, type HostMode } from './paths';
import { HostServer, type ListenerSpec, type ServerLimits } from './server';
import { HOST_VERSION } from './version';

export interface ServeOptions {
  mode: HostMode;
  socketDir?: string;
  stateDir?: string;
  ollamaUrl: string;
  signal: AbortSignal;
  log: (line: string) => void;
  /** Called once every socket listens. */
  onListening?: (listeners: ListenerSpec[]) => void;
  limits?: Partial<ServerLimits>;
  groupFile?: string;
  probe?: typeof probeModelHost;
  /** How often the state lock is read back; a host whose lock was taken over stops (ms). */
  lockCheckMs?: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The host only ever talks to the Ollama on its own machine. */
export function checkOllamaUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error(`The Ollama URL must be http on a loopback address, such as http://127.0.0.1:11434 (got ${url})`);
  }
  return parsed.origin;
}

/** What ties a server id to this machine: a state directory copied to or shared with another one gets a new id. */
export async function machineIdentity(): Promise<string> {
  const id = (await readFile('/etc/machine-id', 'utf8').catch(() => '')).trim();
  return /^[0-9a-f]{32}$/.test(id) ? id : `host:${hostname()}`;
}

async function readSavedServerId(path: string): Promise<{ id: string; machine: string } | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const saved = JSON.parse(await handle.readFile('utf8')) as { id?: unknown; machine?: unknown };
    if (typeof saved.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(saved.id)) return null;
    return typeof saved.machine === 'string' ? { id: saved.id, machine: saved.machine } : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function readServerId(stateDir: string, machine?: string): Promise<string> {
  const path = join(stateDir, 'server-id');
  const here = machine ?? (await machineIdentity());
  const saved = await readSavedServerId(path);
  if (saved?.machine === here) return saved.id;
  const id = randomUUID();
  // A fresh file renamed into place, so a planted symlink is replaced rather than written through.
  const draft = `${path}.${randomBytes(6).toString('hex')}`;
  const handle = await open(draft, 'wx', 0o644);
  try {
    await handle.writeFile(`${JSON.stringify({ id, machine: here })}\n`);
    await handle.close();
    await rename(draft, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(draft, { force: true });
    throw error;
  }
  return id;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockHolder {
  pid: number | null;
  host: string | null;
  machine: string | null;
}

async function readLockHolder(lockPath: string): Promise<LockHolder | null> {
  try {
    const holder = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown; host?: unknown; machine?: unknown };
    return {
      pid: typeof holder.pid === 'number' ? holder.pid : null,
      host: typeof holder.host === 'string' ? holder.host : null,
      machine: typeof holder.machine === 'string' ? holder.machine : null,
    };
  } catch {
    return null;
  }
}

/**
 * One host per state directory and per socket directory (`what` names which, for the error). A holder on this machine
 * whose pid is gone crashed and is taken over at once. A holder on another machine (a shared home) is never taken
 * over, however stale its lock looks: staleness compares that machine's refreshes with this one's clock and boot time.
 * Machines are told apart by `machineIdentity()`, since two can share a default hostname.
 */
async function takeLock(dir: string, what: string, machine: string) {
  const path = join(dir, 'serve');
  const lockPath = `${path}.lock`;
  const busy = (holder: LockHolder) => {
    const remote = holder.machine ? holder.machine !== machine : holder.host !== null && holder.host !== hostname();
    const detail = [holder.pid ? `pid ${holder.pid}` : null, remote && holder.host ? `on ${holder.host}` : null]
      .filter(Boolean)
      .join(' ');
    const hint = remote ? `; if that machine no longer runs it, remove ${lockPath}` : '';
    return new Error(`Another b4m-host is running with ${what} in ${dir}${detail ? ` (${detail})` : ''}${hint}`);
  };
  const before = await readLockHolder(lockPath);
  if (before?.machine && before.machine !== machine) throw busy(before);
  try {
    return await lockFile(path, 'b4m-host', { machine });
  } catch (error) {
    if (!(error instanceof ModelFileBusyError)) throw error;
    const holder = await readLockHolder(lockPath);
    if (error.pid && holder?.machine === machine && !processAlive(error.pid)) {
      return lockFile(path, 'b4m-host', { force: true, machine });
    }
    throw busy(holder ?? { pid: error.pid, host: null, machine: null });
  }
}

/** Removes a socket file nothing listens on; refuses one that is live, is not a socket, or cannot be probed. */
async function clearStaleSocket(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return;
  if (!stat.isSocket()) throw new Error(`${path} exists and is not a socket`);
  const code = await new Promise<string | null>(resolve => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(null);
    });
    socket.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'unknown'));
  });
  if (code === null) throw new Error(`Another b4m-host is already listening on ${path}`);
  if (code === 'ENOENT') return;
  if (code !== 'ECONNREFUSED') throw new Error(`Cannot tell whether ${path} is in use (${code}); remove it by hand`);
  await rm(path, { force: true });
}

/**
 * Creates `dir` with `mode` if missing, then requires a real directory owned by this user that nobody else can write.
 * Group and other bits beyond that are the caller's choice: the sockets' own modes are the authorization.
 */
async function ensurePrivateDir(dir: string, mode: number): Promise<void> {
  const created = await mkdir(dir, { recursive: true, mode });
  if (created !== undefined) await chmod(dir, mode);
  const info = await lstat(dir);
  const uid = process.getuid?.();
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && info.uid !== uid) throw new Error(`${dir} is owned by uid ${info.uid}, not ${uid}`);
  if (info.mode & 0o022) {
    throw new Error(`${dir} is writable by group or others (mode ${(info.mode & 0o777).toString(8)})`);
  }
}

async function listenerSpecs(options: ServeOptions, socketDir: string): Promise<ListenerSpec[]> {
  const specs: ListenerSpec[] = [];
  for (const spec of socketSpecs(options.mode, socketDir)) {
    const gid = spec.group ? await lookupGroupId(spec.group, options.groupFile) : null;
    if (spec.group && gid === null) {
      options.log(`group ${spec.group} does not exist; ${spec.path} is limited to this user`);
    }
    specs.push({ role: spec.role, path: spec.path, gid, mode: gid === null ? 0o600 : 0o660 });
  }
  return specs;
}

/** Runs the host until `signal` aborts. */
export async function serve(options: ServeOptions): Promise<void> {
  const ollamaUrl = checkOllamaUrl(options.ollamaUrl);
  const stateDir = options.stateDir ?? defaultStateDir(options.mode);
  const socketDir = options.socketDir ?? defaultSocketDir(options.mode);
  await ensurePrivateDir(stateDir, options.mode === 'user' ? 0o700 : 0o750);
  await ensurePrivateDir(socketDir, options.mode === 'user' ? 0o700 : 0o755);

  const machine = await machineIdentity();
  const locks = [{ dir: stateDir, lock: await takeLock(stateDir, 'state', machine) }];
  try {
    if (socketDir !== stateDir) locks.push({ dir: socketDir, lock: await takeLock(socketDir, 'sockets', machine) });
  } catch (error) {
    await locks[0].lock.release();
    throw error;
  }
  // Stops on the caller's signal, or when another host took a lock over (a shared directory).
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  options.signal.addEventListener('abort', stop, { once: true });
  let lockLost = null as Error | null;
  const lockCheck = setInterval(() => {
    for (const { dir, lock } of locks) {
      lock.check().catch((error: unknown) => {
        if (!(error instanceof ModelFileBusyError)) return;
        lockLost ??= new Error(`Lost the lock on ${dir}; another b4m-host took it over`);
        stop();
      });
    }
  }, options.lockCheckMs ?? 10_000);
  const runtime = new OllamaRuntime({ baseUrl: ollamaUrl });
  const probe = options.probe ?? probeModelHost;
  let app: HostApp | null = null;
  let server: HostServer | null = null;
  try {
    app = createHostApp({
      mode: options.mode,
      serverId: await readServerId(stateDir, machine),
      version: HOST_VERSION,
      ollamaUrl,
      probe: () => probe({ ollamaUrl, runtime }),
      health: () => runtime.health(),
      log: options.log,
    });
    server = new HostServer(app.handler, options.limits, options.log);
    for (const spec of await listenerSpecs(options, socketDir)) {
      await clearStaleSocket(spec.path);
      await server.listen(spec);
      options.log(`listening on ${spec.path} (${spec.role}, mode ${spec.mode.toString(8)})`);
    }
    options.onListening?.(server.listeners);
    if (!options.signal.aborted && !stopped.signal.aborted) {
      await new Promise<void>(resolve => stopped.signal.addEventListener('abort', () => resolve(), { once: true }));
    }
  } finally {
    clearInterval(lockCheck);
    options.signal.removeEventListener('abort', stop);
    app?.close();
    await server?.close();
    for (const { lock } of locks) await lock.release();
  }
  if (lockLost) throw lockLost;
}
