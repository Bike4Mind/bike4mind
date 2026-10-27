import { execFile } from 'node:child_process';
import { statfs as nodeStatfs } from 'node:fs/promises';
import nodeOs from 'node:os';
import { parseWindowsGpus, scanLinuxGpus, windowsGpuCommand, type DetectedGpu } from './gpus';

export interface HardwareProfile {
  platform: string;
  /** The hardware's architecture: `arm64` for an x64 process translated by Rosetta. */
  arch: string;
  memoryKind: 'unified' | 'discrete' | 'cpu';
  totalMemoryBytes: number;
  /** Summed across one vendor's GPUs; null on unified memory, where the GPU shares `totalMemoryBytes`, or unknown. */
  gpuMemoryBytes: number | null;
  gpuName: string | null;
  /** Usable discrete GPUs behind `gpuMemoryBytes`; integrated GPUs that Ollama skips are not counted. */
  gpuCount: number;
  chip: string | null;
  diskFreeBytes: number | null;
  /** 'low' when a usable GPU's memory is unknown or the GPUs cannot be listed or reached (WSL, containers). */
  confidence: 'high' | 'low';
}

export type ExecLike = (command: string, args: string[]) => Promise<{ stdout: string }>;

export interface StatfsResult {
  bavail: number | bigint;
  bsize: number | bigint;
}

export interface HardwareProbeOptions {
  /** Directory models are stored in; its filesystem's free space becomes `diskFreeBytes`. */
  modelDir?: string;
  exec?: ExecLike;
  os?: { totalmem(): number };
  statfs?: (path: string) => Promise<StatfsResult>;
  platform?: string;
  arch?: string;
  /** Where Linux `/sys`, `/proc` and `/dev` are read from; tests point it at a fixture tree. */
  rootDir?: string;
  /** Checked for WSL and `SystemRoot`; defaults to `process.env`. */
  env?: Environment;
}

type Environment = Record<string, string | undefined>;

const EXEC_TIMEOUT_MS = 5_000;
const MIB = 1024 * 1024;

const defaultExec: ExecLike = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });

interface NvidiaGpu {
  name: string;
  /** Null when nvidia-smi prints `[N/A]`: unified-memory parts (GB10, Jetson) have no dedicated VRAM. */
  memoryBytes: number | null;
}

/** Parses `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (memory in MiB). */
export function parseNvidiaSmi(stdout: string): NvidiaGpu[] {
  return stdout.split(/\r?\n/).flatMap((line): NvidiaGpu[] => {
    const separator = line.lastIndexOf(',');
    if (separator < 0) return [];
    const name = line.slice(0, separator).trim();
    const memory = line.slice(separator + 1).trim();
    if (!name) return [];
    if (/^\[?N\/A\]?$/i.test(memory)) return [{ name, memoryBytes: null }];
    const mib = Number(memory);
    return Number.isFinite(mib) && mib > 0 ? [{ name, memoryBytes: Math.round(mib * MIB) }] : [];
  });
}

async function attempt<T>(task: () => Promise<T> | T): Promise<T | null> {
  try {
    return await task();
  } catch {
    return null;
  }
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([task, expired]);
  } finally {
    clearTimeout(timer);
  }
}

let cachedWindowsGpus: DetectedGpu[] | undefined;

/** PowerShell costs a second or more to start, so a successful real query is kept for the process. */
async function windowsGpus(exec: ExecLike, env: Environment, cache: boolean): Promise<DetectedGpu[] | null> {
  if (cache && cachedWindowsGpus) return cachedWindowsGpus;
  const [command, args] = windowsGpuCommand(env);
  const gpus = parseWindowsGpus((await exec(command, args)).stdout);
  if (cache && gpus) cachedWindowsGpus = gpus;
  return gpus;
}

