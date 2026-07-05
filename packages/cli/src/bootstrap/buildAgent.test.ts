import { describe, it, expect, vi } from 'vitest';
import { buildAgent, type BuildAgentInput } from './buildAgent.js';
import { createMockConfig, createMockLlmBackend } from '../test-utils/mocks.js';
import type { AgentContext } from '../utils';

function makeInput(overrides: Partial<BuildAgentInput> = {}): BuildAgentInput {
  const agentContext: AgentContext = { currentAgent: null, observationQueue: [] };
  return {
    config: createMockConfig(),
    modelId: 'test-model',
    notifyingLlm: createMockLlmBackend() as never,
    allTools: [],
    agentContext,
    agentToolsRef: { current: null },
    silentLogger: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    sessionId: 'sess-1',
    initialInteractionMode: 'normal',
    contextContent: 'PROJECT CONTEXT',
    agentStore: { getDirectoryContext: () => '' } as never,
    customCommandStore: { getAllCommands: vi.fn(() => []) } as never,
    enableSkillTool: true,
    additionalDirectories: [],
    featureModulePrompts: '',
    ...overrides,
  };
}

describe('buildAgent', () => {
  it('constructs a ReAct agent exposing getTools()', () => {
    const { agent } = buildAgent(makeInput());
    expect(agent).toBeDefined();
    expect(typeof agent.getTools).toBe('function');
  });

  it('records the constructed agent in the shared context (before any subscription is registered)', () => {
    const input = makeInput();
    const { agent } = buildAgent(input);
    expect(input.agentContext.currentAgent).toBe(agent);
  });

  it('wires agentToolsRef to the agent live tools array', () => {
    const input = makeInput();
    const { agent } = buildAgent(input);
    expect(input.agentToolsRef.current).toBe(agent.getTools());
  });

  it('returns a buildPromptForMode that produces different prompts for plan vs normal', () => {
    const { buildPromptForMode } = buildAgent(makeInput());
    const normal = buildPromptForMode('normal');
    const plan = buildPromptForMode('plan');
    expect(typeof normal).toBe('string');
    expect(normal.length).toBeGreaterThan(0);
    expect(plan).not.toBe(normal);
  });

  it('re-evaluates customCommandStore.getAllCommands() on every prompt build (not a snapshot)', () => {
    const getAllCommands = vi.fn(() => []);
    const input = makeInput({ customCommandStore: { getAllCommands } as never });
    const { buildPromptForMode } = buildAgent(input);
    // buildAgent invokes the closure once internally for the initial system prompt.
    const callsAfterBuild = getAllCommands.mock.calls.length;
    expect(callsAfterBuild).toBeGreaterThanOrEqual(1);
    buildPromptForMode('plan');
    buildPromptForMode('normal');
    expect(getAllCommands.mock.calls.length).toBe(callsAfterBuild + 2);
  });
});
