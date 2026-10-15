import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the Zustand store and bridge as inert mocks - wireAgentEvents only reads
// them at event time, and these tests assert subscription wiring plus the
// usage-tracking store calls, not UI rendering.
const storeState = {
  pendingMessages: [] as Array<{ id: string; role: string; content: string }>,
  updatePendingMessage: vi.fn((index: number, message: { id: string; role: string; content: string }) => {
    storeState.pendingMessages[index] = message;
  }),
  updateLiveSubagentUsage: vi.fn(),
  removeLiveSubagentUsage: vi.fn(),
};
vi.mock('../store', () => ({
  useCliStore: { getState: vi.fn(() => storeState) },
}));
vi.mock('../features/bridgePresence/index.js', () => ({
  bridgePresence: { emitEvent: vi.fn() },
}));

import { wireAgentEvents } from './wireAgentEvents.js';

function createFakeAgent() {
  return { on: vi.fn(), observationQueue: undefined as unknown };
}
function createFakeSubagent(tokens = 0, credits = 0) {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getTokenUsage: vi.fn(() => tokens),
    getCreditsUsage: vi.fn(() => credits),
  };
}
function createFakeOrchestrator() {
  return { setBeforeRunCallback: vi.fn(), setAfterRunCallback: vi.fn() };
}

