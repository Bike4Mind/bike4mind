import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTokenLimits } from '../useTokenLimits';

const MODEL_GPT5_2_CHAT = { id: 'gpt-5.2-chat-latest', contextWindow: 128_000, max_tokens: 16_384 };
const MODEL_GPT5_2 = { id: 'gpt-5.2', contextWindow: 400_000, max_tokens: 128_000 };
const MODEL_SMALL = { id: 'tiny', contextWindow: 4_096, max_tokens: 4_096 };
const MODEL_INFO = [MODEL_GPT5_2_CHAT, MODEL_GPT5_2, MODEL_SMALL];

describe('useTokenLimits', () => {
  it('returns sane budget for GPT-5.2 Chat Latest with default max_tokens', () => {
    const { result } = renderHook(() =>
      useTokenLimits({
        model: 'gpt-5.2-chat-latest',
        modelInfo: MODEL_INFO,
        max_tokens: 16384,
        chatInputLength: 100,
      })
    );
    expect(result.current.contextWindowLimit).toBe(128_000);
    expect(result.current.effectiveMaxOutputTokens).toBe(16_384);
    expect(result.current.maxInputTokens).toBe(128_000 - 16_384);
    expect(result.current.isOverContextWindow).toBe(false);
  });

  it('clamps stale max_tokens that exceeds the new model catalog max', () => {
    // The exact bug scenario: state.max_tokens = 128_000 (from previous GPT-5.2)
    // but new model is GPT-5.2 Chat Latest (catalog max = 16_384).
    const { result } = renderHook(() =>
      useTokenLimits({
        model: 'gpt-5.2-chat-latest',
        modelInfo: MODEL_INFO,
        max_tokens: 128_000,
        chatInputLength: 93,
      })
    );
    // Defensive cap kicks in: output cannot exceed catalog max
    expect(result.current.effectiveMaxOutputTokens).toBeLessThanOrEqual(16_384);
    // And input budget must be positive so the user can keep typing
    expect(result.current.maxInputTokens).toBeGreaterThan(0);
    expect(result.current.isOverContextWindow).toBe(false);
  });

  it('falls back to a non-zero input budget when stale max_tokens meets/exceeds contextWindow', () => {
    // Hypothetical: a model with no catalog max (0) and stale max_tokens >= contextWindow.
    // Without the safety net this would yield maxInputTokens = 0 and trip isOverContextWindow.
    const modelInfo = [{ id: 'rogue', contextWindow: 8_000, max_tokens: 0 }];
    const { result } = renderHook(() =>
      useTokenLimits({
        model: 'rogue',
        modelInfo,
        max_tokens: 8_000,
        chatInputLength: 50,
      })
    );
    expect(result.current.maxInputTokens).toBeGreaterThan(0);
    expect(result.current.isOverContextWindow).toBe(false);
  });

  it('does not trip the over-limit signal while modelInfo is still loading', () => {
    const { result } = renderHook(() =>
      useTokenLimits({
        model: 'gpt-5.2-chat-latest',
        modelInfo: undefined,
        max_tokens: 128_000,
        chatInputLength: 93,
      })
    );
    expect(result.current.contextWindowLimit).toBe(0);
    expect(result.current.maxInputTokens).toBe(0);
    // Even though length > maxInputTokens, the signal is suppressed until contextWindowLimit > 0
    expect(result.current.isOverContextWindow).toBe(false);
  });

  // A discovery run can overwrite a seeded media row's contextWindow with the literal 0, meaning
  // "not applicable" to the feed, not a real zero-token budget (see safeInputWindow in
  // @bike4mind/utils). Before this fix, maxInputTokens landed at 0 and validateChatInput blocked
  // every send with a misleading "No AI model selected" - even though a model WAS selected.
  it('falls back to a usable input budget for a media model whose contextWindow arrives as 0', () => {
    const modelInfo = [{ id: 'flux-pro-1.1', type: 'image', contextWindow: 0, max_tokens: 10_000 }];
    const { result } = renderHook(() =>
      useTokenLimits({
        model: 'flux-pro-1.1',
        modelInfo,
        max_tokens: undefined,
        chatInputLength: 50,
      })
    );
    expect(result.current.maxInputTokens).toBeGreaterThan(0);
    expect(result.current.isOverContextWindow).toBe(false);
  });

  it('still reports a zero input budget for a TEXT model whose contextWindow arrives as 0', () => {
    // Text rows keep 0 literal: this hook's "still loading" suppression (contextWindowLimit > 0)
    // is what the caller relies on to avoid a false over-limit flash, and a media-only fallback
    // must not weaken that for a genuinely misconfigured text row.
    const modelInfo = [{ id: 'broken-text', type: 'text', contextWindow: 0, max_tokens: 4_096 }];
    const { result } = renderHook(() =>
      useTokenLimits({
        model: 'broken-text',
        modelInfo,
        max_tokens: undefined,
        chatInputLength: 50,
      })
    );
    expect(result.current.contextWindowLimit).toBe(0);
    expect(result.current.maxInputTokens).toBe(0);
  });

  it('flips isOverContextWindow when input genuinely exceeds the available budget', () => {
    const { result } = renderHook(() =>
      useTokenLimits({
        model: 'tiny',
        modelInfo: MODEL_INFO,
        max_tokens: 1_000,
        chatInputLength: 5_000,
      })
    );
    // ctx 4_096 - max 1_000 = 3_096 input budget; length 5_000 exceeds it
    expect(result.current.maxInputTokens).toBe(3_096);
    expect(result.current.isOverContextWindow).toBe(true);
  });
});
