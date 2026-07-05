import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentExecutionStore, selectPendingApprovalForSession, findChildAnyDepth } from './useAgentExecutionStore';

// Reset only the data fields between tests - using setState's replace flag
// would wipe out the action functions too. The store is module-scoped, so
// without this reset each test would inherit residue from prior ones.
const resetStore = () =>
  useAgentExecutionStore.setState({ executions: {}, pendingDispatches: [], pendingReconnects: [] });

describe('useAgentExecutionStore — pending dispatch FIFO queue', () => {
  beforeEach(resetStore);

  it('registerPendingDispatch enqueues in order', () => {
    const { registerPendingDispatch } = useAgentExecutionStore.getState();
    registerPendingDispatch('session-A');
    registerPendingDispatch('session-B');
    expect(useAgentExecutionStore.getState().pendingDispatches).toEqual(['session-A', 'session-B']);
  });

  it('consumePendingDispatch drains FIFO and returns the head', () => {
    const { registerPendingDispatch, consumePendingDispatch } = useAgentExecutionStore.getState();
    registerPendingDispatch('session-A');
    registerPendingDispatch('session-B');

    expect(consumePendingDispatch()).toBe('session-A');
    expect(useAgentExecutionStore.getState().pendingDispatches).toEqual(['session-B']);

    expect(useAgentExecutionStore.getState().consumePendingDispatch()).toBe('session-B');
    expect(useAgentExecutionStore.getState().pendingDispatches).toEqual([]);
  });

  it('consumePendingDispatch returns undefined when the queue is empty (no-op drain)', () => {
    expect(useAgentExecutionStore.getState().consumePendingDispatch()).toBeUndefined();
    expect(useAgentExecutionStore.getState().pendingDispatches).toEqual([]);
  });
});

describe('useAgentExecutionStore — startExecution', () => {
  beforeEach(resetStore);

  it('creates a new execution with the supplied sessionId and status=running', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'session-A');
    const exec = useAgentExecutionStore.getState().executions['exec-1'];
    expect(exec).toBeDefined();
    expect(exec.sessionId).toBe('session-A');
    expect(exec.status).toBe('running');
    expect(exec.iterations).toEqual([]);
  });

  it('preserves an existing sessionId when called again without one', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'session-A');
    useAgentExecutionStore.getState().startExecution('exec-1', undefined);
    expect(useAgentExecutionStore.getState().executions['exec-1'].sessionId).toBe('session-A');
  });
});

describe('useAgentExecutionStore — clearForSession', () => {
  beforeEach(resetStore);

  it('removes executions bound to the target session and keeps others', () => {
    const { startExecution, clearForSession } = useAgentExecutionStore.getState();
    startExecution('exec-a1', 'session-A');
    startExecution('exec-a2', 'session-A');
    startExecution('exec-b1', 'session-B');

    clearForSession('session-A');

    const remaining = Object.keys(useAgentExecutionStore.getState().executions);
    expect(remaining).toEqual(['exec-b1']);
  });

  it('drains pendingDispatches entries for the target session (P3-1 fix)', () => {
    const { registerPendingDispatch, clearForSession } = useAgentExecutionStore.getState();
    registerPendingDispatch('session-A');
    registerPendingDispatch('session-B');
    registerPendingDispatch('session-A');

    clearForSession('session-A');

    expect(useAgentExecutionStore.getState().pendingDispatches).toEqual(['session-B']);
  });

  it('leaves the queue untouched when no entries match', () => {
    useAgentExecutionStore.getState().registerPendingDispatch('session-B');
    useAgentExecutionStore.getState().clearForSession('session-A');
    expect(useAgentExecutionStore.getState().pendingDispatches).toEqual(['session-B']);
  });
});

describe('useAgentExecutionStore — pending reconnect FIFO queue', () => {
  beforeEach(resetStore);

  it('registerPendingReconnect enqueues in order', () => {
    const { registerPendingReconnect } = useAgentExecutionStore.getState();
    registerPendingReconnect('session-A');
    registerPendingReconnect('session-B');
    expect(useAgentExecutionStore.getState().pendingReconnects).toEqual(['session-A', 'session-B']);
  });

  it('consumePendingReconnect drains FIFO and returns the head', () => {
    const { registerPendingReconnect, consumePendingReconnect } = useAgentExecutionStore.getState();
    registerPendingReconnect('session-A');
    registerPendingReconnect('session-B');

    expect(consumePendingReconnect()).toBe('session-A');
    expect(useAgentExecutionStore.getState().pendingReconnects).toEqual(['session-B']);

    expect(useAgentExecutionStore.getState().consumePendingReconnect()).toBe('session-B');
    expect(useAgentExecutionStore.getState().pendingReconnects).toEqual([]);
  });

  it('consumePendingReconnect returns undefined when the queue is empty', () => {
    expect(useAgentExecutionStore.getState().consumePendingReconnect()).toBeUndefined();
  });
});

