import { execFile } from 'node:child_process';
import { statfs as nodeStatfs } from 'node:fs/promises';
import nodeOs from 'node:os';
import { parseWindowsGpus, scanLinuxGpus, windowsGpuCommand, type DetectedGpu, type GpuVendor } from './gpus';

export interface HardwareProfile {
  platform: string;
  /** The hardware's architecture: `arm64` for an x64 process translated by Rosetta. */
  arch: string;
  memoryKind: 'unified' | 'discrete' | 'cpu';
  /** RAM the OS sees; a firmware VRAM carve-out is not part of it. */
  totalMemoryBytes: number;
  /**
   * Summed across one vendor's GPUs. On AMD unified memory, what ROCm can allocate; null on Apple and NVIDIA unified
   * memory, where the GPU shares `totalMemoryBytes`, or when unknown.
   */
  gpuMemoryBytes: number | null;
  gpuName: string | null;
  /** Usable discrete GPUs behind `gpuMemoryBytes`; integrated GPUs that Ollama skips are not counted. */
  gpuCount: number;
  /** Vendor of the GPUs behind `gpuMemoryBytes`; null without a usable GPU. */
  gpuVendor?: GpuVendor | 'apple' | null;
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
      gpuVendor: 'apple',
      chip: brand?.stdout.trim() || null,
      confidence: 'high',
    };
  }

  if (platform === 'darwin') {
    // Ollama's and llama.cpp's Intel Mac builds run on the CPU, whatever GPU the Mac has.
    return { ...base, ...NO_GPU, confidence: 'high' };
  }

  const smi = await attempt(() =>
    exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  );
  const nvidia = smi ? parseNvidiaSmi(smi.stdout) : [];
  if (nvidia.some(gpu => gpu.memoryBytes === null)) {
    return {
      ...base,
      memoryKind: 'unified',
      gpuMemoryBytes: null,
      gpuName: nvidia[0]?.name ?? null,
      gpuCount: nvidia.length,
      gpuVendor: 'nvidia',
      chip: null,
      confidence: 'high',
    };
  }

  const env = options.env ?? process.env;
  // Runs beside nvidia-smi too, to find a Strix Halo APU; on Windows only with an AMD CPU, sparing others PowerShell.
  const scanned =
    platform === 'linux'
      ? await attempt(() => withTimeout(scanLinuxGpus(options.rootDir, env), EXEC_TIMEOUT_MS))
      : platform === 'win32' && (nvidia.length === 0 || /AuthenticAMD/i.test(env.PROCESSOR_IDENTIFIER ?? ''))
        ? await attempt(() => windowsGpus(exec, env, !options.exec))
        : null;
  const discrete: GpuFields =
    nvidia.length > 0
      ? {
          memoryKind: 'discrete',
          gpuMemoryBytes: nvidia.reduce((sum, gpu) => sum + (gpu.memoryBytes ?? 0), 0),
          gpuName: nvidia[0]?.name ?? null,
          gpuCount: nvidia.length,
          gpuVendor: 'nvidia',
          chip: null,
          confidence: 'high',
        }
      : discreteFields(scanned && scanned.filter(gpu => !gpu.sharedMemory));
  const apu = scanned?.find(gpu => gpu.sharedMemory);
  if (!apu) return { ...base, ...discrete };

  // Uncapped, since llama-server fits layers to what HIP reports; Ollama holds an integrated GPU to free RAM only when
  // placing and batching (server/sched.go), which the planner weighs against totalMemoryBytes.
  const apuBytes = apu.memoryBytes;
  // The APU and a discrete GPU are separate pools under separate runtimes, so report the larger and never sum them.
  const dgpuBytes = discrete.gpuMemoryBytes;
  if (dgpuBytes !== null && (apuBytes === null || dgpuBytes > apuBytes)) return { ...base, ...discrete };
  // A Windows carve-out below the RAM Windows sees is not the usable pool; leave it unknown so fit plans from RAM.
  const carveOut = platform === 'win32' && apuBytes !== null && apuBytes < totalMemoryBytes;
  // Linux ROCm moves to GTT once the carve-out is the smaller pool; what HIP on Windows reports then is unconfirmed.
  const unconfirmed = apu.memoryUnconfirmed || carveOut;
  return {
    ...base,
    memoryKind: 'unified',
    gpuMemoryBytes: carveOut ? null : apuBytes,
    gpuName: apu.name,
    gpuCount: 1,
    gpuVendor: 'amd',
    chip: null,
    confidence: totalMemoryBytes > 0 && apuBytes !== null && !unconfirmed ? 'high' : 'low',
  };
}

type GpuFields = Omit<HardwareProfile, 'platform' | 'arch' | 'totalMemoryBytes' | 'diskFreeBytes'>;

const NO_GPU = {
  memoryKind: 'cpu',
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  gpuVendor: null,
  chip: null,
} as const satisfies Omit<GpuFields, 'confidence'>;

/** Discrete GPUs from a sysfs or Windows scan; null when the scan failed. */
function discreteFields(scanned: DetectedGpu[] | null): GpuFields {
  if (!scanned || scanned.length === 0) return { ...NO_GPU, confidence: scanned ? 'high' : 'low' };
  const first = scanned[0];
  if (scanned.some(gpu => gpu.memoryBytes === null)) {
    return {
      memoryKind: 'discrete',
      gpuMemoryBytes: null,
      gpuName: first.name,
      gpuCount: scanned.length,
      gpuVendor: first.vendor,
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
    memoryKind: 'discrete',
    gpuMemoryBytes: sizeOf(largest),
    gpuName: largest[0]?.name ?? null,
    gpuCount: largest.length,
    gpuVendor: largest[0]?.vendor ?? null,
    chip: null,
    confidence: 'high',
  };
}
