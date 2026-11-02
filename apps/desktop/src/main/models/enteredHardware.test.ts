import type { HardwareProfile } from '@bike4mind/common';
import type { ModelServerSpecs } from '@shared/modelServers';
import { describe, expect, it } from 'vitest';
import { serverHardware, withEnteredSpecs } from './enteredHardware';

const GIB = 1024 ** 3;

const probe = (overrides: Partial<HardwareProfile> = {}): HardwareProfile => ({
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: 62 * GIB,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  gpuVendor: null,
  chip: null,
  diskFreeBytes: 100 * GIB,
  confidence: 'low',
  ...overrides,
});

const specs = (overrides: Partial<ModelServerSpecs> = {}): ModelServerSpecs => ({
  ramGiB: null,
  gpuMemoryGiB: null,
  bandwidthGBps: null,
  unified: false,
  ...overrides,
});

describe('withEnteredSpecs', () => {
  it('returns the probe untouched without entered memory', () => {
    const probed = probe();
    expect(withEnteredSpecs(probed, null)).toBe(probed);
    expect(withEnteredSpecs(probed, specs({ bandwidthGBps: 256 }))).toBe(probed);
  });

  it('replaces RAM alone and keeps what the probe knew about the GPU', () => {
    const probed = probe({
      memoryKind: 'discrete',
      gpuMemoryBytes: 24 * GIB,
      gpuName: 'Test GPU',
      gpuCount: 1,
      gpuVendor: 'nvidia',
      confidence: 'high',
    });
    expect(withEnteredSpecs(probed, specs({ ramGiB: 128 }))).toEqual({ ...probed, totalMemoryBytes: 128 * GIB });
  });

  it('makes a probe that found no GPU a discrete GPU of unknown vendor once GPU memory is entered', () => {
    const next = withEnteredSpecs(probe(), specs({ gpuMemoryGiB: 16 }));
    expect(next).toMatchObject({ memoryKind: 'discrete', gpuMemoryBytes: 16 * GIB, gpuCount: 1, confidence: 'high' });
    expect('gpuVendor' in next).toBe(false);
  });

  it('keeps unified memory unified and takes the entered GPU memory as what its GPU can use', () => {
    const probed = probe({ memoryKind: 'unified', gpuVendor: 'amd', gpuCount: 0, gpuName: 'Radeon' });
    expect(withEnteredSpecs(probed, specs({ ramGiB: 128, gpuMemoryGiB: 96 }))).toMatchObject({
      memoryKind: 'unified',
      totalMemoryBytes: 128 * GIB,
      gpuMemoryBytes: 96 * GIB,
      gpuVendor: 'amd',
      confidence: 'high',
    });
  });
});

describe('serverHardware', () => {
  it('leaves a server without RAM unrated', () => {
    expect(serverHardware(null)).toBeNull();
    expect(serverHardware(specs({ gpuMemoryGiB: 24 }))).toBeNull();
  });

  it.each([
    ['RAM only', specs({ ramGiB: 64 }), { memoryKind: 'cpu', gpuMemoryBytes: null, gpuCount: 0 }],
    [
      'a discrete GPU',
      specs({ ramGiB: 64, gpuMemoryGiB: 24 }),
      { memoryKind: 'discrete', gpuMemoryBytes: 24 * GIB, gpuCount: 1 },
    ],
    ['unified memory', specs({ ramGiB: 64, unified: true }), { memoryKind: 'unified', gpuMemoryBytes: null }],
    [
      'unified memory with a GPU budget',
      specs({ ramGiB: 128, gpuMemoryGiB: 96, unified: true }),
      { memoryKind: 'unified', gpuMemoryBytes: 96 * GIB, gpuCount: 0 },
    ],
  ] as const)('describes %s', (_label, entered, expected) => {
    expect(serverHardware(entered)).toMatchObject({ ...expected, confidence: 'high' });
  });
});
