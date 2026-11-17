import { describe, it, expect, vi } from 'vitest';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { DeferredToolRegistry } from '@bike4mind/agents';
import { buildToolSearch } from './buildToolSearch.js';
import { syncPeerTools } from '../tools/peerTools.js';
import { holdIdleSession } from '../session/holdIdleSession.js';
import { runWithModelOverride } from '../session/modelOverride.js';
import { useCliStore } from '../store/index.js';
import { buildAgent, type BuildAgentInput } from './buildAgent.js';
import { createMockConfig, createMockLlmBackend, createMockSession } from '../test-utils/mocks.js';
import type { AgentContext } from '../utils';

function makeInput(overrides: Partial<BuildAgentInput> = {}): BuildAgentInput {
  const agentContext: AgentContext = { currentAgent: null };
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

it('exposes peer schemas off/on/off to real agent requests without breaking deferred tool_search', async () => {
  const requests: string[][] = [];
  const llm: ICompletionBackend = {
    currentModel: 'test-model',
    complete: async (_model, _messages, options, callback) => {
      requests.push((options.tools ?? []).map(tool => tool.toolSchema.name));
      await callback(['done'], { inputTokens: 1, outputTokens: 1, toolsUsed: [], stopReason: 'end_turn' });
    },
    pushToolMessages: vi.fn(),
    getModelInfo: async () => [],
  };
  const makeTool = (name: string): ICompletionOptionTools => ({
    toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
    toolFn: async () => name,
  });
  const registry = new DeferredToolRegistry();
  registry.register([makeTool('mcp__deferred')]);
  const agentToolsRef: { current: ICompletionOptionTools[] | null } = { current: null };
  const search = buildToolSearch({ llm, models: [], registry, agentToolsRef });
  if (!search.toolSearchTool) throw new Error('Missing real tool_search');
  const core = makeTool('core');
  const peerTools = ['peer_list', 'peer_send', 'peer_status'].map(makeTool);
  const { agent } = buildAgent(
    makeInput({ notifyingLlm: llm, allTools: [core, search.toolSearchTool], agentToolsRef })
  );
  const liveTools = agent.getTools();
  await agent.run('off');
  syncPeerTools(agent, peerTools, true);
  await agent.run('on');
  await search.toolSearchTool.toolFn({ query: 'select:mcp__deferred' });
  expect(agent.getTools().map(tool => tool.toolSchema.name)).toContain('mcp__deferred');
  syncPeerTools(agent, peerTools, false);
  await agent.run('off again');
  expect(agent.getTools()).toBe(liveTools);
  expect(agentToolsRef.current).toBe(liveTools);
  expect(requests[0]).not.toContain('peer_send');
  expect(requests[1]).toEqual(expect.arrayContaining(peerTools.map(tool => tool.toolSchema.name)));
  expect(requests[2]).not.toContain('peer_send');
  expect(requests[2]).toEqual(expect.arrayContaining(['core', 'tool_search', 'mcp__deferred']));
});

it.each([false, true])(
  'runs a real custom-command model turn under one dispatch claim (override: %s)',
  async override => {
    useCliStore.setState({
      session: createMockSession({ model: 'base-model' }),
      turnInFlight: false,
      peerTurnActive: false,
      isThinking: false,
      sessionHolds: 0,
    });
    const complete = vi.fn<ICompletionBackend['complete']>(async (_model, _messages, _options, callback) => {
      expect(useCliStore.getState().sessionHolds).toBe(1);
      await callback(['custom result'], { inputTokens: 1, outputTokens: 1, toolsUsed: [], stopReason: 'end_turn' });
    });
    const llm: ICompletionBackend = {
      currentModel: 'base-model',
      complete,
      pushToolMessages: vi.fn(),
      getModelInfo: async () => [],
    };
    const { agent } = buildAgent(makeInput({ notifyingLlm: llm }));
    const claim = holdIdleSession();
    if (!claim) throw new Error('Custom dispatch must acquire an idle session');
    const executeTurn = async () => {
      claim.assertHeld();
      return agent.run('expanded custom command');
    };
    try {
      const result = override
        ? await runWithModelOverride(
            {
              applyModel: model => {
                const current = useCliStore.getState().session;
                if (current) useCliStore.getState().setSession({ ...current, model });
              },
              sessionStore: {
                save: async () => {
                  claim.assertHeld();
                  expect(useCliStore.getState().sessionHolds).toBe(1);
                },
              },
            },
            'override-model',
            executeTurn
          )
        : await executeTurn();
      expect(result.finalAnswer).toBe('custom result');
      expect(complete).toHaveBeenCalledTimes(1);
      expect(useCliStore.getState().sessionHolds).toBe(1);
      expect(useCliStore.getState().session?.model).toBe('base-model');
    } finally {
      claim.release();
    }
    expect(useCliStore.getState().sessionHolds).toBe(0);
  }
);
