import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ModelInfo } from '@bike4mind/common';

const { selectSessionModel, updateSessionToServer, toastError } = vi.hoisted(() => ({
  selectSessionModel: vi.fn(),
  updateSessionToServer: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: { getState: () => ({ selectSessionModel }) } }));
vi.mock('@client/app/utils/sessionsAPICalls', () => ({ updateSessionToServer }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { useAffordableModelOffer } from './useAffordableModelOffer';

const cheap = { id: 'cheap', name: 'Cheap', type: 'text', backend: 'openai' } as unknown as ModelInfo;

const setup = (initial: Partial<Parameters<typeof useAffordableModelOffer>[0]> = {}) =>
  renderHook(props => useAffordableModelOffer(props), {
    initialProps: {
      enforceCredits: true,
      modelsLoaded: true,
      selectedModelId: 'model-a',
      sessionId: 'session-1',
      ...initial,
    },
  });

describe('useAffordableModelOffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSessionToServer.mockResolvedValue(undefined);
  });

  it('uses a chat override and saves it on the session', () => {
    const { result } = setup();
    act(() => result.current.onSelect(cheap));
    expect(selectSessionModel).toHaveBeenCalledWith('cheap', cheap);
    expect(updateSessionToServer).toHaveBeenCalledWith({ id: 'session-1', lastUsedModel: 'cheap' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('skips the save when there is no session', () => {
    const { result } = setup({ sessionId: null });
    act(() => result.current.onSelect(cheap));
    expect(selectSessionModel).toHaveBeenCalledWith('cheap', cheap);
    expect(updateSessionToServer).not.toHaveBeenCalled();
  });

  it('dismisses per model: model A stays hidden, model B shows the offer again', () => {
    const { result, rerender } = setup();
    expect(result.current.show).toBe(true);
    act(() => result.current.onDismiss());
    expect(result.current.show).toBe(false);

    rerender({ enforceCredits: true, modelsLoaded: true, selectedModelId: 'model-b', sessionId: 'session-1' });
    expect(result.current.show).toBe(true);

    rerender({ enforceCredits: true, modelsLoaded: true, selectedModelId: 'model-a', sessionId: 'session-1' });
    expect(result.current.show).toBe(false);
  });

  it('hides the offer while credits are not enforced or models have not loaded', () => {
    expect(setup({ enforceCredits: false }).result.current.show).toBe(false);
    expect(setup({ modelsLoaded: false }).result.current.show).toBe(false);
  });

  it('toasts an error when saving the model fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    updateSessionToServer.mockRejectedValue(new Error('boom'));
    const { result } = setup();
    await act(async () => {
      result.current.onSelect(cheap);
    });
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
