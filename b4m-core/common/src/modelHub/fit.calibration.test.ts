import { describe, it, expect } from 'vitest';
import { ModelArchSchema, type ModelArch } from '../schemas/modelHub';
import { machine } from './__fixtures__/hubManifest';
import { estimateFit, flashAttnOffBytes, kvCacheBytes, ollamaUbatch, type FitRuntime } from './fit';

// Linux x64, CPU only, MiB as printed: llama-server b11889 (-np 1, -ub 512, f16 KV, flash attention on) load logs
// and Ollama 0.40.11 /api/ps sizes, load logs and runner RSS. CUDA and Metal terms are not covered here.

const MIB = 1024 ** 2;

const MODELS = {
  'qwen2.5:0.5b': {
    fileBytes: 397_807_936,
    bufferMiB: 373.71,
    arch: {
      contextMax: 32768,
      blockCount: 24,
      embeddingLength: 896,
      activeFeedForwardLength: 4864,
      full: { layers: 24, kvHeads: 2, keyLength: 64, valueLength: 64 },
    },
  },
  'gemma3:270m': {
    fileBytes: 291_545_472,
    bufferMiB: 271.81,
    arch: {
      contextMax: 32768,
      blockCount: 18,
      embeddingLength: 640,
      activeFeedForwardLength: 2048,
      full: { layers: 3, kvHeads: 1, keyLength: 256, valueLength: 256 },
      swa: { layers: 15, kvHeads: 1, keyLength: 256, valueLength: 256, window: 512 },
    },
  },
  'granite4:350m-h': {
    fileBytes: 366_195_616,
    bufferMiB: 345.83,
    arch: {
      contextMax: 1048576,
      blockCount: 32,
      embeddingLength: 768,
      activeFeedForwardLength: 2048,
      full: { layers: 4, kvHeads: 4, keyLength: 64, valueLength: 64 },
      recurrent: { layers: 28, stateBytesPerSeq: 22_622_208, kind: 'mamba2' },
    },
  },
  'qwen3.5:0.8b': {
    fileBytes: 811_843_520,
    bufferMiB: 763.78,
    arch: {
      contextMax: 262144,
      blockCount: 24,
      embeddingLength: 1024,
      activeFeedForwardLength: 3584,
      full: { layers: 6, kvHeads: 2, keyLength: 256, valueLength: 256 },
      recurrent: { layers: 18, stateBytesPerSeq: 20_201_472, kind: 'gated-delta-net' },
    },
  },
} as const;
type ModelName = keyof typeof MODELS;

interface Row {
  model: ModelName;
  ctx: number;
  ls: { kvMiB: number; recurrentMiB: number; computeMiB: number; totalMiB: number };
  ollama: { psBytes: number; ubatch: number; contextMiB: number };
}

