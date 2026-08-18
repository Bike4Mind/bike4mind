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

/** Mock LLM that emits the SAME batch of tool calls on every iteration. */
function createLoopingMultiLlm(toolCalls: Array<{ name: string; arguments?: string }>): ICompletionBackend {
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
        toolsUsed: toolCalls,
      });
    },
    pushToolMessages: vi.fn(),
  };
}

/** Mock LLM that emits a scripted tool call per iteration, then a final answer. */
function createScriptedLlm(script: Array<{ name: string; arguments?: string }>): ICompletionBackend {
  let i = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      const step = script[i++];
      await callback([step ? 'working' : 'All done'], {
        inputTokens: 100,
        outputTokens: 50,
        toolsUsed: step ? [step] : [],
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

  it('re-reads a file after an edit even if the pre-edit read was blocked', async () => {
    let contents = 'old contents';
    const readFn = vi.fn(async () => contents);
    const readTool = {
      toolFn: readFn,
      toolSchema: {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };
    const editTool = {
      toolFn: vi.fn(async () => {
        contents = 'new contents';
        return 'edited';
      }),
      // 'edit_file' is classified as a write tool by defaultIsReadOnlyTool.
      toolSchema: {
        name: 'edit_file',
        description: 'Edit a file',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };

    // Read the same file 6 times (trips the block at threshold 5), then edit it,
    // then read it once more - the final read must actually run.
    const script = [
      ...Array.from({ length: 6 }, () => ({ name: 'file_read', arguments: '{"path":"a.ts"}' })),
      { name: 'edit_file', arguments: '{"path":"a.ts"}' },
      { name: 'file_read', arguments: '{"path":"a.ts"}' },
    ];

    const context: AgentContext = {
      userId: 'test-user',
      logger: createMockLogger() as unknown as AgentContext['logger'],
      llm: createScriptedLlm(script),
      model: 'test-model',
      tools: [readTool, editTool],
      maxIterations: 12,
      repeatedCallGuard: { warnThreshold: 3, blockThreshold: 5 },
    };

    const result = await new ReActAgent(context).run('Edit then verify');

    // 5 pre-edit reads ran (6th blocked) + 1 post-edit verify read = 6 executions.
    expect(readFn).toHaveBeenCalledTimes(6);
    // The last read returned the post-edit content.
    const readObservations = result.steps
      .filter(s => s.type === 'observation' && s.metadata?.toolName === 'file_read')
      .map(s => s.content);
    expect(readObservations.at(-1)).toContain('new contents');
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

  it('guards calls dispatched through the parallel-execution path', async () => {
    // Two read-only tools in one turn trips shouldUseParallelExecution, so the
    // batch runs via executeToolsInParallel rather than the sequential loop.
    // This locks in that the guard's record/shouldBlock still fire on that path.
    const readAFn = vi.fn(async () => 'contents of a');
    const readBFn = vi.fn(async () => 'contents of b');
    const readA = {
      toolFn: readAFn,
      toolSchema: {
        name: 'read_a',
        description: 'Read a',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };
    const readB = {
      toolFn: readBFn,
      toolSchema: {
        name: 'read_b',
        description: 'Read b',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };

    const context: AgentContext = {
      userId: 'test-user',
      logger: createMockLogger() as unknown as AgentContext['logger'],
      llm: createLoopingMultiLlm([
        { name: 'read_a', arguments: '{"path":"a.ts"}' },
        { name: 'read_b', arguments: '{"path":"b.ts"}' },
      ]),
      model: 'test-model',
      tools: [readA, readB],
      maxIterations: 12,
      repeatedCallGuard: { warnThreshold: 3, blockThreshold: 5 },
    };

    const result = await new ReActAgent(context).run('Read both', { parallelExecution: true });

    // Each signature is tracked independently through the parallel path and
    // blocks once it has returned the same result blockThreshold (5) times.
    expect(readAFn).toHaveBeenCalledTimes(5);
    expect(readBFn).toHaveBeenCalledTimes(5);
    const observations = result.steps.filter(s => s.type === 'observation').map(s => s.content);
    expect(observations.some(o => o.includes('Circuit breaker'))).toBe(true);
  });

  it('keeps a blocked read blocked when a following mutation FAILS', async () => {
    // The invalidateReadOnly() clear is gated on the write succeeding: a thrown
    // write did not change state, so an earlier read's "settled" block must
    // stand. This is the #696 write-spin invariant - contrast with the
    // successful-edit test above, where the post-edit re-read is allowed to run.
    const readFn = vi.fn(async () => 'unchanged contents');
    const readTool = {
      toolFn: readFn,
      toolSchema: {
        name: 'file_read',
        description: 'Read a file',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };
    const failingWrite = {
      toolFn: vi.fn(async () => {
        throw new Error('disk full');
      }),
      // 'edit_file' is classified as a write tool by defaultIsReadOnlyTool.
      toolSchema: {
        name: 'edit_file',
        description: 'Edit a file',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    };

    // Read until the block trips (5 reads at threshold 5), then a FAILED write,
    // then one more read - which must stay blocked because the write threw.
    const script = [
      ...Array.from({ length: 5 }, () => ({ name: 'file_read', arguments: '{"path":"a.ts"}' })),
      { name: 'edit_file', arguments: '{"path":"a.ts"}' },
      { name: 'file_read', arguments: '{"path":"a.ts"}' },
    ];

    const context: AgentContext = {
      userId: 'test-user',
      logger: createMockLogger() as unknown as AgentContext['logger'],
      llm: createScriptedLlm(script),
      model: 'test-model',
      tools: [readTool, failingWrite],
      maxIterations: 12,
      repeatedCallGuard: { warnThreshold: 3, blockThreshold: 5 },
    };

    const result = await new ReActAgent(context).run('Edit then verify');

    // Only the 5 pre-write reads ran; the failed write did not invalidate the
    // read-only history, so the final read was short-circuited (still 5, not 6).
    expect(readFn).toHaveBeenCalledTimes(5);
    const readObservations = result.steps
      .filter(s => s.type === 'observation' && s.metadata?.toolName === 'file_read')
      .map(s => s.content);
    expect(readObservations.at(-1)).toContain('Circuit breaker');
  });
});
