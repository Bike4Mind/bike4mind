import { describe, expect, it } from 'vitest';
import {
  buildAggregatorKeyIndex,
  measureJoinCoverage,
  normalizeLiteLlmKey,
  normalizeModelsDevKey,
  resolveAggregatorKey,
  type ModelIdAliasMap,
} from './modelIdJoin';

/**
 * Real key subsets captured from models.dev/api.json and the pinned LiteLLM
 * release on 2026-07-26, trimmed to the cases the table below exercises plus
 * the siblings that make collisions real: `claude-opus-4-5` next to its dated
 * twin, `gpt-4.1-mini` next to `gpt-4.1`, and the gateway-resold spellings that
 * must never outrank a direct key.
 */
const MODELS_DEV_KEYS = [
  'claude-fable-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-opus-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'deepseek.v3-v1:0',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3-pro-preview',
  'gemini-3.1-flash-image',
  'global.anthropic.claude-opus-4-6-v1',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-sonnet-5',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5',
  'gpt-5.4-mini',
  'gpt-image-1.5',
  'grok-4.3',
  'grok-4.5',
  'grok-imagine-image-quality',
  'jp.anthropic.claude-opus-4-8',
  'o3',
  'o3-mini',
  'o4-mini',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-opus-4-1-20250805-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'us.deepseek.r1-v1:0',
  'us.meta.llama4-maverick-17b-instruct-v1:0',
  'us.meta.llama4-scout-17b-instruct-v1:0',
];

const LITELLM_KEYS = [
  'ai21.j2-mid-v1',
  'anthropic.claude-opus-4-6-v1',
  'azure_ai/gpt-5.4-mini',
  'black_forest_labs/flux-kontext-max',
  'black_forest_labs/flux-pro',
  'black_forest_labs/flux-pro-1.1',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-6',
  'deepseek.v3-v1:0',
  'gemini-2.5-pro',
  'gemini-3-pro-preview',
  'gemini-3.1-flash-image',
  'gemini/gemini-2.5-pro',
  'global.anthropic.claude-opus-4-6-v1',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-sonnet-5',
  'gpt-4.1-2025-04-14',
  'gpt-4.1-nano-2025-04-14',
  'gpt-5',
  'gpt-5.4-mini',
  'gpt-image-1.5',
  'meta.llama3-70b-instruct-v1:0',
  'o3-2025-04-16',
  'o4-mini-2025-04-16',
  'openrouter/openai/gpt-5',
  'sora-2',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-opus-4-1-20250805-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'us.deepseek.r1-v1:0',
  'us.meta.llama4-maverick-17b-instruct-v1:0',
  'us.meta.llama4-scout-17b-instruct-v1:0',
  'vercel_ai_gateway/xai/grok-4.5',
  'whisper-1',
  'xai/grok-3-fast-latest',
  'xai/grok-4-0709',
  'xai/grok-4.5',
];

const modelsDev = buildAggregatorKeyIndex(MODELS_DEV_KEYS, 'modelsDev');
const litellm = buildAggregatorKeyIndex(LITELLM_KEYS, 'litellm');