describe('useAgentExecutionStore — hydrateFromReconnect', () => {
  beforeEach(resetStore);

  it('stamps sessionId so the execution shows up in selectExecutionIdsForSession', async () => {
    useAgentExecutionStore.getState().hydrateFromReconnect({
      executionId: 'exec-rehydrated',
      sessionId: 'session-A',
      status: 'running',
      totalCreditsUsed: 12,
      iterationCount: 3,
    });

    const exec = useAgentExecutionStore.getState().executions['exec-rehydrated'];
    expect(exec.sessionId).toBe('session-A');
    expect(exec.status).toBe('running');
    expect(exec.totalCreditsUsed).toBe(12);
    expect(exec.lastKnownIteration).toBe(3);

    const { selectExecutionIdsForSession } = await import('./useAgentExecutionStore');
    expect(selectExecutionIdsForSession('session-A')(useAgentExecutionStore.getState())).toEqual(['exec-rehydrated']);
  });

  it('preserves higher live lastKnownIteration when a smaller snapshot arrives', () => {
    const { appendIteration, hydrateFromReconnect } = useAgentExecutionStore.getState();
    // Simulate a few live iterations already streamed
    appendIteration('exec-1', {
      iteration: 4,
      step: { type: 'thought', content: '' },
      isComplete: false,
      receivedAt: 0,
    });
    hydrateFromReconnect({
      executionId: 'exec-1',
      sessionId: 'session-A',
      status: 'running',
      totalCreditsUsed: 5,
      iterationCount: 2,
    });
    expect(useAgentExecutionStore.getState().executions['exec-1'].lastKnownIteration).toBe(4);
  });

  it('preserves an existing sessionId when the snapshot omits one', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'session-A');
    useAgentExecutionStore.getState().hydrateFromReconnect({
      executionId: 'exec-1',
      status: 'running',
      totalCreditsUsed: 0,
      iterationCount: 1,
    });
    expect(useAgentExecutionStore.getState().executions['exec-1'].sessionId).toBe('session-A');
  });

  // --- Step replay ---

  it('replaces iterations when the snapshot includes them', () => {
    const { appendIteration, hydrateFromReconnect } = useAgentExecutionStore.getState();
    // Pre-existing live iteration that should be wiped by the authoritative replay.
    appendIteration('exec-replay', {
      iteration: 0,
      step: { type: 'thought', content: 'live-stale' },
      isComplete: false,
      receivedAt: 1,
    });
    hydrateFromReconnect({
      executionId: 'exec-replay',
      sessionId: 'session-A',
      status: 'running',
      totalCreditsUsed: 7,
      iterationCount: 2,
      iterations: [
        { iteration: 0, step: { type: 'thought', content: 'replay-0' }, isComplete: false, receivedAt: 10 },
        { iteration: 0, step: { type: 'action', content: 'replay-1' }, isComplete: false, receivedAt: 11 },
        { iteration: 1, step: { type: 'observation', content: 'replay-2' }, isComplete: false, receivedAt: 12 },
      ],
    });
    const exec = useAgentExecutionStore.getState().executions['exec-replay'];
    expect(exec.iterations).toHaveLength(3);
    expect(exec.iterations[0]?.step.content).toBe('replay-0');
    expect(exec.iterations[2]?.iteration).toBe(1);
  });

  // Models the REST-fallback race window in `useAgentExecution`: WS
  // `reconnect_result` arrives with `stepsTruncated: true`, a live
  // `iteration_step` event lands before the fetch resolves, then the
  // `replaceIterations` call merges replayed + dedup(live). The merge must
  // preserve the live step exactly once even when the replayed snapshot
  // overlaps with it (Lambda persisted the same step before the fetch ran).
  it('replaceIterations + live append survives the REST-fallback merge race', () => {
    const { hydrateFromReconnect, appendIteration, replaceIterations } = useAgentExecutionStore.getState();

    // (1) WS `reconnect_result` with stepsTruncated - iterations omitted,
    //     live state established.
    hydrateFromReconnect({
      executionId: 'exec-race',
      sessionId: 'session-A',
      status: 'running',
      totalCreditsUsed: 4,
      iterationCount: 5,
      // iterations intentionally omitted - server signaled stepsTruncated.
    });

    // (2) A live `iteration_step` event lands during the fetch window.
    //     receivedAt=1000 simulates the agent emit-time stamp the server
    //     also persists into checkpoint.steps[].metadata.timestamp.
    appendIteration('exec-race', {
      iteration: 5,
      step: { type: 'thought', content: 'live-during-fetch' },
      isComplete: false,
      receivedAt: 1000,
    });

    // (3) REST resolves: replayed checkpoint includes earlier iterations
    //     PLUS the just-emitted step (Lambda persisted it before fetch
    //     read). The fallback path deduplicates by receivedAt, so the
    //     final merged trace must contain that step exactly once.
    const replayed = [
      { iteration: 0, step: { type: 'thought' as const, content: 'iter-0' }, isComplete: false, receivedAt: 100 },
      { iteration: 1, step: { type: 'thought' as const, content: 'iter-1' }, isComplete: false, receivedAt: 200 },
      {
        iteration: 5,
        step: { type: 'thought' as const, content: 'live-during-fetch' },
        isComplete: false,
        receivedAt: 1000,
      },
    ];
    const currentIterations = useAgentExecutionStore.getState().executions['exec-race'].iterations;
    const liveBaselineLength = 0; // simulating: nothing in store at reconnect_result time
    const liveSinceReplay = currentIterations.slice(liveBaselineLength);
    const replayedTimestamps = new Set(replayed.map(s => s.receivedAt));
    const deduped = liveSinceReplay.filter(s => !replayedTimestamps.has(s.receivedAt));
    replaceIterations('exec-race', [...replayed, ...deduped]);

    const exec = useAgentExecutionStore.getState().executions['exec-race'];
    expect(exec.iterations).toHaveLength(3);
    expect(exec.iterations.filter(s => s.receivedAt === 1000)).toHaveLength(1);
    // Authoritative state from the WS message must not be clobbered.
    expect(exec.status).toBe('running');
    expect(exec.totalCreditsUsed).toBe(4);
  });

  // Regression guard: the REST-fallback path must NOT clear a
  // pendingPermission that arrived between the WS `reconnect_result` and the
  // fetch resolving. `replaceIterations` is the chosen action specifically
  // because `hydrateFromReconnect` would overwrite `pendingPermission` from a
  // stale closure of the original WS message.
  it('replaceIterations does not touch pendingPermission / status / credits', () => {
    const { hydrateFromReconnect, setPendingPermission, replaceIterations } = useAgentExecutionStore.getState();
    hydrateFromReconnect({
      executionId: 'exec-perm',
      sessionId: 'session-A',
      status: 'running',
      totalCreditsUsed: 9,
      iterationCount: 2,
    });
    // Permission request arrives mid-fetch.
    setPendingPermission('exec-perm', {
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      iteration: 2,
      requestedAt: 1234,
    });
    replaceIterations('exec-perm', [
      { iteration: 0, step: { type: 'thought', content: 'replayed' }, isComplete: false, receivedAt: 100 },
    ]);
    const exec = useAgentExecutionStore.getState().executions['exec-perm'];
    expect(exec.pendingPermission?.toolName).toBe('shell');
    expect(exec.status).toBe('awaiting_permission');
    expect(exec.totalCreditsUsed).toBe(9);
    expect(exec.iterations).toHaveLength(1);
  });

  it('keeps existing iterations when the snapshot omits them (legacy / large-trace fallback)', () => {
    const { appendIteration, hydrateFromReconnect } = useAgentExecutionStore.getState();
    appendIteration('exec-keep', {
      iteration: 0,
      step: { type: 'thought', content: 'kept-step' },
      isComplete: false,
      receivedAt: 1,
    });
    hydrateFromReconnect({
      executionId: 'exec-keep',
      sessionId: 'session-A',
      status: 'running',
      totalCreditsUsed: 3,
      iterationCount: 1,
      // iterations intentionally omitted - server signaled stepsTruncated and
      // the REST fallback hasn't resolved yet.
    });
    const exec = useAgentExecutionStore.getState().executions['exec-keep'];
    expect(exec.iterations).toHaveLength(1);
    expect(exec.iterations[0]?.step.content).toBe('kept-step');
  });

  // --- Subagent replay ---

  it('replaces childExecutions when the snapshot includes them', () => {
    const { startChild, hydrateFromReconnect } = useAgentExecutionStore.getState();
    // A pre-existing live child that should be wiped by the authoritative replay.
    startChild('exec-children', {
      childExecutionId: 'stale-child',
      agentName: 'StaleAgent',
      isBackground: false,
    });
    hydrateFromReconnect({
      executionId: 'exec-children',
      sessionId: 'session-A',
      status: 'completed',
      totalCreditsUsed: 7,
      iterationCount: 4,
      childExecutions: {
        'child-1': {
          executionId: 'child-1',
          agentName: 'Market Analyst',
          status: 'completed',
          iterations: [
            { iteration: 0, step: { type: 'thought', content: 'child-thought' }, isComplete: true, receivedAt: 10 },
          ],
          isBackground: false,
        },
      },
    });
    const exec = useAgentExecutionStore.getState().executions['exec-children'];
    expect(Object.keys(exec.childExecutions)).toEqual(['child-1']);
    expect(exec.childExecutions['child-1']?.agentName).toBe('Market Analyst');
    expect(exec.childExecutions['child-1']?.iterations).toHaveLength(1);
  });

  it('wipes stale children when the snapshot ships an authoritative empty map ({})', () => {
    // `buildChildren` returns `{}` (NOT undefined) when the server explicitly
    // sent `children: []` - an authoritative "this run has no children" signal
    // that must clear leftovers from a prior run in this tab. This guards the
    // `?? exec.childExecutions` semantic against a refactor to `||` (which would
    // treat the empty `{}` as falsy and wrongly keep the stale entries).
    const { startChild, hydrateFromReconnect } = useAgentExecutionStore.getState();
    startChild('exec-empty-wipe', {
      childExecutionId: 'stale-from-prior-run',
      agentName: 'StaleAgent',
      isBackground: false,
    });
    hydrateFromReconnect({
      executionId: 'exec-empty-wipe',
      sessionId: 'session-A',
      status: 'completed',
      totalCreditsUsed: 0,
      iterationCount: 0,
      childExecutions: {}, // authoritative empty
    });
    const exec = useAgentExecutionStore.getState().executions['exec-empty-wipe'];
    expect(Object.keys(exec.childExecutions)).toEqual([]);
  });

  it('keeps existing childExecutions when the snapshot omits them (childrenTruncated fallback)', () => {
    const { startChild, hydrateFromReconnect } = useAgentExecutionStore.getState();
    startChild('exec-keep-children', {
      childExecutionId: 'live-child',
      agentName: 'LiveAgent',
      isBackground: false,
    });
    hydrateFromReconnect({
      executionId: 'exec-keep-children',
      sessionId: 'session-A',
      status: 'running',
      totalCreditsUsed: 0,
      iterationCount: 0,
      // childExecutions intentionally omitted - server signaled
      // childrenTruncated and the REST fallback hasn't resolved yet.
    });
    const exec = useAgentExecutionStore.getState().executions['exec-keep-children'];
    expect(Object.keys(exec.childExecutions)).toEqual(['live-child']);
    expect(exec.childExecutions['live-child']?.agentName).toBe('LiveAgent');
  });

  it('setChildExecutions swaps the map without touching status/credits/permission', () => {
    const { hydrateFromReconnect, setPendingPermission, setChildExecutions } = useAgentExecutionStore.getState();
    hydrateFromReconnect({
      executionId: 'exec-rcx',
      sessionId: 'session-A',
      status: 'running',
      totalCreditsUsed: 15,
      iterationCount: 3,
    });
    setPendingPermission('exec-rcx', {
      toolName: 'shell',
      toolInput: {},
      iteration: 3,
      requestedAt: 9999,
    });
    setChildExecutions('exec-rcx', {
      'child-A': {
        executionId: 'child-A',
        agentName: 'Researcher',
        status: 'completed',
        iterations: [],
        isBackground: false,
      },
    });
    const exec = useAgentExecutionStore.getState().executions['exec-rcx'];
    expect(exec.status).toBe('awaiting_permission');
    expect(exec.totalCreditsUsed).toBe(15);
    expect(exec.pendingPermission?.toolName).toBe('shell');
    expect(Object.keys(exec.childExecutions)).toEqual(['child-A']);
  });

  it('mergeChildExecutions applies prefer-more-iterations contract via the store', () => {
    // Sanity test that the store action wires the helper correctly. The full
    // merge contract is exercised in mergeChildExecutions.test.ts; this just
    // confirms the wiring (and that the new action is reachable from state).
    const { startChild, mergeChildExecutions } = useAgentExecutionStore.getState();
    startChild('exec-merge', {
      childExecutionId: 'c-live',
      agentName: 'LiveAgent',
      isBackground: false,
    });
    // Live entry has 0 iterations. Replayed has 1 -> REST wins for this child.
    mergeChildExecutions('exec-merge', {
      'c-live': {
        executionId: 'c-live',
        agentName: 'RESTAgent',
        status: 'completed',
        iterations: [{ iteration: 0, step: { type: 'thought', content: 'replay' }, isComplete: true, receivedAt: 1 }],
        isBackground: false,
      },
    });
    const child = useAgentExecutionStore.getState().executions['exec-merge'].childExecutions['c-live'];
    expect(child?.agentName).toBe('RESTAgent');
    expect(child?.iterations).toHaveLength(1);
  });
});