const ROWS: Row[] = [
  {
    model: 'qwen2.5:0.5b',
    ctx: 4096,
    ls: { kvMiB: 48, recurrentMiB: 0, computeMiB: 41.27, totalMiB: 463.56 },
    ollama: { psBytes: 486_067_403, ubatch: 512, contextMiB: 48 },
  },
  {
    model: 'qwen2.5:0.5b',
    ctx: 16384,
    ls: { kvMiB: 192, recurrentMiB: 0, computeMiB: 53.27, totalMiB: 619.56 },
    ollama: { psBytes: 705_502_903, ubatch: 1024, contextMiB: 192 },
  },
  {
    model: 'qwen2.5:0.5b',
    ctx: 32768,
    ls: { kvMiB: 384, recurrentMiB: 0, computeMiB: 69.27, totalMiB: 827.56 },
    ollama: { psBytes: 940_383_927, ubatch: 1024, contextMiB: 384 },
  },
  {
    model: 'gemma3:270m',
    ctx: 4096,
    ls: { kvMiB: 27, recurrentMiB: 0, computeMiB: 23.28, totalMiB: 323.09 },
    ollama: { psBytes: 326_201_507, ubatch: 512, contextMiB: 27 },
  },
  {
    model: 'gemma3:270m',
    ctx: 16384,
    ls: { kvMiB: 63, recurrentMiB: 0, computeMiB: 35.28, totalMiB: 371.09 },
    ollama: { psBytes: 384_680_590, ubatch: 1024, contextMiB: 70 },
  },
  {
    model: 'gemma3:270m',
    ctx: 32768,
    ls: { kvMiB: 111, recurrentMiB: 0, computeMiB: 51.28, totalMiB: 435.09 },
    ollama: { psBytes: 418_235_022, ubatch: 1024, contextMiB: 118 },
  },
  {
    model: 'granite4:350m-h',
    ctx: 4096,
    ls: { kvMiB: 16, recurrentMiB: 21.57, computeMiB: 28.88, totalMiB: 412.66 },
    ollama: { psBytes: 432_705_370, ubatch: 512, contextMiB: 37 },
  },
  {
    model: 'granite4:350m-h',
    ctx: 32768,
    ls: { kvMiB: 128, recurrentMiB: 21.57, computeMiB: 56.88, totalMiB: 552.66 },
    ollama: { psBytes: 638_362_581, ubatch: 1024, contextMiB: 149 },
  },
  {
    model: 'granite4:350m-h',
    ctx: 131072,
    ls: { kvMiB: 512, recurrentMiB: 21.57, computeMiB: 152.88, totalMiB: 1032.66 },
    ollama: { psBytes: 1_561_340_148, ubatch: 2048, contextMiB: 533 },
  },
  // Ollama loads this library model with its MTP draft (--spec-draft-n-max 2), which keeps two extra recurrent
  // snapshots; its /api/ps size (below the weights alone) does not count the draft and projector runners.
  {
    model: 'qwen3.5:0.8b',
    ctx: 4096,
    ls: { kvMiB: 48, recurrentMiB: 19.27, computeMiB: 39.02, totalMiB: 871.02 },
    ollama: { psBytes: 574_074_386, ubatch: 512, contextMiB: 105 },
  },
  {
    model: 'qwen3.5:0.8b',
    ctx: 32768,
    ls: { kvMiB: 384, recurrentMiB: 19.27, computeMiB: 67.02, totalMiB: 1235.02 },
    ollama: { psBytes: 731_392_243, ubatch: 1024, contextMiB: 441 },
  },
  {
    model: 'qwen3.5:0.8b',
    ctx: 131072,
    ls: { kvMiB: 1536, recurrentMiB: 19.27, computeMiB: 163.02, totalMiB: 2483.02 },
    ollama: { psBytes: 1_473_825_994, ubatch: 2048, contextMiB: 1593 },
  },
];

const archOf = (name: ModelName) => ModelArchSchema.parse(MODELS[name].arch);
const OLLAMA_DRAFT_MAX: Partial<Record<ModelName, number>> = { 'qwen3.5:0.8b': 2 };

function estimate(row: Row, runtime: FitRuntime) {
  const { fileBytes } = MODELS[row.model];
  return estimateFit({
    model: { arch: archOf(row.model), weightsBytes: fileBytes },
    hardware: machine('cpu', 64),
    mode: 'chat',
    runtime,
    context: row.ctx,
  }).requested!;
}

describe('estimator against llama-server b11889 allocations', () => {
  it.each(ROWS)('$model at $ctx: KV and recurrent state match to the byte', row => {
    const { memory } = estimate(row, { kind: 'llama-server' });
    expect(memory.kvBytes).toBe(row.ls.kvMiB * MIB);
    expect(memory.recurrentBytes / MIB).toBeCloseTo(row.ls.recurrentMiB, 2);
  });

  it.each(ROWS)('$model at $ctx: file size stays within 4% of the weight buffers', row => {
    const { fileBytes, bufferMiB } = MODELS[row.model];
    expect(fileBytes / MIB / bufferMiB).toBeGreaterThan(1);
    expect(fileBytes / MIB / bufferMiB).toBeLessThan(1.04);
  });

  it.each(ROWS)('$model at $ctx: compute is at or above the allocation and within 20%', row => {
    const { memory } = estimate(row, { kind: 'llama-server' });
    expect(memory.computeBytes).toBeGreaterThanOrEqual(row.ls.computeMiB * MIB);
    expect(memory.computeBytes).toBeLessThanOrEqual(row.ls.computeMiB * MIB * 1.2);
    expect(memory.totalBytes).toBeGreaterThan(row.ls.totalMiB * MIB);
  });
});

