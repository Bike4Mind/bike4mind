import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the Zustand store and bridge as inert mocks - wireAgentEvents only reads
// them at event time, and these tests assert subscription wiring plus the
// usage-tracking store calls, not UI rendering.
const storeState = {
  pendingMessages: [],
  updatePendingMessage: vi.fn(),
  updateLiveSubagentUsage: vi.fn(),
  removeLiveSubagentUsage: vi.fn(),
  recordSubagentCompletion: vi.fn(),
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

  it('subscribes the step handler to thought/observation/action and tavern handlers to action/observation/final_answer', () => {
    const events = agent.on.mock.calls.map(c => c[0]);
    // step handler: thought, observation, action
    // tavern handlers: action, observation, final_answer
    expect(events).toEqual(['thought', 'observation', 'action', 'action', 'observation', 'final_answer']);
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

  it('folds final usage into the session and clears the live entry on afterRun', () => {
    const subagent = createFakeSubagent(2500, 12);
    getBeforeRun()(subagent, 'explore');
    const runId = storeState.updateLiveSubagentUsage.mock.calls[0][0] as string;

    getAfterRun()(subagent, 'explore');
    expect(storeState.removeLiveSubagentUsage).toHaveBeenCalledWith(runId);
    expect(storeState.recordSubagentCompletion).toHaveBeenCalledWith('explore', 2500, 12);
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

  it('does not record usage on afterRun for a subagent it never saw beforeRun', () => {
    const subagent = createFakeSubagent(999, 9);
    getAfterRun()(subagent, 'explore');
    expect(storeState.removeLiveSubagentUsage).not.toHaveBeenCalled();
    expect(storeState.recordSubagentCompletion).not.toHaveBeenCalled();
  });
});
