import { describe, it, expect } from 'vitest';
import {
  buildModelSelectionPatch,
  computeDefaultMaxTokens,
  getModelSpeedFromStats,
  refitMaxTokensForModel,
} from '../aiSettingsUtils';
import type { ModelInfo } from '@bike4mind/common';

describe('computeDefaultMaxTokens', () => {
  it('falls back to the catalog max_tokens when contextWindow is missing/0', () => {
    // Tier logic needs a context window - without it, defer to the model author's intent.
    expect(computeDefaultMaxTokens({ contextWindow: 0, max_tokens: 16384 })).toBe(16384);
  });

  it('returns 0 when max_tokens is 0', () => {
    expect(computeDefaultMaxTokens({ contextWindow: 128000, max_tokens: 0 })).toBe(0);
  });

  it('halves the context window for small-context models (ctx ≤ 32768)', () => {
    // ctx 8192, max 4096: halve to 4096, capped by model max -> 4096
    expect(computeDefaultMaxTokens({ contextWindow: 8192, max_tokens: 4096 })).toBe(4096);
    // ctx 4096, max 4096: halve to 2048
    expect(computeDefaultMaxTokens({ contextWindow: 4096, max_tokens: 4096 })).toBe(2048);
    expect(computeDefaultMaxTokens({ contextWindow: 16000, max_tokens: 16384 })).toBe(8000);
    expect(computeDefaultMaxTokens({ contextWindow: 32768, max_tokens: 16384 })).toBe(16384);
  });

  it('gives large-context models a quarter of the window, floored at 16384', () => {
    // Just past the small tier: the quarter share (10000) is below the floor -> 16384
    expect(computeDefaultMaxTokens({ contextWindow: 40000, max_tokens: 16384 })).toBe(16384);
    // GPT-5.2 Chat Latest: ctx 128k, max 16k -> the model ceiling binds
    expect(computeDefaultMaxTokens({ contextWindow: 128000, max_tokens: 16384 })).toBe(16384);
    // ctx 200k, max 64k -> quarter share of 50000 binds
    expect(computeDefaultMaxTokens({ contextWindow: 200000, max_tokens: 64000 })).toBe(50000);
  });

  it('gives frontier models their full advertised max_tokens', () => {
    // Claude Opus/Sonnet 5: ctx 1M, max 128k - the quarter share (250k) exceeds the ceiling
    expect(computeDefaultMaxTokens({ contextWindow: 1_000_000, max_tokens: 128000 })).toBe(128000);
    // Grok 4.5: ctx 500k, max 128k -> 125000
    expect(computeDefaultMaxTokens({ contextWindow: 500000, max_tokens: 128000 })).toBe(125000);
    // GPT-5.2: ctx 400k, max 128k -> 100000 (was 16384 before this tier existed)
    expect(computeDefaultMaxTokens({ contextWindow: 400000, max_tokens: 128000 })).toBe(100000);
  });

  it('never lowers the default as the context window grows', () => {
    const windows = [4096, 8192, 16000, 32768, 40000, 128000, 200000, 400000, 1_000_000];
    const defaults = windows.map(contextWindow => computeDefaultMaxTokens({ contextWindow, max_tokens: 128000 }));
    expect(defaults).toEqual([...defaults].sort((a, b) => a - b));
  });

  it('respects model max_tokens when it is lower than the tier cap', () => {
    // ctx 200k, max 4096 -> 4096
    expect(computeDefaultMaxTokens({ contextWindow: 200000, max_tokens: 4096 })).toBe(4096);
  });

  it('floors fractional results from the halving branch', () => {
    // ctx 4097, max 4097: halve to 2048.5 -> 2048
    expect(computeDefaultMaxTokens({ contextWindow: 4097, max_tokens: 4097 })).toBe(2048);
  });
});

