import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseWindowsGpus, scanLinuxGpus, WINDOWS_GPU_SCRIPT, windowsGpuCommand } from './gpus';
import { parseNvidiaSmi, probeHardware, type ExecLike } from './hardware';
import {
  amdRaphaelIgpu,
  amdRx7900xtx,
  amdStrixHalo,
  aspeedBmc,
  intelArcA770I915,
  intelArcB580Xe,
  intelIgpu,
  KFD_CPU_NODE,
  KFD_RAPHAEL_NODE,
  KFD_RX7900XTX_NODE,
  KFD_STRIX_HALO_NODE,
  nvidiaGt218Nouveau,
  nvidiaRtx4090,
  PCI_IDS,
  pcieBridges,
  POWERSHELL_AMD_DISCRETE_AND_APU,
  POWERSHELL_INTEL_ARC,
  POWERSHELL_INTEL_IGPU_ONLY,
  POWERSHELL_NVIDIA,
  POWERSHELL_STRIX_HALO,
  rawLocation,
  strixHalo,
  sysfsTree,
  type SysfsFixture,
} from './__test__/hardwareFixtures';

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

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

function sysfs(fixture: SysfsFixture): string {
  const tree = sysfsTree(fixture);
  cleanups.push(tree.cleanup);
  return tree.root;
}

const linux = (
  fixture: SysfsFixture,
  exec: ExecLike = execFrom({}),
  env: Record<string, string> = {},
  ram = 64 * GiB
) => probeHardware({ exec, os: os(ram), platform: 'linux', arch: 'x64', rootDir: sysfs(fixture), env });

const POWERSHELL = windowsGpuCommand({})[0];

const windows = (
  powershell: string | Error,
  extra: Record<string, string | Error> = {},
  env: Record<string, string> = {}
) =>
  probeHardware({
    exec: execFrom({ [POWERSHELL]: powershell, ...extra }),
    os: os(32 * GiB),
    platform: 'win32',
    arch: 'x64',
    env,
  });

const cpuOnly = { memoryKind: 'cpu', gpuMemoryBytes: null, gpuName: null, gpuCount: 0, gpuVendor: null, chip: null };
const RYZEN_AI_MAX = { PROCESSOR_IDENTIFIER: 'AMD64 Family 26 Model 112 Stepping 0, AuthenticAMD' };
const RTX_4090_SMI = 'NVIDIA GeForce RTX 4090, 24564\n';
const amdKfd = [KFD_CPU_NODE, KFD_RX7900XTX_NODE, KFD_RAPHAEL_NODE];
const kernel = (release: string) => `Linux version ${release} (builder@localhost) #1 SMP PREEMPT_DYNAMIC\n`;

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
      gpuVendor: 'apple',
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
      rootDir: sysfs({ pci: false }),
    });

    expect(profile).toEqual({
      platform: 'linux',
      arch: 'x64',
      memoryKind: 'discrete',
      totalMemoryBytes: 128 * GiB,
      gpuMemoryBytes: 2 * 24564 * MiB,
      gpuName: 'NVIDIA GeForce RTX 4090',
      gpuCount: 2,
      gpuVendor: 'nvidia',
      chip: null,
      diskFreeBytes: 4_096_000_000,
      confidence: 'high',
    });
    expect(exec).toHaveBeenCalledWith('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    expect(statfs).toHaveBeenCalledWith('/home/me/.ollama/models');
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
      rootDir: sysfs({}),
      env: {},
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
      rootDir: sysfs({}),
      env: {},
    });
    expect(profile.diskFreeBytes).toBe(40960);
  });

  it('uses nvidia-smi on Windows before PowerShell', async () => {
    const exec = execFrom({ 'nvidia-smi': 'NVIDIA GeForce RTX 3060, 12288\r\n' });
    const profile = await probeHardware({ exec, os: os(32 * GiB), platform: 'win32', arch: 'x64', env: {} });
    expect(profile).toMatchObject({ memoryKind: 'discrete', gpuCount: 1, gpuMemoryBytes: 12288 * MiB });
    expect(exec).not.toHaveBeenCalledWith(POWERSHELL, expect.anything());
  });

  it('reports an Intel Mac as confidently CPU-only without running nvidia-smi', async () => {
    const exec = execFrom({ sysctl: '0\n' });
    const profile = await probeHardware({ exec, os: os(16 * GiB), platform: 'darwin', arch: 'x64' });
    expect(profile).toMatchObject({ arch: 'x64', ...cpuOnly, confidence: 'high' });
    expect(exec).not.toHaveBeenCalledWith('nvidia-smi', expect.anything());
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

  it('falls through to sysfs when nvidia-smi lists no GPUs', async () => {
    const profile = await linux({ devices: [intelIgpu] }, execFrom({ 'nvidia-smi': 'No devices were found\n' }));
    expect(profile).toMatchObject({ ...cpuOnly, confidence: 'high' });
  });
});

