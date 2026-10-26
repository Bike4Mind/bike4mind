import { describe, it, expect } from 'vitest';
import { ModelArchSchema } from '../schemas/modelHub';
import { machine } from './__fixtures__/hubManifest';
import { estimateFit, flashAttnOffBytes, kvCacheBytes, type FitRuntime } from './fit';

// Measured on Linux x64, CPU only: llama-server b11889 (-np 1, -ub 512, f16 KV, flash attention auto = on) load
// logs, llama-fit-params b11889 breakdowns, and Ollama 0.40.11 (which runs its bundled llama-server) /api/ps and
// load breakdowns. Models are the Ollama library blobs. MiB as the runtimes print them.

const MIB = 1024 ** 2;

const MODELS = {
  'qwen2.5:0.5b': {
    fileBytes: 397_807_936,
    bufferMiB: 373.71,
    arch: { contextMax: 32768, blockCount: 24, full: { layers: 24, kvHeads: 2, keyLength: 64, valueLength: 64 } },
  },
  'gemma3:270m': {
    fileBytes: 291_545_472,
    bufferMiB: 271.81,
    arch: {
      contextMax: 32768,
      blockCount: 18,
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
      full: { layers: 4, kvHeads: 4, keyLength: 64, valueLength: 64 },
      recurrent: { layers: 28, stateBytesPerSeq: 22_622_208 },
    },
  },
  'qwen3.5:0.8b': {
    fileBytes: 811_843_520,
    bufferMiB: 763.78,
    arch: {
      contextMax: 262144,
      blockCount: 24,
      full: { layers: 6, kvHeads: 2, keyLength: 256, valueLength: 256 },
      recurrent: { layers: 18, stateBytesPerSeq: 20_201_472 },
    },
  },
} as const;
type ModelName = keyof typeof MODELS;

interface Row {
  model: ModelName;
  ctx: number;
  ls: { kvMiB: number; recurrentMiB: number; computeMiB: number; totalMiB: number };
  fitParamsComputeMiB: number;
  ollama: { psBytes: number; ubatch: number; contextMiB: number };
}

