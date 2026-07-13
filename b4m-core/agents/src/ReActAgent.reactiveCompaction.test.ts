/**
 * Tests for reactive compaction recovery on a mid-loop context-limit error
 * in `ReActAgent.run()` (see `AgentRunOptions.onContextLimit`).
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createContext(llm: ICompletionBackend, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'u1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: createMockLogger() as any,
    llm,
    model: 'test-model',
    tools: [],
    maxIterations: 5,
    ...overrides,
  };
}

/** Backend whose `complete()` throws on the Nth call (1-indexed), then succeeds. */
function createFailThenSucceedLlm(failOnCall: number, failureMessage: string, failCount = 1): ICompletionBackend {
  let callIndex = 0;
  let failuresLeft = failCount;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      callIndex++;
      if (callIndex >= failOnCall && failuresLeft > 0) {
        failuresLeft--;
        throw new Error(failureMessage);
      }
      await callback(['final answer'], { inputTokens: 5, outputTokens: 2, toolsUsed: [], stopReason: 'end_turn' });
    },
    pushToolMessages: vi.fn(),
  };
}

describe('ReActAgent reactive compaction recovery', () => {
  it('compacts and retries once on a context-limit error, succeeding on retry', async () => {
    const llm = createFailThenSucceedLlm(1, 'prompt is too long: 250000 tokens > 200000 maximum');
    const agent = new ReActAgent(createContext(llm));

    const onContextLimit = vi.fn(async (messages: IMessage[]) => {
      // Return a strictly smaller history: keep just the system message.
      return [messages[0]];
    });

    const result = await agent.run('do the thing', { onContextLimit });

    expect(onContextLimit).toHaveBeenCalledTimes(1);
    expect(result.finalAnswer).toBe('final answer');
    expect(result.completionInfo.iterations).toBe(1);
  });

  it('does not double-count tokens/steps from the failed attempt', async () => {
    // First call throws mid-stream after reporting partial usage; second call succeeds.
    let callIndex = 0;
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (_model, _messages, _options, callback) => {
        callIndex++;
        if (callIndex === 1) {
          await callback(['partial'], { inputTokens: 999, outputTokens: 999, toolsUsed: [] });
          throw new Error('prompt is too long');
        }
        await callback(['final answer'], { inputTokens: 5, outputTokens: 2, toolsUsed: [], stopReason: 'end_turn' });
      },
      pushToolMessages: vi.fn(),
    };
    const agent = new ReActAgent(createContext(llm));

    const result = await agent.run('do the thing', {
      onContextLimit: async messages => [messages[0]],
    });

    expect(result.completionInfo.totalInputTokens).toBe(5);
    expect(result.completionInfo.totalOutputTokens).toBe(2);
  });

  it('rethrows the original error when the callback returns null', async () => {
    const llm = createFailThenSucceedLlm(1, 'prompt is too long');
    const agent = new ReActAgent(createContext(llm));

    const onContextLimit = vi.fn(async () => null);

    await expect(agent.run('do the thing', { onContextLimit })).rejects.toThrow('prompt is too long');
    expect(onContextLimit).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error when the callback cannot shrink the history', async () => {
    const llm = createFailThenSucceedLlm(1, 'prompt is too long');
    const agent = new ReActAgent(createContext(llm));

    // Returns the same history back (no shrink).
    const onContextLimit = vi.fn(async (messages: IMessage[]) => messages);

    await expect(agent.run('do the thing', { onContextLimit })).rejects.toThrow('prompt is too long');
  });

  it('fires at most once per run(): a second consecutive context-limit error rethrows', async () => {
    const llm = createFailThenSucceedLlm(1, 'prompt is too long', 2);
    const agent = new ReActAgent(createContext(llm));

    const onContextLimit = vi.fn(async (messages: IMessage[]) => [messages[0]]);

    await expect(agent.run('do the thing', { onContextLimit })).rejects.toThrow('prompt is too long');
    expect(onContextLimit).toHaveBeenCalledTimes(1);
  });

  it('does not attempt compaction for non-context errors', async () => {
    const llm = createFailThenSucceedLlm(1, 'Authentication failed: invalid API key');
    const agent = new ReActAgent(createContext(llm));

    const onContextLimit = vi.fn(async (messages: IMessage[]) => [messages[0]]);

    await expect(agent.run('do the thing', { onContextLimit })).rejects.toThrow('Authentication failed');
    expect(onContextLimit).not.toHaveBeenCalled();
  });

  it('behaves exactly as before when no onContextLimit is provided', async () => {
    const llm = createFailThenSucceedLlm(1, 'prompt is too long');
    const agent = new ReActAgent(createContext(llm));

    await expect(agent.run('do the thing')).rejects.toThrow('prompt is too long');
  });
});