describe('probeHardware on Linux without nvidia-smi', () => {
  it('is confidently CPU-only with no GPU, or only a BMC display controller', async () => {
    expect(await linux({ devices: pcieBridges })).toMatchObject({ ...cpuOnly, confidence: 'high' });
    expect(await linux({ devices: [...pcieBridges, aspeedBmc] })).toMatchObject({ ...cpuOnly, confidence: 'high' });
  });

  it('is confidently CPU-only with only Intel integrated graphics', async () => {
    const profile = await linux({ devices: [intelIgpu], pciIds: PCI_IDS });
    expect(profile).toEqual({
      platform: 'linux',
      arch: 'x64',
      totalMemoryBytes: 64 * GiB,
      diskFreeBytes: null,
      ...cpuOnly,
      confidence: 'high',
    });
  });

  it('reads AMD discrete VRAM from amdgpu and skips the APU beside it, both identified through KFD', async () => {
    const profile = await linux({ devices: [amdRx7900xtx, amdRaphaelIgpu], kfdNodes: amdKfd, pciIds: PCI_IDS });
    expect(profile).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 25753026560,
      gpuName: 'AMD Navi 31 [Radeon RX 7900 XT/7900 XTX/7900 GRE/7900M]',
      gpuCount: 1,
      confidence: 'high',
    });
  });

  it('skips an APU with a large carve-out by its KFD gfx target, though its node has no CPU cores', async () => {
    const raphael16 = { ...amdRaphaelIgpu, files: { mem_info_vram_total: String(16 * GiB) } };
    expect(await linux({ devices: [raphael16], kfdNodes: amdKfd })).toMatchObject({ ...cpuOnly, confidence: 'high' });
  });

  it('sizes Strix Halo from a firmware carve-out larger than GTT, which the RAM the OS sees leaves out', async () => {
    // 128 GB with 96 GiB carved out: the OS sees about 31 GiB and ROCm 98304 MiB.
    const device = strixHalo(96 * GiB, 16636528640);
    expect(await linux({ devices: [device], kfdNodes: [KFD_STRIX_HALO_NODE] }, undefined, {}, 31 * GiB)).toMatchObject({
      memoryKind: 'unified',
      totalMemoryBytes: 31 * GiB,
      gpuMemoryBytes: 96 * GiB,
      gpuName: 'AMD GPU [1002:1586]',
      gpuCount: 1,
      gpuVendor: 'amd',
      confidence: 'high',
    });
  });

  it('sizes Strix Halo with a small carve-out from GTT, bounded by the TTM page limit', async () => {
    const ram = 125 * GiB;
    const ttm = (pages: number) => ({ 'sys/module/ttm/parameters/pages_limit': String(pages) });
    const probe = (gtt: number, files: Record<string, string> = {}) =>
      linux(
        { devices: [strixHalo(512 * MiB, gtt)], kfdNodes: [KFD_STRIX_HALO_NODE], files, procVersion: kernel('6.15.0') },
        undefined,
        {},
        ram
      );
    // The kernel default: GTT and the TTM limit both at half of RAM, as AMD's amd-ttm prints it.
    const half = 16469033 * 4096;
    expect(await probe(half, ttm(16469033))).toMatchObject({ gpuMemoryBytes: half, confidence: 'high' });
    // amdgpu.gttsize below the TTM limit, and GTT alone when the TTM parameter cannot be read.
    expect(await probe(32 * GiB, ttm(16469033))).toMatchObject({ gpuMemoryBytes: 32 * GiB });
    expect(await probe(48 * GiB)).toMatchObject({ gpuMemoryBytes: 48 * GiB });
    // A TTM limit raised near all of RAM is reported as is, since llama-server fits layers to what HIP reports.
    expect(await probe(120 * GiB, ttm(120 * 262144))).toMatchObject({ gpuMemoryBytes: 120 * GiB });
    // A higher TTM limit than GTT still stops at GTT.
    expect(await probe(40 * GiB, ttm(100 * 262144))).toMatchObject({ gpuMemoryBytes: 40 * GiB });
  });

  it('sizes Strix Halo by the rule of the running kernel', async () => {
    const files = { 'sys/module/ttm/parameters/pages_limit': String(24 * 262144) };
    const probe = (vram: number, gtt: number, procVersion: string) =>
      linux(
        { devices: [strixHalo(vram, gtt)], kfdNodes: [KFD_STRIX_HALO_NODE], files, procVersion },
        undefined,
        {},
        125 * GiB
      );
    // Before 6.10 KFD reports the carve-out, however small.
    expect(await probe(512 * MiB, 32 * GiB, kernel('6.9.12'))).toMatchObject({ gpuMemoryBytes: 512 * MiB });
    // 6.10 to 6.14 report the TTM limit on every APU, a large carve-out included.
    for (const release of ['6.10.0', '6.14.11']) {
      expect(await probe(96 * GiB, 32 * GiB, kernel(release))).toMatchObject({ gpuMemoryBytes: 24 * GiB });
    }
    // 6.15 keeps a carve-out at least as large as GTT.
    expect(await probe(96 * GiB, 32 * GiB, kernel('6.15.0'))).toMatchObject({ gpuMemoryBytes: 96 * GiB });
    expect(await probe(96 * GiB, 32 * GiB, kernel('7.0.1'))).toMatchObject({ gpuMemoryBytes: 96 * GiB });
    expect(await probe(512 * MiB, 32 * GiB, kernel('6.17.0'))).toMatchObject({ gpuMemoryBytes: 24 * GiB });
  });

  it('takes the smaller Strix Halo budget at low confidence when the kernel version cannot be read', async () => {
    const probe = (vram: number, gtt: number) =>
      linux(
        { devices: [strixHalo(vram, gtt)], kfdNodes: [KFD_STRIX_HALO_NODE], procVersion: '' },
        undefined,
        {},
        31 * GiB
      );
    expect(await probe(96 * GiB, 16 * GiB)).toMatchObject({ gpuMemoryBytes: 16 * GiB, confidence: 'low' });
    expect(await probe(512 * MiB, 16 * GiB)).toMatchObject({ gpuMemoryBytes: 512 * MiB, confidence: 'low' });
  });

  it('keeps Strix Halo unified at low confidence when its GTT size is missing', async () => {
    const device = { ...amdStrixHalo, files: { mem_info_vram_total: String(64 * GiB) } };
    expect(await linux({ devices: [device], kfdNodes: [KFD_STRIX_HALO_NODE] })).toMatchObject({
      memoryKind: 'unified',
      gpuMemoryBytes: null,
      confidence: 'low',
    });
  });

  it('recognises Strix Halo by its PCI device id when KFD is not mounted, as in a container', async () => {
    expect(await linux({ devices: [amdStrixHalo], pciIds: PCI_IDS })).toMatchObject({
      memoryKind: 'unified',
      gpuMemoryBytes: 64 * GiB,
      confidence: 'high',
    });
  });

  it('keeps Strix Halo unified at low confidence when system RAM is unknown', async () => {
    const profile = await probeHardware({
      exec: execFrom({}),
      os: os(0),
      platform: 'linux',
      arch: 'x64',
      rootDir: sysfs({ devices: [amdStrixHalo], kfdNodes: [KFD_STRIX_HALO_NODE] }),
      env: {},
    });
    expect(profile).toMatchObject({ memoryKind: 'unified', totalMemoryBytes: 0, confidence: 'low' });
  });

  it('reports the larger of Strix Halo and an AMD card beside it, never their sum', async () => {
    const kfdNodes = [KFD_STRIX_HALO_NODE, KFD_RX7900XTX_NODE];
    expect(await linux({ devices: [amdStrixHalo, amdRx7900xtx], kfdNodes })).toMatchObject({
      memoryKind: 'unified',
      gpuMemoryBytes: 64 * GiB,
      gpuCount: 1,
      confidence: 'high',
    });
    const small = strixHalo(16 * GiB, 8 * GiB);
    expect(await linux({ devices: [small, amdRx7900xtx], kfdNodes })).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 25753026560,
      gpuCount: 1,
      confidence: 'high',
    });
  });

  it('weighs Strix Halo against an NVIDIA card that nvidia-smi measures', async () => {
    const smi = execFrom({ 'nvidia-smi': RTX_4090_SMI });
    const devices = (apu: typeof amdStrixHalo) => ({ devices: [nvidiaRtx4090, apu], kfdNodes: [KFD_STRIX_HALO_NODE] });
    expect(await linux(devices(strixHalo(96 * GiB, 16 * GiB)), smi, {}, 31 * GiB)).toMatchObject({
      memoryKind: 'unified',
      gpuMemoryBytes: 96 * GiB,
      gpuVendor: 'amd',
      confidence: 'high',
    });
    expect(await linux(devices(strixHalo(16 * GiB, 8 * GiB)), smi)).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 24564 * MiB,
      gpuName: 'NVIDIA GeForce RTX 4090',
      gpuVendor: 'nvidia',
      confidence: 'high',
    });
  });

  it('keeps Strix Halo at high confidence beside a GPU whose memory it does not count', async () => {
    for (const other of [intelArcB580Xe, { ...nvidiaRtx4090, driver: 'nouveau' }, nvidiaRtx4090]) {
      expect(await linux({ devices: [amdStrixHalo, other], kfdNodes: [KFD_STRIX_HALO_NODE] })).toMatchObject({
        memoryKind: 'unified',
        gpuMemoryBytes: 64 * GiB,
        gpuCount: 1,
        confidence: 'high',
      });
    }
  });

  it('still skips an APU whose KFD node reports CPU cores, as ACPI CRAT topologies do', async () => {
    const crat = KFD_STRIX_HALO_NODE.replace('cpu_cores_count 0', 'cpu_cores_count 16').replace('110501', '120000');
    expect(await linux({ devices: [amdStrixHalo], kfdNodes: [crat] })).toMatchObject({
      ...cpuOnly,
      confidence: 'high',
    });
  });

  it('leaves AMD VRAM unmeasured when KFD cannot say whether the device is an APU', async () => {
    const phoenix16 = {
      ...amdRaphaelIgpu,
      device: '0x15bf',
      files: { mem_info_vram_total: String(16 * GiB) },
    };
    for (const devices of [[phoenix16], [amdRx7900xtx]]) {
      expect(await linux({ devices, pciIds: PCI_IDS })).toMatchObject({
        memoryKind: 'discrete',
        gpuMemoryBytes: null,
        gpuCount: 1,
        confidence: 'low',
      });
    }
  });

  it('treats a 1 GiB AMD carve-out as integrated', async () => {
    const raphael1 = { ...amdRaphaelIgpu, files: { mem_info_vram_total: String(GiB) } };
    expect(await linux({ devices: [raphael1] })).toMatchObject({ ...cpuOnly, confidence: 'high' });
  });

  it('counts an AMD card whose gfx target is a known discrete part', async () => {
    const rdna4 = KFD_RX7900XTX_NODE.replace('110000', '120001');
    expect(await linux({ devices: [amdRx7900xtx], kfdNodes: [rdna4] })).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 25753026560,
      confidence: 'high',
    });
  });

  it('leaves VRAM unmeasured for a gfx target on neither list, like a future APU with a large carve-out', async () => {
    for (const target of ['130000', '90402']) {
      const node = KFD_STRIX_HALO_NODE.replace('110501', target);
      expect(await linux({ devices: [amdStrixHalo], kfdNodes: [KFD_CPU_NODE, node] })).toMatchObject({
        memoryKind: 'discrete',
        gpuMemoryBytes: null,
        gpuCount: 1,
        confidence: 'low',
      });
    }
  });

  it('ignores AMD cards amdgpu does not drive', async () => {
    const profile = await linux({ devices: [{ ...amdRx7900xtx, driver: 'radeon' }], kfdNodes: amdKfd });
    expect(profile).toMatchObject({ ...cpuOnly, confidence: 'high' });
  });

  it('records Intel Arc on xe with unknown VRAM and skips the iGPU', async () => {
    const profile = await linux({ devices: [intelIgpu, intelArcB580Xe], pciIds: PCI_IDS });
    expect(profile).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: null,
      gpuName: 'Intel Battlemage G21 [Arc B580]',
      gpuCount: 1,
      confidence: 'low',
    });
  });

  it('records Intel Arc on i915 with unknown VRAM and low confidence', async () => {
    const profile = await linux({ devices: [intelIgpu, intelArcA770I915], pciIds: PCI_IDS });
    expect(profile).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: null,
      gpuName: 'Intel DG2 [Arc A770]',
      gpuCount: 1,
      confidence: 'low',
    });
  });

  it('keeps mixed-vendor VRAM unknown when Intel memory cannot be measured', async () => {
    const profile = await linux({ devices: [amdRx7900xtx, intelArcB580Xe], kfdNodes: amdKfd, pciIds: PCI_IDS });
    expect(profile).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: null,
      gpuName: 'AMD Navi 31 [Radeon RX 7900 XT/7900 XTX/7900 GRE/7900M]',
      gpuCount: 2,
      confidence: 'low',
    });
  });

  it('records an NVIDIA GPU on the proprietary driver with unknown VRAM', async () => {
    const profile = await linux({ devices: [nvidiaRtx4090], pciIds: PCI_IDS });
    expect(profile).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: null,
      gpuName: 'NVIDIA AD102 [GeForce RTX 4090]',
      gpuCount: 1,
      confidence: 'low',
    });
  });

  it('keeps VRAM unknown for the whole machine when one usable GPU is unmeasured', async () => {
    const amd = { ...amdRx7900xtx, address: '0000:03:00.0' };
    const profile = await linux({ devices: [nvidiaRtx4090, amd], kfdNodes: amdKfd });
    expect(profile).toMatchObject({ memoryKind: 'discrete', gpuMemoryBytes: null, gpuCount: 2, confidence: 'low' });
  });

  it('ignores NVIDIA cards no runtime can use: pre-Maxwell, unbound or passed through', async () => {
    for (const device of [
      nvidiaGt218Nouveau,
      { ...nvidiaRtx4090, driver: undefined },
      { ...nvidiaRtx4090, driver: 'vfio-pci' },
    ]) {
      expect(await linux({ devices: [...pcieBridges, device] })).toMatchObject({ ...cpuOnly, confidence: 'high' });
    }
  });

  it('keeps a Maxwell or newer card on nouveau as unmeasured, since Vulkan can reach it', async () => {
    const profile = await linux({ devices: [{ ...nvidiaRtx4090, driver: 'nouveau' }] });
    expect(profile).toMatchObject({ memoryKind: 'discrete', gpuName: 'NVIDIA GPU [10de:2684]', confidence: 'low' });
  });

  it('counts no GPU, at low confidence, when sysfs shows a usable card this namespace cannot open', async () => {
    const low = { ...cpuOnly, confidence: 'low' };
    expect(await linux({ devices: [amdRx7900xtx], kfdNodes: amdKfd, devNodes: false })).toMatchObject(low);
    expect(await linux({ devices: [nvidiaRtx4090], devNodes: false })).toMatchObject(low);
    expect(await linux({ devices: [intelIgpu, nvidiaGt218Nouveau], devNodes: false })).toMatchObject({
      ...cpuOnly,
      confidence: 'high',
    });
  });

  it('falls back to low confidence when the GPUs cannot be listed', async () => {
    const low = { ...cpuOnly, confidence: 'low' };
    expect(await linux({ pci: false })).toMatchObject(low);
    expect(
      await linux({ procVersion: 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1) #1 SMP\n' })
    ).toMatchObject(low);
    expect(await linux({ deviceTreeCompatible: 'nvidia,p3768-0000+p3767-0005\0nvidia,tegra234\0' })).toMatchObject(low);
  });

  it.each(['class', 'vendor', 'device'])('keeps missing PCI %s metadata at low confidence', async field => {
    const root = sysfs({ devices: [amdRx7900xtx], kfdNodes: amdKfd });
    unlinkSync(join(root, 'sys/bus/pci/devices', amdRx7900xtx.address, field));
    expect(await scanLinuxGpus(root, {})).toBeNull();
    expect(
      await probeHardware({ exec: execFrom({}), os: os(64 * GiB), platform: 'linux', rootDir: root, env: {} })
    ).toMatchObject({ ...cpuOnly, confidence: 'low' });
  });

  it.skipIf(process.getuid?.() === 0)('keeps an existing but inaccessible GPU device at low confidence', async () => {
    const root = sysfs({ devices: [amdRx7900xtx], kfdNodes: amdKfd });
    chmodSync(join(root, 'dev/dri/renderD128'), 0);
    expect(await scanLinuxGpus(root, {})).toBeNull();
  });

  it('detects WSL with a custom kernel from its environment, interop handler or /dev/dxg', async () => {
    const low = { ...cpuOnly, confidence: 'low' };
    expect(await linux({}, execFrom({}), { WSL_DISTRO_NAME: 'Ubuntu-24.04' })).toMatchObject(low);
    expect(await linux({}, execFrom({}), { WSL_INTEROP: '/run/WSL/1_interop' })).toMatchObject(low);
    expect(await linux({ files: { 'proc/sys/fs/binfmt_misc/WSLInterop': 'enabled\n' } })).toMatchObject(low);
    expect(await linux({ files: { 'dev/dxg': '' } })).toMatchObject(low);
  });

  it('scans the same tree directly', async () => {
    const root = sysfs({ devices: [amdRx7900xtx, amdRaphaelIgpu], kfdNodes: amdKfd });
    expect(await scanLinuxGpus(root, {})).toEqual([
      { vendor: 'amd', name: 'AMD GPU [1002:744c]', memoryBytes: 25753026560 },
    ]);
  });
});

