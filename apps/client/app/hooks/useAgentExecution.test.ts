import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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

import {
  useAgentExecutionSubscriptions,
  useAgentExecutionDispatch,
  GATE_ACK_WINDOW_MS,
  failedRunReply,
} from './useAgentExecution';
import { useAgentExecutionStore } from '@client/app/stores/useAgentExecutionStore';
import { AGENT_TRACE_ROUTE } from '@client/app/utils/agentTraceLink';

const mountSubscriptions = (queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
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
      {
        action: 'agent_execute',
        command: 'reconnect',
        requestId: expect.any(String),
        sessionId: 'sess-1',
        executionId: 'exec-1',
      },
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
 * Reconnect requests are answered by independent server invocations whose cost scales with
 * each run's child count, so responses routinely come back in a different order than they
 * were sent - and a `found: false` answers nothing at all. The session a run belongs to must
 * therefore come from the response itself, never from which request is "next": pairing by
 * arrival order stamps a live run with another session's id (it vanishes from the session the
 * user is looking at) or with none (it vanishes everywhere).
 */
describe('useAgentExecutionSubscriptions -- reconnect responses carry their own session', () => {
  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3; // CLOSED
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  const found = (executionId: string, sessionId: string) =>
    handlers['reconnect_result']({
      action: 'reconnect_result',
      found: true,
      executionId,
      sessionId,
      status: 'running',
    });
  const notFound = () => handlers['reconnect_result']({ action: 'reconnect_result', found: false });

  const mountDispatch = () => renderHook(() => useAgentExecutionDispatch()).result.current;

  it('keeps each session on its own run when sweep responses arrive out of order', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-1', 'sess-A');
    store.startExecution('exec-2', 'sess-B');
    ws.readyState = 1; // OPEN

    mountSubscriptions();

    await found('exec-2', 'sess-B');
    await found('exec-1', 'sess-A');

    const executions = useAgentExecutionStore.getState().executions;
    expect(executions['exec-2']?.sessionId).toBe('sess-B');
    expect(executions['exec-1']?.sessionId).toBe('sess-A');
  });

  it.each([
    ['the live run answers first', ['found', 'notFound']],
    ['the idle probe answers first', ['notFound', 'found']],
  ])('two concurrent mount probes: the live run lands on its own session when %s', async (_, order) => {
    mountSubscriptions();
    const { reconnect } = mountDispatch();
    reconnect('sess-A'); // idle session
    reconnect('sess-B'); // session with a live run

    for (const response of order) {
      await (response === 'found' ? found('exec-B', 'sess-B') : notFound());
    }

    expect(useAgentExecutionStore.getState().executions['exec-B']?.sessionId).toBe('sess-B');
  });

  it('a found:false for a gone swept run does not cost a concurrent probe its session', async () => {
    useAgentExecutionStore.getState().startExecution('exec-gone', 'sess-stale');
    ws.readyState = 1; // OPEN
    mountSubscriptions();
    mountDispatch().reconnect('sess-probe');

    await notFound(); // the sweep's answer: the server no longer has exec-gone
    await found('exec-live', 'sess-probe');

    expect(useAgentExecutionStore.getState().executions['exec-live']?.sessionId).toBe('sess-probe');
  });

  it('a found:false changes nothing in the store', async () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'sess-A');
    mountSubscriptions();
    const before = useAgentExecutionStore.getState().executions;

    await notFound();

    expect(useAgentExecutionStore.getState().executions).toEqual(before);
  });

  it('a found:true without a sessionId keeps the session the store already holds', async () => {
    // A server that predates the echo: the sweep's run already knows its session.
    useAgentExecutionStore.getState().startExecution('exec-1', 'sess-A');
    mountSubscriptions();

    await handlers['reconnect_result']({
      action: 'reconnect_result',
      found: true,
      executionId: 'exec-1',
      status: 'running',
    });

    expect(useAgentExecutionStore.getState().executions['exec-1']?.sessionId).toBe('sess-A');
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
      {
        action: 'agent_execute',
        command: 'reconnect',
        requestId: expect.any(String),
        sessionId: 'sess-1',
        executionId: 'exec-1',
      },
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

  it('a swept run with no sessionId takes its session from the server', async () => {
    // A stray event synthesises an active execution with no sessionId; the server
    // knows which session the run belongs to and echoes it.
    useAgentExecutionStore.getState().setStatus('exec-orphan', 'running');
    ws.readyState = 1; // OPEN

    mountSubscriptions();
    await handlers['reconnect_result']({
      action: 'reconnect_result',
      found: true,
      executionId: 'exec-orphan',
      sessionId: 'sess-real',
      status: 'running',
    });

    expect(useAgentExecutionStore.getState().executions['exec-orphan']?.sessionId).toBe('sess-real');
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

/**
 * `toolCallId` identity wire: the server binds a `permission_response` to the
 * specific pause it named, via the id the client echoes back. Nothing previously
 * asserted that this hook actually threads the id through on any of its three
 * legs (live `permission_request`, `reconnect_result.pendingPermission` replay,
 * and the `permission_response` send) - each was deletable with the suite green.
 */
describe('useAgentExecutionSubscriptions -- toolCallId identity wire', () => {
  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3; // CLOSED
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it('a live permission_request stores the toolCallId on pendingPermission', async () => {
    mountSubscriptions();
    useAgentExecutionStore.getState().startExecution('exec-1', 'sess-1');

    await handlers['permission_request']({
      action: 'permission_request',
      executionId: 'exec-1',
      toolName: 'send_slack_message',
      toolInput: { text: 'hi' },
      iteration: 1,
      toolCallId: 'toolu_live_1',
    });

    expect(useAgentExecutionStore.getState().executions['exec-1']?.pendingPermission?.toolCallId).toBe('toolu_live_1');
  });

  it('reconnect_result threads pendingPermission.toolCallId through to the store', async () => {
    useAgentExecutionStore.getState().startExecution('exec-2', 'sess-2');
    ws.readyState = 1; // OPEN
    mountSubscriptions();

    await handlers['reconnect_result']({
      action: 'reconnect_result',
      found: true,
      executionId: 'exec-2',
      status: 'awaiting_permission',
      pendingPermission: {
        toolName: 'send_slack_message',
        toolInput: { text: 'hi' },
        requestedAt: new Date(),
        toolCallId: 'toolu_reconnect_1',
      },
    });

    expect(useAgentExecutionStore.getState().executions['exec-2']?.pendingPermission?.toolCallId).toBe(
      'toolu_reconnect_1'
    );
  });

  it('respondToPermission sends the toolCallId on permission_response', () => {
    const { result } = renderHook(() => useAgentExecutionDispatch());

    result.current.respondToPermission('exec-3', 'send_slack_message', true, false, 'toolu_response_1');

    expect(ws.sendJsonMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_execute',
        command: 'permission_response',
        executionId: 'exec-3',
        toolName: 'send_slack_message',
        toolCallId: 'toolu_response_1',
        approved: true,
        rememberForSession: false,
      })
    );
  });
});

describe('useAgentExecutionSubscriptions -- generation jobs started mid-run', () => {
  const questsKey = ['quests', 'session', 's1'];
  const seeded = () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(questsKey, {
      pages: [{ data: [{ id: 'q1', sessionId: 's1', prompt: 'make a song', replies: [] }], hasMore: false }],
      pageParams: [{ page: 1 }],
    });
    return queryClient;
  };
  const cachedJobs = (queryClient: QueryClient) =>
    (queryClient.getQueryData(questsKey) as { pages: Array<{ data: Array<{ generationJobs?: unknown }> }> }).pages[0]
      .data[0].generationJobs;
  const frame = (executionId: string) => ({
    action: 'progress',
    executionId,
    questId: 'q1',
    generationJobs: [{ id: 'job-1', kind: 'music' }],
  });

  beforeEach(() => {
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it("puts a progress frame's jobs on the run's quest so the cards render live", async () => {
    const queryClient = seeded();
    mountSubscriptions(queryClient);
    useAgentExecutionStore.getState().startExecution('e1', 's1');

    await handlers['progress'](frame('e1'));

    expect(cachedJobs(queryClient)).toEqual([{ id: 'job-1', kind: 'music' }]);
  });

  it('ignores a frame for an execution this tab does not know', async () => {
    const queryClient = seeded();
    mountSubscriptions(queryClient);

    await handlers['progress'](frame('unknown'));

    expect(cachedJobs(queryClient)).toBeUndefined();
  });
});

describe('useAgentExecutionSubscriptions -- write preview raised mid-run', () => {
  const questsKey = ['quests', 'session', 's1'];

  beforeEach(() => {
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it("puts a progress frame's pending action on the run's quest so the Confirm card renders live", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(questsKey, {
      pages: [{ data: [{ id: 'q1', sessionId: 's1', prompt: 'file an issue', replies: [] }], hasMore: false }],
      pageParams: [{ page: 1 }],
    });
    mountSubscriptions(queryClient);
    useAgentExecutionStore.getState().startExecution('e1', 's1');
    const pendingAction = { tool: 'create_issue', params: { title: 't' }, ts: 1 };

    await handlers['progress']({ action: 'progress', executionId: 'e1', questId: 'q1', pendingAction });

    const cached = queryClient.getQueryData(questsKey) as {
      pages: Array<{ data: Array<{ pendingAction?: unknown }> }>;
    };
    expect(cached.pages[0].data[0].pendingAction).toEqual(pendingAction);
  });
});

/**
 * Confidence-gate wire: a paused run is only resumable if the client actually
 * subscribes to `confidence_gate`, rehydrates `pendingGate` on reconnect, and
 * can send `gate_response`. Each leg was previously untested and deletable.
 */
describe('useAgentExecutionSubscriptions -- confidence gate wire', () => {
  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3; // CLOSED
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it('a live confidence_gate stores the gate and flips the run to paused', async () => {
    mountSubscriptions();
    useAgentExecutionStore.getState().startExecution('exec-gate-1', 'sess-1');

    await handlers['confidence_gate']({
      action: 'confidence_gate',
      executionId: 'exec-gate-1',
      iteration: 2,
      confidence: 0.42,
      reason: 'Iteration confidence 42% below threshold 60%',
    });

    const exec = useAgentExecutionStore.getState().executions['exec-gate-1'];
    expect(exec.status).toBe('paused');
    expect(exec.pendingGate).toEqual({
      iteration: 2,
      confidence: 0.42,
      reason: 'Iteration confidence 42% below threshold 60%',
      requestedAt: expect.any(Number),
    });
  });

  it('reconnect_result restores pendingGate with an ISO requestedAt normalised to epoch ms', async () => {
    useAgentExecutionStore.getState().startExecution('exec-gate-2', 'sess-2');
    ws.readyState = 1; // OPEN
    mountSubscriptions();

    const requestedAt = '2026-10-20T12:00:00.000Z';

    await handlers['reconnect_result']({
      action: 'reconnect_result',
      found: true,
      executionId: 'exec-gate-2',
      status: 'paused',
      pendingGate: {
        iteration: 4,
        confidence: 0.31,
        reason: 'Iteration confidence 31% below threshold 60%',
        requestedAt,
      },
    });

    const exec = useAgentExecutionStore.getState().executions['exec-gate-2'];
    expect(exec.pendingGate).toEqual({
      iteration: 4,
      confidence: 0.31,
      reason: 'Iteration confidence 31% below threshold 60%',
      requestedAt: new Date(requestedAt).getTime(),
    });
  });

  it('a resumed frame clears a gate restored by a stale reconnect', async () => {
    ws.readyState = 1; // OPEN
    mountSubscriptions();
    useAgentExecutionStore.getState().startExecution('exec-gate-7', 'sess-7');
    // A reconnect whose snapshot was read before an in-flight `gate_response`
    // was applied restores `paused` + the gate.
    useAgentExecutionStore.getState().hydrateFromReconnect({
      executionId: 'exec-gate-7',
      sessionId: 'sess-7',
      status: 'paused',
      totalCreditsUsed: 0,
      iterationCount: 2,
      pendingGate: { iteration: 2, confidence: 0.42, reason: 'below threshold', requestedAt: 1234 },
    });
    expect(useAgentExecutionStore.getState().executions['exec-gate-7'].pendingGate).toBeDefined();

    // The resume frame then moves the run off `paused`. The gate must not
    // survive it: the card is status-blind, so it would paint a dead
    // Proceed/Stop over a live run whose responses the server drops.
    await handlers['resumed']({ action: 'resumed', executionId: 'exec-gate-7' });

    const exec = useAgentExecutionStore.getState().executions['exec-gate-7'];
    expect(exec.status).toBe('running');
    expect(exec.pendingGate).toBeUndefined();
  });

  it('respondToGate sends the matching gate_response for continue and stop', () => {
    const { result } = renderHook(() => useAgentExecutionDispatch());

    result.current.respondToGate('exec-gate-3', 'continue');
    result.current.respondToGate('exec-gate-3', 'stop');

    expect(ws.sendJsonMessage).toHaveBeenNthCalledWith(1, {
      action: 'agent_execute',
      command: 'gate_response',
      executionId: 'exec-gate-3',
      decision: 'continue',
    });
    expect(ws.sendJsonMessage).toHaveBeenNthCalledWith(2, {
      action: 'agent_execute',
      command: 'gate_response',
      executionId: 'exec-gate-3',
      decision: 'stop',
    });
  });

  // `continue` has no ack of its own: the handler only re-invokes the executor,
  // and a response for a pause the stale sweep already closed is dropped in
  // silence. Without the re-ask the client would sit on a dead run.
  describe('continue ack window', () => {
    const GATE = {
      iteration: 2,
      confidence: 0.42,
      reason: 'Iteration confidence 42% below threshold 60%',
      requestedAt: Date.now(),
    };

    const mountPausedRun = (executionId: string, sessionId: string) => {
      useAgentExecutionStore.getState().startExecution(executionId, sessionId);
      useAgentExecutionStore.getState().setPendingGate(executionId, GATE);
    };

    it('re-asks the server when no frame moves the run off paused', async () => {
      vi.useFakeTimers();
      try {
        ws.readyState = 1; // OPEN
        mountSubscriptions();
        mountPausedRun('exec-gate-4', 'sess-4');

        const { result } = renderHook(() => useAgentExecutionDispatch());
        result.current.respondToGate('exec-gate-4', 'continue');
        ws.sendJsonMessage.mockClear();

        act(() => {
          vi.advanceTimersByTime(GATE_ACK_WINDOW_MS);
        });

        expect(ws.sendJsonMessage).toHaveBeenCalledTimes(1);
        expect(ws.sendJsonMessage).toHaveBeenCalledWith({
          action: 'agent_execute',
          command: 'reconnect',
          requestId: expect.any(String),
          sessionId: 'sess-4',
          executionId: 'exec-gate-4',
        });

        // The re-ask lands on the run's real terminal status, not a stale pause.
        await handlers['reconnect_result']({
          action: 'reconnect_result',
          found: true,
          executionId: 'exec-gate-4',
          status: 'aborted',
        });
        expect(useAgentExecutionStore.getState().executions['exec-gate-4'].status).toBe('aborted');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not re-ask when a server frame resumes the run first', () => {
      vi.useFakeTimers();
      try {
        mountPausedRun('exec-gate-5', 'sess-5');

        const { result } = renderHook(() => useAgentExecutionDispatch());
        result.current.respondToGate('exec-gate-5', 'continue');
        ws.sendJsonMessage.mockClear();

        // The executor's `resumed` frame lands inside the window.
        useAgentExecutionStore.getState().setStatus('exec-gate-5', 'running');
        act(() => {
          vi.advanceTimersByTime(GATE_ACK_WINDOW_MS);
        });

        expect(ws.sendJsonMessage).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-asks the server when a stop is never answered', () => {
      vi.useFakeTimers();
      try {
        mountPausedRun('exec-gate-6', 'sess-6');

        const { result } = renderHook(() => useAgentExecutionDispatch());
        result.current.respondToGate('exec-gate-6', 'stop');
        ws.sendJsonMessage.mockClear();

        // No `completed` frame: the pause was swept, so the server drops the
        // stop and the run still reads paused.
        act(() => {
          vi.advanceTimersByTime(GATE_ACK_WINDOW_MS);
        });

        expect(ws.sendJsonMessage).toHaveBeenCalledTimes(1);
        expect(ws.sendJsonMessage).toHaveBeenCalledWith({
          action: 'agent_execute',
          command: 'reconnect',
          requestId: expect.any(String),
          sessionId: 'sess-6',
          executionId: 'exec-gate-6',
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('useAgentExecutionSubscriptions -- reconnect snapshot freshness', () => {
  const gate = { iteration: 2, confidence: 0.42, reason: 'below threshold', requestedAt: 1234 };

  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3;
    Object.keys(handlers).forEach(key => delete handlers[key]);
    useAgentExecutionStore.getState().clearAll();
    mountSubscriptions();
  });

  const requestReconnect = (sessionId = 'session-fresh', executionId?: string) => {
    const { result } = renderHook(() => useAgentExecutionDispatch());
    act(() => {
      result.current.reconnect(sessionId, executionId);
    });
    const message = ws.sendJsonMessage.mock.lastCall?.[0] as { requestId: string };
    return message.requestId;
  };

  const reply = (requestId: string | undefined, status: string, pendingGate?: typeof gate) =>
    handlers['reconnect_result']({
      action: 'reconnect_result',
      found: true,
      requestId,
      executionId: 'exec-fresh',
      sessionId: 'session-fresh',
      status,
      pendingGate,
    });

  it.each(['resumed', 'completed'])('does not restore an old gate after a live %s frame', async action => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-fresh', 'session-fresh');
    store.setPendingGate('exec-fresh', gate);
    const requestId = requestReconnect();
    await handlers[action]({ action, executionId: 'exec-fresh', answer: 'done', totalCreditsUsed: 1 });

    await reply(requestId, 'paused', gate);

    const execution = useAgentExecutionStore.getState().executions['exec-fresh'];
    expect(execution.status).toBe(action === 'resumed' ? 'running' : 'completed');
    expect(execution.pendingGate).toBeUndefined();
  });

  it('does not erase a new gate with an older running snapshot', async () => {
    useAgentExecutionStore.getState().startExecution('exec-fresh', 'session-fresh');
    const requestId = requestReconnect();
    await handlers['confidence_gate']({ action: 'confidence_gate', executionId: 'exec-fresh', ...gate });

    await reply(requestId, 'running');

    expect(useAgentExecutionStore.getState().executions['exec-fresh']).toMatchObject({
      status: 'paused',
      pendingGate: { iteration: gate.iteration },
    });
  });

  it('restores a still-paused gate after a response was not accepted', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-fresh', 'session-fresh');
    store.setPendingGate('exec-fresh', gate);
    store.setPendingGate('exec-fresh', undefined);
    const requestId = requestReconnect();

    await reply(requestId, 'paused', gate);

    expect(useAgentExecutionStore.getState().executions['exec-fresh'].pendingGate).toEqual(gate);
  });

  it('accepts a snapshot after credits change without a lifecycle transition', async () => {
    useAgentExecutionStore.getState().startExecution('exec-fresh', 'session-fresh');
    const requestId = requestReconnect();
    useAgentExecutionStore.getState().recordCredits('exec-fresh', 1);

    await reply(requestId, 'paused', gate);

    expect(useAgentExecutionStore.getState().executions['exec-fresh'].pendingGate).toEqual(gate);
  });

  it('restores missed trace steps from a completed snapshot after a live completion', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-fresh', 'session-fresh');
    const requestId = requestReconnect();
    await handlers['completed']({
      action: 'completed',
      executionId: 'exec-fresh',
      answer: 'done',
      totalCreditsUsed: 1,
    });

    await handlers['reconnect_result']({
      action: 'reconnect_result',
      found: true,
      requestId,
      executionId: 'exec-fresh',
      sessionId: 'session-fresh',
      status: 'completed',
      steps: [{ type: 'thought', content: 'A missed step', metadata: { iteration: 0, timestamp: 1234 } }],
    });

    const execution = useAgentExecutionStore.getState().executions['exec-fresh'];
    expect(execution.status).toBe('completed');
    expect(execution.iterations[0].step.content).toBe('A missed step');
  });

  it('does not replace a terminal outcome with a conflicting terminal snapshot', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-fresh', 'session-fresh');
    const requestId = requestReconnect();
    store.markAborted('exec-fresh');

    await reply(requestId, 'completed');

    expect(useAgentExecutionStore.getState().executions['exec-fresh'].status).toBe('aborted');
  });

  it('accepts a terminal snapshot after a live status transition when completion was not pushed', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-fresh', 'session-fresh');
    store.setPendingGate('exec-fresh', gate);
    const requestId = requestReconnect('session-fresh', 'exec-fresh');
    await handlers['resumed']({ action: 'resumed', executionId: 'exec-fresh' });

    await reply(requestId, 'completed');

    expect(useAgentExecutionStore.getState().executions['exec-fresh'].status).toBe('completed');
  });

  it('re-asks once after a lifecycle conflict and accepts the current pause', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-fresh', 'session-fresh');
    const requestId = requestReconnect();
    store.setStatus('exec-fresh', 'continuing');
    const callsBeforeReply = ws.sendJsonMessage.mock.calls.length;

    await reply(requestId, 'paused', gate);

    expect(ws.sendJsonMessage).toHaveBeenCalledTimes(callsBeforeReply + 1);
    const retryRequestId = (ws.sendJsonMessage.mock.lastCall?.[0] as { requestId: string }).requestId;
    await reply(retryRequestId, 'paused', gate);
    expect(useAgentExecutionStore.getState().executions['exec-fresh'].pendingGate).toEqual(gate);
  });

  it('does not create a retry loop if the retry is also overtaken by live status', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-fresh', 'session-fresh');
    const requestId = requestReconnect();
    store.setStatus('exec-fresh', 'continuing');
    await reply(requestId, 'paused', gate);
    const retryRequestId = (ws.sendJsonMessage.mock.lastCall?.[0] as { requestId: string }).requestId;
    store.setStatus('exec-fresh', 'running');
    const callsBeforeRetryReply = ws.sendJsonMessage.mock.calls.length;

    await reply(retryRequestId, 'paused', gate);

    expect(ws.sendJsonMessage).toHaveBeenCalledTimes(callsBeforeRetryReply);
    expect(useAgentExecutionStore.getState().executions['exec-fresh'].status).toBe('running');
  });

  it('equal running progress does not invalidate a reconnect', async () => {
    const store = useAgentExecutionStore.getState();
    store.startExecution('exec-fresh', 'session-fresh');
    const requestId = requestReconnect();
    await handlers['progress']({ action: 'progress', executionId: 'exec-fresh', status: 'running' });
    const callsBeforeReply = ws.sendJsonMessage.mock.calls.length;

    await reply(requestId, 'paused', gate);

    expect(ws.sendJsonMessage).toHaveBeenCalledTimes(callsBeforeReply);
    expect(useAgentExecutionStore.getState().executions['exec-fresh'].pendingGate).toEqual(gate);
  });

  it('a session-only probe discovers a run that was absent when the request was sent', async () => {
    const requestId = requestReconnect('session-fresh', undefined);

    await reply(requestId, 'paused', gate);

    expect(useAgentExecutionStore.getState().executions['exec-fresh']).toMatchObject({
      sessionId: 'session-fresh',
      status: 'paused',
      pendingGate: gate,
    });
  });

  it('a session-only probe cannot overwrite a run started live while it was in flight', async () => {
    const requestId = requestReconnect('session-fresh', undefined);
    useAgentExecutionStore.getState().startExecution('exec-fresh', 'session-fresh');

    await reply(requestId, 'paused', gate);

    expect(useAgentExecutionStore.getState().executions['exec-fresh'].status).toBe('running');
  });

  it('the newer correlated snapshot wins when responses arrive in reverse order', async () => {
    useAgentExecutionStore.getState().startExecution('exec-fresh', 'session-fresh');
    const oldRequestId = requestReconnect();
    const newRequestId = requestReconnect();
    await reply(newRequestId, 'running');

    await reply(oldRequestId, 'paused', gate);

    expect(useAgentExecutionStore.getState().executions['exec-fresh'].status).toBe('running');
  });

  it('cleans up a correlated found:false without affecting another request', async () => {
    const goneRequestId = requestReconnect('session-gone', 'exec-gone');
    const liveRequestId = requestReconnect('session-fresh', undefined);
    await handlers['reconnect_result']({ action: 'reconnect_result', found: false, requestId: goneRequestId });

    expect(useAgentExecutionStore.getState().pendingReconnectRequests[goneRequestId]).toBeUndefined();
    expect(useAgentExecutionStore.getState().pendingReconnectRequests[liveRequestId]).toBeDefined();
    await reply(liveRequestId, 'paused', gate);
    expect(useAgentExecutionStore.getState().executions['exec-fresh'].pendingGate).toEqual(gate);
  });

  it.each(['missing', 'expired'])('%s responses do not hydrate or retry an active run', async mode => {
    vi.useFakeTimers();
    try {
      useAgentExecutionStore.getState().startExecution('exec-fresh', 'session-fresh');
      const requestId = requestReconnect();
      if (mode === 'expired') vi.advanceTimersByTime(60_000);
      const callsBeforeReply = ws.sendJsonMessage.mock.calls.length;

      await reply(mode === 'missing' ? 'unknown' : requestId, 'paused', gate);

      expect(ws.sendJsonMessage).toHaveBeenCalledTimes(callsBeforeReply);
      expect(useAgentExecutionStore.getState().executions['exec-fresh'].status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['missing', 'expired', 'legacy'])('%s responses cannot roll a terminal run back', async mode => {
    vi.useFakeTimers();
    try {
      useAgentExecutionStore.getState().startExecution('exec-fresh', 'session-fresh');
      let requestId: string | undefined = requestReconnect();
      useAgentExecutionStore.getState().markCompleted('exec-fresh', 'done', 1);
      if (mode === 'missing') requestId = 'unknown';
      if (mode === 'expired') vi.advanceTimersByTime(60_000);
      if (mode === 'legacy') requestId = undefined;

      await reply(requestId, 'paused', gate);

      expect(useAgentExecutionStore.getState().executions['exec-fresh'].status).toBe('completed');
      expect(useAgentExecutionStore.getState().executions['exec-fresh'].pendingGate).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useAgentExecutionSubscriptions -- failed run reply', () => {
  const questsKey = ['quests', 'session', 's1'];
  const seeded = () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(questsKey, {
      pages: [{ data: [{ id: 'q1', sessionId: 's1', prompt: 'post to slack', replies: [] }], hasMore: false }],
      pageParams: [{ page: 1 }],
    });
    return queryClient;
  };
  const latestReplies = (queryClient: QueryClient) =>
    (queryClient.getQueryData(questsKey) as { pages: Array<{ data: Array<{ replies?: string[] }> }> }).pages[0].data[0]
      .replies;

  beforeEach(() => {
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  it("shows the server's denial text instead of reporting a crash when a tool is denied", async () => {
    const queryClient = seeded();
    mountSubscriptions(queryClient);
    useAgentExecutionStore.getState().startExecution('e1', 's1');

    await handlers['failed']({
      action: 'failed',
      executionId: 'e1',
      reason: 'tool_denied',
      toolName: 'slack_post',
      message: 'Execution stopped: you denied "slack_post".',
    });

    expect(latestReplies(queryClient)).toEqual(['Execution stopped: you denied "slack_post".']);
  });

  it('keeps the generic message for any other failure reason', async () => {
    const queryClient = seeded();
    mountSubscriptions(queryClient);
    useAgentExecutionStore.getState().startExecution('e1', 's1');

    await handlers['failed']({ action: 'failed', executionId: 'e1', reason: 'error', message: 'rate limited' });

    expect(latestReplies(queryClient)).toEqual(['Agent execution failed.']);
  });

  it('still names the tool when a denial frame carries no message', () => {
    expect(failedRunReply('tool_denied', 'slack_post')).toBe('Execution stopped: "slack_post" was denied.');
    expect(failedRunReply('tool_denied')).toBe('Execution stopped: a tool call was denied.');
  });
});

describe('useAgentExecutionDispatch -- watching a run by id (subscribe)', () => {
  beforeEach(() => {
    ws.sendJsonMessage.mockClear();
    ws.readyState = 3; // CLOSED
    Object.keys(handlers).forEach(k => delete handlers[k]);
    useAgentExecutionStore.getState().clearAll();
  });

  const sent = () => ws.sendJsonMessage.mock.calls.map(c => c[0] as Record<string, unknown>);
  const mountDispatch = () => renderHook(() => useAgentExecutionDispatch()).result.current;
  const step = (iteration: number, timestamp: number, content = `step ${timestamp}`) => ({
    type: 'thought' as const,
    content,
    metadata: { timestamp, iteration },
  });
  const snapshot = (requestId: unknown, steps: ReturnType<typeof step>[], iterationCount = 0) =>
    handlers['reconnect_result']({
      action: 'reconnect_result',
      requestId,
      found: true,
      executionId: 'run-1',
      sessionId: 'loop-session',
      status: 'running',
      iterationCount,
      steps,
    });

  it('sends subscribe (never reconnect) and marks the run as viewed', () => {
    mountDispatch().subscribe('run-1');
    expect(sent()).toEqual([
      { action: 'agent_execute', command: 'subscribe', requestId: expect.any(String), executionId: 'run-1' },
    ]);
    expect(useAgentExecutionStore.getState().viewedExecutionIds['run-1']).toBe('pending');
  });

  it('does nothing for a run this tab already streams from chat', () => {
    useAgentExecutionStore.getState().startExecution('run-1', 'sess-1');
    mountDispatch().subscribe('run-1');
    expect(sent()).toEqual([]);
  });

  it('marks the viewer not found on a bare found:false', async () => {
    mountSubscriptions();
    mountDispatch().subscribe('run-1');
    await handlers['reconnect_result']({ action: 'reconnect_result', requestId: sent()[0].requestId, found: false });
    expect(useAgentExecutionStore.getState().viewedExecutionIds['run-1']).toBe('not_found');
  });

  it('leaves a viewed run out of the socket-up sweep (its AgentRunViewer re-subscribes)', async () => {
    mountDispatch().subscribe('run-1');
    mountSubscriptions();
    await snapshot(sent()[0].requestId, []);
    ws.sendJsonMessage.mockClear();

    ws.readyState = 1; // OPEN
    mountSubscriptions();

    expect(sent()).toEqual([]);
  });

  it('renders each step once when the live stream overlaps the snapshot', async () => {
    mountSubscriptions();
    mountDispatch().subscribe('run-1');
    await snapshot(sent()[0].requestId, [step(0, 1), step(0, 2)]);

    for (const s of [step(0, 2), step(1, 3)]) {
      await handlers['iteration_step']({
        action: 'iteration_step',
        executionId: 'run-1',
        iteration: s.metadata.iteration,
        step: s,
        isComplete: false,
      });
    }

    const iterations = useAgentExecutionStore.getState().executions['run-1'].iterations;
    expect(iterations.map(it => it.step.metadata?.timestamp)).toEqual([1, 2, 3]);
    expect(useAgentExecutionStore.getState().viewedExecutionIds['run-1']).toBe('found');
  });

  it('re-subscribes exactly once when a live step skips ahead', async () => {
    mountSubscriptions();
    mountDispatch().subscribe('run-1');
    await snapshot(sent()[0].requestId, [step(0, 1)], 0);
    ws.sendJsonMessage.mockClear();

    for (const [iteration, timestamp] of [
      [3, 10],
      [3, 11],
    ]) {
      await handlers['iteration_step']({
        action: 'iteration_step',
        executionId: 'run-1',
        iteration,
        step: step(iteration, timestamp),
        isComplete: false,
      });
    }

    expect(sent().map(m => m.command)).toEqual(['subscribe']);
  });

  it('does not patch a chat bubble for a viewed run', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['quests', 'session', 'loop-session'], { pages: [] });
    const setSpy = vi.spyOn(queryClient, 'setQueryData');
    mountSubscriptions(queryClient);
    mountDispatch().subscribe('run-1');
    await snapshot(sent()[0].requestId, []);
    setSpy.mockClear();

    await handlers['completed']({ action: 'completed', executionId: 'run-1', answer: 'done', totalCreditsUsed: 4 });

    expect(setSpy).not.toHaveBeenCalled();
    expect(useAgentExecutionStore.getState().executions['run-1'].status).toBe('completed');
  });

  it('unsubscribe tells the server and drops the run from the store', async () => {
    mountSubscriptions();
    const dispatch = mountDispatch();
    dispatch.subscribe('run-1');
    await snapshot(sent()[0].requestId, [step(0, 1)]);
    ws.sendJsonMessage.mockClear();

    dispatch.unsubscribe('run-1');

    expect(sent()).toEqual([{ action: 'agent_execute', command: 'unsubscribe', executionId: 'run-1' }]);
    expect(useAgentExecutionStore.getState().executions['run-1']).toBeUndefined();
    expect(useAgentExecutionStore.getState().viewedExecutionIds['run-1']).toBe('closed');
  });

  it("keeps a finished run's outcome from the snapshot", async () => {
    mountSubscriptions();
    const dispatch = mountDispatch();
    dispatch.subscribe('run-1');
    dispatch.subscribe('run-2');
    const [done, broke] = sent();
    await handlers['reconnect_result']({
      action: 'reconnect_result',
      requestId: done.requestId,
      found: true,
      executionId: 'run-1',
      status: 'completed',
      steps: [{ type: 'final_answer', content: 'All done', metadata: { timestamp: 1, iteration: 0 } }],
      answer: 'All done',
    });
    await handlers['reconnect_result']({
      action: 'reconnect_result',
      requestId: broke.requestId,
      found: true,
      executionId: 'run-2',
      status: 'failed',
      failureReason: 'insufficient_credits',
      errorMessage: 'Out of credits',
    });

    const { executions } = useAgentExecutionStore.getState();
    expect(executions['run-1']).toMatchObject({ status: 'completed', answer: 'All done' });
    expect(executions['run-2']).toMatchObject({
      status: 'failed',
      failureReason: 'insufficient_credits',
      errorMessage: 'Out of credits',
    });
  });

  it('takes the answer from the REST trace when the snapshot was truncated', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answer: 'Big answer', steps: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      mountSubscriptions();
      mountDispatch().subscribe('run-1');
      await handlers['reconnect_result']({
        action: 'reconnect_result',
        requestId: sent()[0].requestId,
        found: true,
        executionId: 'run-1',
        status: 'completed',
        stepsTruncated: true,
      });

      await vi.waitFor(() => expect(useAgentExecutionStore.getState().executions['run-1']?.answer).toBe('Big answer'));
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-executions/run-1', expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops frames that arrive after unsubscribe, so the run is never taken over on socket-up', async () => {
    mountSubscriptions();
    const dispatch = mountDispatch();
    dispatch.subscribe('run-1');
    const firstRequest = sent()[0].requestId;
    dispatch.unsubscribe('run-1');
    ws.sendJsonMessage.mockClear();

    await handlers['agent_text_delta']({ action: 'agent_text_delta', executionId: 'run-1', iteration: 0, delta: 'x' });
    await snapshot(firstRequest, [step(0, 1)]);
    expect(useAgentExecutionStore.getState().executions['run-1']).toBeUndefined();
    expect(useAgentExecutionStore.getState().viewedExecutionIds['run-1']).toBe('closed');

    ws.readyState = 1; // OPEN
    mountSubscriptions();
    expect(sent()).toEqual([]);

    dispatch.subscribe('run-1');
    expect(sent().map(m => m.command)).toEqual(['subscribe']);
    expect(useAgentExecutionStore.getState().viewedExecutionIds['run-1']).toBe('pending');
  });
});
