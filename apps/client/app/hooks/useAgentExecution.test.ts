import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

/**
 * Regression coverage: clicking "View trace" on the background-subagent
 * completion (and failure) toast must navigate.
 *
 * The original implementation navigated through `useNavigate()` held in a ref.
 * But this hook's host (`AgentExecutionSubscriber`) mounts OUTSIDE the
 * RouterProvider, so `useNavigate()` resolved to null and the click threw
 * `Cannot read properties of null (reading 'navigate')`. The fix navigates via
 * the `router` singleton instead.
 *
 * These tests drive the real `subagent_completed` / `subagent_failed`
 * subscription handlers, then invoke the toast action's `onClick` as a user
 * click would, asserting it routes through the singleton with the right
 * deep-link search.
 */

// vi.mock factories are hoisted, so anything they reference must be created via
// vi.hoisted. `subscribeToAction` is a stable identity so the subscription
// effect (keyed on it) doesn't re-run across renders.
const { navigateMock, toastMock, handlers, subscribeToAction } = vi.hoisted(() => {
  const handlers: Record<string, (msg: unknown) => Promise<void>> = {};
  return {
    navigateMock: vi.fn(),
    toastMock: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
    handlers,
    subscribeToAction: (action: string, cb: (msg: unknown) => Promise<void>) => {
      handlers[action] = cb;
      return () => {
        delete handlers[action];
      };
    },
  };
});

// Mock the router singleton; also avoids loading the full route tree into the test.
vi.mock('@client/app/router', () => ({ router: { navigate: navigateMock } }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction }),
}));

import { useAgentExecutionSubscriptions } from './useAgentExecution';
import { useAgentExecutionStore } from '@client/app/stores/useAgentExecutionStore';
import { AGENT_TRACE_ROUTE } from '@client/app/utils/agentTraceLink';

const mountSubscriptions = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useAgentExecutionSubscriptions(), { wrapper });
};