describe('wireAgentEvents', () => {
  let agent: ReturnType<typeof createFakeAgent>;
  let orchestrator: ReturnType<typeof createFakeOrchestrator>;
  let agentContext: { currentAgent: unknown; observationQueue: unknown[] };

  const getBeforeRun = () => {
    const calls = orchestrator.setBeforeRunCallback.mock.calls;
    return calls[calls.length - 1][0] as (s: unknown, t: unknown) => void;
  };
  const getAfterRun = () => {
    const calls = orchestrator.setAfterRunCallback.mock.calls;
    return calls[calls.length - 1][0] as (s: unknown, t: unknown) => void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    agent = createFakeAgent();
    orchestrator = createFakeOrchestrator();
    agentContext = { currentAgent: null, observationQueue: [{ toolId: 't', toolName: 'x', result: 1 }] };
    wireAgentEvents({
      agent: agent as never,
      agentContext: agentContext as never,
      orchestrator: orchestrator as never,
    });
  });

  it('shares the observation queue reference onto the agent', () => {
    expect(agent.observationQueue).toBe(agentContext.observationQueue);
  });

  it('subscribes the step, live-text and tavern handlers to the main agent', () => {
    const events = agent.on.mock.calls.map(c => c[0]);
    expect(events).toEqual([
      // step handler
      'thought',
      'observation',
      'action',
      // live text: stream deltas, clear the preamble once it becomes a thought/action
      'text_delta',
      'thought',
      'action',
      // tavern handlers
      'action',
      'observation',
      'final_answer',
    ]);
  });

  describe('live reply text', () => {
    const emit = (event: string, payload: unknown) => {
      for (const [name, handler] of agent.on.mock.calls) {
        if (name === event) (handler as (p: unknown) => void)(payload);
      }
    };
    const pendingContent = () => storeState.pendingMessages[0].content;

    beforeEach(() => {
      storeState.pendingMessages = [{ id: 'm1', role: 'assistant', content: '...' }];
    });

    it('appends streamed deltas to the pending message', () => {
      emit('text_delta', { delta: 'Hello', iteration: 1 });
      emit('text_delta', { delta: ' world', iteration: 1 });
      expect(pendingContent()).toBe('Hello world');
    });

    it('starts fresh on a new iteration, matching the agent restarting its text', () => {
      emit('text_delta', { delta: 'draft', iteration: 1 });
      emit('text_delta', { delta: 'revised', iteration: 2 });
      expect(pendingContent()).toBe('revised');
    });

    it('starts fresh for a new pending message', () => {
      emit('text_delta', { delta: 'first turn', iteration: 1 });
      storeState.pendingMessages = [{ id: 'm2', role: 'assistant', content: '...' }];
      emit('text_delta', { delta: 'second turn', iteration: 1 });
      expect(pendingContent()).toBe('second turn');
    });

    it('clears a streamed preamble once it becomes a thought step', () => {
      emit('text_delta', { delta: 'Let me check the files.', iteration: 1 });
      emit('thought', { type: 'thought', content: 'Let me check the files.', metadata: {} });
      expect(pendingContent()).toBe('...');
    });

    it('leaves the placeholder alone on a tool call when nothing streamed', () => {
      emit('action', { type: 'action', content: '', metadata: { toolName: 'grep' } });
      expect(pendingContent()).toBe('...');
    });
  });

  it('registers before/after run callbacks exactly once (single-slot setters)', () => {
    expect(orchestrator.setBeforeRunCallback).toHaveBeenCalledTimes(1);
    expect(orchestrator.setAfterRunCallback).toHaveBeenCalledTimes(1);
  });

  it('wires subagent subscriptions through the beforeRun callback', () => {
    const subagent = createFakeSubagent();
    getBeforeRun()(subagent, 'explore');
    const events = subagent.on.mock.calls.map(c => c[0]);
    // step handlers, tavern handlers, then the usage handler
    expect(events).toEqual([
      'thought',
      'observation',
      'action',
      'action',
      'observation',
      'final_answer',
      'thought',
      'observation',
      'final_answer',
    ]);
  });

  it('unwires subagent subscriptions through the afterRun callback', () => {
    const subagent = createFakeSubagent();
    getBeforeRun()(subagent, 'explore');
    getAfterRun()(subagent, 'explore');
    const events = subagent.off.mock.calls.map(c => c[0]);
    expect(events).toEqual([
      'thought',
      'observation',
      'action',
      'action',
      'observation',
      'final_answer',
      'thought',
      'observation',
      'final_answer',
    ]);
  });

  it('seeds a live usage entry on beforeRun and updates it as steps fire', () => {
    const subagent = createFakeSubagent(500, 3);
    getBeforeRun()(subagent, 'explore');
    // seeded once on spawn
    expect(storeState.updateLiveSubagentUsage).toHaveBeenCalledWith(expect.any(String), 'explore', 500, 3);

    // simulate a step event: fire the usage handler registered on 'thought'
    subagent.getTokenUsage.mockReturnValue(1200);
    subagent.getCreditsUsage.mockReturnValue(7);
    const usageHandler = subagent.on.mock.calls[6][1] as () => void;
    usageHandler();
    expect(storeState.updateLiveSubagentUsage).toHaveBeenLastCalledWith(expect.any(String), 'explore', 1200, 7);
  });

  it('clears the live entry on afterRun (session rollup is onSubagentUsage, not this path)', () => {
    const subagent = createFakeSubagent(2500, 12);
    getBeforeRun()(subagent, 'explore');
    const runId = storeState.updateLiveSubagentUsage.mock.calls[0][0] as string;

    getAfterRun()(subagent, 'explore');
    expect(storeState.removeLiveSubagentUsage).toHaveBeenCalledWith(runId);
  });

  it('uses distinct run ids for concurrent same-name subagents', () => {
    const a = createFakeSubagent();
    const b = createFakeSubagent();
    getBeforeRun()(a, 'explore');
    getBeforeRun()(b, 'explore');
    const runIdA = storeState.updateLiveSubagentUsage.mock.calls[0][0];
    const runIdB = storeState.updateLiveSubagentUsage.mock.calls[1][0];
    expect(runIdA).not.toBe(runIdB);
  });

  it('does not touch the live map on afterRun for a subagent it never saw beforeRun', () => {
    const subagent = createFakeSubagent(999, 9);
    getAfterRun()(subagent, 'explore');
    expect(storeState.removeLiveSubagentUsage).not.toHaveBeenCalled();
  });
});
