import { afterEach, describe, it, expect, vi } from 'vitest';
import { ModelArchSchema, type ModelArch } from '../schemas/modelHub';
import { MOE_35B_ARCH, machine } from './__fixtures__/hubManifest';
import {
  FIT_CONSTANTS,
  KV_BYTES_PER_ELEMENT,
  activationBytesPerToken,
  attentionMaskBytes,
  computeBufferBytes,
  contextFloor,
  contextOptions,
  contextTarget,
  estimateFit,
  estimateFitFromSize,
  fitMarginBytes,
  flashAttnOffBytes,
  isCpuOnly,
  kvCacheBytes,
  memoryBudgets,
  ollamaNumCtx,
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
  embeddingLength: 2048,
  activeFeedForwardLength: 18432,
  full: { layers: 16, kvHeads: 4, keyLength: 256, valueLength: 256 },
});
const MOE_64K = arch({ ...ARCH_64K, blockCount: 40, moe: { experts: 128, used: 8, moeLayers: 40 } });

const LS = { kind: 'llama-server', flashAttn: 'on' } as const;
const OLLAMA = { kind: 'ollama' } as const;
const mac = (budgetGiB: number): HardwareProfile => ({
  ...machine('unified', 128),
  gpuWorkingSetBytes: budgetGiB * GIB,
});
/** Strix Halo: RAM the OS sees and the device memory ROCm reports. */
const strix = (ramGiB: number, deviceGiB: number): HardwareProfile => ({
  ...machine('unified', ramGiB),
  platform: 'linux',
  arch: 'x64',
  gpuMemoryBytes: deviceGiB * GIB,
  gpuVendor: 'amd',
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

describe('estimator KV growth against published deltas', () => {
  const span = (a: ModelArch) => {
    const options = contextOptions({
      model: { arch: a, weightsBytes: 12e9 },
      hardware: mac(200),
      mode: 'code',
      runtime: LS,
    });
    const at = (c: number) => options.find(o => o.context === c)!.memory.kvBytes;
    return (at(131072) - at(8192)) / 1e9;
  };

  it('grows the gpt-oss-20b cache by about 3.0 GB from 8k to 131k', () => {
    expect(span(GPT_OSS_20B)).toBeCloseTo(3.0, 1);
  });

  it('grows the gpt-oss-120b cache by about 4.5 GB from 8k to 131k', () => {
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

describe('isCpuOnly', () => {
  it.each([
    ['no GPU', machine('cpu', 64), true],
    ['a discrete GPU of unknown memory', machine('discrete', 64), true],
    ['a discrete GPU', machine('discrete', 64, 24), false],
    ['unified memory', machine('unified', 64), false],
  ] as const)('%s: %s', (_label, hw, expected) => {
    expect(isCpuOnly(hw)).toBe(expected);
    expect(fit({ hardware: hw, runtime: OLLAMA, context: 16384 }).requested?.placement === 'cpu').toBe(expected);
  });
});

describe('estimateFit', () => {
  it('totals what the runtime allocates and keeps the margin beside it', () => {
    const { memory } = fit();
    expect(memory.kvBytes).toBe(4 * GIB);
    expect(memory.totalBytes).toBe(memory.weightsBytes + memory.kvBytes + memory.computeBytes);
    expect(memory.marginBytes).toBe(GIB);
  });

  it('fits only when the total and the margin together stay within the budget', () => {
    const need = fit().memory.totalBytes + GIB;
    const at = (budget: number) => fit({ hardware: { ...mac(16), gpuWorkingSetBytes: budget } });
    expect(at(need)).toMatchObject({ verdict: 'fast', context: 65536, kv: F16 });
    expect(at(need - 1)).toMatchObject({ context: 65536, kv: Q8 });
  });

  it('keeps more headroom on a discrete GPU than on unified memory or a CPU, and some on every GPU of a split', () => {
    const cpu = fitMarginBytes(machine('cpu', 32));
    const unified = fitMarginBytes(machine('unified', 32));
    const discrete = fitMarginBytes(machine('discrete', 32, 8));
    expect(cpu).toBeLessThan(unified);
    expect(unified).toBeLessThan(discrete);
    expect(fitMarginBytes(machine('discrete', 32, null))).toBe(cpu);
    expect(fitMarginBytes({ ...machine('discrete', 32, 16), gpuCount: 2 })).toBe(2 * discrete);
  });

  it('plans two GPUs below one card of the same summed VRAM', () => {
    const one = machine('discrete', 64, 17);
    expect(fit({ hardware: one })).toMatchObject({ verdict: 'fast', context: 65536, kv: F16 });
    const two = fit({ hardware: { ...one, gpuCount: 2 } });
    expect(two.memory.computeBytes).toBeGreaterThan(fit({ hardware: one }).memory.computeBytes);
    expect(two.kv === F16 && two.context === 65536 && two.placement === 'gpu').toBe(false);
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

  it('swaps the F16 mask for the KQ matrix and F32 mask when flash attention is off', () => {
    const kq = flashAttnOffBytes(8192, 512, 32);
    expect(kq).toBe(8192 * 512 * 4 * 33);
    const compute = (a: ModelArch, flashAttn: 'on' | 'off') =>
      estimateFit({
        model: { arch: a, weightsBytes: GIB },
        hardware: machine('cpu', 64),
        mode: 'chat',
        runtime: { kind: 'llama-server', flashAttn },
        context: 8192,
      }).requested!.memory.computeBytes;
    const mask = attentionMaskBytes(ARCH_64K, 8192, 512);
    expect(mask).toBe(8192 * 512 * 2);
    const heads = { ...ARCH_64K, headCount: 32 };
    expect(compute(heads, 'off') - compute(heads, 'on')).toBe(kq - mask);
    const assumed = flashAttnOffBytes(8192, 512, FIT_CONSTANTS.faOffAssumedHeads);
    expect(compute(ARCH_64K, 'off') - compute(ARCH_64K, 'on')).toBe(assumed - mask);
  });

  it('plans more compute on a discrete GPU than a CPU, and more again on unified memory', () => {
    const compute = (hardware: HardwareProfile) =>
      fit({ hardware, weightsGiB: 1, context: 32768 }).requested!.memory.computeBytes;
    const cpu = compute(machine('cpu', 64));
    expect(compute(machine('discrete', 64, 24))).toBeGreaterThan(cpu);
    expect(compute(mac(64))).toBeGreaterThan(compute(machine('discrete', 64, 24)));
  });

  it('keeps the host mask copy on all unified memory, ROCm included', () => {
    const compute = (hardware: HardwareProfile) =>
      fit({ hardware, weightsGiB: 1, context: 32768 }).requested!.memory.computeBytes;
    expect(compute(strix(31, 96))).toBe(compute(mac(64)));
    const mask = attentionMaskBytes(ARCH_64K, 32768, 512);
    expect(compute(strix(31, 96))).toBe(compute(machine('discrete', 64, 24)) + mask);
  });

  it('reserves at least one layer of F16 KV per extra slot on a GPU', () => {
    const compute = (slots: number) =>
      fit({ hardware: mac(64), weightsGiB: 1, context: 32768, runtime: { ...LS, slots } }).requested!.memory
        .computeBytes;
    const layer = kvCacheBytes(ARCH_64K, 32768, F16) / ARCH_64K.blockCount;
    expect(compute(4) - compute(1)).toBeGreaterThanOrEqual(3 * layer);
  });

  it('counts a copy of an offloaded expert tensor in the CUDA compute buffer', () => {
    // gpt-oss-120b-like: three MXFP4 expert tensors of 128 x 2880 x 2880 per layer.
    const expertTensor = 128 * 2880 * 2880 * (4.25 / 8);
    const model = {
      arch: arch({
        contextMax: 131072,
        blockCount: 36,
        headCount: 64,
        embeddingLength: 2880,
        activeFeedForwardLength: 4 * 2880,
        full: { layers: 18, kvHeads: 8, keyLength: 64, valueLength: 64 },
        swa: { layers: 18, kvHeads: 8, keyLength: 64, valueLength: 64, window: 128 },
        moe: { experts: 128, used: 4, moeLayers: 36 },
      }),
      weightsBytes: 63.4e9,
      expertBytesPerLayer: 3 * expertTensor,
    };
    const r = estimateFit({
      model,
      hardware: machine('discrete', 64, 24),
      mode: 'chat',
      runtime: { kind: 'llama-server' },
    });
    expect(r).toMatchObject({ verdict: 'tight', reason: 'expert-offload' });
    const graph = computeBufferBytes(model, r.context, r.ubatch, { memoryKind: 'discrete' });
    expect(r.memory.computeBytes).toBeGreaterThanOrEqual(graph + expertTensor);
    expect(r.memory.totalBytes - r.memory.offloadedBytes + r.memory.marginBytes).toBeLessThanOrEqual(24 * GIB);
  });

  it('counts the same copy in the Metal compute buffer when a preset leaves experts on the CPU', () => {
    const model = { arch: arch(MOE_35B_ARCH), weightsBytes: 21.71e9, expertBytesPerLayer: 492_750_000 };
    const r = estimateFit({ model, hardware: mac(32), mode: 'chat', runtime: { ...LS, nCpuMoe: 10 } });
    expect(r).toMatchObject({ placement: 'expert-offload', nCpuMoe: 10 });
    const graph = computeBufferBytes(model, r.context, r.ubatch, { memoryKind: 'unified' });
    expect(r.memory.computeBytes).toBeGreaterThanOrEqual(graph + model.expertBytesPerLayer / 3);
  });

  it('keeps an f16 cache on Ollama when flash attention is off, whatever the daemon KV type', () => {
    expect(fit({ runtime: { kind: 'ollama', kv: Q8, flashAttn: 'off' } }).kv).toEqual(F16);
  });

  it('keeps Ollama at its daemon KV type', () => {
    const r = fit({ hardware: mac(15), runtime: OLLAMA });
    expect(r).toMatchObject({ verdict: 'tight', reason: 'reduced-context', context: 32768, kv: F16 });
    expect(fit({ hardware: mac(15), runtime: { kind: 'ollama', kv: Q8 } }).kv).toEqual(Q8);
  });

  it("plans Ollama's batch from context on a CPU and steps it down on a GPU as Ollama does", () => {
    const ubatch = (hardware: HardwareProfile, runtime: FitInput['runtime'] = OLLAMA) =>
      fit({ hardware, runtime, context: 65536 }).requested!.ubatch;
    expect(ubatch(machine('cpu', 64))).toBe(2048);
    expect(ubatch(machine('cpu', 16))).toBe(2048);
    // 10 GiB of weights plus Ollama's 4 GiB f16 KV prediction: 2048 needs it within 60% of free memory, 1024 75%.
    expect([16, 20, 40].map(budget => ubatch(mac(budget)))).toEqual([512, 1024, 2048]);
    expect(ubatch(machine('discrete', 64, 48))).toBe(2048);
    expect(ubatch(machine('discrete', 64, 48), { kind: 'ollama', flashAttn: 'off' })).toBe(512);
    expect(ubatch(machine('discrete', 64, 8), { kind: 'ollama', flashAttn: 'off' })).toBe(256);
  });

  it("keys Ollama's flash-attention-off batch on CUDA, so ROCm and Vulkan step down instead", () => {
    const faOff = (hardware: HardwareProfile) =>
      fit({ hardware, runtime: { kind: 'ollama', flashAttn: 'off' }, context: 65536 }).requested!.ubatch;
    expect(faOff({ ...machine('discrete', 64, 48), gpuVendor: 'nvidia' })).toBe(512);
    expect(faOff({ ...machine('unified', 128), platform: 'linux', arch: 'arm64', gpuVendor: 'nvidia' })).toBe(512);
    expect(faOff({ ...machine('discrete', 64, 48), gpuVendor: 'amd' })).toBe(2048);
    expect(faOff({ ...machine('discrete', 64, 48), gpuVendor: 'intel' })).toBe(2048);
    expect(faOff(strix(31, 96))).toBe(2048);
  });

  it("steps Ollama's batch down by the RAM the OS sees on unified memory, as Ollama holds an iGPU to free RAM", () => {
    const ubatch = (hardware: HardwareProfile) =>
      fit({ hardware, runtime: OLLAMA, weightsGiB: 20, context: 65536 }).requested!.ubatch;
    // 20 GiB of weights plus a 4 GiB KV prediction is past 60% and 75% of 31 GiB, though not of the 96 GiB carve-out.
    expect(ubatch(strix(31, 96))).toBe(512);
    expect(ubatch(strix(125, 96))).toBe(2048);
  });

  it('loads Ollama embedding models with one slot and a 2048 batch capped at the context', () => {
    const embed = (context: number) =>
      fit({ mode: 'embeddings', hardware: machine('cpu', 64), runtime: { kind: 'ollama', slots: 4 }, context })
        .requested!;
    expect(embed(8192)).toMatchObject({ ubatch: 2048 });
    expect(embed(1024)).toMatchObject({ ubatch: 1024 });
    expect(embed(8192).memory.kvBytes).toBe(kvCacheBytes(ARCH_64K, 8192, F16));
  });

  it('reduces context down to the mode floor as tight', () => {
    expect(fit({ hardware: mac(13.5) })).toMatchObject({
      verdict: 'tight',
      reason: 'reduced-context',
      context: 32768,
      kv: F16,
    });
  });

  it('goes below the floor only as slow', () => {
    expect(fit({ hardware: mac(12.3) })).toMatchObject({ verdict: 'slow', reason: 'below-floor', context: 16384 });
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
    expect(r).toMatchObject({ verdict: 'tight', reason: 'expert-offload', context: 65536, kv: Q8, nCpuMoe: 38 });
    expect(r.memory.offloadedBytes).toBe(19 * GIB);
    expect(r.memory.totalBytes - r.memory.offloadedBytes + r.memory.marginBytes).toBeLessThanOrEqual(8 * GIB);
  });

  it('honours a fixed nCpuMoe', () => {
    const r = estimateFit({
      model: { arch: MOE_64K, weightsBytes: 22 * GIB, expertBytesPerLayer: GIB / 2 },
      hardware: machine('discrete', 32, 8),
      mode: 'chat',
      runtime: { ...LS, nCpuMoe: 40 },
    });
    expect(r).toMatchObject({ reason: 'expert-offload', context: 65536, nCpuMoe: 40 });
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
    expect(r).toMatchObject({ reason: 'expert-offload', context: 65536, kv: Q8, nCpuMoe: 762 });
    expect(plans).toBeLessThan(64);
    const gpuOnly = r.memory.totalBytes - r.memory.offloadedBytes + r.memory.marginBytes;
    expect(gpuOnly).toBeLessThanOrEqual(24 * GIB);
    expect(gpuOnly + 0.5 * GIB).toBeGreaterThan(24 * GIB);
  });

  it('falls back to a slow dense layer split when the expert split runs out of RAM, or on Ollama', () => {
    const moe = { arch: MOE_64K, weightsBytes: 22 * GIB, expertBytesPerLayer: GIB / 2 };
    // This RAM pool holds a dense split but not the whole expert layers the 8 GiB card would have to shed.
    const small = estimateFit({ model: moe, hardware: machine('discrete', 24.2, 8), mode: 'chat', runtime: LS });
    expect(small).toMatchObject({ verdict: 'slow', reason: 'layer-offload', nCpuMoe: 0 });
    expect(small.memory.offloadedBytes).toBeLessThanOrEqual(small.memory.ramPoolBytes);
    const ollama = estimateFit({ model: moe, hardware: machine('discrete', 32, 8), mode: 'chat', runtime: OLLAMA });
    expect(ollama).toMatchObject({ verdict: 'slow', reason: 'layer-offload', nCpuMoe: 0 });
  });

  it('splits a dense model across GPU and RAM at the target', () => {
    const r = fit({ hardware: machine('discrete', 32, 8) });
    expect(r).toMatchObject({ verdict: 'slow', reason: 'layer-offload', context: 65536, kv: F16 });
    expect(r.memory.offloadedBytes).toBe(r.memory.totalBytes + r.memory.marginBytes - 8 * GIB);
    const graph = computeBufferBytes({ arch: ARCH_64K, weightsBytes: 10 * GIB }, r.context, r.ubatch, {
      memoryKind: 'discrete',
    });
    expect(r.memory.computeBytes).toBeGreaterThanOrEqual(graph + Math.ceil((10 * GIB * 2) / 3 / ARCH_64K.blockCount));
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

  it('budgets AMD unified memory from what ROCm reports, not a share of the RAM the OS sees', () => {
    // A 96 GiB carve-out leaves the OS 31 GiB; a small one leaves GTT at about half of RAM.
    expect(fit({ hardware: strix(31, 96) }).memory.budgetBytes).toBe(96 * GIB);
    expect(fit({ hardware: strix(125, 62) }).memory.budgetBytes).toBe(62 * GIB);
    expect(fit({ hardware: strix(31, 96), weightsGiB: 60, runtime: OLLAMA })).toMatchObject({ verdict: 'fast' });
    expect(fit({ hardware: strix(125, 62), weightsGiB: 70, runtime: OLLAMA })).toMatchObject({ verdict: 'too-large' });
  });

  it('plans a Windows Strix Halo carve-out machine from RAM, since its reported bytes are not the usable pool', () => {
    const carveOut = { ...strix(64, 0.5), platform: 'win32' } as const;
    expect(fit({ hardware: carveOut, weightsGiB: 4, runtime: OLLAMA })).toMatchObject({ verdict: 'too-large' });
    const unknown = { ...carveOut, gpuMemoryBytes: null };
    expect(fit({ hardware: unknown, weightsGiB: 4, runtime: OLLAMA })).toMatchObject({ verdict: 'fast' });
    expect(fit({ hardware: unknown, weightsGiB: 4, runtime: OLLAMA }).memory.budgetBytes).toBe(48 * GIB);
  });

  it('grows compute with ubatch', () => {
    const at = (ubatch: number) =>
      fit({ hardware: machine('cpu', 64), runtime: { ...LS, ubatch }, context: 8192 }).requested!.memory.computeBytes;
    expect(at(512)).toBeLessThan(at(1024));
    expect(at(1024)).toBeLessThan(at(2048));
  });

  it('keeps compute finite when the tensor stats describe a heavier build than the weights', () => {
    const noWidths = { ...MOE_64K, embeddingLength: undefined, activeFeedForwardLength: undefined, blockCount: 48 };
    const model = {
      arch: arch({ ...noWidths, moe: { experts: 128, used: 8, moeLayers: 48 } }),
      weightsBytes: 18 * GIB,
    };
    const heavy = { ...model, expertBytesPerLayer: 0.6 * GIB };
    expect(Number.isFinite(activationBytesPerToken(heavy))).toBe(true);
    const r = estimateFit({ model: heavy, hardware: mac(64), mode: 'chat', runtime: OLLAMA });
    expect(Number.isFinite(r.memory.computeBytes)).toBe(true);
    expect(r.verdict).toBe('fast');
  });

  it('keeps a calibrated recurrent model at or above its transformer layers, and any other at the old flat rate', () => {
    const narrow = { ...ARCH_64K, activeFeedForwardLength: 1024 };
    const perToken = (a: unknown) => activationBytesPerToken({ arch: arch(a), weightsBytes: GIB });
    const recurrent = { layers: 8, stateBytesPerSeq: MIB };
    expect(perToken({ ...narrow, recurrent: { ...recurrent, kind: 'mamba2' } })).toBeGreaterThan(perToken(narrow));
    // The flat 1 GiB per 512-token ubatch this estimator charged before it was measured.
    expect(perToken({ ...narrow, recurrent })).toBeGreaterThanOrEqual(GIB / 512);
    expect(perToken({ ...narrow, recurrent: { ...recurrent, kind: 'future-kind' } })).toBeGreaterThanOrEqual(GIB / 512);
    const { embeddingLength: _e, activeFeedForwardLength: _f, ...noWidths } = narrow;
    expect(perToken({ ...noWidths, recurrent })).toBeGreaterThanOrEqual(GIB / 512);
  });

  it('sizes absorbed MLA attention past the FFN on 128-head DeepSeek-class models', () => {
    const v3 = arch({
      ...DEEPSEEK_V31,
      headCount: 128,
      embeddingLength: 7168,
      activeFeedForwardLength: 8 * 2048 + 2048,
      moe: { experts: 256, used: 8, moeLayers: 58 },
    });
    // q_nope absorbed, q_pe and their concat are live together: about 154.6k floats per token with the residual.
    expect(activationBytesPerToken({ arch: v3, weightsBytes: 400 * GIB })).toBeGreaterThanOrEqual(4 * 154_600);
    const { headCount: _h, ...ffnOnly } = v3;
    expect(activationBytesPerToken({ arch: v3, weightsBytes: 400 * GIB })).toBeGreaterThan(
      activationBytesPerToken({ arch: arch(ffnOnly), weightsBytes: 400 * GIB })
    );
  });

  it('counts the down projection output of narrow-expert MoE layers', () => {
    const narrowExperts = arch({
      ...ARCH_64K,
      activeFeedForwardLength: 8 * 512,
      moe: { experts: 64, used: 8, moeLayers: 16 },
    });
    const wideExperts = arch({
      ...ARCH_64K,
      embeddingLength: 512,
      activeFeedForwardLength: 8 * 512,
      moe: { experts: 64, used: 8, moeLayers: 16 },
    });
    const perToken = (a: ModelArch) => activationBytesPerToken({ arch: a, weightsBytes: GIB });
    // 8 experts x n_embd 2048 outlives the 4096-wide expert input; at n_embd 512 the FFN widths dominate.
    expect(perToken(narrowExperts)).toBeGreaterThanOrEqual(4 * (8 * 2048 + 4096));
    expect(perToken(wideExperts)).toBeGreaterThanOrEqual(4 * 3 * 4096);
  });

  it('bounds activations from the weights at or above the widths when the widths are unknown', () => {
    const strip = ({ embeddingLength: _e, activeFeedForwardLength: _f, ...shape }: ModelArch) => arch(shape);
    const dense = { arch: ARCH_64K, weightsBytes: 10 * GIB };
    expect(activationBytesPerToken({ ...dense, arch: strip(ARCH_64K) })).toBeGreaterThanOrEqual(
      activationBytesPerToken(dense)
    );
    const moe = { arch: MOE_64K, weightsBytes: 22 * GIB, expertBytesPerLayer: GIB / 2 };
    expect(activationBytesPerToken({ ...moe, arch: strip(MOE_64K) })).toBeGreaterThanOrEqual(
      activationBytesPerToken(moe)
    );
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
      const r = fit({ hardware: mac(12.3), context: 8192 });
      expect(r).toMatchObject({ verdict: 'slow', context: 16384 });
      expect(r.requested).toMatchObject({ context: 8192, fits: true, placement: 'gpu' });
    });

    it('marks a requested context that does not fit', () => {
      expect(fit({ hardware: mac(12.3), context: 65536 }).requested).toMatchObject({ context: 65536, fits: false });
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
      hardware: mac(12.3),
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

describe('memoryBudgets', () => {
  it('gives a CPU-only machine a share of its RAM and a discrete GPU its VRAM plus a RAM pool', () => {
    expect(memoryBudgets(machine('cpu', 128))).toEqual({ gpu: 96 * GIB, ramPool: 0, cpuOnly: true });
    expect(memoryBudgets(machine('discrete', 64, 24))).toEqual({
      gpu: 24 * GIB,
      ramPool: 64 * GIB * FIT_CONSTANTS.discreteOffloadRamFraction,
      cpuOnly: false,
    });
  });
});

describe('ollamaNumCtx', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('caps the reported window at 32K unless OLLAMA_MAX_NUM_CTX sets another cap', () => {
    expect(ollamaNumCtx(262144)).toBe(32768);
    expect(ollamaNumCtx(Infinity)).toBe(32768);
    expect(ollamaNumCtx(8192)).toBe(8192);
    vi.stubEnv('OLLAMA_MAX_NUM_CTX', '65536');
    expect(ollamaNumCtx(262144)).toBe(65536);
    vi.stubEnv('OLLAMA_MAX_NUM_CTX', 'nonsense');
    expect(ollamaNumCtx(262144)).toBe(32768);
  });
});

describe('estimateFitFromSize', () => {
  const cpu128 = machine('cpu', 128);

  it('fits a small file and counts compute on top of it', () => {
    const fit = estimateFitFromSize(GIB, cpu128, 32768);
    expect(fit).toMatchObject({ level: 'fits', budgetBytes: 96 * GIB, offloadBytes: 0, cpuOnly: true, context: 32768 });
    expect(fit.needBytes).toBeGreaterThan(GIB);
    expect(fit.needBytes).toBeLessThan(2 * GIB);
  });

  it('is tight past the headroom left for context memory', () => {
    expect(estimateFitFromSize(80 * GIB, cpu128, 32768).level).toBe('tight');
  });

  it('is too large past the budget without a GPU to split onto', () => {
    const fit = estimateFitFromSize(120 * GIB, cpu128, 32768);
    expect(fit.level).toBe('too-large');
    expect(fit.offloadBytes).toBeGreaterThan(24 * GIB);
  });

  it('splits a discrete GPU overflow into system RAM until the pool runs out', () => {
    const rig = machine('discrete', 64, 24);
    const split = estimateFitFromSize(30 * GIB, rig, 16384);
    expect(split.level).toBe('tight');
    expect(split.offloadBytes).toBeGreaterThan(6 * GIB);
    expect(estimateFitFromSize(100 * GIB, rig, 16384).level).toBe('too-large');
  });

  it('needs more at a longer context', () => {
    const short = estimateFitFromSize(4 * GIB, cpu128, 8192);
    const long = estimateFitFromSize(4 * GIB, cpu128, 131072);
    expect(long.needBytes).toBeGreaterThan(short.needBytes);
  });
});
