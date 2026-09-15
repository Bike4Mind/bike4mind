import { describe, it, expect, vi } from 'vitest';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { ServerAgentStore } from '../../agents/ServerAgentStore';
import { createCoordinateTaskTool, type DagDispatcher } from './coordinateTask';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
  } as unknown as Logger;
}

function makeLlm(): ICompletionBackend {
  return {
    currentModel: 'claude-sonnet-4-6',
    complete: vi.fn(),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([]),
  } as unknown as ICompletionBackend;
}

function makeDagDispatcher(): DagDispatcher {
  return {
    createNode: vi.fn(),
    dispatchNode: vi.fn(),
  };
}

describe('createCoordinateTaskTool \u2014 per-member credit cap gate', () => {
  it('refuses to spawn the coordinator when checkMemberCreditCap returns true, spending no LLM tokens', async () => {
    const llm = makeLlm();

    const tool = createCoordinateTaskTool({
      userId: 'u1',
      llm,
      logger: makeLogger(),
      parentTools: [],
      agentStore: new ServerAgentStore({}),
      dagDispatcher: makeDagDispatcher(),
      getParentExecutionId: () => 'exec-1',
      checkMemberCreditCap: () => true,
    });

    const result = await tool.toolFn({ task: 'Decompose this into research + writing subtasks' });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/credit limit reached/);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
