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
const { navigateMock, toastMock, handlers, subscribeToAction, dispatchUiSideEffectsMock, ws } = vi.hoisted(() => {
  const handlers: Record<string, (msg: unknown) => Promise<void>> = {};
  return {
    navigateMock: vi.fn(),
    toastMock: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
    dispatchUiSideEffectsMock: vi.fn(),
    handlers,
    // Mutable socket state so a test can mount with the socket already up (or
    // still down) without re-mocking the module.
    ws: { readyState: 3 /* CLOSED */, sendJsonMessage: vi.fn() },
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
  // ReadyState is re-exported by the real module and the hook compares against
  // it, so the mock has to carry it too.
  ReadyState: { UNINSTANTIATED: -1, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({
    subscribeToAction,
    readyState: ws.readyState,
    sendJsonMessage: ws.sendJsonMessage,
  }),
}));
vi.mock('@client/app/utils/uiSideEffectDispatcher', () => ({
  dispatchUiSideEffects: dispatchUiSideEffectsMock,
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

describe('useAgentExecutionSubscriptions — iteration_step UI side-effects', () => {
  beforeEach(() => {
    dispatchUiSideEffectsMock.mockClear();
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it('dispatches a tool side-effect live, keyed on executionId:iteration', async () => {
    mountSubscriptions();
    useAgentExecutionStore.getState().startExecution('e1', 's1');

    await handlers['iteration_step']({
      action: 'iteration_step',
      executionId: 'e1',
      iteration: 2,
      step: { type: 'observation', content: 'done', metadata: { timestamp: 1 } },
      isComplete: false,
      uiSideEffects: [{ type: 'populateDecomposition', payload: { foo: 'bar' } }],
    });

    expect(dispatchUiSideEffectsMock).toHaveBeenCalledTimes(1);
    expect(dispatchUiSideEffectsMock).toHaveBeenCalledWith(
      [{ type: 'populateDecomposition', payload: { foo: 'bar' } }],
      { live: true, dedupeKey: 'e1:2' }
    );
  });

  it('does not dispatch when an iteration_step carries no side-effects', async () => {
    mountSubscriptions();
    useAgentExecutionStore.getState().startExecution('e1', 's1');

    await handlers['iteration_step']({
      action: 'iteration_step',
      executionId: 'e1',
      iteration: 0,
      step: { type: 'thought', content: 'thinking', metadata: { timestamp: 1 } },
      isComplete: false,
    });

    expect(dispatchUiSideEffectsMock).not.toHaveBeenCalled();
  });
});

/**
 * Regression coverage for the run that never finishes on screen.
 *
 * Agent progress is pushed to the connection id captured when the run started,
 * and a failed push is only logged. So a socket that dies mid-run misses every
 * later frame including `completed`, and the UI keeps showing "In Progress"
 * for a run the server finished long ago (observed on production: a ~2 minute
 * run still spinning 81 minutes later). The repair round-trip existed on both
 * ends already - it just had no caller. These tests pin the caller.
 */
describe('useAgentExecutionSubscriptions -- recovering a run after the socket comes back', () => {
  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3; // CLOSED
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  const reconnectCalls = () =>
    ws.sendJsonMessage.mock.calls.map(c => c[0] as Record<string, unknown>).filter(m => m.command === 'reconnect');

  it('asks the server to re-state a still-running execution once the socket is open', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'sess-1');
    ws.readyState = 1; // OPEN

    mountSubscriptions();

    expect(reconnectCalls()).toEqual([
      { action: 'agent_execute', command: 'reconnect', sessionId: 'sess-1', executionId: 'exec-1' },
    ]);
    // The response does not echo the sessionId back, so it must be queued for
    // `reconnect_result` to stamp on - keyed by executionId so a sweep over
    // several runs cannot be mis-paired by arrival order.
    expect(useAgentExecutionStore.getState().pendingReconnects).toEqual([
      { sessionId: 'sess-1', executionId: 'exec-1' },
    ]);
  });

  it('stays silent while the socket is down', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'sess-1');
    ws.readyState = 3; // CLOSED

    mountSubscriptions();

    expect(reconnectCalls()).toEqual([]);
  });

  it('does not re-ask about a run that already finished', () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-1', 'sess-1');
    store.setStatus('exec-1', 'completed');
    ws.readyState = 1; // OPEN

    mountSubscriptions();

    expect(reconnectCalls()).toEqual([]);
  });

  it('sends nothing when this tab is not watching any run', () => {
    ws.readyState = 1; // OPEN

    mountSubscriptions();

    expect(reconnectCalls()).toEqual([]);
  });
});

/**
 * A socket-open sweep asks about several runs at once, and each request is answered by an
 * independent server invocation whose cost scales with that run's child count - so the
 * responses routinely come back in a different order than they were sent. Correlating them
 * by arrival order would stamp a live run with another session's id, which is worse than the
 * spinner this recovery exists to clear: the run vanishes from the session the user is
 * looking at and reappears under one it does not belong to, and nothing corrects it.
 */
describe('useAgentExecutionSubscriptions -- reconnect responses pair with the run that asked', () => {
  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3; // CLOSED
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  const reconnectResult = (executionId: string) =>
    handlers['reconnect_result']({
      action: 'reconnect_result',
      found: true,
      executionId,
      status: 'running',
    });

  it('keeps each session on its own run when the responses arrive out of order', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-1', 'sess-A');
    store.startExecution('exec-2', 'sess-B');
    ws.readyState = 1; // OPEN

    mountSubscriptions();

    // exec-2 answers first - the case that arrival-order pairing gets wrong.
    await reconnectResult('exec-2');
    await reconnectResult('exec-1');

    const executions = useAgentExecutionStore.getState().executions;
    expect(executions['exec-2']?.sessionId).toBe('sess-B');
    expect(executions['exec-1']?.sessionId).toBe('sess-A');
    expect(useAgentExecutionStore.getState().pendingReconnects).toEqual([]);
  });

  it('still answers the mount-time probe, which has no execution id to key on', async () => {
    // The probe asks "is anything running in this session?" before any id exists.
    useAgentExecutionStore.getState().registerPendingReconnect('sess-C');
    mountSubscriptions();

    await reconnectResult('exec-9');

    expect(useAgentExecutionStore.getState().executions['exec-9']?.sessionId).toBe('sess-C');
    expect(useAgentExecutionStore.getState().pendingReconnects).toEqual([]);
  });
});

