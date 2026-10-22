import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerAgentDefinition } from '@bike4mind/agents';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';

/**
 * The delegation tools are the hops that carry the parent's permission lists into an
 * in-process child's orchestrator (`ServerOrchestratorDeps.toolPermissions`). Drop the field
 * at any hop and that child silently runs tools the parent's gate would have paused on, so
 * these drive the real tools and orchestrator end to end.
 *
 * `ReActAgent` is stubbed to call every tool it is handed: `delegate_to_agent` with a real
 * delegation (so the grandchild hop is exercised too, down to the depth cap), every other
 * tool with no input.
 */
const { StubReActAgent, childCalls } = vi.hoisted(() => {
  const childCalls: Array<{ name: string; result: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  class StubReActAgent extends EventEmitter {
    private readonly tools: ICompletionOptionTools[];
    constructor(context: { tools: ICompletionOptionTools[] }) {
      super();
      this.tools = context.tools;
    }
    getIteration(): number {
      return 1;
    }
    async run() {
      for (const tool of this.tools) {
        const name = tool.toolSchema.name;
        if (name === 'decompose_task') continue;
        const input = name === 'delegate_to_agent' ? { task: 't', agent: 'worker', thoroughness: 'quick' } : {};
        childCalls.push({ name, result: await tool.toolFn(input) });
      }
      return {
        finalAnswer: 'done',
        steps: [],
        agentName: 'worker',
        completionInfo: { iterations: 1, totalCredits: 0, totalTokens: 0, reachedMaxIterations: false },
      };
    }
  }
  return { StubReActAgent, childCalls };
});

vi.mock('@bike4mind/agents', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/agents')>();
  return { ...actual, ReActAgent: StubReActAgent };
});

import { MAX_SUBAGENT_DEPTH } from '../../agents/ServerSubagentOrchestrator';
import { ServerAgentStore } from '../../agents/ServerAgentStore';
import { createDelegateToAgentTool } from './delegateToAgent';
import { createCoordinateTaskTool } from './coordinateTask';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() } as unknown as Logger;
}

function makeLlm(): ICompletionBackend {
  return {
    currentModel: 'claude-sonnet-4-6',
    complete: vi.fn(),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([]),
  } as unknown as ICompletionBackend;
}

function makeAgent(name: string, overrides: Partial<ServerAgentDefinition> = {}): ServerAgentDefinition {
  return {
    name,
    description: name,
    model: 'claude-sonnet-4-6',
    systemPrompt: 'Task: $TASK',
    maxIterations: { quick: 1, medium: 1, very_thorough: 1 },
    defaultThoroughness: 'quick',
    ...overrides,
  };
}

const agentStore = new ServerAgentStore(
  {},
  {
    orgAgents: [
      makeAgent('worker'),
      makeAgent('coordinator', { allowedTools: ['decompose_task', 'send_slack_message'] }),
    ],
  }
);

const ran: string[] = [];
const slackTool: ICompletionOptionTools = {
  toolFn: async () => {
    ran.push('send_slack_message');
    return 'sent';
  },
  toolSchema: { name: 'send_slack_message', description: 'post', parameters: { type: 'object', properties: {} } },
};

const baseDeps = () => ({
  userId: 'u1',
  llm: makeLlm(),
  logger: makeLogger(),
  parentTools: [slackTool],
  agentStore,
  toolPermissions: { approvedTools: [] as string[], deniedTools: [] as string[] },
});

const slackResults = () => childCalls.filter(call => call.name === 'send_slack_message').map(call => call.result);

describe('delegation tools carry the parent permission lists to in-process children', () => {
  beforeEach(() => {
    ran.length = 0;
    childCalls.length = 0;
  });

  it('delegate_to_agent gates the child and every grandchild down to the depth cap', async () => {
    await createDelegateToAgentTool(baseDeps()).toolFn({ task: 't', agent: 'worker', thoroughness: 'quick' });

    expect(ran).toEqual([]);
    expect(slackResults()).toHaveLength(MAX_SUBAGENT_DEPTH);
    for (const result of slackResults()) expect(result).toMatch(/^Error: send_slack_message was not run/);
  });

  it('delegate_to_agent lets a child run a tool the parent approved', async () => {
    const deps = { ...baseDeps(), toolPermissions: { approvedTools: ['send_slack_message'], deniedTools: [] } };
    await createDelegateToAgentTool(deps).toolFn({ task: 't', agent: 'worker', thoroughness: 'quick' });

    expect(ran).toHaveLength(MAX_SUBAGENT_DEPTH);
  });

  it("coordinate_task gates the coordinator agent's toolbelt", async () => {
    await createCoordinateTaskTool({
      ...baseDeps(),
      dagDispatcher: { createNode: vi.fn(), dispatchNode: vi.fn() },
      getParentExecutionId: () => 'exec-1',
    }).toolFn({ task: 'Split this into research and writing' });

    expect(ran).toEqual([]);
    expect(slackResults()).toEqual([expect.stringMatching(/^Error: send_slack_message was not run/)]);
  });
});
