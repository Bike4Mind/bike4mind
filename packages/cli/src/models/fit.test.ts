import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HardwareProfile } from '@bike4mind/local-models';
import { fitForPlan, isLoopbackUrl, machineLabel, machineReader, rateDownload } from './fit.js';
import type { PullPlan } from './localModels.js';

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
    // The 24 GiB GPU less its 2 GiB margin, as Desktop words it.
    expect(fit.detail).toContain('at the 8K context the CLI requests, more than the 23.6 GB a model can use in GPU');
    expect(fit.detail).toContain('part of it runs from system RAM');
    expect(fit.detail).toMatch(/ Close other apps first, or this computer may slow down\.$/);
  });

  it('adds the close-other-apps line only to a tight verdict', () => {
    expect(rateDownload(80 * GIB, { hardware: cpu(128) }, 8192)).toMatchObject({ verdict: 'tight' });
    expect(rateDownload(80 * GIB, { hardware: cpu(128) }, 8192).detail).toContain('Close other apps first');
    expect(rateDownload(GIB, { hardware: cpu(128) }, 8192).detail).not.toContain('Close other apps');
    expect(rateDownload(200 * GIB, { hardware: cpu(128) }, 8192).detail).not.toContain('Close other apps');
  });

  it('names the limit a split runs past, and when only the context room is short', () => {
    const rig = rtx(24, 64);
    expect(rateDownload(200 * GIB, { hardware: rig }, 16384).detail).toContain('this computer can hold for a model.');
    const near = rateDownload(60 * GIB, { hardware: rig }, 16384);
    expect(near.verdict).toBe('too-large');
    expect(near.detail).toContain('to leave room for that');
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

  it('compares the need with what a model can use once headroom is kept free, with decimals that tell them apart', () => {
    const fit = rateDownload(9.5 * GIB, { hardware: cpu(14) }, 8192);
    expect(fit.verdict).toBe('too-large');
    expect(fit.detail).toContain('about 11.1 GB before context memory');
    expect(fit.detail).toContain('more than the 11.0 GB this computer can hold for a model.');
    const close = rateDownload(9.405 * GIB, { hardware: cpu(14) }, 8192);
    expect(close.verdict).toBe('too-large');
    expect(close.detail).toContain('about 11.04 GB before context memory');
    expect(close.detail).toContain('more than the 11.01 GB this computer can hold');
  });
});

describe('fitForPlan', () => {
  const plan = (server: { id: string; name: string } | undefined) =>
    ({
      kind: 'ollama',
      target: { runtime: { baseUrl: 'http://127.0.0.1:21434' }, source: server ? 'server' : 'env', server },
      manifest: { sizeBytes: 40 * GIB },
    }) as unknown as PullPlan;

  it("never rates a saved server's download against this machine, even on a loopback tunnel", async () => {
    const read = vi.fn(async () => ({ hardware: cpu(16) }));
    const fit = await fitForPlan(plan({ id: 'a1', name: 'gpu-box' }), read);
    expect(read).not.toHaveBeenCalled();
    expect(fit.verdict).toBe('unknown');
    expect(fit.detail).toContain('saved model server');
  });

  it('rates a local runtime against this machine', async () => {
    const read = vi.fn(async () => ({ hardware: cpu(16) }));
    const fit = await fitForPlan(plan(undefined), read);
    expect(read).toHaveBeenCalledWith('http://127.0.0.1:21434');
    expect(fit.verdict).toBe('too-large');
  });
});
