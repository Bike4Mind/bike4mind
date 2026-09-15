import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockFetchPromptById, setProgrammaticLaunch, setChatInputValue, mockMutate, mockToastError } = vi.hoisted(
  () => ({
    mockFetchPromptById: vi.fn(),
    setProgrammaticLaunch: vi.fn(),
    setChatInputValue: vi.fn(),
    mockMutate: vi.fn(),
    mockToastError: vi.fn(),
  })
);

vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { name: 'Ada', email: 'ada@x.com', level: 'PaidUser' } }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 's1' }),
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: mockMutate }) }));
vi.mock('@client/app/hooks/data/briefcase', () => ({
  fetchPromptById: (...a: unknown[]) => mockFetchPromptById(...a),
}));

// useChatInput is used as a selector (useChatInput(s => s.x)) and via getState().
vi.mock('@client/app/hooks/useChatInput', () => {
  const state = {
    setProgrammaticLaunch,
    setChatInputValue,
    briefcaseLaunchInFlight: false,
    setBriefcaseLaunchInFlight: (v: boolean) => {
      state.briefcaseLaunchInFlight = v;
    },
  };
  const useChatInput = (selector: (s: typeof state) => unknown) => selector(state);
  useChatInput.getState = () => state;
  return { useChatInput };
});

import { useLaunchPrompt, type LaunchResult } from './useLaunchPrompt';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLaunchPrompt — execution-mode dispatch', () => {
  it('inject mode sets the input WITHOUT dispatching', async () => {
    mockFetchPromptById.mockResolvedValue({
      id: 'p1',
      name: 'P',
      promptText: 'Hello {{userName}}',
      executionMode: 'inject',
      userId: null,
    });
    const { result } = renderHook(() => useLaunchPrompt());
    let res: LaunchResult | undefined;
    await act(async () => {
      res = await result.current.launch('p1');
    });
    expect(res?.status).toBe('injected');
    expect(setChatInputValue).toHaveBeenCalledWith('Hello Ada');
    expect(setProgrammaticLaunch).not.toHaveBeenCalled();
  });

  it('auto-fire mode dispatches a resolved payload with a nonce and required tools', async () => {
    mockFetchPromptById.mockResolvedValue({
      id: 'p2',
      name: 'Deep Dive',
      promptText: 'Research {{userName}}',
      executionMode: 'auto-fire',
      requiredTools: ['deep_research'],
      userId: 'u1',
    });
    const { result } = renderHook(() => useLaunchPrompt());
    let res: LaunchResult | undefined;
    await act(async () => {
      res = await result.current.launch('p2');
    });
    expect(setProgrammaticLaunch).toHaveBeenCalledTimes(1);
    expect(res?.status).toBe('dispatched');
    if (res?.status === 'dispatched') {
      expect(res.dispatch).toMatchObject({
        promptId: 'p2',
        promptContent: 'Research Ada',
        requiredTools: ['deep_research'],
        sessionId: 's1',
      });
      expect(res.dispatch.dispatchNonce).toBeTruthy();
    }
  });

  it('returns {status:"error"} and toasts when the refetch throws', async () => {
    mockFetchPromptById.mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => useLaunchPrompt());
    let res: LaunchResult | undefined;
    await act(async () => {
      res = await result.current.launch('gone');
    });
    expect(res?.status).toBe('error');
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(setProgrammaticLaunch).not.toHaveBeenCalled();
  });

  it('emits a PROMPT_SELECTED analytics signal', async () => {
    mockFetchPromptById.mockResolvedValue({
      id: 'p3',
      name: 'P',
      promptText: 'hi',
      executionMode: 'inject',
      userId: null,
    });
    const { result } = renderHook(() => useLaunchPrompt());
    await act(async () => {
      await result.current.launch('p3');
    });
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ promptId: 'p3', ownership: 'system' }) })
    );
  });
});