describe('estimator against Ollama 0.40.11 library models', () => {
  it.each(ROWS)('$model at $ctx: picks the ubatch Ollama passed and matches its context breakdown', row => {
    const plan = estimate(row, { kind: 'ollama', draftMax: OLLAMA_DRAFT_MAX[row.model] });
    expect(plan.ubatch).toBe(row.ollama.ubatch);
    // The breakdown prints whole MiB, truncated.
    expect(Math.floor((plan.memory.kvBytes + plan.memory.recurrentBytes) / MIB)).toBe(row.ollama.contextMiB);
  });

  it.each(ROWS.filter(r => r.model !== 'qwen3.5:0.8b'))('$model at $ctx: total stays above /api/ps size', row => {
    expect(estimate(row, { kind: 'ollama' }).memory.totalBytes).toBeGreaterThan(row.ollama.psBytes);
  });
});

// GGUF builds loaded on Ollama 0.40.11 with num_ctx; arch from /api/show. Buffers from the runner's load log
// (weights = CPU + CPU_REPACK), RSS of the runner after one generated token.
const HF = {
  'Qwen2.5 0.5B Q4_K_M': {
    fileBytes: 491_400_032,
    weightsMiB: 462.96,
    arch: {
      contextMax: 32768,
      blockCount: 24,
      headCount: 14,
      embeddingLength: 896,
      activeFeedForwardLength: 4864,
      full: { layers: 24, kvHeads: 2, keyLength: 64, valueLength: 64 },
    },
  },
  'Qwen3 4B 2507 Q4_K_M': {
    fileBytes: 2_497_281_120,
    weightsMiB: 2375.91,
    arch: {
      contextMax: 262144,
      blockCount: 36,
      headCount: 32,
      embeddingLength: 2560,
      activeFeedForwardLength: 9728,
      full: { layers: 36, kvHeads: 8, keyLength: 128, valueLength: 128 },
    },
  },
  'Qwen3 8B Q4_K_M': {
    fileBytes: 5_027_783_488,
    weightsMiB: 4789.19,
    arch: {
      contextMax: 40960,
      blockCount: 36,
      headCount: 32,
      embeddingLength: 4096,
      activeFeedForwardLength: 12288,
      full: { layers: 36, kvHeads: 8, keyLength: 128, valueLength: 128 },
    },
  },
  'gpt-oss 20B MXFP4': {
    fileBytes: 12_109_566_624,
    weightsMiB: 11536.18,
    arch: {
      contextMax: 131072,
      blockCount: 24,
      headCount: 64,
      embeddingLength: 2880,
      activeFeedForwardLength: 4 * 2880,
      full: { layers: 12, kvHeads: 8, keyLength: 64, valueLength: 64 },
      swa: { layers: 12, kvHeads: 8, keyLength: 64, valueLength: 64, window: 128 },
      moe: { experts: 32, used: 4, moeLayers: 24 },
    },
  },
  'Granite 4.0 H Tiny Q4_K_M': {
    fileBytes: 4_230_976_352,
    weightsMiB: 4031.55,
    arch: {
      contextMax: 1048576,
      blockCount: 40,
      headCount: 12,
      embeddingLength: 1536,
      activeFeedForwardLength: 6 * 512 + 1024,
      full: { layers: 4, kvHeads: 4, keyLength: 128, valueLength: 128 },
      recurrent: { layers: 36, stateBytesPerSeq: 58_060_800, kind: 'mamba2' },
      moe: { experts: 64, used: 6, moeLayers: 40 },
    },
  },
  'Granite 4.0 H Micro Q4_K_M': {
    fileBytes: 1_942_564_512,
    weightsMiB: 1849.16,
    arch: {
      contextMax: 1048576,
      blockCount: 40,
      headCount: 32,
      embeddingLength: 2048,
      activeFeedForwardLength: 8192,
      full: { layers: 4, kvHeads: 8, keyLength: 64, valueLength: 64 },
      recurrent: { layers: 36, stateBytesPerSeq: 77_377_536, kind: 'mamba2' },
    },
  },
  // n_embd is twice the expert width, where the down projection's used x n_embd output sets the MoE peak.
  'granite3-moe:1b': {
    fileBytes: 821_844_672,
    weightsMiB: 782.11,
    arch: {
      contextMax: 4096,
      blockCount: 24,
      headCount: 16,
      embeddingLength: 1024,
      activeFeedForwardLength: 8 * 512,
      full: { layers: 24, kvHeads: 8, keyLength: 64, valueLength: 64 },
      moe: { experts: 32, used: 8, moeLayers: 24 },
    },
  },
} as const;
type HfName = keyof typeof HF;

