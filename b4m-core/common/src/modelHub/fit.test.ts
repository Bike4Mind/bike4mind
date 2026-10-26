import { describe, it, expect } from 'vitest';
import { ModelArchSchema, type ModelArch } from '../schemas/modelHub';
import { machine } from './__fixtures__/hubManifest';
import {
  FIT_CONSTANTS,
  KV_BYTES_PER_ELEMENT,
  contextFloor,
  contextOptions,
  contextTarget,
  estimateFit,
  flashAttnOffBytes,
  kvCacheBytes,
  ollamaUbatch,
  type FitInput,
  type HardwareProfile,
} from './fit';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const F16 = { k: 'f16', v: 'f16' } as const;
const Q8 = { k: 'q8_0', v: 'q8_0' } as const;

const arch = (input: unknown): ModelArch => ModelArchSchema.parse(input);

// Shapes from config.json / GGUF headers, as listed in the runtime research worked numbers.
const QWEN3_30B_A3B = arch({
  contextMax: 40960,
  blockCount: 48,
  full: { layers: 48, kvHeads: 4, keyLength: 128, valueLength: 128 },
});
const QWEN38_27B = arch({
  contextMax: 262144,
  blockCount: 64,
  full: { layers: 16, kvHeads: 4, keyLength: 256, valueLength: 256 },
  recurrent: { layers: 48, stateBytesPerSeq: 150 * MIB },
});
const GPT_OSS_20B = arch({
  contextMax: 131072,
  blockCount: 24,
  full: { layers: 12, kvHeads: 8, keyLength: 64, valueLength: 64 },
  swa: { layers: 12, kvHeads: 8, keyLength: 64, valueLength: 64, window: 128 },
});
const GPT_OSS_120B = arch({
  contextMax: 131072,
  blockCount: 36,
  full: { layers: 18, kvHeads: 8, keyLength: 64, valueLength: 64 },
  swa: { layers: 18, kvHeads: 8, keyLength: 64, valueLength: 64, window: 128 },
});
const GEMMA4_31B = arch({
  contextMax: 262144,
  blockCount: 60,
  full: { layers: 10, kvHeads: 4, keyLength: 512, valueLength: 512 },
  swa: { layers: 50, kvHeads: 16, keyLength: 256, valueLength: 256, window: 1024 },
});
const LAGUNA_S = arch({
  contextMax: 131072,
  blockCount: 48,
  full: { layers: 12, kvHeads: 8, keyLength: 128, valueLength: 128 },
  swa: { layers: 36, kvHeads: 8, keyLength: 128, valueLength: 128, window: 512 },
});
const DEEPSEEK_V31 = arch({
  contextMax: 163840,
  blockCount: 61,
  full: { layers: 0, kvHeads: 1, keyLength: 1, valueLength: 1 },
  mla: { layers: 61, kvLoraRank: 512, ropeDim: 64 },
});

// 64 KiB of f16 KV per token: 65536 tokens = 4 GiB, so overheads stay readable.
const ARCH_64K = arch({
  contextMax: 262144,
  blockCount: 16,
  full: { layers: 16, kvHeads: 4, keyLength: 256, valueLength: 256 },
});
const MOE_64K = arch({ ...ARCH_64K, blockCount: 40, moe: { experts: 128, used: 8, moeLayers: 40 } });

const LS = { kind: 'llama-server', flashAttn: 'on' } as const;
const OLLAMA = { kind: 'ollama' } as const;
const mac = (budgetGiB: number): HardwareProfile => ({
  ...machine('unified', 128),
  gpuWorkingSetBytes: budgetGiB * GIB,
});

function fit(over: Partial<FitInput> & { weightsGiB?: number; arch?: ModelArch } = {}) {
  const { weightsGiB = 10, arch: a = ARCH_64K, ...rest } = over;
  return estimateFit({
    model: { arch: a, weightsBytes: weightsGiB * GIB },
    hardware: mac(16),
    mode: 'chat',
    runtime: LS,
    ...rest,
  });
}

