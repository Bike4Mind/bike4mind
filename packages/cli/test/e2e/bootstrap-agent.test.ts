/**
 * E2E test: the agent produced by bootstrap/buildAgent is actually runnable.
 *
 * The harness (harness.ts) proves a hand-built ReActAgent runs against a faux
 * backend. This test closes the loop for the index.tsx decomposition (Q1a):
 * it builds the agent through the real `buildAgent` bootstrap seam - system
 * prompt construction, tool-ref wiring, agent-context recording - and then
 * runs it against the faux backend, asserting the wired agent settles on the
 * scripted answer. If the bootstrap seam mis-wires the agent, this fails.
 */

import { describe, it, expect } from 'vitest';
import { buildAgent, type BuildAgentInput } from '../../src/bootstrap/buildAgent.js';
import { createMockConfig } from '../../src/test-utils/mocks.js';
import type { AgentContext } from '../../src/utils';
import { createFauxBackend } from './faux-llm.js';

function makeInput(over: Partial<BuildAgentInput> = {}): BuildAgentInput {
  const agentContext: AgentContext = { currentAgent: null, observationQueue: [] };
  return {
    config: createMockConfig(),
    modelId: 'faux-model',
    notifyingLlm: createFauxBackend({ turns: [{ text: 'Hello from bootstrap' }] }),
    allTools: [],
    agentContext,
    agentToolsRef: { current: null },
    silentLogger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    sessionId: 'sess-e2e',
    initialInteractionMode: 'normal',
    contextContent: 'PROJECT CONTEXT',
    agentStore: { getDirectoryContext: () => '' } as never,
    customCommandStore: { getAllCommands: () => [] } as never,
    enableSkillTool: true,
    additionalDirectories: [],
    featureModulePrompts: '',
    ...over,
  };
}

describe('e2e — bootstrap buildAgent produces a runnable agent', () => {
  it('runs the constructed agent against a faux backend and returns the scripted answer', async () => {
    const input = makeInput();
    const { agent } = buildAgent(input);

    const result = await agent.run('Say hello', { parallelExecution: false });

    expect(result.finalAnswer).toBe('Hello from bootstrap');
    // The bootstrap seam must have recorded the agent in the shared context.
    expect(input.agentContext.currentAgent).toBe(agent);
    // ...and wired the tool-search ref to the agent's live tools array.
    expect(input.agentToolsRef.current).toBe(agent.getTools());
  });

  it('builds an agent whose system prompt reflects the requested interaction mode', () => {
    const { buildPromptForMode } = buildAgent(makeInput());
    expect(buildPromptForMode('plan')).not.toBe(buildPromptForMode('normal'));
  });
});