describe('useAgentExecutionStore — selectExecutionIdsForSession', () => {
  beforeEach(resetStore);

  it('returns ids sorted by startedAt for the requested session only', async () => {
    const { startExecution } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    // Force a measurable startedAt gap so the sort is deterministic on fast hardware.
    await new Promise(r => setTimeout(r, 2));
    startExecution('exec-2', 'session-A');
    await new Promise(r => setTimeout(r, 2));
    startExecution('exec-3', 'session-B');

    const { selectExecutionIdsForSession } = await import('./useAgentExecutionStore');
    const ids = selectExecutionIdsForSession('session-A')(useAgentExecutionStore.getState());
    expect(ids).toEqual(['exec-1', 'exec-2']);
  });

  it('returns an empty array for a falsy sessionId', async () => {
    const { selectExecutionIdsForSession } = await import('./useAgentExecutionStore');
    expect(selectExecutionIdsForSession(null)(useAgentExecutionStore.getState())).toEqual([]);
    expect(selectExecutionIdsForSession(undefined)(useAgentExecutionStore.getState())).toEqual([]);
    expect(selectExecutionIdsForSession('')(useAgentExecutionStore.getState())).toEqual([]);
  });
});

// `recordCredits` is the live-tick path driven by server `progress.creditsUsed`
// events. CreditCounter reads `totalCreditsUsed` as a primitive, so
// the reducer must accumulate deltas (each progress event adds, never replaces)
// - anything else would either lose ticks (replace) or double-count (multiply).
describe('useAgentExecutionStore — recordCredits', () => {
  beforeEach(resetStore);

  it('accumulates additive deltas across calls (live progress ticks)', () => {
    const { startExecution, recordCredits } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    recordCredits('exec-1', 12);
    recordCredits('exec-1', 25);
    recordCredits('exec-1', 7);
    expect(useAgentExecutionStore.getState().executions['exec-1'].totalCreditsUsed).toBe(44);
  });

  it('creates an empty execution at totalCreditsUsed=credits if the id was unknown', () => {
    // Defensive path - a stray `progress` event arriving before
    // `execution_started` shouldn't be lost; the store materialises the
    // execution lazily via withExecution's emptyExecution fallback.
    useAgentExecutionStore.getState().recordCredits('exec-orphan', 5);
    expect(useAgentExecutionStore.getState().executions['exec-orphan'].totalCreditsUsed).toBe(5);
  });

  it('does not leak credits across executions', () => {
    const { startExecution, recordCredits } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    startExecution('exec-2', 'session-A');
    recordCredits('exec-1', 50);
    recordCredits('exec-2', 30);
    const { executions } = useAgentExecutionStore.getState();
    expect(executions['exec-1'].totalCreditsUsed).toBe(50);
    expect(executions['exec-2'].totalCreditsUsed).toBe(30);
  });
});

