/**
 * Tests for the per-iteration prompt-cache strategy built by ReActAgent
 * (see `buildCacheStrategy` in ReActAgent.ts) - issue #631: an incremental,
 * moving conversation-history cache breakpoint.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage, ICacheStrategy } from '@bike4mind/common';

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

/**
 * Backend that requests a tool call on the first N completions (so the loop
 * keeps iterating), then finishes with a final answer. Snapshots the
 * cacheStrategy it was called with on every completion.
 */
function createToolThenAnswerLlm(toolIterations: number): {
  llm: ICompletionBackend;
  cacheStrategies: (ICacheStrategy | undefined)[];
} {
  const cacheStrategies: (ICacheStrategy | undefined)[] = [];
  let callIndex = 0;
  const llm: ICompletionBackend = {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      cacheStrategies.push(options.cacheStrategy);
      callIndex++;
      if (callIndex <= toolIterations) {
        await callback([''], {
          inputTokens: 5,
          outputTokens: 2,
          toolsUsed: [{ id: `call-${callIndex}`, name: 'noop', arguments: '{}' }],
          stopReason: 'tool_use',
        });
        return;
      }
      await callback(['final answer'], { inputTokens: 5, outputTokens: 2, toolsUsed: [], stopReason: 'end_turn' });
    },
    pushToolMessages: (messages, toolCall, observation) => {
      messages.push({ role: 'assistant', content: `[tool_use ${toolCall.id}]` } as IMessage);
      messages.push({ role: 'user', content: `[tool_result ${toolCall.id}] ${observation}` } as IMessage);
    },
  };
  return { llm, cacheStrategies };
}

const noopTool = {
  toolFn: async () => 'ok',
  toolSchema: { name: 'noop', description: 'noop', parameters: { type: 'object' as const, properties: {} } },
};

describe('ReActAgent cache strategy', () => {
  it('is undefined when enableCaching is not set', async () => {
    const { llm, cacheStrategies } = createToolThenAnswerLlm(1);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    await agent.run('do the thing');

    expect(cacheStrategies.length).toBeGreaterThan(0);
    for (const strategy of cacheStrategies) {
      expect(strategy).toBeUndefined();
    }
  });

  it('enables a moving conversation-history breakpoint on every iteration', async () => {
    const { llm, cacheStrategies } = createToolThenAnswerLlm(2);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    await agent.run('do the thing', { enableCaching: true });

    expect(cacheStrategies.length).toBe(3);
    for (const strategy of cacheStrategies) {
      expect(strategy?.enableCaching).toBe(true);
      expect(strategy?.cacheSystemPrompt).toBe(true);
      expect(strategy?.cacheTools).toBe(true);
      expect(strategy?.cacheConversationHistory).toBe(true);
      expect(strategy?.historyCacheExcludeTrailingCount).toBe(0);
    }
  });

  it('excludes the trailing workflow reminder from the history breakpoint', async () => {
    const { llm, cacheStrategies } = createToolThenAnswerLlm(2);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    await agent.run('do the thing', {
      enableCaching: true,
      workflowReminder: () => 'Open todos:\n1. [in_progress] fix the bug',
    });

    expect(cacheStrategies.length).toBe(3);
    for (const strategy of cacheStrategies) {
      expect(strategy?.cacheConversationHistory).toBe(true);
      expect(strategy?.historyCacheExcludeTrailingCount).toBe(1);
    }
  });

  it('reflects cacheTools as false when the agent has no tools', async () => {
    const { llm, cacheStrategies } = createToolThenAnswerLlm(0);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('do the thing', { enableCaching: true });

    expect(cacheStrategies.length).toBe(1);
    expect(cacheStrategies[0]?.cacheTools).toBe(false);
    expect(cacheStrategies[0]?.cacheConversationHistory).toBe(true);
  });

  it('builds the same moving breakpoint strategy in runIteration()', async () => {
    const { llm, cacheStrategies } = createToolThenAnswerLlm(2);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    const options = {
      enableCaching: true,
      workflowReminder: () => 'iter state',
    };
    let result = await agent.runIteration('do the thing', options);
    while (!result.isComplete) {
      result = await agent.runIteration(undefined, options);
    }

    expect(cacheStrategies.length).toBe(3);
    for (const strategy of cacheStrategies) {
      expect(strategy?.cacheConversationHistory).toBe(true);
      expect(strategy?.historyCacheExcludeTrailingCount).toBe(1);
    }
  });
});