describe('refitMaxTokensForModel', () => {
  const frontier = { contextWindow: 1_000_000, max_tokens: 128000 };
  const small = { contextWindow: 32768, max_tokens: 16384 };

  it('raises a value left low by a weaker model', () => {
    // The regression this fixes: 16384 carried over from a 16k-output model stuck forever.
    expect(refitMaxTokensForModel(16384, frontier)).toBe(128000);
  });

  it('lowers a value carried over from a bigger model', () => {
    expect(refitMaxTokensForModel(128000, small)).toBe(16384);
  });

  it('leaves a value that already sits between the default and the ceiling', () => {
    // User raised it above the default but within what the model advertises - keep it.
    expect(refitMaxTokensForModel(64000, { contextWindow: 200000, max_tokens: 64000 })).toBe(64000);
  });

  it('replaces an unset value with the default', () => {
    expect(refitMaxTokensForModel(0, frontier)).toBe(128000);
    expect(refitMaxTokensForModel(0, frontier, { allowRaise: false })).toBe(128000);
  });

  it('leaves the value alone when the model advertises no ceiling', () => {
    expect(refitMaxTokensForModel(8192, { contextWindow: 128000, max_tokens: 0 })).toBe(8192);
  });

  describe('allowRaise: false (same model - mount, reload, catalog refetch)', () => {
    it('keeps a deliberately-lowered value instead of resetting it to the default', () => {
      expect(refitMaxTokensForModel(2048, frontier, { allowRaise: false })).toBe(2048);
    });

    it('still lowers a value the model cannot accept', () => {
      expect(refitMaxTokensForModel(128000, small, { allowRaise: false })).toBe(16384);
    });
  });
});

describe('buildModelSelectionPatch', () => {
  // Only the fields the patch reads; the rest of ModelInfo is irrelevant here.
  const model = (over: Partial<ModelInfo>): ModelInfo =>
    ({ id: 'gpt-4o', type: 'text', contextWindow: 128000, max_tokens: 16384, ...over }) as ModelInfo;

  it('records a text model in the text slot', () => {
    const patch = buildModelSelectionPatch(model({ id: 'gpt-4o', type: 'text' }));
    expect(patch).toMatchObject({ model: 'gpt-4o', lastUsedTextModel: 'gpt-4o' });
    expect(patch).not.toHaveProperty('lastUsedImageModel');
  });

  it('records an image model in the image slot', () => {
    const patch = buildModelSelectionPatch(model({ id: 'gpt-image-1', type: 'image' }));
    expect(patch).toMatchObject({ model: 'gpt-image-1', lastUsedImageModel: 'gpt-image-1' });
    expect(patch).not.toHaveProperty('lastUsedTextModel');
  });

  it.each(['video', 'speech-to-text'] as const)('files a %s model under the text slot, as before', type => {
    // Matches the isImageModel() name-list behavior this replaced: only image models get the
    // image slot, everything else shares the text one.
    const patch = buildModelSelectionPatch(model({ id: 'sora', type }));
    expect(patch).toMatchObject({ lastUsedTextModel: 'sora' });
    expect(patch).not.toHaveProperty('lastUsedImageModel');
  });

  it('resets max_tokens to the new model default', () => {
    expect(buildModelSelectionPatch(model({ contextWindow: 32768, max_tokens: 16384 }))).toMatchObject({
      max_tokens: 16384,
    });
  });
});

describe('getModelSpeedFromStats', () => {
  it('returns null when there are no stats, or none for this model', () => {
    expect(getModelSpeedFromStats('gpt-5', {})).toBeNull();
    expect(getModelSpeedFromStats('gpt-5', undefined as unknown as Record<string, number>)).toBeNull();
    expect(getModelSpeedFromStats('gpt-5', { 'claude-opus-4-5': 1000 })).toBeNull();
  });

  it('buckets the model average against the tooltip thresholds', () => {
    expect(getModelSpeedFromStats('m', { m: 6999 })).toBe('fast');
    expect(getModelSpeedFromStats('m', { m: 7000 })).toBe('medium');
    expect(getModelSpeedFromStats('m', { m: 14999 })).toBe('medium');
    expect(getModelSpeedFromStats('m', { m: 15000 })).toBe('slow');
  });
});