// `markCompleted` is the terminal authoritative-replace path. The server's
// `completed.totalCreditsUsed` is the source of truth (re-read from the DB at
// run end - see agentExecutor.ts) and must overwrite any accumulated total
// from progress deltas, since intermediate progress emits can race with the
// final DB-backed figure.
describe('useAgentExecutionStore — markCompleted', () => {
  beforeEach(resetStore);

  it('replaces totalCreditsUsed with the authoritative server figure', () => {
    const { startExecution, recordCredits, markCompleted } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    recordCredits('exec-1', 12);
    recordCredits('exec-1', 25);
    // Server's final tally (e.g. includes a billing record that didn't fire
    // a progress event, or corrects for rounding across iterations).
    markCompleted('exec-1', 'final answer', 50);
    const exec = useAgentExecutionStore.getState().executions['exec-1'];
    expect(exec.totalCreditsUsed).toBe(50);
    expect(exec.status).toBe('completed');
    expect(exec.answer).toBe('final answer');
  });

  it('handles a 0 final total without falling back to the accumulated value', () => {
    // If the server reports 0 credits (free-tool-only run), the counter
    // must show 0 - never persist a stale non-zero from progress ticks.
    const { startExecution, recordCredits, markCompleted } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    recordCredits('exec-1', 5);
    markCompleted('exec-1', undefined, 0);
    expect(useAgentExecutionStore.getState().executions['exec-1'].totalCreditsUsed).toBe(0);
  });
});

