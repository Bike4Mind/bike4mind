import type { LoadedModel } from '@bike4mind/local-models';
import { describe, expect, it, vi } from 'vitest';
import { clearsCap, isLinuxStoreDir, parseC2cMode, partialLoad, probeIntegratedGpu, runsInWsl } from './wslGpuCap';

const GIB = 1024 ** 3;

const model = (name: string, sizeGib: number, gpuGib: number): LoadedModel => ({
  name,
  sizeBytes: sizeGib * GIB,
  vramBytes: gpuGib * GIB,
  contextLength: 131072,
  expiresAt: null,
});

describe('parseC2cMode', () => {
  it('reads a GPU attached to the CPU, beside the NPU Windows lists with no C2C mode', () => {
    expect(parseC2cMode('Enabled\r\n[N/A]\r\n')).toBe(true);
    expect(parseC2cMode('Enabled\n')).toBe(true);
  });

  it('reads a discrete GPU as not integrated', () => {
    expect(parseC2cMode('[N/A]\n')).toBe(false);
    expect(parseC2cMode('Disabled\n[N/A]\n')).toBe(false);
  });

  it('cannot say from empty output or an nvidia-smi that does not know the field', () => {
    expect(parseC2cMode('')).toBeNull();
    expect(parseC2cMode('Field "c2c.mode" is not a valid field to query.\n')).toBeNull();
  });
});

describe('probeIntegratedGpu', () => {
  it('asks nvidia-smi for the C2C mode alone, so an older nvidia-smi cannot fail the hardware probe', async () => {
    const exec = vi.fn(async () => ({ stdout: 'Enabled\n' }));
    expect(await probeIntegratedGpu(exec)).toBe(true);
    expect(exec).toHaveBeenCalledWith('nvidia-smi', ['--query-gpu=c2c.mode', '--format=csv,noheader']);
  });

  it('cannot say when nvidia-smi fails', async () => {
    expect(await probeIntegratedGpu(async () => Promise.reject(new Error('exit 2')))).toBeNull();
  });
});

describe('runsInWsl', () => {
  it('reads the WSL environment or kernel', () => {
    expect(runsInWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, null)).toBe(true);
    expect(runsInWsl({ WSL_INTEROP: '/run/WSL/1_interop' }, null)).toBe(true);
    expect(runsInWsl({}, 'Linux version 6.18.33.2-microsoft-standard-WSL2 (root@host)')).toBe(true);
    expect(runsInWsl({}, 'Linux version 6.8.0-45-generic (buildd@lcy02)')).toBe(false);
    expect(runsInWsl({}, null)).toBe(false);
  });
});

describe('isLinuxStoreDir', () => {
  it('tells a Linux model folder from a Windows one', () => {
    expect(isLinuxStoreDir('/usr/share/ollama/.ollama/models')).toBe(true);
    expect(isLinuxStoreDir('C:\\Users\\me\\.ollama\\models')).toBe(false);
    expect(isLinuxStoreDir('\\\\wsl.localhost\\Ubuntu\\home\\me\\.ollama\\models')).toBe(false);
    expect(isLinuxStoreDir(null)).toBe(false);
  });
});

// Dedicated GPU memory differs per machine and per firmware setting; nothing here may assume one size.
describe.each([24, 64, 72, 80, 96])('partialLoad with %i GiB of usable GPU memory', usableGib => {
  const usable = usableGib * GIB;

  it('finds a model that fits the GPU held partly on the CPU', () => {
    const capped = model('big:q8', usableGib * 0.6, usableGib * 0.35);
    expect(partialLoad([model('small:q4', 2, 2), capped], usable)).toEqual({
      model: 'big:q8',
      sizeBytes: capped.sizeBytes,
      gpuBytes: capped.vramBytes,
    });
  });

  it('ignores a model fully on the GPU, or short of it only by rounding', () => {
    expect(partialLoad([model('big:q8', usableGib * 0.6, usableGib * 0.6)], usable)).toBeNull();
    expect(partialLoad([model('big:q8', usableGib * 0.6, usableGib * 0.6 * 0.95)], usable)).toBeNull();
  });

  it('ignores a model larger than the GPU, which runs partly on the CPU anyway', () => {
    expect(partialLoad([model('huge:bf16', usableGib * 1.2, usableGib * 0.5)], usable)).toBeNull();
  });

  it('finds a model that fits the GPU held entirely on the CPU', () => {
    expect(partialLoad([model('big:q8', usableGib * 0.6, 0)], usable)).toMatchObject({ model: 'big:q8', gpuBytes: 0 });
  });
});

describe('partialLoad', () => {
  it('ignores sizes that are not finite', () => {
    const odd = (sizeBytes: number, vramBytes: number): LoadedModel => ({ ...model('x', 1, 1), sizeBytes, vramBytes });
    expect(partialLoad([odd(Number.NaN, GIB)], 64 * GIB)).toBeNull();
    expect(partialLoad([odd(10 * GIB, Number.NaN)], 64 * GIB)).toBeNull();
    expect(partialLoad([odd(Number.POSITIVE_INFINITY, GIB)], 64 * GIB)).toBeNull();
    expect(partialLoad([model('big:q8', 10, 5)], Number.NaN)).toBeNull();
  });
});

describe.each([24, 64, 96])('clearsCap after a %i GiB cap', capGib => {
  const capped = { model: 'big:q8', sizeBytes: capGib * 1.5 * GIB, gpuBytes: capGib * GIB };

  it('clears once a model as large as the capped one runs fully on the GPU', () => {
    expect(clearsCap([model('big:q8', capGib * 1.5, capGib * 1.5)], capped)).toBe(true);
    expect(clearsCap([model('other', capGib * 2, capGib * 2)], capped)).toBe(true);
  });

  it('clears for a load short of the GPU only by rounding, as partialLoad tolerates', () => {
    expect(clearsCap([model('big:q8', capGib * 1.5, capGib * 1.5 * 0.95)], capped)).toBe(true);
  });

  it('keeps it for a model the capped Ollama could hold anyway, or one still short', () => {
    expect(clearsCap([model('small', capGib * 0.5, capGib * 0.5)], capped)).toBe(false);
    expect(clearsCap([model('other', capGib + 1, capGib + 1)], capped)).toBe(false);
    expect(clearsCap([model('big:q8', capGib * 1.5, capGib)], capped)).toBe(false);
    expect(clearsCap([], capped)).toBe(false);
  });
});