interface Load {
  model: HfName;
  ctx: number;
  ubatch: number;
  /** KV buffers (full + SWA) plus the recurrent-state buffer. */
  contextMiB: number;
  computeMiB: number;
  rssMiB: number;
  /** Ollama's num_batch option, which sets -b and -ub. */
  numBatch?: number;
}

const LOADS: Load[] = [
  { model: 'Qwen2.5 0.5B Q4_K_M', ctx: 4096, ubatch: 512, contextMiB: 48, computeMiB: 41.27, rssMiB: 590.4 },
  { model: 'Qwen2.5 0.5B Q4_K_M', ctx: 6144, ubatch: 1024, contextMiB: 72, computeMiB: 86.54, rssMiB: 614.4 },
  { model: 'Qwen2.5 0.5B Q4_K_M', ctx: 16384, ubatch: 1024, contextMiB: 192, computeMiB: 106.54, rssMiB: 734.4 },
  { model: 'Qwen2.5 0.5B Q4_K_M', ctx: 32768, ubatch: 1024, contextMiB: 384, computeMiB: 138.54, rssMiB: 926.4 },
  { model: 'Qwen3 4B 2507 Q4_K_M', ctx: 16384, ubatch: 1024, contextMiB: 2304, computeMiB: 196.04, rssMiB: 4766.7 },
  { model: 'Qwen3 4B 2507 Q4_K_M', ctx: 32768, ubatch: 1024, contextMiB: 4608, computeMiB: 228.04, rssMiB: 7070.6 },
  { model: 'Qwen3 4B 2507 Q4_K_M', ctx: 36864, ubatch: 2048, contextMiB: 5184, computeMiB: 472.07, rssMiB: 7646.6 },
  { model: 'Qwen3 4B 2507 Q4_K_M', ctx: 65536, ubatch: 2048, contextMiB: 9216, computeMiB: 584.07, rssMiB: 11678.7 },
  { model: 'Qwen3 8B Q4_K_M', ctx: 16384, ubatch: 1024, contextMiB: 2304, computeMiB: 256.04, rssMiB: 7194.3 },
  { model: 'Qwen3 8B Q4_K_M', ctx: 32768, ubatch: 1024, contextMiB: 4608, computeMiB: 288.04, rssMiB: 9498.2 },
  { model: 'Qwen3 8B Q4_K_M', ctx: 40960, ubatch: 2048, contextMiB: 5760, computeMiB: 608.07, rssMiB: 10650.1 },
  { model: 'gpt-oss 20B MXFP4', ctx: 16384, ubatch: 1024, contextMiB: 414, computeMiB: 225.8, rssMiB: 12073.9 },
  { model: 'gpt-oss 20B MXFP4', ctx: 32768, ubatch: 1024, contextMiB: 798, computeMiB: 257.8, rssMiB: 12457.8 },
  { model: 'gpt-oss 20B MXFP4', ctx: 65536, ubatch: 2048, contextMiB: 1590, computeMiB: 647.6, rssMiB: 13249.9 },
  {
    model: 'Granite 4.0 H Tiny Q4_K_M',
    ctx: 16384,
    ubatch: 1024,
    contextMiB: 128 + 55.37,
    computeMiB: 134.03,
    rssMiB: 4365.2,
  },
  {
    model: 'Granite 4.0 H Tiny Q4_K_M',
    ctx: 32768,
    ubatch: 1024,
    contextMiB: 256 + 55.37,
    computeMiB: 166.03,
    rssMiB: 4490.4,
  },
  {
    model: 'Granite 4.0 H Tiny Q4_K_M',
    ctx: 65536,
    ubatch: 2048,
    contextMiB: 512 + 55.37,
    computeMiB: 460.06,
    rssMiB: 4748.8,
  },
  {
    model: 'Granite 4.0 H Micro Q4_K_M',
    ctx: 16384,
    ubatch: 1024,
    contextMiB: 128 + 73.79,
    computeMiB: 176.03,
    rssMiB: 2209.6,
  },
  {
    model: 'Granite 4.0 H Micro Q4_K_M',
    ctx: 32768,
    ubatch: 1024,
    contextMiB: 256 + 73.79,
    computeMiB: 208.03,
    rssMiB: 2340.6,
  },
  {
    model: 'Granite 4.0 H Micro Q4_K_M',
    ctx: 65536,
    ubatch: 2048,
    contextMiB: 512 + 73.79,
    computeMiB: 564.61,
    rssMiB: 2606.5,
  },
  { model: 'granite3-moe:1b', ctx: 4096, ubatch: 512, contextMiB: 192, computeMiB: 38.02, rssMiB: 1028.18 },
  {
    model: 'granite3-moe:1b',
    ctx: 4096,
    ubatch: 2048,
    contextMiB: 192,
    computeMiB: 152.07,
    rssMiB: 1028.23,
    numBatch: 2048,
  },
];

