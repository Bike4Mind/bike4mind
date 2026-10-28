import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerAgentDefinition } from '@bike4mind/agents';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';

/**
 * On a tier-substituted turn the delegation tools must carry `substituteIdentity` into every
 * in-process child's orchestrator, or the child's `ReActAgent` is told it is the substitute.
 * `ReActAgent` is stubbed to record its identity and re-delegate, so grandchildren are covered.
 */
const { StubReActAgent, identities } = vi.hoisted(() => {
  const identities: Array<{ model: string; modelIdentityId?: string; modelDisplayName?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  class StubReActAgent extends EventEmitter {
    private readonly tools: ICompletionOptionTools[];
    constructor(context: {
      tools: ICompletionOptionTools[];
      model: string;
      modelIdentityId?: string;
      modelDisplayName?: string;
    }) {
      super();
      this.tools = context.tools;
      identities.push({
        model: context.model,
        modelIdentityId: context.modelIdentityId,
        modelDisplayName: context.modelDisplayName,
      });
    }
    getIteration(): number {
      return 1;
    }
    async run() {
      const delegate = this.tools.find(tool => tool.toolSchema.name === 'delegate_to_agent');
      if (delegate) await delegate.toolFn({ task: 't', agent: 'worker', thoroughness: 'quick' });
      return {
        finalAnswer: 'done',
        steps: [],
        agentName: 'worker',
        completionInfo: { iterations: 1, totalCredits: 0, totalTokens: 0, reachedMaxIterations: false },
      };
    }
  }
  return { StubReActAgent, identities };
});

vi.mock('@bike4mind/agents', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/agents')>();
  return { ...actual, ReActAgent: StubReActAgent };
});

import { MAX_SUBAGENT_DEPTH } from '../../agents/ServerSubagentOrchestrator';
import { ServerAgentStore } from '../../agents/ServerAgentStore';
import { createDelegateToAgentTool } from './delegateToAgent';
import { createCoordinateTaskTool } from './coordinateTask';

const SUBSTITUTE = 'claude-sonnet-4-6';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() } as unknown as Logger;
}

function makeLlm(): ICompletionBackend {
  return {
    currentModel: SUBSTITUTE,
    complete: vi.fn(),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([]),
  } as unknown as ICompletionBackend;
}

function makeAgent(name: string, overrides: Partial<ServerAgentDefinition> = {}): ServerAgentDefinition {
  return {
    name,
    description: name,
    model: SUBSTITUTE,
    systemPrompt: 'Task: $TASK',
    maxIterations: { quick: 1, medium: 1, very_thorough: 1 },
    defaultThoroughness: 'quick',
    ...overrides,
  };
}

const agentStore = new ServerAgentStore(
  {},
  { orgAgents: [makeAgent('worker'), makeAgent('coordinator', { allowedTools: ['decompose_task'] })] }
);

const substituteIdentity = { substituteId: SUBSTITUTE, identityId: 'premium-model', displayName: 'Premium Model' };

const baseDeps = () => ({
  userId: 'u1',
  llm: makeLlm(),
  logger: makeLogger(),
  parentTools: [],
  agentStore,
  substituteIdentity,
});

const masked = { model: SUBSTITUTE, modelIdentityId: 'premium-model', modelDisplayName: 'Premium Model' };

describe('delegation tools carry the substitute identity to in-process children', () => {
  beforeEach(() => {
    identities.length = 0;
  });

  it('delegate_to_agent masks the child and every grandchild down to the depth cap', async () => {
    await createDelegateToAgentTool(baseDeps()).toolFn({ task: 't', agent: 'worker', thoroughness: 'quick' });

    expect(identities).toEqual(Array(MAX_SUBAGENT_DEPTH).fill(masked));
  });

  it('coordinate_task masks the coordinator agent', async () => {
    await createCoordinateTaskTool({
      ...baseDeps(),
      dagDispatcher: { createNode: vi.fn(), dispatchNode: vi.fn() },
      getParentExecutionId: () => 'exec-1',
    }).toolFn({ task: 'Split this into research and writing' });

    expect(identities).toEqual([masked]);
  });

  it('leaves the identity alone on an unsubstituted turn', async () => {
    await createDelegateToAgentTool({ ...baseDeps(), substituteIdentity: undefined }).toolFn({
      task: 't',
      agent: 'worker',
      thoroughness: 'quick',
    });

    expect(identities[0]).toEqual({ model: SUBSTITUTE, modelIdentityId: undefined, modelDisplayName: undefined });
  });
});