const ROWS: Row[] = [
  {
    model: 'qwen2.5:0.5b',
    ctx: 4096,
    ls: { kvMiB: 48, recurrentMiB: 0, computeMiB: 41.27, totalMiB: 463.56 },
    fitParamsComputeMiB: 309,
    ollama: { psBytes: 486_067_403, ubatch: 512, contextMiB: 48 },
  },
  {
    model: 'qwen2.5:0.5b',
    ctx: 16384,
    ls: { kvMiB: 192, recurrentMiB: 0, computeMiB: 53.27, totalMiB: 619.56 },
    fitParamsComputeMiB: 323,
    ollama: { psBytes: 705_502_903, ubatch: 1024, contextMiB: 192 },
  },
  {
    model: 'qwen2.5:0.5b',
    ctx: 32768,
    ls: { kvMiB: 384, recurrentMiB: 0, computeMiB: 69.27, totalMiB: 827.56 },
    fitParamsComputeMiB: 337,
    ollama: { psBytes: 940_383_927, ubatch: 1024, contextMiB: 384 },
  },
  {
    model: 'gemma3:270m',
    ctx: 4096,
    ls: { kvMiB: 27, recurrentMiB: 0, computeMiB: 23.28, totalMiB: 323.09 },
    fitParamsComputeMiB: 524,
    ollama: { psBytes: 326_201_507, ubatch: 512, contextMiB: 27 },
  },
  {
    model: 'gemma3:270m',
    ctx: 16384,
    ls: { kvMiB: 63, recurrentMiB: 0, computeMiB: 35.28, totalMiB: 371.09 },
    fitParamsComputeMiB: 535,
    ollama: { psBytes: 384_680_590, ubatch: 1024, contextMiB: 70 },
  },
  {
    model: 'gemma3:270m',
    ctx: 32768,
    ls: { kvMiB: 111, recurrentMiB: 0, computeMiB: 51.28, totalMiB: 435.09 },
    fitParamsComputeMiB: 551,
    ollama: { psBytes: 418_235_022, ubatch: 1024, contextMiB: 118 },
  },
  {
    model: 'granite4:350m-h',
    ctx: 4096,
    ls: { kvMiB: 16, recurrentMiB: 21.57, computeMiB: 28.88, totalMiB: 412.66 },
    fitParamsComputeMiB: 207,
    ollama: { psBytes: 432_705_370, ubatch: 512, contextMiB: 37 },
  },
  {
    model: 'granite4:350m-h',
    ctx: 32768,
    ls: { kvMiB: 128, recurrentMiB: 21.57, computeMiB: 56.88, totalMiB: 552.66 },
    fitParamsComputeMiB: 235,
    ollama: { psBytes: 638_362_581, ubatch: 1024, contextMiB: 149 },
  },
  {
    model: 'granite4:350m-h',
    ctx: 131072,
    ls: { kvMiB: 512, recurrentMiB: 21.57, computeMiB: 152.88, totalMiB: 1032.66 },
    fitParamsComputeMiB: 331,
    ollama: { psBytes: 1_561_340_148, ubatch: 2048, contextMiB: 533 },
  },
  // Ollama loads this library model with its MTP draft (--spec-draft-n-max 2), which keeps two extra recurrent
  // snapshots; its /api/ps size (below the weights alone) does not count the draft and projector runners.
  {
    model: 'qwen3.5:0.8b',
    ctx: 4096,
    ls: { kvMiB: 48, recurrentMiB: 19.27, computeMiB: 39.02, totalMiB: 871.02 },
    fitParamsComputeMiB: 501,
    ollama: { psBytes: 574_074_386, ubatch: 512, contextMiB: 105 },
  },
  {
    model: 'qwen3.5:0.8b',
    ctx: 32768,
    ls: { kvMiB: 384, recurrentMiB: 19.27, computeMiB: 67.02, totalMiB: 1235.02 },
    fitParamsComputeMiB: 527,
    ollama: { psBytes: 731_392_243, ubatch: 1024, contextMiB: 441 },
  },
  {
    model: 'qwen3.5:0.8b',
    ctx: 131072,
    ls: { kvMiB: 1536, recurrentMiB: 19.27, computeMiB: 163.02, totalMiB: 2483.02 },
    fitParamsComputeMiB: 623,
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

  // The 1 GiB per 512-token ubatch is sized for large models; on these small ones it overshoots. Both measured
  // compute figures (runtime allocation and fit-params worst case with full-ubatch logits) must stay under it.
  it.each(ROWS)('$model at $ctx: compute and total stay conservative', row => {
    const { memory } = estimate(row, { kind: 'llama-server' });
    expect(memory.computeBytes).toBeGreaterThan(Math.max(row.ls.computeMiB, row.fitParamsComputeMiB) * MIB);
    expect(memory.totalBytes).toBeGreaterThan(row.ls.totalMiB * MIB);
  });
});

describe('estimator against Ollama 0.40.11', () => {
  it.each(ROWS)('$model at $ctx: picks the ubatch Ollama passed and matches its context breakdown', row => {
    const plan = estimate(row, { kind: 'ollama', draftMax: OLLAMA_DRAFT_MAX[row.model] });
    expect(plan.ubatch).toBe(row.ollama.ubatch);
    // The breakdown prints whole MiB, truncated.
    expect(Math.floor((plan.memory.kvBytes + plan.memory.recurrentBytes) / MIB)).toBe(row.ollama.contextMiB);
  });

  it.each(ROWS)('$model at $ctx: total stays above /api/ps size', row => {
    expect(estimate(row, { kind: 'ollama' }).memory.totalBytes).toBeGreaterThan(row.ollama.psBytes);
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
