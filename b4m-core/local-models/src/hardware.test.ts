import { describe, expect, it, vi } from 'vitest';
import { parseNvidiaSmi, probeHardware, type ExecLike } from './hardware';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const enoent = () => Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });

function execFrom(outputs: Record<string, string | Error>): ExecLike {
  return vi.fn(async (command: string) => {
    const output = outputs[command];
    if (output === undefined || output instanceof Error) throw output ?? enoent();
    return { stdout: output };
  });
}

const os = (bytes: number) => ({ totalmem: () => bytes });

describe('probeHardware', () => {
  it('reports Apple Silicon as unified memory with the chip name', async () => {
    const exec = execFrom({ sysctl: 'Apple M3 Max\n' });
    const profile = await probeHardware({ exec, os: os(64 * GiB), platform: 'darwin', arch: 'arm64' });

    expect(profile).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      memoryKind: 'unified',
      totalMemoryBytes: 64 * GiB,
      gpuMemoryBytes: null,
      gpuName: null,
      gpuCount: 1,
      chip: 'Apple M3 Max',
      diskFreeBytes: null,
      confidence: 'high',
    });
    expect(exec).toHaveBeenCalledWith('sysctl', ['-n', 'machdep.cpu.brand_string']);
    expect(exec).not.toHaveBeenCalledWith('nvidia-smi', expect.anything());
  });

  it('keeps unified memory with a null chip when sysctl fails', async () => {
    const profile = await probeHardware({ exec: execFrom({}), os: os(16 * GiB), platform: 'darwin', arch: 'arm64' });
    expect(profile.memoryKind).toBe('unified');
    expect(profile.chip).toBeNull();
  });

  it('sums NVIDIA GPUs on Linux and reads free disk space from statfs', async () => {
    const exec = execFrom({ 'nvidia-smi': 'NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 4090, 24564\n' });
    const statfs = vi.fn(async () => ({ bavail: 1_000_000, bsize: 4096 }));
    const profile = await probeHardware({
      modelDir: '/home/me/.ollama/models',
      exec,
      os: os(128 * GiB),
      statfs,
      platform: 'linux',
      arch: 'x64',
    });

    expect(profile).toEqual({
      platform: 'linux',
      arch: 'x64',
      memoryKind: 'discrete',
      totalMemoryBytes: 128 * GiB,
      gpuMemoryBytes: 2 * 24564 * MiB,
      gpuName: 'NVIDIA GeForce RTX 4090',
      gpuCount: 2,
      chip: null,
      diskFreeBytes: 4_096_000_000,
      confidence: 'high',
    });
    expect(exec).toHaveBeenCalledWith('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    expect(statfs).toHaveBeenCalledWith('/home/me/.ollama/models');
  });

  it('falls back to cpu with low confidence on Linux without nvidia-smi', async () => {
    const profile = await probeHardware({ exec: execFrom({}), os: os(32 * GiB), platform: 'linux', arch: 'x64' });
    expect(profile).toMatchObject({
      memoryKind: 'cpu',
      gpuMemoryBytes: null,
      gpuName: null,
      gpuCount: 0,
      confidence: 'low',
      totalMemoryBytes: 32 * GiB,
    });
  });

  it('degrades diskFreeBytes to null when statfs fails', async () => {
    const statfs = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    const profile = await probeHardware({
      modelDir: '/missing',
      exec: execFrom({}),
      os: os(8 * GiB),
      statfs,
      platform: 'linux',
      arch: 'arm64',
    });
    expect(profile.diskFreeBytes).toBeNull();
    expect(profile.totalMemoryBytes).toBe(8 * GiB);
  });

  it('accepts bigint statfs fields', async () => {
    const statfs = async () => ({ bavail: 10n, bsize: 4096n });
    const profile = await probeHardware({
      modelDir: '/',
      exec: execFrom({}),
      os: os(GiB),
      statfs,
      platform: 'linux',
      arch: 'x64',
    });
    expect(profile.diskFreeBytes).toBe(40960);
  });

  it('uses nvidia-smi on Windows too, and reports cpu with low confidence on an Intel Mac', async () => {
    const windows = await probeHardware({
      exec: execFrom({ 'nvidia-smi': 'NVIDIA GeForce RTX 3060, 12288\r\n' }),
      os: os(32 * GiB),
      platform: 'win32',
      arch: 'x64',
    });
    expect(windows).toMatchObject({ memoryKind: 'discrete', gpuCount: 1, gpuMemoryBytes: 12288 * MiB });

    const intelMac = await probeHardware({ exec: execFrom({}), os: os(16 * GiB), platform: 'darwin', arch: 'x64' });
    expect(intelMac).toMatchObject({ memoryKind: 'cpu', confidence: 'low' });
  });

  it('treats an x64 process under Rosetta as Apple Silicon', async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('sysctl.proc_translated')) return { stdout: '1\n' };
      if (args.includes('machdep.cpu.brand_string')) return { stdout: 'Apple M2 Pro\n' };
      throw enoent();
    });
    const profile = await probeHardware({ exec, os: os(32 * GiB), platform: 'darwin', arch: 'x64' });
    expect(profile).toMatchObject({
      arch: 'arm64',
      memoryKind: 'unified',
      chip: 'Apple M2 Pro',
      gpuMemoryBytes: null,
      confidence: 'high',
    });
  });

  it('keeps an Intel Mac on the x64 path when sysctl.proc_translated is 0', async () => {
    const exec = execFrom({ sysctl: '0\n' });
    const profile = await probeHardware({ exec, os: os(16 * GiB), platform: 'darwin', arch: 'x64' });
    expect(profile).toMatchObject({ arch: 'x64', memoryKind: 'cpu', confidence: 'low' });
  });

  it('reports unified memory for an NVIDIA GPU without dedicated VRAM', async () => {
    const profile = await probeHardware({
      exec: execFrom({ 'nvidia-smi': 'NVIDIA GB10, [N/A]\n' }),
      os: os(128 * GiB),
      platform: 'linux',
      arch: 'arm64',
    });
    expect(profile).toMatchObject({
      memoryKind: 'unified',
      totalMemoryBytes: 128 * GiB,
      gpuMemoryBytes: null,
      gpuName: 'NVIDIA GB10',
      gpuCount: 1,
      confidence: 'high',
    });
  });

  it('treats nvidia-smi output with no GPUs as cpu', async () => {
    const profile = await probeHardware({
      exec: execFrom({ 'nvidia-smi': 'No devices were found\n' }),
      os: os(GiB),
      platform: 'linux',
      arch: 'x64',
    });
    expect(profile.memoryKind).toBe('cpu');
  });
});

describe('parseNvidiaSmi', () => {
  it('keeps commas inside GPU names and skips unparseable lines', () => {
    expect(parseNvidiaSmi('NVIDIA RTX A6000, Ada, 49140\n\ngarbage\nTesla T4, 0\n')).toEqual([
      { name: 'NVIDIA RTX A6000, Ada', memoryBytes: 49140 * MiB },
    ]);
  });

  it('keeps GPUs whose memory reads [N/A] with null memory', () => {
    expect(parseNvidiaSmi('NVIDIA GB10, [N/A]\nOrin, N/A\n')).toEqual([
      { name: 'NVIDIA GB10', memoryBytes: null },
      { name: 'Orin', memoryBytes: null },
    ]);
  });
});