describe('useAgentExecutionStore — startChild / selectActiveBackgroundChildrenForSession', () => {
  beforeEach(resetStore);

  it('threads isBackground onto the ChildExecution shape', () => {
    const { startExecution, startChild } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    startChild('exec-1', { childExecutionId: 'child-1', agentName: 'Researcher', isBackground: true });
    startChild('exec-1', { childExecutionId: 'child-2', agentName: 'Inline' }); // omitted -> falsy

    const exec = useAgentExecutionStore.getState().executions['exec-1'];
    expect(exec.childExecutions['child-1'].isBackground).toBe(true);
    expect(exec.childExecutions['child-2'].isBackground).toBeUndefined();
  });

  it('selectActiveBackgroundChildrenForSession returns only active background children for that session', async () => {
    const { startExecution, startChild, completeChild } = useAgentExecutionStore.getState();
    startExecution('exec-a', 'session-A');
    startChild('exec-a', { childExecutionId: 'bg-1', agentName: 'Researcher', isBackground: true });
    startChild('exec-a', { childExecutionId: 'bg-2', agentName: 'Analyst', isBackground: true });
    startChild('exec-a', { childExecutionId: 'fg-1', agentName: 'Inline', isBackground: false });
    // Complete one of the background children - should drop out of the active list.
    completeChild('exec-a', 'bg-2', { totalCredits: 5, iterations: 1, finalAnswer: 'done' });

    startExecution('exec-b', 'session-B');
    startChild('exec-b', { childExecutionId: 'bg-3', agentName: 'OtherSession', isBackground: true });

    const { selectActiveBackgroundChildrenForSession } = await import('./useAgentExecutionStore');
    const result = selectActiveBackgroundChildrenForSession('session-A')(useAgentExecutionStore.getState());
    expect(result.map(r => r.child.executionId)).toEqual(['bg-1']);
    expect(result[0].parentExecutionId).toBe('exec-a');
  });

  it('returns empty array for falsy sessionId', async () => {
    const { selectActiveBackgroundChildrenForSession } = await import('./useAgentExecutionStore');
    expect(selectActiveBackgroundChildrenForSession(null)(useAgentExecutionStore.getState())).toEqual([]);
    expect(selectActiveBackgroundChildrenForSession(undefined)(useAgentExecutionStore.getState())).toEqual([]);
    expect(selectActiveBackgroundChildrenForSession('')(useAgentExecutionStore.getState())).toEqual([]);
  });

  // Regression guard for the getSnapshot-caching fix (React's "getSnapshot
  // should be cached" invariant): when the underlying child reference hasn't
  // mutated, successive selector calls must return the SAME wrapper objects so
  // `useShallow`'s index-wise `===` comparison short-circuits the re-render in
  // `BackgroundAgentBadge`. Without the WeakMap cache, this assertion fails and
  // the badge re-renders forever.
  it('selectActiveBackgroundChildrenForSession returns stable wrapper references across calls', async () => {
    const { startExecution, startChild } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    startChild('exec-1', { childExecutionId: 'bg-1', agentName: 'Researcher', isBackground: true });
    startChild('exec-1', { childExecutionId: 'bg-2', agentName: 'Analyst', isBackground: true });

    const { selectActiveBackgroundChildrenForSession } = await import('./useAgentExecutionStore');
    const selector = selectActiveBackgroundChildrenForSession('session-A');
    const first = selector(useAgentExecutionStore.getState());
    const second = selector(useAgentExecutionStore.getState());

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    // Wrapper objects must be the SAME reference - this is the invariant the
    // getSnapshot-caching fix depends on. A new `{ parentExecutionId, child }`
    // per call would defeat `useShallow` and trigger the infinite render loop.
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  // Companion guard for the empty path: returning a fresh `[]` each call would
  // also break `useShallow` (different array refs even with length 0). The
  // `EMPTY_BG_CHILDREN` singleton ensures the empty case returns the same
  // reference every time.
  it('selectActiveBackgroundChildrenForSession returns the same empty-array reference across calls', async () => {
    const { selectActiveBackgroundChildrenForSession } = await import('./useAgentExecutionStore');
    const a = selectActiveBackgroundChildrenForSession('session-unknown')(useAgentExecutionStore.getState());
    const b = selectActiveBackgroundChildrenForSession('session-unknown')(useAgentExecutionStore.getState());
    expect(a).toEqual([]);
    expect(b).toBe(a);
  });
});

describe('useAgentExecutionStore — setChildProgress', () => {
  beforeEach(resetStore);

  it('stores lastProgress on an existing child', () => {
    const { startExecution, startChild, setChildProgress } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    startChild('exec-1', { childExecutionId: 'child-1', agentName: 'Researcher' });
    setChildProgress('exec-1', 'child-1', 'Searching...');

    const child = useAgentExecutionStore.getState().executions['exec-1'].childExecutions['child-1'];
    expect(child.lastProgress).toBe('Searching...');
  });

  it('overwrites with the most recent progress string', () => {
    const { startExecution, startChild, setChildProgress } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    startChild('exec-1', { childExecutionId: 'child-1', agentName: 'Researcher' });
    setChildProgress('exec-1', 'child-1', 'Searching...');
    setChildProgress('exec-1', 'child-1', 'Reading file...');

    const child = useAgentExecutionStore.getState().executions['exec-1'].childExecutions['child-1'];
    expect(child.lastProgress).toBe('Reading file...');
  });

  // Guard against a stray `subagent_progress` arriving before `subagent_started`
  // (out-of-order WS events, race on reconnect). Do NOT auto-create a
  // placeholder child for progress - the string alone has no agentName context,
  // so an "unknown" child would surface in the UI until the next event.
  it('is a no-op when the child has not been started yet', () => {
    const { startExecution, setChildProgress } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    setChildProgress('exec-1', 'never-started', 'Searching...');

    const exec = useAgentExecutionStore.getState().executions['exec-1'];
    expect(exec.childExecutions['never-started']).toBeUndefined();
  });

  it('is a no-op when the parent execution does not exist', () => {
    const { setChildProgress } = useAgentExecutionStore.getState();
    setChildProgress('missing-parent', 'child-1', 'Searching...');

    expect(useAgentExecutionStore.getState().executions['missing-parent']).toBeUndefined();
  });
});

describe('useAgentExecutionStore — selectPendingApprovalForSession', () => {
  beforeEach(resetStore);

  const pending = { toolName: 'send_slack_message', toolInput: {}, iteration: 2, requestedAt: 1 };

  it('returns null when no execution in the session is awaiting permission', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'session-A');
    expect(selectPendingApprovalForSession('session-A')(useAgentExecutionStore.getState())).toBeNull();
  });

  it('returns the executionId and toolName of an awaiting-permission execution', () => {
    const { startExecution, setPendingPermission } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    setPendingPermission('exec-1', pending);

    expect(selectPendingApprovalForSession('session-A')(useAgentExecutionStore.getState())).toEqual({
      executionId: 'exec-1',
      toolName: 'send_slack_message',
    });
  });

  it('ignores pending approvals belonging to a different session', () => {
    const { startExecution, setPendingPermission } = useAgentExecutionStore.getState();
    startExecution('exec-b', 'session-B');
    setPendingPermission('exec-b', pending);

    expect(selectPendingApprovalForSession('session-A')(useAgentExecutionStore.getState())).toBeNull();
  });

  it('returns the earliest-started execution when several are awaiting permission', () => {
    const { startExecution, setPendingPermission } = useAgentExecutionStore.getState();
    startExecution('exec-late', 'session-A');
    startExecution('exec-early', 'session-A');
    // Force a deterministic ordering regardless of startExecution's clock.
    useAgentExecutionStore.setState(state => ({
      executions: {
        ...state.executions,
        'exec-early': { ...state.executions['exec-early'], startedAt: 1 },
        'exec-late': { ...state.executions['exec-late'], startedAt: 2 },
      },
    }));
    setPendingPermission('exec-late', pending);
    setPendingPermission('exec-early', { ...pending, toolName: 'web_search' });

    expect(selectPendingApprovalForSession('session-A')(useAgentExecutionStore.getState())).toEqual({
      executionId: 'exec-early',
      toolName: 'web_search',
    });
  });

  it('returns null for a null/undefined sessionId', () => {
    expect(selectPendingApprovalForSession(null)(useAgentExecutionStore.getState())).toBeNull();
    expect(selectPendingApprovalForSession(undefined)(useAgentExecutionStore.getState())).toBeNull();
  });
});

