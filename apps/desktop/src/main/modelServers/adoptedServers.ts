import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readLaunchShape, type LaunchRuntime, type ModelServerLaunchSettings } from '@shared/modelServers';
import type { ServerHandle } from './LocalServerSupervisor';
import { loopbackPortFree } from './loopbackPort';

/**
 * A server Desktop started, written down while it runs so that a launch after Desktop's main process died without
 * stopping it can take it back (LocalServerSupervisor.adopt).
 */
export interface OwnedRecord {
  /** The saved server id it runs for. */
  id: string;
  runtime: LaunchRuntime;
  pid: number;
  /** From ProcessProbe.startTime: a reused pid has another. */
  startTime: string;
  port: number;
  startedAt: string;
  /** The launch settings it started with. */
  settings: ModelServerLaunchSettings;
  /** llama-server's per-process key, which every request to it needs; held decrypted, written sealed. */
  apiKey?: string;
}

export interface ProcessProbe {
  /**
   * When `pid` started, compared only with sameStartTime; null when it is definitely not running or this platform
   * cannot say. Rejects when it cannot tell (timeout, unreadable), which callers treat as still running.
   */
  startTime(pid: number): Promise<string | null>;
  /** Whether `pid` leads its own process group, which `signal` ends; rejects when it cannot tell, true on Windows. */
  leadsGroup(pid: number): Promise<boolean>;
  /** Whether something listens on 127.0.0.1:port. */
  listening(port: number): Promise<boolean>;
  /** Signals the process and its process group. */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
}

/** `open` decrypts a router's sealed key (see writeOwnedRecords); a router without a readable key is dropped. */
export function readOwnedRecords(text: string | null, open?: (sealed: string) => string): OwnedRecord[] {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return [];
  }
  const servers = (parsed as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(servers)) return [];
  return servers.flatMap((value: unknown): OwnedRecord[] => {
    if (typeof value !== 'object' || value === null) return [];
    const raw = value as Record<string, unknown>;
    const runtime = raw.runtime === 'ollama' || raw.runtime === 'llama-server' ? raw.runtime : null;
    const whole = (field: unknown) =>
      typeof field === 'number' && Number.isInteger(field) && field > 0 ? field : null;
    const pid = whole(raw.pid);
    const port = whole(raw.port);
    // Pid 1 is init, and a signal to -pid or pid 0/1 would reach far more than one server.
    if (typeof raw.id !== 'string' || !runtime || !pid || pid < 2 || !port || port > 65_535) return [];
    if (typeof raw.startTime !== 'string' || typeof raw.startedAt !== 'string') return [];
    let apiKey: string | undefined;
    if (runtime === 'llama-server') {
      // The router needs its key; without one that can be read back, it cannot be used and is not adopted.
      if (typeof raw.sealedKey !== 'string' || !open) return [];
      try {
        apiKey = open(raw.sealedKey) || undefined;
      } catch {
        return [];
      }
      if (!apiKey) return [];
    }
    return [
      {
        id: raw.id,
        runtime,
        pid,
        startTime: raw.startTime,
        port,
        startedAt: raw.startedAt,
        settings: readLaunchShape(raw.settings),
        ...(apiKey ? { apiKey } : {}),
      },
    ];
  });
}

/** How many entries a records file lists, readable or not. */
export function ownedEntryCount(text: string | null): number {
  try {
    const servers = (JSON.parse(text ?? 'null') as { servers?: unknown } | null)?.servers;
    return Array.isArray(servers) ? servers.length : 0;
  } catch {
    return 0;
  }
}

/** `seal` encrypts a router's key for the file; with none, no key is written. */
export function writeOwnedRecords(records: readonly OwnedRecord[], seal?: (key: string) => string): string {
  const servers = records.map(({ apiKey, ...rest }) => (apiKey && seal ? { ...rest, sealedKey: seal(apiKey) } : rest));
  return JSON.stringify({ version: 1, servers });
}