/** Our id -> the key each aggregator publishes for it, or null when it publishes none. */
const JOIN_TABLE: ReadonlyArray<{ id: string; modelsDev: string | null; litellm: string | null }> = [
  // Direct Anthropic, undated and dated.
  { id: 'claude-opus-5', modelsDev: 'claude-opus-5', litellm: null },
  { id: 'claude-opus-4-5-20251101', modelsDev: 'claude-opus-4-5-20251101', litellm: 'claude-opus-4-5-20251101' },
  { id: 'claude-sonnet-4-6', modelsDev: 'claude-sonnet-4-6', litellm: 'claude-sonnet-4-6' },
  { id: 'claude-haiku-4-5-20251001', modelsDev: 'claude-haiku-4-5-20251001', litellm: 'claude-haiku-4-5-20251001' },
  { id: 'claude-fable-5', modelsDev: 'claude-fable-5', litellm: 'claude-fable-5' },

  // Bedrock: us./global. prefixes, -v1:0 and bare -v1 suffixes.
  {
    id: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
    modelsDev: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
    litellm: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  },
  {
    id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    modelsDev: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    litellm: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
  {
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    modelsDev: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    litellm: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  },
  {
    id: 'global.anthropic.claude-opus-4-8',
    modelsDev: 'global.anthropic.claude-opus-4-8',
    litellm: 'global.anthropic.claude-opus-4-8',
  },
  {
    id: 'global.anthropic.claude-opus-4-6-v1',
    modelsDev: 'global.anthropic.claude-opus-4-6-v1',
    litellm: 'global.anthropic.claude-opus-4-6-v1',
  },
  {
    id: 'global.anthropic.claude-sonnet-5',
    modelsDev: 'global.anthropic.claude-sonnet-5',
    litellm: 'global.anthropic.claude-sonnet-5',
  },
  { id: 'us.deepseek.r1-v1:0', modelsDev: 'us.deepseek.r1-v1:0', litellm: 'us.deepseek.r1-v1:0' },
  { id: 'deepseek.v3-v1:0', modelsDev: 'deepseek.v3-v1:0', litellm: 'deepseek.v3-v1:0' },
  {
    id: 'us.meta.llama4-scout-17b-instruct-v1:0',
    modelsDev: 'us.meta.llama4-scout-17b-instruct-v1:0',
    litellm: 'us.meta.llama4-scout-17b-instruct-v1:0',
  },
  {
    id: 'us.meta.llama4-maverick-17b-instruct-v1:0',
    modelsDev: 'us.meta.llama4-maverick-17b-instruct-v1:0',
    litellm: 'us.meta.llama4-maverick-17b-instruct-v1:0',
  },
  { id: 'meta.llama3-70b-instruct-v1:0', modelsDev: null, litellm: 'meta.llama3-70b-instruct-v1:0' },
  { id: 'ai21.j2-mid-v1', modelsDev: null, litellm: 'ai21.j2-mid-v1' },

  // OpenAI: dashed ISO dates that models.dev drops and litellm keeps.
  { id: 'gpt-5', modelsDev: 'gpt-5', litellm: 'gpt-5' },
  { id: 'gpt-5.4-mini', modelsDev: 'gpt-5.4-mini', litellm: 'gpt-5.4-mini' },
  { id: 'gpt-4.1-2025-04-14', modelsDev: 'gpt-4.1', litellm: 'gpt-4.1-2025-04-14' },
  { id: 'gpt-4.1-nano-2025-04-14', modelsDev: 'gpt-4.1-nano', litellm: 'gpt-4.1-nano-2025-04-14' },
  { id: 'gpt-image-1.5', modelsDev: 'gpt-image-1.5', litellm: 'gpt-image-1.5' },
  { id: 'o3-2025-04-16', modelsDev: 'o3', litellm: 'o3-2025-04-16' },
  { id: 'o4-mini-2025-04-16', modelsDev: 'o4-mini', litellm: 'o4-mini-2025-04-16' },
  { id: 'sora-2', modelsDev: null, litellm: 'sora-2' },
  { id: 'whisper-1', modelsDev: null, litellm: 'whisper-1' },

  // Gemini.
  { id: 'gemini-2.5-pro', modelsDev: 'gemini-2.5-pro', litellm: 'gemini-2.5-pro' },
  { id: 'gemini-3-pro-preview', modelsDev: 'gemini-3-pro-preview', litellm: 'gemini-3-pro-preview' },
  { id: 'gemini-3.1-flash-image', modelsDev: 'gemini-3.1-flash-image', litellm: 'gemini-3.1-flash-image' },
  { id: 'gemini-2.5-flash-preview-09-25', modelsDev: null, litellm: null },
  { id: 'gemini-1.5-pro', modelsDev: null, litellm: null },

  // xAI: litellm publishes provider-qualified, models.dev bare.
  { id: 'grok-4.5', modelsDev: 'grok-4.5', litellm: 'xai/grok-4.5' },
  { id: 'grok-4-0709', modelsDev: null, litellm: 'xai/grok-4-0709' },
  { id: 'grok-imagine-image-quality', modelsDev: 'grok-imagine-image-quality', litellm: null },
  { id: 'grok-3-fast', modelsDev: null, litellm: null },

  // BFL is first-party in litellm only; models.dev carries FLUX under resellers.
  { id: 'flux-pro-1.1', modelsDev: null, litellm: 'black_forest_labs/flux-pro-1.1' },
  { id: 'flux-kontext-max', modelsDev: null, litellm: 'black_forest_labs/flux-kontext-max' },
  { id: 'flux-pro', modelsDev: null, litellm: 'black_forest_labs/flux-pro' },

  // AWS Transcribe exists in no aggregator.
  { id: 'transcribe', modelsDev: null, litellm: null },
];

describe('modelIdJoin normalizers', () => {
  it.each(JOIN_TABLE)('resolves $id', ({ id, modelsDev: expectedModelsDev, litellm: expectedLitellm }) => {
    expect(resolveAggregatorKey(id, modelsDev)?.key ?? null).toBe(expectedModelsDev);
    expect(resolveAggregatorKey(id, litellm)?.key ?? null).toBe(expectedLitellm);
  });

  it('covers every namespace the catalog uses', () => {
    expect(JOIN_TABLE.length).toBeGreaterThanOrEqual(30);
  });

  it('applies the fixed step order', () => {
    expect(normalizeModelsDevKey('US.Anthropic.Claude-Opus-4-5-20251101-v1:0')).toBe('anthropic.claude-opus-4-5');
    expect(normalizeLiteLlmKey('bedrock/eu.anthropic.claude-opus-4-6-v1')).toBe('anthropic.claude-opus-4-6');
    expect(normalizeLiteLlmKey('openai/gpt-4.1-2025-04-14')).toBe('gpt-4.1');
    expect(normalizeLiteLlmKey('anthropic/claude-3-7-sonnet-20250219')).toBe('claude-3-7-sonnet');
  });

  it('leaves a gateway prefix in place so a resold key never outranks a direct one', () => {
    expect(normalizeLiteLlmKey('azure_ai/gpt-5.4-mini')).toBe('azure_ai/gpt-5.4-mini');
    expect(normalizeLiteLlmKey('openrouter/openai/gpt-5')).toBe('openrouter/openai/gpt-5');
    expect(resolveAggregatorKey('gpt-5', litellm)).toEqual({ key: 'gpt-5', how: 'exact' });
    expect(resolveAggregatorKey('gpt-5.4-mini', litellm)).toEqual({ key: 'gpt-5.4-mini', how: 'exact' });
  });

  it('leaves an unlisted region prefix alone rather than guessing', () => {
    expect(normalizeModelsDevKey('jp.anthropic.claude-opus-4-8')).toBe('jp.anthropic.claude-opus-4-8');
  });

  it('breaks a normalized collision on the shortest key, deterministically', () => {
    const forward = buildAggregatorKeyIndex(['claude-opus-4-5-20251101', 'claude-opus-4-5'], 'modelsDev');
    const reversed = buildAggregatorKeyIndex(['claude-opus-4-5', 'claude-opus-4-5-20251101'], 'modelsDev');
    expect(forward.byNormalized.get('claude-opus-4-5')).toBe('claude-opus-4-5');
    expect(reversed.byNormalized.get('claude-opus-4-5')).toBe('claude-opus-4-5');
  });

  it('prefers an exact key over the normalized sibling it collides with', () => {
    expect(resolveAggregatorKey('claude-opus-4-5-20251101', modelsDev)).toEqual({
      key: 'claude-opus-4-5-20251101',
      how: 'exact',
    });
  });
});

describe('modelIdJoin aliases', () => {
  const aliases: ModelIdAliasMap = {
    'grok-3-fast': { litellm: 'xai/grok-3-fast-latest' },
    'gpt-5': { litellm: 'openrouter/openai/gpt-5' },
    'claude-opus-5': { modelsDev: 'claude-fable-5' },
  };

  it('beats the normalizer', () => {
    expect(resolveAggregatorKey('grok-3-fast', litellm)).toBeNull();
    expect(resolveAggregatorKey('grok-3-fast', litellm, aliases)).toEqual({
      key: 'xai/grok-3-fast-latest',
      how: 'alias',
    });
  });

  it('beats an exact match too', () => {
    expect(resolveAggregatorKey('gpt-5', litellm, aliases)).toEqual({ key: 'openrouter/openai/gpt-5', how: 'alias' });
  });

  it('beats the normalizer per aggregator, leaving the other side untouched', () => {
    expect(resolveAggregatorKey('claude-opus-5', modelsDev, aliases)).toEqual({ key: 'claude-fable-5', how: 'alias' });
    expect(resolveAggregatorKey('claude-opus-5', litellm, aliases)).toBeNull();
  });

  it('resolves a dead alias to null instead of falling through to the normalizer', () => {
    const dead: ModelIdAliasMap = { 'claude-opus-4-5-20251101': { modelsDev: 'claude-opus-4-5-retired' } };
    expect(resolveAggregatorKey('claude-opus-4-5-20251101', modelsDev, dead)).toBeNull();
  });
});

describe('measureJoinCoverage', () => {
  it('counts matches and returns the unmatched ids sorted', () => {
    const coverage = measureJoinCoverage(['gpt-5', 'transcribe', 'gemini-1.5-pro'], litellm);
    expect(coverage).toEqual({ matched: 1, total: 3, unmatched: ['gemini-1.5-pro', 'transcribe'] });
  });
});
