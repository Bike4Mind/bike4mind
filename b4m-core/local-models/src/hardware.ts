import { execFile } from 'node:child_process';
import { statfs as nodeStatfs } from 'node:fs/promises';
import nodeOs from 'node:os';

export interface HardwareProfile {
  platform: string;
  /** The hardware's architecture: `arm64` for an x64 process translated by Rosetta. */
  arch: string;
  memoryKind: 'unified' | 'discrete' | 'cpu';
  totalMemoryBytes: number;
  /** Summed across GPUs; null on unified memory, where the GPU shares `totalMemoryBytes`. */
  gpuMemoryBytes: number | null;
  gpuName: string | null;
  gpuCount: number;
  chip: string | null;
  diskFreeBytes: number | null;
  /** 'low' when a GPU this probe cannot measure (AMD, Intel, unknown) may be present. */
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
}

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

  return {
    ...base,
    memoryKind: 'cpu',
    gpuMemoryBytes: null,
    gpuName: null,
    gpuCount: 0,
    chip: null,
    confidence: 'low',
  };
}
