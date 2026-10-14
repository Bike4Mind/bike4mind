import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerAgentDefinition } from '@bike4mind/agents';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';

/**
 * The subagent permission gate: a child's tool calls are classified against the parent's
 * approved/denied lists, and anything not `allowed` is refused instead of run, because a
 * child has no approver to pause for.
 *
 * `ReActAgent` is stubbed (same reason as the sibling `.onChildProgress.test.ts`): the stub
 * calls every tool it was handed, so the assertions see exactly what the child's own tool
 * loop would have run.
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
        childCalls.push({ name: tool.toolSchema.name, result: await tool.toolFn({}) });
      }
      return {
        finalAnswer: 'done',
        steps: [],
        agentName: 'researcher',
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

import { ServerSubagentOrchestrator, gateSubagentTools } from './ServerSubagentOrchestrator';

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

function makeAgentDef(): ServerAgentDefinition {
  return {
    name: 'researcher',
    description: 'Test agent',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'Task: $TASK',
    maxIterations: { quick: 3, medium: 6, very_thorough: 12 },
    defaultThoroughness: 'medium',
  };
}

const ran: string[] = [];
function makeTool(name: string): ICompletionOptionTools {
  return {
    toolFn: async () => {
      ran.push(name);
      return `${name} ok`;
    },
    toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  };
}

async function runGated(name: string, approvedTools: string[], deniedTools: string[]): Promise<string> {
  const [tool] = gateSubagentTools([makeTool(name)], { approvedTools, deniedTools }, makeLogger());
  return tool.toolFn({});
}

describe('gateSubagentTools', () => {
  beforeEach(() => {
    ran.length = 0;
  });

  it('runs a tool the parent gate classifies as allowed', async () => {
    expect(await runGated('web_search', [], [])).toBe('web_search ok');
    expect(ran).toEqual(['web_search']);
  });

  it('refuses an external tool the parent never approved, pointing the model back at the parent', async () => {
    const result = await runGated('send_slack_message', [], []);
    expect(result).toMatch(/^Error: send_slack_message was not run because it needs the user's approval/);
    expect(result).toContain('so the parent agent can run it');
    expect(ran).toEqual([]);
  });

  it('refuses an MCP tool the parent never approved', async () => {
    expect(await runGated('mcp__github__create_issue', [], [])).toMatch(/needs the user's approval/);
    expect(ran).toEqual([]);
  });

  it('runs an external tool the parent approved', async () => {
    expect(await runGated('send_slack_message', ['send_slack_message'], [])).toBe('send_slack_message ok');
  });

  it('refuses a tool the parent denied, even one that is otherwise allowed', async () => {
    expect(await runGated('web_search', [], ['web_search'])).toMatch(/the user denied it for this session/);
    expect(ran).toEqual([]);
  });

  it('passes the delegation tools and the coordinator capture tool through untouched', () => {
    const tools = ['delegate_to_agent', 'coordinate_task', 'decompose_task'].map(makeTool);
    expect(gateSubagentTools(tools, { approvedTools: [], deniedTools: [] }, makeLogger())).toEqual(tools);
  });
});

describe('ServerSubagentOrchestrator in-process child tool gate', () => {
  beforeEach(() => {
    ran.length = 0;
    childCalls.length = 0;
    vi.useRealTimers();
  });

  const parentTools = () => [makeTool('web_search'), makeTool('send_slack_message')];

  it('gates the child toolbelt when the parent supplies toolPermissions', async () => {
    const orchestrator = new ServerSubagentOrchestrator({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: parentTools(),
      toolPermissions: { approvedTools: [], deniedTools: [] },
    });

    await orchestrator.delegateToAgent({ task: 't', agentDef: makeAgentDef(), thoroughness: 'quick' });

    expect(ran).toEqual(['web_search']);
    expect(childCalls.find(c => c.name === 'send_slack_message')?.result).toMatch(/^Error:/);
  });

  it('leaves the child ungated when the parent is ungated (no toolPermissions)', async () => {
    const orchestrator = new ServerSubagentOrchestrator({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: parentTools(),
    });

    await orchestrator.delegateToAgent({ task: 't', agentDef: makeAgentDef(), thoroughness: 'quick' });

    expect(ran).toEqual(['web_search', 'send_slack_message']);
  });
});