// PermissionCard renders purely on `pendingPermission` presence, so a stale value
// leaves a dead permission prompt on a finished run. A terminal run can't have a
// live permission outstanding - clear it on terminal transitions, and on a
// reconnect only restore it for a still-active run.
describe('useAgentExecutionStore — clears stale pendingPermission on terminal runs', () => {
  beforeEach(resetStore);

  const PENDING = { toolName: 'shell', toolInput: { cmd: 'ls' }, iteration: 1, requestedAt: 1234 };

  const seedAwaitingPermission = (executionId: string) => {
    const { startExecution, setPendingPermission } = useAgentExecutionStore.getState();
    startExecution(executionId, 'session-A');
    setPendingPermission(executionId, PENDING);
    // Sanity: the card would show now.
    expect(useAgentExecutionStore.getState().executions[executionId].pendingPermission).toEqual(PENDING);
  };

  it('markCompleted clears pendingPermission', () => {
    seedAwaitingPermission('exec-c');
    useAgentExecutionStore.getState().markCompleted('exec-c', 'done', 5);
    const exec = useAgentExecutionStore.getState().executions['exec-c'];
    expect(exec.status).toBe('completed');
    expect(exec.pendingPermission).toBeUndefined();
  });

  it('markFailed clears pendingPermission', () => {
    seedAwaitingPermission('exec-f');
    useAgentExecutionStore.getState().markFailed('exec-f', 'boom', 'it broke');
    const exec = useAgentExecutionStore.getState().executions['exec-f'];
    expect(exec.status).toBe('failed');
    expect(exec.pendingPermission).toBeUndefined();
  });

  it('markAborted clears pendingPermission', () => {
    seedAwaitingPermission('exec-a');
    useAgentExecutionStore.getState().markAborted('exec-a');
    const exec = useAgentExecutionStore.getState().executions['exec-a'];
    expect(exec.status).toBe('aborted');
    expect(exec.pendingPermission).toBeUndefined();
  });

  it('hydrateFromReconnect drops a stale pendingPermission for a TERMINAL run (the reconnect bug)', () => {
    useAgentExecutionStore.getState().hydrateFromReconnect({
      executionId: 'exec-recon-done',
      sessionId: 'session-A',
      status: 'completed',
      totalCreditsUsed: 3,
      iterationCount: 2,
      pendingPermission: PENDING,
    });
    const exec = useAgentExecutionStore.getState().executions['exec-recon-done'];
    expect(exec.status).toBe('completed');
    expect(exec.pendingPermission).toBeUndefined();
  });

  it('hydrateFromReconnect keeps pendingPermission for a still-ACTIVE run', () => {
    useAgentExecutionStore.getState().hydrateFromReconnect({
      executionId: 'exec-recon-active',
      sessionId: 'session-A',
      status: 'awaiting_permission',
      totalCreditsUsed: 1,
      iterationCount: 1,
      pendingPermission: PENDING,
    });
    const exec = useAgentExecutionStore.getState().executions['exec-recon-active'];
    expect(exec.pendingPermission).toEqual(PENDING);
  });
});