const measuredMiB = (load: Load) => HF[load.model].weightsMiB + load.contextMiB + load.computeMiB;

function ollamaPlan(load: Load, arch: ModelArch = ModelArchSchema.parse(HF[load.model].arch)) {
  return estimateFit({
    model: { arch, weightsBytes: HF[load.model].fileBytes },
    hardware: machine('cpu', 64),
    mode: 'chat',
    runtime: { kind: 'ollama', slots: 1, draftMax: 0, ubatch: load.numBatch },
    context: load.ctx,
  }).requested!;
}

describe('estimator against Hugging Face builds on Ollama 0.40.11', () => {
  it.each(LOADS)('$model at $ctx: passes the ubatch Ollama chose', load => {
    expect(ollamaPlan(load).ubatch).toBe(load.ubatch);
  });

  it.each(LOADS)('$model at $ctx: KV and recurrent state match the log', load => {
    const { memory } = ollamaPlan(load);
    expect((memory.kvBytes + memory.recurrentBytes) / MIB).toBeCloseTo(load.contextMiB, 1);
  });

  it.each(LOADS)('$model at $ctx: compute is at or above the buffer and within 15%', load => {
    const { computeBytes } = ollamaPlan(load).memory;
    expect(computeBytes).toBeGreaterThanOrEqual(load.computeMiB * MIB);
    expect(computeBytes).toBeLessThanOrEqual(load.computeMiB * MIB * 1.15);
  });

  it.each(LOADS)('$model at $ctx: total is at or above the load and within 3%, and above the runner RSS', load => {
    const { totalBytes, marginBytes } = ollamaPlan(load).memory;
    expect(totalBytes).toBeGreaterThanOrEqual(measuredMiB(load) * MIB);
    expect(totalBytes).toBeLessThanOrEqual(measuredMiB(load) * MIB * 1.03);
    expect(totalBytes + marginBytes).toBeGreaterThan(load.rssMiB * MIB);
  });

  it.each(LOADS)(
    '$model at $ctx: without the activation widths, compute stays a bound and the total within 25%',
    load => {
      const { embeddingLength: _e, activeFeedForwardLength: _f, ...rest } = HF[load.model].arch;
      const { memory } = ollamaPlan(load, ModelArchSchema.parse(rest));
      expect(memory.computeBytes).toBeGreaterThanOrEqual(load.computeMiB * MIB);
      expect(memory.totalBytes).toBeLessThanOrEqual(measuredMiB(load) * MIB * 1.25);
    }
  );

  it('follows the ubatch rule in server/sched.go, counting every slot', () => {
    const contexts = [2048, 4096, 4097, 6144, 32768, 32769, 40960, 65536, 262144];
    expect(contexts.map(c => ollamaUbatch(c))).toEqual([512, 512, 1024, 1024, 1024, 2048, 2048, 2048, 2048]);
    expect(ollamaUbatch(4096, 2)).toBe(1024);
    expect(ollamaUbatch(16384, 4)).toBe(2048);
  });
});

