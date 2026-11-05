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
  /** When `pid` started, compared only with sameStartTime; null when it is not running or this platform cannot say. */
  startTime(pid: number): Promise<string | null>;
  /** Whether `pid` leads its own process group, which `signal` ends; always true where start time is not read per group. */
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

async function linuxStartTime(pid: number, read: ReadText): Promise<string | null> {
  const stat = await read(`/proc/${pid}/stat`).catch(() => null);
  if (!stat) return null;
  const fields = procStatFields(stat);
  if (fields[0] === 'Z' || !/^\d+$/.test(fields[19] ?? '')) return null;
  // Start ticks count from boot, so only the same boot makes them comparable.
  const boot = (await read('/proc/sys/kernel/random/boot_id').catch(() => '')).trim();
  return boot ? `${boot}:${fields[19]}` : null;
}

async function linuxLeadsGroup(pid: number, read: ReadText): Promise<boolean> {
  const stat = await read(`/proc/${pid}/stat`).catch(() => null);
  return !!stat && procStatFields(stat)[2] === String(pid);
}

function macStartTime(pid: number, run: ExecFileLike): Promise<string | null> {
  return new Promise(resolve => {
    run(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    );
  });
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
          ? macStartTime(pid, run)
          : Promise.resolve(null),
    leadsGroup: pid => (platform === 'linux' ? linuxLeadsGroup(pid, readText) : Promise.resolve(true)),
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
  const gone = async () => !sameStartTime(await probe.startTime(record.pid).catch(() => null), record.startTime);
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
          break;
        }
        await pause(Math.min(pollMs, 100));
      }
      finish();
      return exited;
    },
  };
}
