/**
 * Tests for ReActAgent token-delta streaming.
 *
 * Verifies the agent emits a `text_delta` event for each text chunk that
 * arrives through the LLM completion callback, with the 0-indexed iteration
 * stamped on the payload. This is the foundation for the subagent UI's
 * "live partial response" rendering; without it, every iteration looks
 * frozen until the full LLM response lands.
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

/**
 * Mock LLM that simulates a streaming backend by invoking the callback
 * multiple times before returning the final completionInfo. Matches the
 * real Anthropic/OpenAI backend contract: each callback gets delta-only
 * text in the `texts` array.
 */
function createStreamingMockLlm(chunks: string[], finalAnswer: string): ICompletionBackend {
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      for (const chunk of chunks) {
        await callback([chunk]);
      }
      await callback([finalAnswer], {
        inputTokens: 10,
        outputTokens: 5,
        toolsUsed: [],
      });
    },
    pushToolMessages: vi.fn(),
  };
}

describe('ReActAgent text_delta emission (#8774)', () => {
  it('emits text_delta for each streamed chunk with 0-indexed iteration', async () => {
    const chunks = ['Hello', ' ', 'world'];
    const finalAnswer = '!';
    const llm = createStreamingMockLlm(chunks, finalAnswer);

    const context: AgentContext = {
      userId: 'u1',
      logger: createMockLogger(),
      llm,
      model: 'test-model',
      tools: [],
      maxIterations: 5,
    };

    const agent = new ReActAgent(context);
    const deltas: Array<{ delta: string; iteration: number }> = [];
    agent.on('text_delta', info => deltas.push(info));

    await agent.run('test query');

    // All four chunks (3 streamed + 1 final) emit deltas, all stamped with iteration 0.
    expect(deltas.map(d => d.delta)).toEqual(['Hello', ' ', 'world', '!']);
    expect(deltas.every(d => d.iteration === 0)).toBe(true);
  });

  it('stamps the correct iteration index on multi-iteration runs', async () => {
    // First iteration calls a tool (no final answer), second produces the answer.
    let callCount = 0;
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (
        _model: string,
        _messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
      ) => {
        callCount++;
        if (callCount === 1) {
          await callback(['think']);
          await callback([' more']);
          await callback([null], {
            inputTokens: 10,
            outputTokens: 5,
            toolsUsed: [{ name: 'ping', arguments: '{}', id: 'tool1' }],
          });
        } else {
          await callback(['done']);
          await callback([null], { inputTokens: 5, outputTokens: 2, toolsUsed: [] });
        }
      },
      pushToolMessages: vi.fn(),
    };

    const context: AgentContext = {
      userId: 'u1',
      logger: createMockLogger(),
      llm,
      model: 'test-model',
      tools: [
        {
          toolFn: async () => 'pong',
          toolSchema: {
            name: 'ping',
            description: 'ping',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ],
      maxIterations: 5,
    };

    const agent = new ReActAgent(context);
    const deltas: Array<{ delta: string; iteration: number }> = [];
    agent.on('text_delta', info => deltas.push(info));

    await agent.run('test');

    const firstIterDeltas = deltas.filter(d => d.iteration === 0).map(d => d.delta);
    const secondIterDeltas = deltas.filter(d => d.iteration === 1).map(d => d.delta);
    expect(firstIterDeltas).toEqual(['think', ' more']);
    expect(secondIterDeltas).toEqual(['done']);
  });

  it('emits a delta per text segment when a callback invocation carries multiple chunks', async () => {
    // Anthropic/OpenAI adapters may surface multiple text blocks in a single
    // streaming callback (e.g., a thinking block followed by a content block).
    // Each non-empty entry must produce its own delta, all stamped with the
    // same iteration index.
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (
        _model: string,
        _messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
      ) => {
        await callback(['a', 'b']);
        await callback([null], { inputTokens: 5, outputTokens: 2, toolsUsed: [] });
      },
      pushToolMessages: vi.fn(),
    };

    const context: AgentContext = {
      userId: 'u1',
      logger: createMockLogger(),
      llm,
      model: 'test-model',
      tools: [],
      maxIterations: 5,
    };

    const agent = new ReActAgent(context);
    const deltas: Array<{ delta: string; iteration: number }> = [];
    agent.on('text_delta', info => deltas.push(info));

    await agent.run('test');

    expect(deltas).toEqual([
      { delta: 'a', iteration: 0 },
      { delta: 'b', iteration: 0 },
    ]);
  });

  /**
   * Regression: when subagent LLM calls flipped to `stream: true`, the ReAct
   * loop began terminating at iteration 1 for any model that emits a preamble
   * before its tool batch. Real Anthropic streaming passes `{ toolsUsed: [...] }`
   * on every `text_delta` cb, but `toolsUsed` is only fully populated once the
   * trailing `tool_use` blocks finish streaming. The old in-callback
   * "no tools && have text -> final answer" guard mis-fired on the preamble
   * frame and ended the loop with the preamble as the answer.
   *
   * Surfaced after upgrading `@bike4mind/agents` 0.11.1 -> 0.15.0, where 100%
   * of agentic "Brief" runs dropped.
   */
  it('does not terminate at iteration 1 when streaming preamble precedes tool_use', async () => {
    let callCount = 0;
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (
        _model: string,
        _messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
      ) => {
        callCount++;
        if (callCount === 1) {
          // Anthropic-style: text_delta cbs carry `{ toolsUsed }` even though
          // tools have not been emitted yet (their `tool_use` blocks stream
          // AFTER the preamble text). The mid-stream `toolsUsed` array is
          // empty; only the terminal cb sees the full tool list.
          await callback(["I'll execute the tool calls now…"], { toolsUsed: [] });
          await callback([null], {
            inputTokens: 100,
            outputTokens: 50,
            toolsUsed: [{ name: 'ping', arguments: '{}', id: 'tool1' }],
          });
        } else {
          // Second iteration: real final answer.
          await callback(['Done.'], { toolsUsed: [] });
          await callback([null], { inputTokens: 50, outputTokens: 10, toolsUsed: [] });
        }
      },
      pushToolMessages: vi.fn(),
    };

    const context: AgentContext = {
      userId: 'u1',
      logger: createMockLogger(),
      llm,
      model: 'test-model',
      tools: [
        {
          toolFn: async () => 'pong',
          toolSchema: {
            name: 'ping',
            description: 'ping',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ],
      maxIterations: 5,
    };

    const agent = new ReActAgent(context);
    const thoughtEvents: string[] = [];
    agent.on('thought', step => thoughtEvents.push(step.content));

    const result = await agent.run('test');

    expect(result.finalAnswer).toBe('Done.');
    expect(result.completionInfo.iterations).toBe(2);
    expect(result.completionInfo.toolCalls).toBe(1);
    // Preamble should land as a single thought step, not as the final answer.
    expect(thoughtEvents).toEqual(["I'll execute the tool calls now…"]);
  });

  it('skips empty/falsy text chunks', async () => {
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (
        _model: string,
        _messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
      ) => {
        await callback([null, undefined, '']);
        await callback(['real chunk']);
        await callback([null], { inputTokens: 5, outputTokens: 2, toolsUsed: [] });
      },
      pushToolMessages: vi.fn(),
    };

    const context: AgentContext = {
      userId: 'u1',
      logger: createMockLogger(),
      llm,
      model: 'test-model',
      tools: [],
      maxIterations: 5,
    };

    const agent = new ReActAgent(context);
    const deltas: string[] = [];
    agent.on('text_delta', info => deltas.push(info.delta));

    await agent.run('test');

    expect(deltas).toEqual(['real chunk']);
  });
});