/**
 * Production never mounts into an already-open socket - it mounts once at app root and the
 * socket goes down and comes back underneath it. The mount-time cases above cannot see a
 * regression in that transition, so drive it directly.
 */
describe('useAgentExecutionSubscriptions -- the sweep runs on the transition, not just at mount', () => {
  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3; // CLOSED
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  const reconnectCalls = () =>
    ws.sendJsonMessage.mock.calls.map(c => c[0] as Record<string, unknown>).filter(m => m.command === 'reconnect');

  it('sweeps when a mounted subscriber sees the socket come back', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'sess-1');
    const { rerender } = mountSubscriptions();
    expect(reconnectCalls()).toEqual([]);

    ws.readyState = 1; // OPEN
    rerender();

    expect(reconnectCalls()).toEqual([
      { action: 'agent_execute', command: 'reconnect', sessionId: 'sess-1', executionId: 'exec-1' },
    ]);
  });

  it('does not re-sweep while the socket stays open', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'sess-1');
    ws.readyState = 1; // OPEN
    const { rerender } = mountSubscriptions();
    rerender();
    rerender();

    expect(reconnectCalls()).toHaveLength(1);
  });
});

describe('useAgentExecutionSubscriptions -- sweep hygiene', () => {
  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3; // CLOSED
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it('a swept run with no sessionId still gets a keyed queue entry (no send-without-enqueue)', () => {
    // A stray event synthesises an active execution with no sessionId; the sweep
    // must still enqueue for it, or its keyed response would drain a concurrent
    // mount-time probe's un-keyed entry and stamp that session onto the wrong run.
    useAgentExecutionStore.getState().setStatus('exec-orphan', 'running');
    ws.readyState = 1; // OPEN

    mountSubscriptions();

    expect(useAgentExecutionStore.getState().pendingReconnects).toEqual([
      { sessionId: undefined, executionId: 'exec-orphan' },
    ]);
  });

  it('a churning dispatcher identity does not re-fire the sweep (the ref guard)', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'sess-1');
    ws.readyState = 1; // OPEN
    const { rerender } = mountSubscriptions();
    const sent = () =>
      ws.sendJsonMessage.mock.calls.filter(c => (c[0] as { command?: string }).command === 'reconnect');
    expect(sent()).toHaveLength(1);

    // The token refresh case: `sendJsonMessage` gets a new identity every refresh,
    // so the dispatcher memoised over it churns too. Keyed on readyState alone (via
    // the ref), the sweep must not re-send.
    ws.sendJsonMessage = vi.fn();
    rerender();

    expect(
      ws.sendJsonMessage.mock.calls.filter(c => (c[0] as { command?: string }).command === 'reconnect')
    ).toHaveLength(0);
  });
});