// --- findChildAnyDepth ---
// Grandchild subagent_* WS events were previously silently dropped because
// the handlers only searched top-level childExecutions maps. findChildAnyDepth
// walks the full recursive tree so events are routed to the correct node.

describe('findChildAnyDepth', () => {
  beforeEach(() => useAgentExecutionStore.setState({ executions: {}, pendingDispatches: [], pendingReconnects: [] }));

  it('returns undefined when the target is not in any execution', () => {
    useAgentExecutionStore.getState().startExecution('exec-1', 'session-A');
    const result = findChildAnyDepth(useAgentExecutionStore.getState().executions, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('returns undefined when there are no executions', () => {
    const result = findChildAnyDepth({}, 'child-1');
    expect(result).toBeUndefined();
  });

  it('finds a direct child at depth 1 with empty ancestorPath', () => {
    const { startExecution, startChild } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    startChild('exec-1', { childExecutionId: 'child-1', agentName: 'SubAgent', isBackground: false });

    const result = findChildAnyDepth(useAgentExecutionStore.getState().executions, 'child-1');
    expect(result).toEqual({ topLevelId: 'exec-1', ancestorPath: [] });
  });

  it('finds a grandchild at depth 2 with one-entry ancestorPath', () => {
    const { startExecution, startChild } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    startChild('exec-1', { childExecutionId: 'child-1', agentName: 'SubAgent', isBackground: false });
    // ancestorPath routes the grandchild into child-1's childExecutions map.
    startChild('exec-1', {
      childExecutionId: 'grandchild-1',
      agentName: 'Leaf',
      isBackground: false,
      ancestorPath: ['child-1'],
    });

    const result = findChildAnyDepth(useAgentExecutionStore.getState().executions, 'grandchild-1');
    expect(result).toEqual({ topLevelId: 'exec-1', ancestorPath: ['child-1'] });
  });

  it('finds a great-grandchild at depth 3 with two-entry ancestorPath', () => {
    const { startExecution, startChild } = useAgentExecutionStore.getState();
    startExecution('exec-1', 'session-A');
    startChild('exec-1', { childExecutionId: 'child-1', agentName: 'Sub', isBackground: false });
    startChild('exec-1', {
      childExecutionId: 'grandchild-1',
      agentName: 'Leaf',
      isBackground: false,
      ancestorPath: ['child-1'],
    });
    startChild('exec-1', {
      childExecutionId: 'ggc-1',
      agentName: 'Deep',
      isBackground: false,
      ancestorPath: ['child-1', 'grandchild-1'],
    });

    const result = findChildAnyDepth(useAgentExecutionStore.getState().executions, 'ggc-1');
    expect(result).toEqual({ topLevelId: 'exec-1', ancestorPath: ['child-1', 'grandchild-1'] });
  });

  it('returns the correct topLevelId when multiple executions are in the store', () => {
    const { startExecution, startChild } = useAgentExecutionStore.getState();
    startExecution('exec-A', 'session-A');
    startExecution('exec-B', 'session-B');
    startChild('exec-B', { childExecutionId: 'child-b', agentName: 'AgentB', isBackground: false });

    const result = findChildAnyDepth(useAgentExecutionStore.getState().executions, 'child-b');
    expect(result?.topLevelId).toBe('exec-B');
    expect(result?.ancestorPath).toEqual([]);
  });

  it('does not find a child that belongs to a sibling execution', () => {
    const { startExecution, startChild } = useAgentExecutionStore.getState();
    startExecution('exec-A', 'session-A');
    startExecution('exec-B', 'session-B');
    startChild('exec-A', { childExecutionId: 'child-a', agentName: 'AgentA', isBackground: false });

    // Searching within exec-B scope should not find exec-A's child.
    const execBOnly = { 'exec-B': useAgentExecutionStore.getState().executions['exec-B']! };
    const result = findChildAnyDepth(execBOnly, 'child-a');
    expect(result).toBeUndefined();
  });
});
