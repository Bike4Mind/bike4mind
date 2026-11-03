import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg } from 'node:os';

const GB = 1024 ** 3;

/**
 * When the runner takes on more work. Extra work waits rather than overloading the machine the
 * user is sitting at. Guesses to tune from real numbers; each is used in one place below.
 */
export const BUDGET = {
  maxLanes: 4,
  minFreeBytes: 4 * GB,
  maxSwapBytes: 2 * GB,
  /** Swap growing by more than this between samples counts as rising. */
  swapRiseBytes: 128 * 1024 ** 2,
  maxLoadRatio: 0.8,
  diskFloorBytes: 20 * GB,
  /** Below this the runner stops its own sessions, not just new claims. */
  diskHardFloorBytes: 10 * GB,
  /** Idle this long (seconds) and the user counts as away. */
  idleSeconds: 120,
  /** Lanes allowed while the user is at the machine. */
  activeLanes: 1,
} as const;

export interface MachineSample {
  cores: number;
  freeBytes: number;
  /** Null where the platform does not say (Windows). */
  swapUsedBytes: number | null;
  /** 1-minute load over cores; null on Windows, where loadavg is always 0. */
  loadRatio: number | null;
  /** Free space on the worktree volume; null when it could not be read. */
  diskFreeBytes: number | null;
  onBattery: boolean;
  idleSeconds: number;
}

export interface BudgetSettings {
  runOnBattery: boolean;
  laneCap?: number;
}

/** A quarter of the cores, 1 to 4 lanes; the user may only lower it. */
export function laneCapFor(cores: number, setting?: number): number {
  const machine = Math.min(Math.max(Math.floor(cores / 4), 1), BUDGET.maxLanes);
  return setting && setting >= 1 ? Math.min(machine, Math.floor(setting)) : machine;
}

export type Admission = { ok: true } | { ok: false; reason: string };

/** Whether one more ticket may be claimed now, and if not, the reason to show. */
export function admit(
  sample: MachineSample,
  previous: MachineSample | undefined,
  busy: number,
  settings: BudgetSettings
): Admission {
  const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
  if (busy >= laneCapFor(sample.cores, settings.laneCap)) return { ok: false, reason: 'all lanes are busy' };
  if (sample.onBattery && !settings.runOnBattery) return { ok: false, reason: 'on battery' };
  if (sample.diskFreeBytes !== null && sample.diskFreeBytes < BUDGET.diskFloorBytes) {
    return { ok: false, reason: `low disk (${gb(sample.diskFreeBytes)} free)` };
  }
  if (sample.freeBytes < BUDGET.minFreeBytes) return { ok: false, reason: `low memory (${gb(sample.freeBytes)} free)` };
  if (sample.swapUsedBytes !== null) {
    if (sample.swapUsedBytes >= BUDGET.maxSwapBytes)
      return { ok: false, reason: `swapping (${gb(sample.swapUsedBytes)})` };
    const before = previous?.swapUsedBytes;
    if (before != null && sample.swapUsedBytes - before > BUDGET.swapRiseBytes)
      return { ok: false, reason: 'swap is rising' };
  }
  if (sample.loadRatio !== null && sample.loadRatio >= BUDGET.maxLoadRatio)
    return { ok: false, reason: 'the machine is busy' };
  if (sample.idleSeconds < BUDGET.idleSeconds && busy >= BUDGET.activeLanes)
    return { ok: false, reason: 'you are active' };
  return { ok: true };
}

/** Why the runner must stop its own sessions now, or null. */
export function hardFloorBreached(sample: MachineSample): string | null {
  if (sample.diskFreeBytes !== null && sample.diskFreeBytes < BUDGET.diskHardFloorBytes) {
    return `disk nearly full (${(sample.diskFreeBytes / GB).toFixed(1)} GB free)`;
  }
  return null;
}

export interface PowerReader {
  isOnBatteryPower(): boolean;
  getSystemIdleTime(): number;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise(resolve =>
    execFile(file, args, { timeout: 5_000 }, (error, stdout) => resolve(error ? '' : stdout))
  );
}

/** macOS counts inactive and purgeable pages as used; they are free for our purposes. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!pageSize) return null;
  const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  return (pages('free') + pages('inactive') + pages('purgeable')) * pageSize;
}

/** `sysctl vm.swapusage`: "total = 2048.00M  used = 1024.50M  free = ...". */
export function parseSwapUsage(text: string): number | null {
  const match = /used = ([\d.]+)([KMG])/.exec(text);
  if (!match) return null;
  return Number(match[1]) * { K: 1024, M: 1024 ** 2, G: GB }[match[2] as 'K' | 'M' | 'G'];
}

/** Linux: MemAvailable and swap used, in bytes. */
export function parseMeminfo(text: string): { free: number | null; swapUsed: number | null } {
  const kb = (key: string) => {
    const value = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1];
    return value === undefined ? null : Number(value) * 1024;
  };
  const total = kb('SwapTotal');
  const free = kb('SwapFree');
  return { free: kb('MemAvailable'), swapUsed: total !== null && free !== null ? total - free : null };
}

export async function sampleMachine(diskPath: string, power: PowerReader): Promise<MachineSample> {
  const cores = availableParallelism();
  let freeBytes = freemem();
  let swapUsedBytes: number | null = null;
  if (process.platform === 'darwin') {
    const [vm, swap] = await Promise.all([run('vm_stat', []), run('sysctl', ['vm.swapusage'])]);
    freeBytes = Math.max(freeBytes, parseVmStat(vm) ?? 0);
    swapUsedBytes = parseSwapUsage(swap);
  } else if (process.platform === 'linux') {
    const info = parseMeminfo(await readFile('/proc/meminfo', 'utf8').catch(() => ''));
    freeBytes = info.free ?? freeBytes;
    swapUsedBytes = info.swapUsed;
  }
  const diskFreeBytes = await statfs(diskPath)
    .then(stats => stats.bavail * stats.bsize)
    .catch(() => null);
  return {
    cores,
    freeBytes,
    swapUsedBytes,
    loadRatio: process.platform === 'win32' ? null : loadavg()[0] / cores,
    diskFreeBytes,
    onBattery: power.isOnBatteryPower(),
    idleSeconds: power.getSystemIdleTime(),
  };
}
