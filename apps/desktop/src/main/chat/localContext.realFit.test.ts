import { describe, expect, it } from 'vitest';
import { archFromModelInfo } from '@bike4mind/local-models';
import { AUTO_LOCAL_CONTEXT, LOCAL_CONTEXT_SIZES } from '@shared/localContextSetting';
import { cpuMachine, discreteMachine, lowConfidenceMachine, unifiedMachine } from './fitStub.testHelper';
import { chatContextTokens, fitsInMemory, grownContext, loadsInMemory, type LocalModelFootprint } from './localContext';

// The real estimator on shapes Ollama 0.40 reports, so these assert relations that survive its tuning.
const qwenHalfB = archFromModelInfo({
  'general.architecture': 'qwen2',
  'qwen2.attention.head_count': 14,
  'qwen2.attention.head_count_kv': 2,
  'qwen2.block_count': 24,
  'qwen2.context_length': 32768,
  'qwen2.embedding_length': 896,
});
const qwen3EightB = archFromModelInfo({
  'general.architecture': 'qwen3',
  'qwen3.attention.head_count': 32,
  'qwen3.attention.head_count_kv': 8,
  'qwen3.attention.key_length': 128,
  'qwen3.attention.value_length': 128,
  'qwen3.block_count': 36,
  'qwen3.context_length': 40960,
  'qwen3.embedding_length': 4096,
});
const halfB = (hardware: LocalModelFootprint['hardware']) => ({ arch: qwenHalfB, weightsBytes: 397_821_319, hardware });
const eightB = (hardware: LocalModelFootprint['hardware']) => ({
  arch: qwen3EightB,
  weightsBytes: 5_027_797_508,
  hardware,
});
const auto = (footprint: LocalModelFootprint) => chatContextTokens({ setting: AUTO_LOCAL_CONTEXT, footprint });

describe('local context sizing with the real fit estimate', () => {
  it('reads both shapes', () => {
    expect(qwenHalfB?.contextMax).toBe(32768);
    expect(qwen3EightB?.contextMax).toBe(40960);
  });

  it('starts every model at 16K on the CPU-only profile the probe reports today', () => {
    expect(auto(halfB(lowConfidenceMachine(62)))).toBe(16384);
    expect(auto(eightB(lowConfidenceMachine(62)))).toBe(16384);
  });

  it('starts a model that fits at its trained length, at most 32K, once the probe reports a CPU-only machine', () => {
    expect(auto(halfB(cpuMachine(62)))).toBe(32768);
    expect(auto(eightB(cpuMachine(62)))).toBe(32768);
    expect(auto(eightB(unifiedMachine(62)))).toBe(40960);
  });

  it('reads a plan that offloads layers as loading but not resident', () => {
    expect(fitsInMemory(eightB(discreteMachine(12, 32)), 40960)).toBe(false);
    expect(loadsInMemory(eightB(discreteMachine(12, 32)), 40960)).toBe(true);
  });

  it.each([8, 12])('starts at the largest candidate that stays on a %i GiB GPU, else at 16K', vram => {
    const footprint = eightB(discreteMachine(vram, 32));
    const picked = auto(footprint);
    if (fitsInMemory(footprint, picked)) {
      const larger = [40960, ...LOCAL_CONTEXT_SIZES].filter(size => size > picked && size <= 40960);
      for (const size of larger) expect(fitsInMemory(footprint, size)).toBe(false);
    } else {
      expect(picked).toBe(16384);
    }
  });

  it('grows once to a resident size that holds the prompt, and by one Settings size on the low-confidence profile', () => {
    expect(grownContext(eightB(cpuMachine(62)), 20_000, undefined, undefined, 16384)).toEqual({
      tokens: 32768,
      slower: false,
    });
    expect(grownContext(eightB(cpuMachine(62)), 33_000, undefined, undefined, 32768)).toEqual({
      tokens: 40960,
      slower: false,
    });
    expect(grownContext(eightB(lowConfidenceMachine(62)), 20_000, undefined, undefined, 16384)).toEqual({
      tokens: 32768,
      slower: false,
    });
  });
});