export function sameStartTime(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

/** The parenthesized command name can hold spaces, so fields are counted from after it: field 3 (state) is index 0. */
function procStatFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

/** The text of a /proc file; null only when the process is definitely gone, any other failure rejects. */
async function readProc(read: ReadText, path: string): Promise<string | null> {
  try {
    return await read(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw error;
  }
}

async function linuxStartTime(pid: number, read: ReadText): Promise<string | null> {
  const stat = await readProc(read, `/proc/${pid}/stat`);
  if (stat === null) return null;
  const fields = procStatFields(stat);
  if (fields[0] === 'Z') return null;
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error(`Unreadable /proc/${pid}/stat.`);
  // Start ticks count from boot, so only the same boot makes them comparable.
  const boot = (await read('/proc/sys/kernel/random/boot_id')).trim();
  if (!boot) throw new Error('Unreadable boot id.');
  return `${boot}:${fields[19]}`;
}

async function linuxLeadsGroup(pid: number, read: ReadText): Promise<boolean> {
  const stat = await readProc(read, `/proc/${pid}/stat`);
  return stat !== null && procStatFields(stat)[2] === String(pid);
}

/** ps output for one pid; null only when ps says there is no such process (exit 1, no output), any other failure rejects. */
function psField(field: string, pid: number, run: ExecFileLike): Promise<string | null> {
  return new Promise((resolve, reject) => {
    run(
      'ps',
      ['-o', `${field}=`, '-p', String(pid)],
      { timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      (error, stdout) => {
        const text = stdout.trim();
        if (!error && text) resolve(text);
        else if (error && (error as { code?: unknown }).code === 1 && !text) resolve(null);
        else reject(error ?? new Error('ps printed nothing.'));
      }
    );
  });
}

async function macLeadsGroup(pid: number, run: ExecFileLike): Promise<boolean> {
  return (await psField('pgid', pid, run)) === String(pid);
}

type ReadText = (path: string) => Promise<string>;
type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
  done: (error: Error | null, stdout: string) => void
) => void;

export interface HostProcessIo {
  readText?: ReadText;
  execFile?: ExecFileLike;
}

/**
 * This computer's processes. Windows has no start time here, so nothing is adopted there: adopting needs the process
 * creation time, which no helper in Desktop reads.
 */
export function hostProcessProbe(
  platform: NodeJS.Platform = process.platform,
  { readText = path => readFile(path, 'utf8'), execFile: run = execFile }: HostProcessIo = {}
): ProcessProbe {
  return {
    startTime: pid =>
      platform === 'linux'
        ? linuxStartTime(pid, readText)
        : platform === 'darwin'
          ? psField('lstart', pid, run)
          : Promise.resolve(null),
    leadsGroup: pid =>
      platform === 'linux'
        ? linuxLeadsGroup(pid, readText)
        : platform === 'darwin'
          ? macLeadsGroup(pid, run)
          : Promise.resolve(true),
    listening: async port => !(await loopbackPortFree(port, platform)),
    signal: (pid, signal) => {
      try {
        process.kill(platform === 'win32' ? pid : -pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
    },
  };
}

export interface AdoptedTiming {
  /** How often it checks the process still runs (ms). */
  pollMs?: number;
  /** SIGKILL after this long without exiting on SIGTERM (ms). */
  stopTimeoutMs?: number;
}

/** A server from an earlier run, known only by its pid: its exit is noticed by polling, and it keeps no log. */
export function adoptedHandle(
  record: OwnedRecord,
  probe: ProcessProbe,
  { pollMs = 2_000, stopTimeoutMs = 5_000 }: AdoptedTiming = {}
): ServerHandle {
  type Exit = { code: number | null; signal: NodeJS.Signals | null; stopped: boolean };
  let running = true;
  let stopping = false;
  let settle: (exit: Exit) => void = () => undefined;
  const exited = new Promise<Exit>(done => (settle = done));
  // A probe that cannot tell counts as still running; the next poll asks again.
  const gone = async () => {
    try {
      return !sameStartTime(await probe.startTime(record.pid), record.startTime);
    } catch {
      return false;
    }
  };
  const finish = () => {
    if (!running) return;
    running = false;
    clearInterval(timer);
    settle({ code: null, signal: null, stopped: stopping });
  };
  const timer = setInterval(() => void gone().then(isGone => isGone && finish()), pollMs);
  timer.unref?.();
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
  return {
    pid: record.pid,
    get running() {
      return running;
    },
    exited,
    ...(record.apiKey ? { apiKey: record.apiKey } : {}),
    log: () => [],
    async stop() {
      if (!running) return exited;
      stopping = true;
      if (await gone()) {
        finish();
        return exited;
      }
      probe.signal(record.pid, 'SIGTERM');
      const killAt = Date.now() + stopTimeoutMs;
      let killed = false;
      while (running) {
        if (await gone()) break;
        if (!killed && Date.now() >= killAt) {
          probe.signal(record.pid, 'SIGKILL');
          killed = true;
        } else if (killed && Date.now() >= killAt + stopTimeoutMs) {
          stopping = false;
          throw new Error(`Process ${record.pid} did not exit after SIGKILL.`);
        }
        await pause(Math.min(pollMs, 100));
      }
      finish();
      return exited;
    },
  };
}