describe('probeHardware on Windows without nvidia-smi', () => {
  it('runs the encoded PowerShell query by absolute path', async () => {
    const exec = execFrom({ [POWERSHELL]: POWERSHELL_INTEL_IGPU_ONLY });
    await probeHardware({ exec, os: os(GiB), platform: 'win32', arch: 'x64', env: {} });
    expect(exec).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      windowsGpuCommand({})[1]
    );
    expect(windowsGpuCommand({ SystemRoot: 'D:\\WINDOWS' })[0]).toBe(
      'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    );
    const encoded = windowsGpuCommand({})[1].at(-1) ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(WINDOWS_GPU_SCRIPT);
  });

  it('terminates on controller enumeration errors before serializing an empty result', () => {
    const enumeration = WINDOWS_GPU_SCRIPT.slice(
      WINDOWS_GPU_SCRIPT.indexOf('try {'),
      WINDOWS_GPU_SCRIPT.indexOf('$rows =')
    );
    expect(enumeration).toContain('Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop');
    expect(enumeration).toContain('catch {');
    expect(enumeration).toContain('[Console]::Error.WriteLine($_.Exception.Message)');
    expect(enumeration).toContain('exit 1');
  });

  it('is confidently CPU-only with only integrated graphics', async () => {
    expect(await windows(POWERSHELL_INTEL_IGPU_ONLY)).toMatchObject({ ...cpuOnly, confidence: 'high' });
    expect(await windows('[]')).toMatchObject({ ...cpuOnly, confidence: 'high' });
  });

  it('reads AMD VRAM past the 4 GiB AdapterRAM cap and skips the APU', async () => {
    expect(await windows(POWERSHELL_AMD_DISCRETE_AND_APU)).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 25753026560,
      gpuName: 'AMD Radeon RX 7900 XTX',
      gpuCount: 1,
      confidence: 'high',
    });
  });

  it('reads Intel Arc VRAM from a single-object reply', async () => {
    expect(await windows(POWERSHELL_INTEL_ARC)).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 17079205888,
      gpuName: 'Intel(R) Arc(TM) A770 Graphics',
      confidence: 'high',
    });
  });

  it('sizes Windows Strix Halo from its Variable Graphics Memory, which the RAM Windows sees leaves out', async () => {
    expect(await windows(POWERSHELL_STRIX_HALO)).toMatchObject({
      memoryKind: 'unified',
      totalMemoryBytes: 32 * GiB,
      gpuMemoryBytes: 96 * GiB,
      gpuName: 'AMD Radeon(TM) 8060S Graphics',
      gpuCount: 1,
      gpuVendor: 'amd',
      confidence: 'high',
    });
  });

  it('leaves a Windows Strix Halo carve-out smaller than the RAM Windows sees unsized, at low confidence', async () => {
    const strix = JSON.parse(POWERSHELL_STRIX_HALO)[0];
    for (const memoryBytes of [512 * MiB, 16 * GiB]) {
      expect(await windows(JSON.stringify([{ ...strix, memoryBytes }]))).toMatchObject({
        memoryKind: 'unified',
        gpuMemoryBytes: null,
        confidence: 'low',
      });
    }
  });

  it('reports the larger of Windows Strix Halo and a discrete card beside it', async () => {
    const strix = JSON.parse(POWERSHELL_STRIX_HALO)[0];
    const xtx = JSON.parse(POWERSHELL_AMD_DISCRETE_AND_APU)[0];
    expect(await windows(JSON.stringify([xtx, strix]))).toMatchObject({
      memoryKind: 'unified',
      gpuMemoryBytes: 96 * GiB,
    });
    const small = { ...strix, memoryBytes: 16 * GiB };
    expect(await windows(JSON.stringify([xtx, small]))).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 25753026560,
      confidence: 'high',
    });
  });

  it('looks for Strix Halo beside nvidia-smi on an AMD CPU only', async () => {
    const smi = { 'nvidia-smi': RTX_4090_SMI };
    expect(await windows(POWERSHELL_STRIX_HALO, smi, RYZEN_AI_MAX)).toMatchObject({
      memoryKind: 'unified',
      gpuMemoryBytes: 96 * GiB,
    });
    const intel = { PROCESSOR_IDENTIFIER: 'Intel64 Family 6 Model 183 Stepping 1, GenuineIntel' };
    expect(await windows(POWERSHELL_STRIX_HALO, smi, intel)).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 24564 * MiB,
    });
  });

  it('reports the largest single-vendor group instead of summing across vendors', async () => {
    const controllers = `[${POWERSHELL_AMD_DISCRETE_AND_APU.slice(1, -1)},${POWERSHELL_INTEL_ARC}]`;
    expect(await windows(controllers)).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 25753026560,
      gpuCount: 1,
      confidence: 'high',
    });
  });

  it('measures an NVIDIA GPU from the registry when nvidia-smi is missing', async () => {
    expect(await windows(POWERSHELL_NVIDIA)).toMatchObject({
      memoryKind: 'discrete',
      gpuMemoryBytes: 25757220864,
      gpuName: 'NVIDIA GeForce RTX 4090',
      confidence: 'high',
    });
  });

  it('falls back to low confidence when PowerShell fails or prints something else', async () => {
    const low = { ...cpuOnly, confidence: 'low' };
    expect(await windows(Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }))).toMatchObject(
      low
    );
    expect(
      await windows(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }))
    ).toMatchObject(low);
    expect(await windows('')).toMatchObject(low);
    expect(await windows('Get-CimInstance : Access denied')).toMatchObject(low);
  });

  it.each(['null', 'false', '42', '"error"', '{}', '[null]', '[{}]', '[false]'])(
    'keeps malformed controller data at low confidence: %s',
    async stdout => {
      expect(parseWindowsGpus(stdout)).toBeNull();
      expect(await windows(stdout)).toMatchObject({ ...cpuOnly, confidence: 'low' });
    }
  );
});

