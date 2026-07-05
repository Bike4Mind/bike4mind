import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the Zustand store and bridge as inert mocks - wireAgentEvents only reads
// them at event time, and these tests assert subscription wiring, not UI updates.
vi.mock('../store', () => ({
  useCliStore: { getState: vi.fn(() => ({ pendingMessages: [], updatePendingMessage: vi.fn() })) },
}));
vi.mock('../features/bridgePresence/index.js', () => ({
  bridgePresence: { emitEvent: vi.fn() },
}));

import { wireAgentEvents } from './wireAgentEvents.js';

function createFakeAgent() {
  return { on: vi.fn(), observationQueue: undefined as unknown };
}
function createFakeOrchestrator() {
  return { setBeforeRunCallback: vi.fn(), setAfterRunCallback: vi.fn() };
}

describe('wireAgentEvents', () => {
  let agent: ReturnType<typeof createFakeAgent>;
  let orchestrator: ReturnType<typeof createFakeOrchestrator>;
  let agentContext: { currentAgent: unknown; observationQueue: unknown[] };

  beforeEach(() => {
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
    const beforeCalls = orchestrator.setBeforeRunCallback.mock.calls;
    const beforeRun = beforeCalls[beforeCalls.length - 1][0] as (s: unknown, t: unknown) => void;
    const subagent = { on: vi.fn(), off: vi.fn() };
    beforeRun(subagent, 'explore');
    const events = subagent.on.mock.calls.map(c => c[0]);
    // wires both step handlers and tavern handlers
    expect(events).toEqual(['thought', 'observation', 'action', 'action', 'observation', 'final_answer']);
  });

  it('unwires subagent subscriptions through the afterRun callback', () => {
    const afterCalls = orchestrator.setAfterRunCallback.mock.calls;
    const afterRun = afterCalls[afterCalls.length - 1][0] as (s: unknown, t: unknown) => void;
    const subagent = { on: vi.fn(), off: vi.fn() };
    afterRun(subagent, 'explore');
    const events = subagent.off.mock.calls.map(c => c[0]);
    expect(events).toEqual(['thought', 'observation', 'action', 'action', 'observation', 'final_answer']);
  });
});
