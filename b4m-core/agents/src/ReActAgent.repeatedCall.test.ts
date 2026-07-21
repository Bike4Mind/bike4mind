/**
 * Integration tests for the repeated-call circuit breaker (see
 * repeatedCallGuard.ts). Reproduces the non-terminating exploration loop from
 * issue #696: a model that keeps re-issuing the same tool call, and asserts the
 * tool stops actually executing once the block threshold is reached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

/** Mock LLM that emits the SAME tool call on every iteration (never converges). */
function createLoopingLlm(toolCall: { name: string; arguments?: string }): ICompletionBackend {
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      await callback(['Still exploring...'], {
        inputTokens: 100,
        outputTokens: 50,
        toolsUsed: [toolCall],
      });
    },
    pushToolMessages: vi.fn(),
  };
}

function createMockLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('ReActAgent repeated-call circuit breaker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stops executing a tool that keeps returning the same result', async () => {
    const toolFn = vi.fn(async () => 'No files found');
    const tool = {
      toolFn,
      toolSchema: {
        name: 'glob_files',
        description: 'Find files',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };

    const context: AgentContext = {
      userId: 'test-user',
      logger: createMockLogger() as unknown as AgentContext['logger'],
      llm: createLoopingLlm({ name: 'glob_files', arguments: '{"pattern":"api/hearth/**"}' }),
      model: 'test-model',
      tools: [tool],
      maxIterations: 20,
      repeatedCallGuard: { warnThreshold: 3, blockThreshold: 5 },
    };

    const result = await new ReActAgent(context).run('Build the module');

    // 20 iterations all requested the tool, but it only actually ran up to the
    // block threshold - the rest were short-circuited.
    expect(toolFn).toHaveBeenCalledTimes(5);

    // The blocked observation is surfaced to the model as a nudge.
    const observations = result.steps.filter(s => s.type === 'observation').map(s => s.content);
    expect(observations.some(o => o.includes('Circuit breaker'))).toBe(true);
  });

  it('appends a repetition warning before blocking', async () => {
    const tool = {
      toolFn: vi.fn(async () => 'same contents'),
      toolSchema: {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };

    const context: AgentContext = {
      userId: 'test-user',
      logger: createMockLogger() as unknown as AgentContext['logger'],
      llm: createLoopingLlm({ name: 'file_read', arguments: '{"path":"x.ts"}' }),
      model: 'test-model',
      tools: [tool],
      maxIterations: 10,
      repeatedCallGuard: { warnThreshold: 3, blockThreshold: 5 },
    };

    const result = await new ReActAgent(context).run('Read it');
    const observations = result.steps.filter(s => s.type === 'observation').map(s => s.content);
    expect(observations.some(o => o.includes('repeated-call notice'))).toBe(true);
  });

  it('does not block when each call returns a different result (genuine progress)', async () => {
    let n = 0;
    const toolFn = vi.fn(async () => `result ${n++}`);
    const tool = {
      toolFn,
      toolSchema: {
        name: 'poll_status',
        description: 'Poll',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };

    const context: AgentContext = {
      userId: 'test-user',
      logger: createMockLogger() as unknown as AgentContext['logger'],
      llm: createLoopingLlm({ name: 'poll_status', arguments: '{}' }),
      model: 'test-model',
      tools: [tool],
      maxIterations: 8,
      repeatedCallGuard: { warnThreshold: 3, blockThreshold: 5 },
    };

    await new ReActAgent(context).run('Poll until done');

    // Changing results reset the counter, so the tool runs every iteration.
    expect(toolFn).toHaveBeenCalledTimes(8);
  });

  it('can be disabled via context', async () => {
    const toolFn = vi.fn(async () => 'same');
    const tool = {
      toolFn,
      toolSchema: {
        name: 'file_read',
        description: 'Read',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };

    const context: AgentContext = {
      userId: 'test-user',
      logger: createMockLogger() as unknown as AgentContext['logger'],
      llm: createLoopingLlm({ name: 'file_read', arguments: '{"path":"x.ts"}' }),
      model: 'test-model',
      tools: [tool],
      maxIterations: 8,
      repeatedCallGuard: { enabled: false },
    };

    await new ReActAgent(context).run('Read it');
    expect(toolFn).toHaveBeenCalledTimes(8);
  });
});