describe('parseWindowsGpus', () => {
  const amd = (fields: Record<string, unknown>) =>
    JSON.stringify([{ name: 'GPU', pnpDeviceId: 'PCI\\VEN_1002&DEV_73BF&SUBSYS_0E3A1002&REV_C1\\6&1', ...fields }]);
  const intel = (fields: Record<string, unknown>) =>
    JSON.stringify([
      { name: 'Intel GPU', pnpDeviceId: 'PCI\\VEN_8086&DEV_4680&SUBSYS_00000000&REV_0C\\3&1', ...fields },
    ]);

  it('uses AdapterRAM only below its cap when the registry has no size', () => {
    expect(parseWindowsGpus(amd({ adapterRam: 2 * GiB, memoryBytes: null }))).toEqual([
      { vendor: 'amd', name: 'GPU', memoryBytes: 2 * GiB },
    ]);
    expect(parseWindowsGpus(amd({ adapterRam: 4293918720, memoryBytes: null }))).toEqual([
      { vendor: 'amd', name: 'GPU', memoryBytes: null },
    ]);
  });

  it('ignores a negative DWORD MemorySize and falls back to AdapterRAM', () => {
    expect(
      parseWindowsGpus(amd({ name: 'AMD Radeon RX 580', adapterRam: 4293918720, memoryBytes: -2147483648 }))
    ).toEqual([{ vendor: 'amd', name: 'AMD Radeon RX 580', memoryBytes: null }]);
  });

  it('recognises AMD APU names and keeps discrete cards', () => {
    const count = (name: string) => parseWindowsGpus(amd({ name, memoryBytes: 2 * GiB }))?.length;
    expect(count('AMD Radeon(TM) Graphics')).toBe(0);
    expect(count('AMD Radeon(TM) RX Vega 11 Graphics')).toBe(0);
    expect(count('AMD Radeon(TM) RX Vega 10 Graphics')).toBe(0);
    expect(count('AMD Radeon(TM) Vega 8 Graphics')).toBe(0);
    expect(count('AMD Radeon 780M Graphics')).toBe(0);
    expect(count('AMD Radeon(TM) 610M')).toBe(0);
    expect(count('AMD Radeon 8060S Graphics')).toBe(1);
    expect(count('AMD Radeon RX 7600M XT')).toBe(1);
    expect(count('Radeon RX Vega')).toBe(1);
    expect(count('Radeon Pro WX 7100 Graphics')).toBe(1);
  });

  it('treats 1 GiB of AMD memory as an APU carve-out', () => {
    expect(parseWindowsGpus(amd({ memoryBytes: GiB }))).toEqual([]);
  });

  it.each(['AMD Radeon 8040S Graphics', 'AMD Radeon 8050S Graphics', 'AMD Radeon(TM) 8060S Graphics'])(
    'marks Strix Halo graphics as a shared-memory carve-out: %s',
    name => {
      expect(parseWindowsGpus(amd({ name, memoryBytes: 64 * GiB }))).toEqual([
        { vendor: 'amd', name, memoryBytes: 64 * GiB, sharedMemory: 'carve-out' },
      ]);
    }
  );

  it('recognises Strix Halo by its device id under a generic name', () => {
    const pnpDeviceId = 'PCI\\VEN_1002&DEV_1586&SUBSYS_8D101462&REV_D5\\4&1';
    expect(parseWindowsGpus(amd({ name: 'AMD Radeon(TM) Graphics', pnpDeviceId, memoryBytes: 512 * MiB }))).toEqual([
      { vendor: 'amd', name: 'AMD Radeon(TM) Graphics', memoryBytes: 512 * MiB, sharedMemory: 'carve-out' },
    ]);
  });

  it.each(['AMD Radeon HD 5450', 'AMD Radeon HD 6450', 'AMD Radeon HD 7670'])(
    'skips pre-GCN graphics without a supported runtime: %s',
    name => {
      expect(parseWindowsGpus(amd({ name, memoryBytes: 2 * GiB }))).toEqual([]);
    }
  );

  it.each(['AMD Radeon HD 8570D', 'AMD Radeon HD 8670D'])(
    'skips legacy integrated graphics with a large carve-out: %s',
    name => {
      expect(parseWindowsGpus(amd({ name, memoryBytes: 2 * GiB }))).toEqual([]);
    }
  );

  it('keeps GCN discrete Radeon cards on the other side of the legacy boundary', () => {
    expect(parseWindowsGpus(amd({ name: 'AMD Radeon HD 7770', memoryBytes: 2 * GiB }))).toEqual([
      { vendor: 'amd', name: 'AMD Radeon HD 7770', memoryBytes: 2 * GiB },
    ]);
  });

  it('reads the PCI bus from raw and resolved LocationInformation', () => {
    for (const location of [rawLocation(0, 2), 'PCI bus 0, device 2, function 0']) {
      expect(parseWindowsGpus(intel({ location, adapterRam: GiB, memoryBytes: null }))).toEqual([]);
      expect(parseWindowsGpus(intel({ location, adapterRam: 2 * GiB, memoryBytes: 2 * GiB }))).toEqual([]);
    }
    for (const location of [rawLocation(4, 0), 'PCI bus 4, device 0, function 0']) {
      expect(parseWindowsGpus(intel({ location, memoryBytes: 16 * GiB }))).toEqual([
        { vendor: 'intel', name: 'Intel GPU', memoryBytes: 16 * GiB },
      ]);
    }
  });

  it('falls back to memory size for Intel when the PCI location is missing', () => {
    expect(parseWindowsGpus(intel({ location: null, memoryBytes: 128 * MiB }))).toEqual([]);
    expect(parseWindowsGpus(intel({ location: null, memoryBytes: 16 * GiB }))?.length).toBe(1);
  });

  it('skips disabled adapters', () => {
    expect(parseWindowsGpus(amd({ memoryBytes: 16 * GiB, errorCode: 22, status: 'Error' }))).toEqual([]);
    expect(parseWindowsGpus(amd({ memoryBytes: 16 * GiB, errorCode: 0, status: 'Degraded' }))).toEqual([]);
    expect(parseWindowsGpus(amd({ memoryBytes: 16 * GiB, errorCode: 0, status: 'OK' }))?.length).toBe(1);
  });

  it('skips non-PCI adapters, other vendors and pre-Maxwell NVIDIA cards', () => {
    const rows = JSON.stringify([
      { name: 'Microsoft Basic Display Adapter', pnpDeviceId: 'ROOT\\BasicDisplay\\0000' },
      { name: 'VMware SVGA 3D', pnpDeviceId: 'PCI\\VEN_15AD&DEV_0405&SUBSYS_040515AD&REV_00\\3&61AAA01&0&78' },
      {
        name: 'NVIDIA GeForce GT 710',
        pnpDeviceId: 'PCI\\VEN_10DE&DEV_128B&SUBSYS_8C931462&REV_A1\\4&1',
        memoryBytes: GiB,
      },
    ]);
    expect(parseWindowsGpus(rows)).toEqual([]);
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
