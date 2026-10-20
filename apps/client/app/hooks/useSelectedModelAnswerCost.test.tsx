import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ModelInfo } from '@bike4mind/common';

const { state } = vi.hoisted(() => ({ state: { selected: 'sonnet', models: undefined as unknown[] | undefined } }));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: { model: string }) => unknown) => selector({ model: state.selected }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: state.models }) }));

import { useSelectedModelAnswerCost } from './useSelectedModelAnswerCost';
import { typicalAnswerCredits } from '@client/app/utils/creditEstimate';

const model = (id: string, name: string, input: number, output: number) =>
  ({
    id,
    name,
    type: 'text',
    backend: 'bedrock',
    pricing: { 1_000_000: { input: input / 1_000_000, output: output / 1_000_000 } },
  }) as unknown as ModelInfo;

const SONNET = model('sonnet', 'Sonnet', 2, 10);
const MINI = model('mini', 'Mini', 0.75, 4.5);

describe('useSelectedModelAnswerCost', () => {
  beforeEach(() => {
    state.selected = 'sonnet';
    state.models = [SONNET, MINI];
  });

  it("prices the user's selected model", () => {
    const { result } = renderHook(() => useSelectedModelAnswerCost());
    expect(result.current).toEqual({ modelName: 'Sonnet', creditsPerAnswer: typicalAnswerCredits(SONNET) });
  });

  it('follows the selection to another model', () => {
    const { result, rerender } = renderHook(() => useSelectedModelAnswerCost());
    expect(result.current?.modelName).toBe('Sonnet');
    state.selected = 'mini';
    rerender();
    expect(result.current?.modelName).toBe('Mini');
    expect(result.current?.creditsPerAnswer).toBeLessThan(typicalAnswerCredits(SONNET)!);
  });

  it('recomputes when the catalog loads and its pricing changes', () => {
    state.models = undefined;
    const { result, rerender } = renderHook(() => useSelectedModelAnswerCost());
    expect(result.current).toBeNull();

    state.models = [SONNET];
    rerender();
    expect(result.current?.creditsPerAnswer).toBe(typicalAnswerCredits(SONNET));

    const repriced = model('sonnet', 'Sonnet', 4, 20);
    state.models = [repriced];
    rerender();
    expect(result.current?.creditsPerAnswer).toBe(typicalAnswerCredits(repriced));

    state.models = [];
    rerender();
    expect(result.current).toBeNull();
  });

  it.each([
    ['image', { ...SONNET, type: 'image' }],
    ['unpriced', { ...SONNET, pricing: undefined }],
    ['free', model('sonnet', 'Free', 0, 0)],
  ])('hides the estimate for a %s model and restores it for a text model', (_label, selected) => {
    const { result, rerender } = renderHook(() => useSelectedModelAnswerCost());
    expect(result.current).not.toBeNull();

    state.models = [selected];
    rerender();
    expect(result.current).toBeNull();

    state.models = [SONNET];
    rerender();
    expect(result.current?.modelName).toBe('Sonnet');
  });

  it('is null while the catalog loads or when the selected model is not in it', () => {
    state.models = undefined;
    expect(renderHook(() => useSelectedModelAnswerCost()).result.current).toBeNull();
    state.models = [SONNET];
    state.selected = 'gone';
    expect(renderHook(() => useSelectedModelAnswerCost()).result.current).toBeNull();
  });
});
