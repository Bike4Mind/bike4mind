import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HardwareProfile } from '@bike4mind/local-models';
import { isLoopbackUrl, machineLabel, machineReader, rateDownload } from './fit.js';

const GIB = 1024 ** 3;

const cpu = (ramGiB: number): HardwareProfile => ({
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: ramGiB * GIB,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  chip: null,
  diskFreeBytes: null,
  confidence: 'high',
});

const rtx = (vramGiB: number, ramGiB: number): HardwareProfile => ({
  ...cpu(ramGiB),
  memoryKind: 'discrete',
  gpuMemoryBytes: vramGiB * GIB,
  gpuName: 'NVIDIA GeForce RTX 4090',
  gpuCount: 1,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isLoopbackUrl', () => {
  it.each(['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'http://0.0.0.0:11434'])(
    'reads %s as this machine',
    url => expect(isLoopbackUrl(url)).toBe(true)
  );

  it.each(['http://gpu-box:11434', 'http://192.168.1.20:11434', 'not a url'])('reads %s as elsewhere', url =>
    expect(isLoopbackUrl(url)).toBe(false)
  );
});

describe('machineReader', () => {
  it('probes once and reads a detected runtime as this machine', async () => {
    const probe = vi.fn(async () => cpu(64));
    const read = machineReader(probe);
    expect(await read(null)).toEqual({ hardware: cpu(64) });
    expect(await read('http://127.0.0.1:11434')).toEqual({ hardware: cpu(64) });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not rate a remote runtime by this machine', async () => {
    const probe = vi.fn(async () => cpu(64));
    expect(await machineReader(probe)('http://gpu-box:11434')).toEqual({
      unknown: 'Ollama at http://gpu-box:11434 runs on another machine, whose memory this one cannot read',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reads a failed or empty probe as unknown', async () => {
    const unknown = { unknown: "This machine's memory could not be read" };
    expect(await machineReader(() => Promise.reject(new Error('no /proc')))(null)).toEqual(unknown);
    expect(await machineReader(async () => cpu(0))(null)).toEqual(unknown);
  });
});

describe('machineLabel', () => {
  it('names the memory a model can run in', () => {
    expect(machineLabel({ hardware: cpu(64) })).toBe('no GPU, 68.7 GB RAM');
    expect(machineLabel({ hardware: rtx(24, 64) })).toBe('NVIDIA GeForce RTX 4090 with 25.8 GB, 68.7 GB RAM');
  });
});

describe('rateDownload', () => {
  it('names a layer split into system RAM as tight', () => {
    const fit = rateDownload(30 * GIB, { hardware: rtx(24, 64) }, 8192);
    expect(fit.verdict).toBe('tight');
    expect(fit.detail).toContain('at the 8K context the CLI requests; with 2.1 GB reserved headroom');
    expect(fit.detail).toContain('this exceeds the 25.8 GB a model can use in GPU');
    expect(fit.detail).toContain('part of it runs from system RAM');
  });

  it('follows OLLAMA_MAX_NUM_CTX, as the chat backend does', () => {
    vi.stubEnv('OLLAMA_MAX_NUM_CTX', '131072');
    expect(rateDownload(GIB, { hardware: cpu(64) }, 262144).detail).toContain('at the 128K context');
  });

  it('is unknown without a size', () => {
    expect(rateDownload(0, { hardware: cpu(64) }, null)).toEqual({
      verdict: 'unknown',
      detail: 'The download size is unknown.',
    });
  });

  it('explains that reserved headroom can exceed the budget even when the file and compute fit', () => {
    const fit = rateDownload(9.5 * GIB, { hardware: cpu(14) }, 8192);
    expect(fit.verdict).toBe('too-large');
    expect(fit.detail).toContain('with 268 MB reserved headroom, this exceeds the 11.3 GB');
    expect(fit.detail).not.toContain('more than');
  });
});