describe('useAgentExecutionSubscriptions — background "View trace" toast launcher', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastMock.mockClear();
    toastMock.error.mockClear();
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it('completion toast "View trace" navigates via the router singleton with the deep-link search', async () => {
    mountSubscriptions();
    const store = useAgentExecutionStore.getState();
    store.startExecution('e1', 's1');
    store.startChild('e1', { childExecutionId: 'c1', agentName: 'researcher', isBackground: true });

    await handlers['subagent_completed']({
      action: 'subagent_completed',
      executionId: 'e1',
      childExecutionId: 'c1',
      finalAnswer: 'The capital of France is Paris.',
    });

    expect(toastMock).toHaveBeenCalledTimes(1);
    const opts = toastMock.mock.calls[0][1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe('View trace');

    // The click that used to throw on a null navigate ref.
    expect(() => opts.action.onClick()).not.toThrow();
    expect(navigateMock).toHaveBeenCalledWith({
      to: AGENT_TRACE_ROUTE,
      search: { expand: 'c1', session: 's1' },
    });
  });

  it('failure toast "View trace" navigates via the router singleton', async () => {
    mountSubscriptions();
    const store = useAgentExecutionStore.getState();
    store.startExecution('e2', 's2');
    store.startChild('e2', { childExecutionId: 'c2', agentName: 'researcher', isBackground: true });

    await handlers['subagent_failed']({
      action: 'subagent_failed',
      executionId: 'e2',
      childExecutionId: 'c2',
      error: 'boom',
    });

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const opts = toastMock.error.mock.calls[0][1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe('View trace');

    expect(() => opts.action.onClick()).not.toThrow();
    expect(navigateMock).toHaveBeenCalledWith({
      to: AGENT_TRACE_ROUTE,
      search: { expand: 'c2', session: 's2' },
    });
  });

  it('does not toast for a foreground (non-background) completion', async () => {
    mountSubscriptions();
    const store = useAgentExecutionStore.getState();
    store.startExecution('e3', 's3');
    store.startChild('e3', { childExecutionId: 'c3', agentName: 'researcher', isBackground: false });

    await handlers['subagent_completed']({
      action: 'subagent_completed',
      executionId: 'e3',
      childExecutionId: 'c3',
      finalAnswer: 'inline answer',
    });

    expect(toastMock).not.toHaveBeenCalled();
  });
});

// Grandchild WS routing

describe('useAgentExecutionSubscriptions — depth-2 grandchild store routing', () => {
  beforeEach(() => {
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it('subagent_started with parentExecutionId places grandchild inside its direct parent, not at top level', async () => {
    mountSubscriptions();
    const store = useAgentExecutionStore.getState();
    store.startExecution('test-exec', 'session-1');
    store.startChild('test-exec', { childExecutionId: 'sub-exec', agentName: 'Sub Orchestrator' });

    await handlers['subagent_started']({
      action: 'subagent_started',
      executionId: 'test-exec',
      parentExecutionId: 'sub-exec',
      childExecutionId: 'leaf-exec',
      agentName: 'Leaf Researcher',
    });

    const leaf =
      useAgentExecutionStore.getState().executions['test-exec']?.childExecutions['sub-exec']?.childExecutions[
        'leaf-exec'
      ];
    expect(leaf).toBeDefined();
    expect(leaf?.agentName).toBe('Leaf Researcher');
    // Must NOT appear as a phantom sibling of Sub at the top level.
    expect(useAgentExecutionStore.getState().executions['test-exec']?.childExecutions['leaf-exec']).toBeUndefined();
  });

  it('subagent_iteration_step appends to the grandchild node, not a phantom sibling', async () => {
    mountSubscriptions();
    const store = useAgentExecutionStore.getState();
    store.startExecution('test-exec', 'session-1');
    store.startChild('test-exec', { childExecutionId: 'sub-exec', agentName: 'Sub Orchestrator' });
    store.startChild('test-exec', {
      childExecutionId: 'leaf-exec',
      agentName: 'Leaf Researcher',
      ancestorPath: ['sub-exec'],
    });

    await handlers['subagent_iteration_step']({
      action: 'subagent_iteration_step',
      executionId: 'test-exec',
      childExecutionId: 'leaf-exec',
      agentName: 'Leaf Researcher',
      iteration: 0,
      step: { type: 'thought', content: 'Searching for facts' },
    });

    const leaf =
      useAgentExecutionStore.getState().executions['test-exec']?.childExecutions['sub-exec']?.childExecutions[
        'leaf-exec'
      ];
    expect(leaf?.iterations).toHaveLength(1);
    expect(useAgentExecutionStore.getState().executions['test-exec']?.childExecutions['leaf-exec']).toBeUndefined();
  });

  it('subagent_completed marks the grandchild completed at the correct store location', async () => {
    mountSubscriptions();
    const store = useAgentExecutionStore.getState();
    store.startExecution('test-exec', 'session-1');
    store.startChild('test-exec', { childExecutionId: 'sub-exec', agentName: 'Sub Orchestrator' });
    store.startChild('test-exec', {
      childExecutionId: 'leaf-exec',
      agentName: 'Leaf Researcher',
      ancestorPath: ['sub-exec'],
    });

    await handlers['subagent_completed']({
      action: 'subagent_completed',
      executionId: 'test-exec',
      childExecutionId: 'leaf-exec',
      agentName: 'Leaf Researcher',
      iterations: 1,
      finalAnswer: 'The sky is blue.',
    });

    const leaf =
      useAgentExecutionStore.getState().executions['test-exec']?.childExecutions['sub-exec']?.childExecutions[
        'leaf-exec'
      ];
    expect(leaf?.status).toBe('completed');
    expect(useAgentExecutionStore.getState().executions['test-exec']?.childExecutions['leaf-exec']).toBeUndefined();
  });

  it('full sequence started → iteration_step → completed nests leaf under sub end-to-end', async () => {
    mountSubscriptions();
    const store = useAgentExecutionStore.getState();
    store.startExecution('test-exec', 'session-1');
    store.startChild('test-exec', { childExecutionId: 'sub-exec', agentName: 'Sub Orchestrator' });

    await handlers['subagent_started']({
      action: 'subagent_started',
      executionId: 'test-exec',
      parentExecutionId: 'sub-exec',
      childExecutionId: 'leaf-exec',
      agentName: 'Leaf Researcher',
    });

    await handlers['subagent_iteration_step']({
      action: 'subagent_iteration_step',
      executionId: 'test-exec',
      childExecutionId: 'leaf-exec',
      agentName: 'Leaf Researcher',
      iteration: 0,
      step: { type: 'thought', content: 'Thinking' },
    });

    await handlers['subagent_completed']({
      action: 'subagent_completed',
      executionId: 'test-exec',
      childExecutionId: 'leaf-exec',
      agentName: 'Leaf Researcher',
      iterations: 1,
      finalAnswer: 'The sky is blue.',
    });

    const leaf =
      useAgentExecutionStore.getState().executions['test-exec']?.childExecutions['sub-exec']?.childExecutions[
        'leaf-exec'
      ];
    expect(leaf).toBeDefined();
    expect(leaf?.agentName).toBe('Leaf Researcher');
    expect(leaf?.iterations).toHaveLength(1);
    expect(leaf?.status).toBe('completed');
    // Regression guard: no phantom sibling at the top level.
    expect(useAgentExecutionStore.getState().executions['test-exec']?.childExecutions['leaf-exec']).toBeUndefined();
  });
});