describe('kvCacheBytes', () => {
  it('keeps ubatch cells per sliding layer when the window is 0, as llama.cpp pads min(size, 0 + n_ubatch)', () => {
    const gemma2 = arch({
      contextMax: 8192,
      blockCount: 42,
      full: { layers: 21, kvHeads: 8, keyLength: 256, valueLength: 256 },
      swa: { layers: 21, kvHeads: 8, keyLength: 256, valueLength: 256, window: 0 },
    });
    const perCell = 21 * 8 * 256 * 2 * 2;
    expect(kvCacheBytes(gemma2, 8192, F16, 1, 512)).toBe(perCell * 8192 + perCell * 512);
    expect(kvCacheBytes(gemma2, 256, F16, 1, 512)).toBe(perCell * 256 * 2);
  });

  it('uses ggml block sizes for quantized caches', () => {
    expect(KV_BYTES_PER_ELEMENT).toEqual({ f16: 2, q8_0: 1.0625, q4_0: 0.5625 });
    expect(kvCacheBytes(ARCH_64K, 4096, Q8)).toBe(4096 * 64 * 1024 * 0.53125);
    expect(kvCacheBytes(ARCH_64K, 4096, { k: 'q8_0', v: 'f16' })).toBe(4096 * 16 * 4 * 256 * (1.0625 + 2));
  });

  it('matches Qwen3-30B-A3B: 96 KiB/token and 384 MiB at 4096', () => {
    expect(kvCacheBytes(QWEN3_30B_A3B, 1, F16) / 256).toBe(96 * 1024);
    expect(kvCacheBytes(QWEN3_30B_A3B, 4096, F16)).toBe(384 * MIB);
  });

  it('caches KV only on the full-attention layers of Qwen3.8-27B: 64 KiB/token, not the naive 256', () => {
    expect(kvCacheBytes(QWEN38_27B, 32768, F16)).toBe(2 * GIB);
  });

  it('prices Gemma 4 31B global layers per token and its SWA layers as a fixed window + ubatch term', () => {
    const swaFixed = 50 * 16 * 512 * 2 * 1536;
    expect(swaFixed / GIB).toBeCloseTo(1.17, 2);
    expect(kvCacheBytes(GEMMA4_31B, 32768, F16)).toBe(80 * 1024 * 32768 + swaFixed);
  });

  it('matches the Laguna S SWA term of 144 MiB', () => {
    expect(kvCacheBytes(LAGUNA_S, 65536, F16) - 48 * 1024 * 65536).toBe(144 * MIB);
  });

  it('caches only the MLA latent for DeepSeek V3.1: 68.6 KiB/token', () => {
    expect(kvCacheBytes(DEEPSEEK_V31, 256, F16) / 256 / 1024).toBeCloseTo(68.6, 1);
  });

  it('pads the cache to 256 cells and gives every slot its own window', () => {
    expect(kvCacheBytes(ARCH_64K, 5000, F16)).toBe(kvCacheBytes(ARCH_64K, 5120, F16));
    expect(kvCacheBytes(LAGUNA_S, 65536, F16, 4)).toBe(4 * kvCacheBytes(LAGUNA_S, 65536, F16));
  });

  it('prices MTP layers on the MLA latent when the model has no full-attention layers', () => {
    const withMtp = arch({ ...DEEPSEEK_V31, mtpLayers: 1 });
    expect(kvCacheBytes(withMtp, 256, F16)).toBe(62 * (512 + 64) * 2 * 256);
  });

  it('uses a kvProbe verbatim', () => {
    const probed = arch({
      ...ARCH_64K,
      kvProbe: { bytesPerToken: 1000, fixedBytes: 5000, source: 'llama-fit-params', runtime: 'b11889' },
    });
    expect(kvCacheBytes(probed, 4096, Q8, 2)).toBe(1000 * 4096 * 2 + 5000);
  });
});

describe('estimator totals against published deltas', () => {
  const span = (a: ModelArch) => {
    const options = contextOptions({
      model: { arch: a, weightsBytes: 12e9 },
      hardware: mac(200),
      mode: 'code',
      runtime: LS,
    });
    const at = (c: number) => options.find(o => o.context === c)!.memory.totalBytes;
    return (at(131072) - at(8192)) / 1e9;
  };

  it('grows gpt-oss-20b by about 3.0 GB from 8k to 131k', () => {
    expect(span(GPT_OSS_20B)).toBeCloseTo(3.0, 1);
  });

  it('grows gpt-oss-120b by about 4.5 GB from 8k to 131k', () => {
    expect(span(GPT_OSS_120B)).toBeCloseTo(4.5, 1);
  });
});