// llama-server b11889 -fa off -np 1 -ub 512: compute buffer MiB, beside the flash-attention rows above.
const FA_OFF: Array<{ model: ModelName; heads: number; ctx: number; computeMiB: number; faOnMiB: number }> = [
  { model: 'qwen2.5:0.5b', heads: 14, ctx: 4096, computeMiB: 131.01, faOnMiB: 41.27 },
  { model: 'qwen2.5:0.5b', heads: 14, ctx: 16384, computeMiB: 491.01, faOnMiB: 53.27 },
  { model: 'qwen2.5:0.5b', heads: 14, ctx: 32768, computeMiB: 971.01, faOnMiB: 69.27 },
  { model: 'gemma3:270m', heads: 4, ctx: 4096, computeMiB: 54.27, faOnMiB: 23.28 },
  { model: 'gemma3:270m', heads: 4, ctx: 32768, computeMiB: 334.27, faOnMiB: 51.28 },
  { model: 'qwen3.5:0.8b', heads: 8, ctx: 4096, computeMiB: 96.02, faOnMiB: 39.02 },
  { model: 'qwen3.5:0.8b', heads: 8, ctx: 32768, computeMiB: 600.02, faOnMiB: 67.02 },
];

describe('flash attention off on llama-server b11889', () => {
  const offBytes = (row: (typeof FA_OFF)[number]) =>
    estimateFit({
      model: { arch: { ...archOf(row.model), headCount: row.heads }, weightsBytes: MODELS[row.model].fileBytes },
      hardware: machine('cpu', 64),
      mode: 'chat',
      runtime: { kind: 'llama-server', flashAttn: 'off' },
      context: row.ctx,
    }).requested!.memory.computeBytes;

  it.each(FA_OFF)('$model at $ctx: the KQ term covers what turning flash attention off added', row => {
    expect(offBytes(row)).toBeGreaterThan(row.computeMiB * MIB);
    expect(flashAttnOffBytes(row.ctx, 512, row.heads)).toBeGreaterThan((row.computeMiB - row.faOnMiB) * MIB);
  });

  it.each(['qwen2.5:0.5b', 'gemma3:270m', 'qwen3.5:0.8b'] as const)('%s: grows with context exactly as measured', m => {
    const rows = FA_OFF.filter(r => r.model === m);
    const [first, last] = [rows[0], rows[rows.length - 1]];
    expect((offBytes(last) - offBytes(first)) / MIB).toBeCloseTo(last.computeMiB - first.computeMiB, 2);
  });
});

describe('cache layout variants measured on llama-server b11889', () => {
  const gemma = archOf('gemma3:270m');
  const f16 = { k: 'f16', v: 'f16' } as const;

  it('sizes the SWA window from ubatch: -ub 2048 at 16384 allocates 85.5 MiB', () => {
    expect(kvCacheBytes(gemma, 16384, f16, 1, 2048)).toBe(85.5 * MIB);
  });

  it('keeps one SWA window per slot: -np 2 at 8192 per slot allocates 78 MiB', () => {
    expect(kvCacheBytes(gemma, 8192, f16, 2)).toBe(78 * MIB);
  });

  it('prices q8_0 at 1.0625 bytes per element: qwen3.5:0.8b at 32768 allocates 204 MiB', () => {
    expect(kvCacheBytes(archOf('qwen3.5:0.8b'), 32768, { k: 'q8_0', v: 'q8_0' })).toBe(204 * MIB);
  });

  it('gives each slot its own recurrent state: granite4:350m-h -np 2 allocates 43.15 MiB', () => {
    const plan = estimateFit({
      model: { arch: archOf('granite4:350m-h'), weightsBytes: MODELS['granite4:350m-h'].fileBytes },
      hardware: machine('cpu', 64),
      mode: 'chat',
      runtime: { kind: 'llama-server', slots: 2 },
    });
    expect(plan.memory.recurrentBytes / MIB).toBeCloseTo(43.15, 2);
  });
});