/** Describes the host's memory and GPUs for model-fit decisions. Never throws; unmeasurable fields are null. */
export async function probeHardware(options: HardwareProbeOptions = {}): Promise<HardwareProfile> {
  const exec = options.exec ?? defaultExec;
  const os = options.os ?? nodeOs;
  const statfs = options.statfs ?? nodeStatfs;
  const platform = options.platform ?? process.platform;
  const processArch = options.arch ?? process.arch;

  const totalMemoryBytes = (await attempt(() => os.totalmem())) ?? 0;
  const { modelDir } = options;
  const diskFreeBytes = modelDir
    ? await attempt(async () => {
        const stats = await statfs(modelDir);
        return Number(stats.bavail) * Number(stats.bsize);
      })
    : null;
  const translated =
    platform === 'darwin' && processArch === 'x64'
      ? (await attempt(() => exec('sysctl', ['-n', 'sysctl.proc_translated'])))?.stdout.trim() === '1'
      : false;
  const arch = translated ? 'arm64' : processArch;
  const base = { platform, arch, totalMemoryBytes, diskFreeBytes };

  if (platform === 'darwin' && arch === 'arm64') {
    const brand = await attempt(() => exec('sysctl', ['-n', 'machdep.cpu.brand_string']));
    return {
      ...base,
      memoryKind: 'unified',
      gpuMemoryBytes: null,
      gpuName: null,
      gpuCount: 1,
      chip: brand?.stdout.trim() || null,
      confidence: 'high',
    };
  }

  if (platform === 'darwin') {
    // Ollama's and llama.cpp's Intel Mac builds run on the CPU, whatever GPU the Mac has.
    return {
      ...base,
      memoryKind: 'cpu',
      gpuMemoryBytes: null,
      gpuName: null,
      gpuCount: 0,
      chip: null,
      confidence: 'high',
    };
  }

  const smi = await attempt(() =>
    exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  );
  const gpus = smi ? parseNvidiaSmi(smi.stdout) : [];
  if (gpus.length > 0 && gpus.some(gpu => gpu.memoryBytes === null)) {
    return {
      ...base,
      memoryKind: 'unified',
      gpuMemoryBytes: null,
      gpuName: gpus[0]?.name ?? null,
      gpuCount: gpus.length,
      chip: null,
      confidence: 'high',
    };
  }
  if (gpus.length > 0) {
    return {
      ...base,
      memoryKind: 'discrete',
      gpuMemoryBytes: gpus.reduce((sum, gpu) => sum + (gpu.memoryBytes ?? 0), 0),
      gpuName: gpus[0]?.name ?? null,
      gpuCount: gpus.length,
      chip: null,
      confidence: 'high',
    };
  }

  const env = options.env ?? process.env;
  const scanned =
    platform === 'linux'
      ? await attempt(() => withTimeout(scanLinuxGpus(options.rootDir, env), EXEC_TIMEOUT_MS))
      : platform === 'win32'
        ? await attempt(() => windowsGpus(exec, env, !options.exec))
        : null;
  if (!scanned || scanned.length === 0) {
    return {
      ...base,
      memoryKind: 'cpu',
      gpuMemoryBytes: null,
      gpuName: null,
      gpuCount: 0,
      chip: null,
      confidence: scanned ? 'high' : 'low',
    };
  }
  if (scanned.some(gpu => gpu.memoryBytes === null)) {
    return {
      ...base,
      memoryKind: 'discrete',
      gpuMemoryBytes: null,
      gpuName: scanned[0]?.name ?? null,
      gpuCount: scanned.length,
      chip: null,
      confidence: 'low',
    };
  }
  // A model loads within one vendor's runtime (ROCm, CUDA or Vulkan per vendor), so VRAM is not summed across vendors.
  const sizeOf = (group: DetectedGpu[]) => group.reduce((sum, gpu) => sum + (gpu.memoryBytes ?? 0), 0);
  const groups = new Map<string, DetectedGpu[]>();
  for (const gpu of scanned) groups.set(gpu.vendor, [...(groups.get(gpu.vendor) ?? []), gpu]);
  const largest = [...groups.values()].reduce((best, group) => (sizeOf(group) > sizeOf(best) ? group : best));
  return {
    ...base,
    memoryKind: 'discrete',
    gpuMemoryBytes: sizeOf(largest),
    gpuName: largest[0]?.name ?? null,
    gpuCount: largest.length,
    chip: null,
    confidence: 'high',
  };
}
