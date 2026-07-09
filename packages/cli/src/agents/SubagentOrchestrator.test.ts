import { describe, it, expect } from 'vitest';
import { SubagentOrchestrator, type OrchestratorDependencies } from './SubagentOrchestrator.js';
import { MAX_SUBAGENT_DEPTH } from './types.js';

/**
 * Minimal dependency stub. The depth guard runs before any dependency is
 * touched, so an empty agent store is enough to exercise the boundary: a spawn
 * that clears the guard falls through to the "Unknown agent" lookup error.
 */
function createOrchestrator(): SubagentOrchestrator {
  const deps = {
    agentStore: {
      getAgent: () => undefined,
      getAgentNames: () => [],
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    configStore: { get: async () => ({}) },
  } as unknown as OrchestratorDependencies;
  return new SubagentOrchestrator(deps);
}

describe('SubagentOrchestrator depth cap', () => {
  it('rejects a spawn at MAX_SUBAGENT_DEPTH before touching dependencies', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH,
      })
    ).rejects.toThrow(/nesting depth .* reached the limit/);
  });

  it('rejects a spawn above MAX_SUBAGENT_DEPTH', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH + 5,
      })
    ).rejects.toThrow(/reached the limit/);
  });

  it('lets a spawn just below the cap through the depth guard', async () => {
    const orchestrator = createOrchestrator();
    // Clears the depth guard, then fails on the (stubbed) unknown-agent lookup -
    // proving the guard did not reject it.
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH - 1,
      })
    ).rejects.toThrow(/Unknown agent/);
  });

  it('defaults an omitted depth to 1 (a direct child), which is allowed', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
      })
    ).rejects.toThrow(/Unknown agent/);
  });
});
