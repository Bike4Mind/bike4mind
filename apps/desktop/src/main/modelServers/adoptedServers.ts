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
  /** llama-server's per-process key, which every request to it needs. */
  apiKey?: string;
}

export interface ProcessProbe {
  /** When `pid` started, compared only with sameStartTime; null when it is not running or this platform cannot say. */
  startTime(pid: number): Promise<string | null>;
  /** Whether something listens on 127.0.0.1:port. */
  listening(port: number): Promise<boolean>;
  /** Signals the process and its process group. */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
}

export function readOwnedRecords(text: string | null): OwnedRecord[] {
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
    if (typeof raw.id !== 'string' || !runtime || !pid || !port || port > 65_535) return [];
    if (typeof raw.startTime !== 'string' || typeof raw.startedAt !== 'string') return [];
    return [
      {
        id: raw.id,
        runtime,
        pid,
        startTime: raw.startTime,
        port,
        startedAt: raw.startedAt,
        settings: readLaunchShape(raw.settings),
        ...(typeof raw.apiKey === 'string' && raw.apiKey ? { apiKey: raw.apiKey } : {}),
      },
    ];
  });
}

export function writeOwnedRecords(records: readonly OwnedRecord[]): string {
  return JSON.stringify({ version: 1, servers: records });
}

const LINUX_START = /^(\d+):(\d+)$/;

/** Linux's boot time is derived from the clock and can drift by a second; the start tick count cannot. */
export function sameStartTime(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = LINUX_START.exec(a);
  const right = LINUX_START.exec(b);
  if (left && right) return left[2] === right[2] && Math.abs(Number(left[1]) - Number(right[1])) <= 2;
  return a === b;
}

async function linuxStartTime(pid: number): Promise<string | null> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
  if (!stat) return null;
  // After the parenthesized command name: field 3 (state) onward, so field 22 (start ticks since boot) is index 19.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields[0] === 'Z' || !/^\d+$/.test(fields[19] ?? '')) return null;
  const boot = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8').catch(() => ''))?.[1];
  return boot ? `${boot}:${fields[19]}` : null;
}

function macStartTime(pid: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2_000 }, (error, stdout) =>
      resolve(error ? null : stdout.trim() || null)
    );
  });
}

/** This computer's processes. Windows has no start time here, so nothing is adopted there. */
export function hostProcessProbe(platform: NodeJS.Platform = process.platform): ProcessProbe {
  return {
    startTime: pid =>
      platform === 'linux' ? linuxStartTime(pid) : platform === 'darwin' ? macStartTime(pid) : Promise.resolve(null),
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
