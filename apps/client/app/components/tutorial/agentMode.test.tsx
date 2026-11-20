import { act, renderHook } from '@testing-library/react';
import { create } from 'zustand';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLLM = vi.hoisted(() => ({
  store: null as unknown as { getState: () => { disableAutoRouteForThisSession: boolean } },
}));
vi.mock('@client/app/contexts/LLMContext', () => {
  const useLLM = create(() => ({ disableAutoRouteForThisSession: false }));
  mockLLM.store = useLLM;
  return { useLLM };
});
vi.mock('@client/app/contexts/UserSettingsContext', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));

import { useLLM } from '@client/app/contexts/LLMContext';
import { useAutoRouteOff, useTutorialAutoRouteOff } from './agentMode';
import { tutorialStoreFor } from './useTutorialStore';

const BASE = '/api/test-tutorials';
const useTutorialStore = {
  setState: (state: Parameters<ReturnType<typeof tutorialStoreFor>['setState']>[0]) =>
    tutorialStoreFor(BASE).setState(state),
  getState: () => tutorialStoreFor(BASE).getState(),
};

const flag = () => mockLLM.store.getState().disableAutoRouteForThisSession;

describe('useAutoRouteOff', () => {
  beforeEach(() => useLLM.setState({ disableAutoRouteForThisSession: false }));

  it('turns auto-routing off while on, and back on when it ends', () => {
    const { rerender } = renderHook(({ on }) => useAutoRouteOff(on), { initialProps: { on: true } });
    expect(flag()).toBe(true);
    rerender({ on: false });
    expect(flag()).toBe(false);
  });

  it('leaves a dismissal the user made before the tutorial in place', () => {
    useLLM.setState({ disableAutoRouteForThisSession: true });
    const { unmount } = renderHook(() => useAutoRouteOff(true));
    unmount();
    expect(flag()).toBe(true);
  });

  it('does nothing while off', () => {
    renderHook(() => useAutoRouteOff(false));
    expect(flag()).toBe(false);
  });
});

describe('useTutorialAutoRouteOff', () => {
  const tutorial = { moduleId: 'alpha', sessionId: 's1', stepId: 'intro' };

  beforeEach(() => {
    useLLM.setState({ disableAutoRouteForThisSession: false });
    useTutorialStore.setState({ active: null, pending: null });
  });

  it('holds from the start box through the start into its session', () => {
    useTutorialStore.setState({ pending: { moduleId: 'alpha', prompt: 'hi' } });
    const { rerender } = renderHook(({ sessionId }) => useTutorialAutoRouteOff(sessionId, BASE), {
      initialProps: { sessionId: null as string | null },
    });
    expect(flag()).toBe(true);
    act(() => {
      useTutorialStore.getState().begin(tutorial);
      rerender({ sessionId: 's1' });
    });
    expect(flag()).toBe(true);
  });

  it('lets go on a New Chat the page opens while a tutorial is active elsewhere', () => {
    useTutorialStore.setState({ active: tutorial });
    renderHook(() => useTutorialAutoRouteOff(null, BASE));
    expect(flag()).toBe(false);
  });

  it('lets go on a New Chat opened after the tutorial session', () => {
    useTutorialStore.setState({ active: tutorial });
    const { rerender } = renderHook(({ sessionId }) => useTutorialAutoRouteOff(sessionId, BASE), {
      initialProps: { sessionId: 's1' as string | null },
    });
    expect(flag()).toBe(true);
    rerender({ sessionId: null });
    expect(flag()).toBe(false);
  });

  it('lets go on another session', () => {
    useTutorialStore.setState({ active: tutorial });
    const { rerender } = renderHook(({ sessionId }) => useTutorialAutoRouteOff(sessionId, BASE), {
      initialProps: { sessionId: 's1' as string | null },
    });
    rerender({ sessionId: 's2' });
    expect(flag()).toBe(false);
  });
});
