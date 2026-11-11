import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const post = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post, get: vi.fn(), put: vi.fn() } }));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: { getState: () => ({ chatInputValue: '', setDraft: vi.fn(), setChatInputValue: vi.fn() }) },
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({ useWorkBenchFiles: () => [] }));
vi.mock('@client/app/utils/react-query', () => ({ setOptimisticQueryData: vi.fn() }));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: () => false }));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));

import { useTutorialProgress, useTutorialRunModules } from '@client/app/hooks/tutorials/useTutorialRun';
import { TutorialRunner } from './TutorialRunner';
import {
  CORE_TUTORIALS_API_BASE,
  TutorialHostProvider,
  registerTutorialSteps,
  resetTutorialStepRegistrations,
  resolveTutorialSteps,
} from './TutorialHostContext';
import { tutorialModulesKey, tutorialProgressKey } from './tutorialKeys';
import type { TutorialScript, TutorialStepProps, TutorialTransport } from './types';
import { resetTutorialStores, tutorialStoreFor, useTutorialStore } from './useTutorialStore';
import { useTutorialActive } from './useTutorialActive';

const A = '/api/host-a';
const B = '/api/host-b';

beforeEach(() => {
  post.mockReset();
  resetTutorialStores();
  resetTutorialStepRegistrations();
});
afterEach(() => resetTutorialStepRegistrations());

const withHost = (apiBase: string, client = new QueryClient()) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TutorialHostProvider apiBase={apiBase}>{children}</TutorialHostProvider>
      </QueryClientProvider>
    );
  };

describe('scoped query keys', () => {
  it('starts every key with the apiBase', () => {
    expect(tutorialProgressKey(A)[0]).toBe(A);
    expect(tutorialModulesKey(A)[0]).toBe(A);
  });

  it('keeps two hosts with different bases in separate cache entries', async () => {
    post.mockImplementation(async (url: string, body: { action: string }) => ({
      data:
        body.action === 'progress'
          ? { modules: { [url.includes('host-a') ? 'from-a' : 'from-b']: { status: 'in_progress' } } }
          : { modules: [] },
    }));
    const client = new QueryClient();
    const a = renderHook(() => useTutorialProgress(), { wrapper: withHost(A, client) });
    const b = renderHook(() => useTutorialProgress(), { wrapper: withHost(B, client) });
    await waitFor(() => expect(a.result.current.data).toBeDefined());
    await waitFor(() => expect(b.result.current.data).toBeDefined());
    expect(Object.keys(a.result.current.data ?? {})).toEqual(['from-a']);
    expect(Object.keys(b.result.current.data ?? {})).toEqual(['from-b']);
    expect(client.getQueryData(tutorialProgressKey(A))).toBeDefined();
    expect(client.getQueryData(tutorialProgressKey(B))).toBeDefined();
    expect(post).toHaveBeenCalledWith(`${A}/run`, { action: 'progress' });
    expect(post).toHaveBeenCalledWith(`${B}/run`, { action: 'progress' });
  });

  it('reads modules under the host base too', async () => {
    post.mockResolvedValue({ data: { modules: [{ id: 'm' }] } });
    const client = new QueryClient();
    renderHook(() => useTutorialRunModules(), { wrapper: withHost(CORE_TUTORIALS_API_BASE, client) });
    await waitFor(() =>
      expect(client.getQueryData(tutorialModulesKey(CORE_TUTORIALS_API_BASE))).toEqual([{ id: 'm' }])
    );
  });
});

describe('scoped runner store', () => {
  it('gives each base its own store', () => {
    expect(tutorialStoreFor(A)).toBe(tutorialStoreFor(A));
    expect(tutorialStoreFor(A)).not.toBe(tutorialStoreFor(B));
  });

  it('does not show a walk started on one base as active on the other', () => {
    const a = renderHook(() => useTutorialStore(state => state.active), { wrapper: withHost(A) });
    const b = renderHook(() => useTutorialStore(state => state.active), { wrapper: withHost(B) });
    const activeA = renderHook(() => useTutorialActive(), { wrapper: withHost(A) });
    const activeB = renderHook(() => useTutorialActive(), { wrapper: withHost(B) });
    act(() => tutorialStoreFor(A).getState().begin({ moduleId: 'm', sessionId: 's1', stepId: 'one' }));
    expect(a.result.current?.moduleId).toBe('m');
    expect(b.result.current).toBeNull();
    expect(activeA.result.current).toBe(true);
    expect(activeB.result.current).toBe(false);
  });

  it('reads a store by an explicit base outside a provider', () => {
    tutorialStoreFor(A).getState().begin({ moduleId: 'm', sessionId: 's1', stepId: 'one' });
    expect(renderHook(() => useTutorialActive(null, A)).result.current).toBe(true);
    expect(renderHook(() => useTutorialActive(null, B)).result.current).toBe(false);
    expect(() => renderHook(() => useTutorialActive())).toThrow();
  });
});

describe('open step registry', () => {
  const transport = (): TutorialTransport => ({
    progress: vi.fn(async () => ({})),
    start: vi.fn(async () => ({ sessionId: 's1' })),
    resume: vi.fn(async () => ({ sessionId: 's1' })),
    sheet: vi.fn(async () => ({ fileId: 'f1' })),
    advance: vi.fn(),
    position: vi.fn(async () => undefined),
  });
  const script: TutorialScript = { id: 'm', steps: [{ id: 'one', type: 'hostOnly', body: 'Host body.' }] };
  const Custom = ({ step }: TutorialStepProps) => <div data-testid="custom-step">{step.id}</div>;

  const mount = (apiBase: string, steps?: Record<string, React.ComponentType<TutorialStepProps>>) => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TutorialHostProvider apiBase={apiBase} steps={steps}>
          <TutorialRunner script={script} transport={transport()} />
        </TutorialHostProvider>
      </QueryClientProvider>
    );
    act(() => tutorialStoreFor(apiBase).getState().begin({ moduleId: 'm', sessionId: 's1', stepId: 'one' }));
  };

  it('renders a step type the host registered', () => {
    registerTutorialSteps(A, { hostOnly: Custom });
    mount(A);
    expect(screen.getByTestId('custom-step')).toHaveTextContent('one');
  });

  it('renders a step type passed to the provider', () => {
    mount(A, { hostOnly: Custom });
    expect(screen.getByTestId('custom-step')).toBeInTheDocument();
  });

  it('does not leak one host registration into another', () => {
    registerTutorialSteps(A, { hostOnly: Custom });
    expect(resolveTutorialSteps(A).hostOnly).toBe(Custom);
    expect(resolveTutorialSteps(B).hostOnly).toBeUndefined();
  });

  it('renders StepFallback for a type nothing registered, so the user can still move on', () => {
    mount(B);
    expect(screen.queryByTestId('custom-step')).not.toBeInTheDocument();
    expect(screen.getByTestId('tutorial-coach-card')).toHaveTextContent('Host body.');
    expect(screen.getByTestId('tutorial-step-next')).toBeInTheDocument();
  });
});