describe('contextTarget and contextFloor', () => {
  it.each([
    ['chat', 262144, undefined, 65536, 32768],
    ['code', 262144, undefined, 262144, 65536],
    ['code', 40960, undefined, 40960, 40960],
    ['code', 262144, 131072, 131072, 65536],
    ['embeddings', 32768, undefined, 8192, 8192],
  ] as const)('%s, contextMax %i, cap %s -> target %i floor %i', (mode, contextMax, cap, target, floor) => {
    const a = arch({ ...ARCH_64K, contextMax });
    expect(contextTarget(a, mode, cap)).toBe(target);
    expect(contextFloor(a, mode, cap)).toBe(floor);
  });
});

describe('estimateFit', () => {
  it('sums weights, KV, compute and margin', () => {
    const { memory } = fit();
    expect(memory).toMatchObject({ kvBytes: 4 * GIB, computeBytes: GIB, marginBytes: GIB, totalBytes: 16 * GIB });
  });

  it('is fast only when the target fits', () => {
    expect(fit()).toMatchObject({ verdict: 'fast', reason: 'fits', context: 65536, kv: F16, placement: 'gpu' });
  });

  it('quantizes KV on llama-server before giving up context', () => {
    expect(fit({ hardware: mac(15) })).toMatchObject({
      verdict: 'fast',
      reason: 'kv-quantized',
      context: 65536,
      kv: Q8,
    });
  });

  it('offers a quantized cache under flash attention auto only once a smoke loaded that type', () => {
    const auto = { kind: 'llama-server' } as const;
    expect(fit({ hardware: mac(15), runtime: auto })).toMatchObject({ reason: 'reduced-context', kv: F16 });
    expect(fit({ hardware: mac(15), runtime: { ...auto, verifiedKv: ['q8_0'] } })).toMatchObject({
      verdict: 'fast',
      kv: Q8,
    });
    expect(fit({ hardware: mac(15), runtime: { ...auto, flashAttn: 'off', verifiedKv: ['q8_0'] } }).kv).toEqual(F16);
  });

  it("plans a fixed quantized V cache only with flash attention 'on'", () => {
    expect(fit({ runtime: { kind: 'llama-server', kv: Q8 } }).kv).toEqual(F16);
    expect(fit({ runtime: { kind: 'llama-server', kv: Q8, flashAttn: 'on' } }).kv).toEqual(Q8);
    expect(fit({ runtime: { kind: 'llama-server', kv: { k: 'q8_0', v: 'f16' } } }).kv).toEqual({ k: 'q8_0', v: 'f16' });
  });

  it('adds the KQ matrix to the compute buffer when flash attention is off', () => {
    const off = { kind: 'llama-server', flashAttn: 'off' } as const;
    const kq = flashAttnOffBytes(8192, 512, 32);
    expect(kq).toBe(8192 * 512 * 4 * 33);
    const r = estimateFit({
      model: { arch: { ...ARCH_64K, headCount: 32 }, weightsBytes: GIB },
      hardware: mac(64),
      mode: 'chat',
      runtime: off,
      context: 8192,
    });
    expect(r.requested?.memory.computeBytes).toBe(GIB + kq);
    const unknownHeads = fit({ hardware: mac(64), runtime: off, context: 8192 }).requested!;
    expect(unknownHeads.memory.computeBytes).toBe(GIB + flashAttnOffBytes(8192, 512, FIT_CONSTANTS.faOffAssumedHeads));
  });

  it('keeps an f16 cache on Ollama when flash attention is off, whatever the daemon KV type', () => {
    expect(fit({ runtime: { kind: 'ollama', kv: Q8, flashAttn: 'off' } }).kv).toEqual(F16);
  });

  it('keeps Ollama at its daemon KV type and its context-scaled ubatch', () => {
    const r = fit({ hardware: mac(15), runtime: OLLAMA });
    expect(r).toMatchObject({ verdict: 'tight', reason: 'reduced-context', context: 32768, kv: F16, ubatch: 1024 });
    expect(r.memory.computeBytes).toBe(2 * GIB);
    expect(fit({ hardware: mac(15), runtime: { kind: 'ollama', kv: Q8 } }).kv).toEqual(Q8);
  });

  it('reduces context down to the mode floor as tight', () => {
    expect(fit({ hardware: mac(14.1) })).toMatchObject({
      verdict: 'tight',
      reason: 'reduced-context',
      context: 32768,
      kv: F16,
    });
  });

  it('goes below the floor only as slow', () => {
    expect(fit({ hardware: mac(13) })).toMatchObject({ verdict: 'slow', reason: 'below-floor', context: 16384 });
  });

  it('reports too-large at the smallest preset', () => {
    expect(fit({ weightsGiB: 20 })).toMatchObject({ verdict: 'too-large', reason: 'exceeds-memory', context: 8192 });
  });

  it('moves the fewest expert layers, searching from the target context rather than only the floor', () => {
    const r = estimateFit({
      model: { arch: MOE_64K, weightsBytes: 22 * GIB, expertBytesPerLayer: GIB / 2 },
      hardware: machine('discrete', 32, 8),
      mode: 'chat',
      runtime: LS,
    });
    expect(r).toMatchObject({ verdict: 'tight', reason: 'expert-offload', context: 65536, kv: Q8, nCpuMoe: 37 });
    expect(r.memory.offloadedBytes).toBe(18.5 * GIB);
    expect(r.memory.totalBytes - r.memory.offloadedBytes).toBeLessThanOrEqual(8 * GIB);
  });

  it('honours a fixed nCpuMoe', () => {
    const r = estimateFit({
      model: { arch: MOE_64K, weightsBytes: 22 * GIB, expertBytesPerLayer: GIB / 2 },
      hardware: machine('discrete', 32, 8),
      mode: 'chat',
      runtime: { ...LS, nCpuMoe: 40 },
    });
    expect(r).toMatchObject({ reason: 'expert-offload', context: 65536, kv: F16, nCpuMoe: 40 });
    const off = estimateFit({
      model: { arch: MOE_64K, weightsBytes: 22 * GIB, expertBytesPerLayer: GIB / 2 },
      hardware: machine('discrete', 32, 8),
      mode: 'chat',
      runtime: { ...LS, nCpuMoe: 0 },
    });
    expect(off).toMatchObject({ reason: 'layer-offload', nCpuMoe: 0 });
  });

  it('carries a fixed nCpuMoe into every plan, even where the model would fit on the GPU', () => {
    const model = { arch: MOE_64K, weightsBytes: 22 * GIB, expertBytesPerLayer: GIB / 2 };
    const roomy = estimateFit({ model, hardware: mac(64), mode: 'chat', runtime: { ...LS, nCpuMoe: 10 } });
    expect(roomy).toMatchObject({
      verdict: 'tight',
      reason: 'expert-offload',
      placement: 'expert-offload',
      nCpuMoe: 10,
    });
    const tiny = estimateFit({
      model,
      hardware: machine('discrete', 8, 4),
      mode: 'chat',
      runtime: { ...LS, nCpuMoe: 10 },
    });
    expect(tiny).toMatchObject({ verdict: 'too-large', placement: 'expert-offload', nCpuMoe: 10 });
  });

  it('finds the fewest expert layers by binary search on the largest MoE the schema allows', () => {
    const wide = arch({ ...ARCH_64K, blockCount: 1024, moe: { experts: 4096, used: 8, moeLayers: 1024 } });
    // Each expert-offload plan reads the per-layer expert size once; a linear scan would read it hundreds of times.
    let plans = 0;
    const model = { arch: wide, weightsBytes: 400 * GIB };
    Object.defineProperty(model, 'expertBytesPerLayer', {
      enumerable: true,
      get: () => {
        plans++;
        return 0.5 * GIB;
      },
    });
    const r = estimateFit({ model, hardware: machine('discrete', 1024, 24), mode: 'chat', runtime: LS });
    expect(r).toMatchObject({ reason: 'expert-offload', context: 65536, kv: Q8, nCpuMoe: 761 });
    expect(plans).toBeLessThan(64);
    const gpuOnly = r.memory.totalBytes - r.memory.offloadedBytes;
    expect(gpuOnly).toBeLessThanOrEqual(24 * GIB);
    expect(gpuOnly + 0.5 * GIB).toBeGreaterThan(24 * GIB);
  });

  it('falls back to a slow dense layer split when the expert split runs out of RAM, or on Ollama', () => {
    const moe = { arch: MOE_64K, weightsBytes: 22 * GIB, expertBytesPerLayer: GIB / 2 };
    const small = estimateFit({ model: moe, hardware: machine('discrete', 24, 8), mode: 'chat', runtime: LS });
    expect(small).toMatchObject({ verdict: 'slow', reason: 'layer-offload', context: 16384 });
    const ollama = estimateFit({ model: moe, hardware: machine('discrete', 32, 8), mode: 'chat', runtime: OLLAMA });
    expect(ollama).toMatchObject({ verdict: 'slow', reason: 'layer-offload', nCpuMoe: 0 });
  });

  it('splits a dense model across GPU and RAM at the target', () => {
    const r = fit({ hardware: machine('discrete', 32, 8) });
    expect(r).toMatchObject({ verdict: 'slow', reason: 'layer-offload', context: 65536, kv: F16 });
    expect(r.memory.offloadedBytes).toBe(8 * GIB);
  });

  it('plans CPU-only machines, and discrete ones with unknown VRAM, against 0.75 of RAM', () => {
    expect(fit({ hardware: machine('cpu', 32) })).toMatchObject({
      verdict: 'slow',
      reason: 'cpu-only',
      context: 65536,
    });
    expect(fit({ hardware: machine('cpu', 32) }).memory.budgetBytes).toBe(24 * GIB);
    expect(fit({ hardware: machine('discrete', 32, null) })).toMatchObject({ reason: 'cpu-only', placement: 'cpu' });
  });

  it('budgets unified memory from the measured working set, else by RAM size', () => {
    expect(fit({ hardware: machine('unified', 16) }).memory.budgetBytes).toBeCloseTo(16 * GIB * 0.66);
    expect(fit({ hardware: machine('unified', 64) }).memory.budgetBytes).toBe(48 * GIB);
    expect(fit({ hardware: { ...machine('unified', 64), gpuWorkingSetBytes: 40 * GIB } }).memory.budgetBytes).toBe(
      40 * GIB
    );
  });

  it('scales the compute buffer with ubatch', () => {
    expect(fit({ runtime: { ...LS, ubatch: 2048 } }).memory.computeBytes).toBe(4 * GIB);
    expect([4096, 8192, 32768, 65536, 262144].map(ollamaUbatch)).toEqual([512, 1024, 1024, 2048, 2048]);
    expect(FIT_CONSTANTS.computeBytesPerUbatch512).toBe(GIB);
  });

  it('multiplies recurrent state by slots and by one snapshot per drafted token', () => {
    const r = estimateFit({
      model: { arch: QWEN38_27B, weightsBytes: 12e9 },
      hardware: mac(64),
      mode: 'code',
      runtime: { ...LS, slots: 2, draftMax: 3 },
    });
    expect(r.memory.recurrentBytes).toBe(150 * MIB * 2 * 4);
  });

  it('caps the target with a preset ctxCap and keeps embeddings short', () => {
    expect(fit({ contextCap: 32768 })).toMatchObject({ verdict: 'fast', context: 32768, target: 32768 });
    expect(fit({ mode: 'embeddings' })).toMatchObject({ verdict: 'fast', context: 8192, target: 8192, floor: 8192 });
  });

  describe('with an explicit context', () => {
    it('reports the requested context separately and keeps the verdict relative to the target', () => {
      const r = fit({ hardware: mac(13), context: 8192 });
      expect(r).toMatchObject({ verdict: 'slow', context: 16384 });
      expect(r.requested).toMatchObject({ context: 8192, fits: true, placement: 'gpu' });
    });

    it('marks a requested context that does not fit', () => {
      expect(fit({ hardware: mac(13), context: 65536 }).requested).toMatchObject({ context: 65536, fits: false });
    });

    it.each([0, -1, 1.5, Number.NaN, 262145])('rejects %s', context => {
      expect(() => fit({ context })).toThrow(RangeError);
    });
  });
});

describe('contextOptions', () => {
  it('lists the target and every preset below it, smallest first, with fits flags', () => {
    const options = contextOptions({
      model: { arch: ARCH_64K, weightsBytes: 10 * GIB },
      hardware: mac(13),
      mode: 'chat',
      runtime: LS,
    });
    expect(options.map(o => [o.context, o.fits])).toEqual([
      [8192, true],
      [16384, true],
      [32768, false],
      [65536, false],
    ]);
  });
});
