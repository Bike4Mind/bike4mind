import { describe, expect, it, vi } from 'vitest';
import type { HardwareProfile, ModelArch } from '@bike4mind/local-models';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import { localContextSizing } from './localContextSizing';

const arch: ModelArch = {
  contextMax: 32768,
  blockCount: 24,
  full: { layers: 24, kvHeads: 2, keyLength: 64, valueLength: 64 },
  mtpLayers: 0,
};
const machine: HardwareProfile = {
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: 64 * 1024 ** 3,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  chip: null,
  diskFreeBytes: null,
  confidence: 'high',
};

describe('localContextSizing', () => {
  it('probes the machine once and inspects each model once', async () => {
    const probe = vi.fn(async () => machine);
    const inspect = vi.fn(async () => ({ arch, model: { sizeBytes: 397_821_000 } }));
    const sizing = localContextSizing({ setting: async () => AUTO_LOCAL_CONTEXT, probe, inspect });

    const first = await sizing.footprint('qwen2.5:0.5b');
    await sizing.footprint('qwen2.5:0.5b');
    await sizing.footprint('llama3.2');

    expect(first).toEqual({ arch, weightsBytes: 397_821_000, hardware: machine });
    expect(probe).toHaveBeenCalledOnce();
    expect(inspect.mock.calls).toEqual([['qwen2.5:0.5b'], ['llama3.2']]);
  });

  it('answers unknown when Ollama cannot be inspected, and asks again next time', async () => {
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ arch, model: { sizeBytes: 1 } });
    const sizing = localContextSizing({
      setting: async () => AUTO_LOCAL_CONTEXT,
      probe: async () => {
        throw new Error('no probe');
      },
      inspect,
    });

    expect(await sizing.footprint('qwen2.5:0.5b')).toEqual({ arch: null, weightsBytes: null, hardware: null });
    expect(await sizing.footprint('qwen2.5:0.5b')).toEqual({ arch, weightsBytes: 1, hardware: null });
  });
});
