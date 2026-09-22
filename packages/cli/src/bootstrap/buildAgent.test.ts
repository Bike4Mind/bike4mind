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
    customCommandStore: { getAllCommands: vi.fn(() => []), getModelReachableCommands: vi.fn(() => []) } as never,
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

  it('re-evaluates the model-reachable commands on every prompt build (not a snapshot)', () => {
    // The prompt advertises the model-reachable set (reserved names filtered), so a
    // reserved-named global/remote skill is never listed as invokable.
    const getModelReachableCommands = vi.fn(() => []);
    const input = makeInput({ customCommandStore: { getModelReachableCommands } as never });
    const { buildPromptForMode } = buildAgent(input);
    // buildAgent invokes the closure once internally for the initial system prompt.
    const callsAfterBuild = getModelReachableCommands.mock.calls.length;
    expect(callsAfterBuild).toBeGreaterThanOrEqual(1);
    buildPromptForMode('plan');
    buildPromptForMode('normal');
    expect(getModelReachableCommands.mock.calls.length).toBe(callsAfterBuild + 2);
  });
});
