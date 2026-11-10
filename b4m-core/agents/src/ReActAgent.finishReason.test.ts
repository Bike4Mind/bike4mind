/**
 * Tests for ReActAgent provider-stop-reason capture (#293).
 *
 * The agent receives `CompletionInfo.stopReason` through the same
 * `backend.complete()` callback chat uses, but historically dropped it. It is
 * now captured (preserve-last-non-null) into `lastStopReason`, surfaced on the
 * checkpoint as `finishReason`, and persisted to `Quest.promptMeta.finishReason`
 * by the executor - so the client can tell a truncated artifact from a completed
 * reply that merely contains an unclosed `<artifact>` tag in prose.
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
 * Mock backend that resolves a single completion, driving the callback with the
 * provided frames. Each frame is `[texts, completionInfo?]`; frames without a
 * `stopReason` exercise the preserve-last-non-null guard.
 */
function createFramedLlm(frames: Array<[(string | null)[], CompletionInfo?]>): ICompletionBackend {
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      for (const [texts, info] of frames) {
        await callback(texts, info);
      }
    },
    pushToolMessages: vi.fn(),
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

const PING_TOOL = {
  toolFn: vi.fn(async () => 'pong'),
  toolSchema: {
    name: 'ping',
    description: 'ping',
    parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
};

describe('ReActAgent finishReason capture (#293)', () => {
  it('captures a clean end_turn stop reason on the checkpoint', async () => {
    const llm = createFramedLlm([
      [['All done.'], { inputTokens: 10, outputTokens: 5, toolsUsed: [], stopReason: 'end_turn' }],
    ]);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('do the thing');

    expect(agent.toCheckpoint().finishReason).toBe('end_turn');
  });

  it('captures max_tokens (truncation) as the stop reason', async () => {
    const llm = createFramedLlm([
      [['Partial repl'], { inputTokens: 10, outputTokens: 4096, toolsUsed: [], stopReason: 'max_tokens' }],
    ]);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('write a long thing');

    expect(agent.toCheckpoint().finishReason).toBe('max_tokens');
  });

  it('lets the final no-tool completion overwrite an earlier tool_use stop reason', async () => {
    // Iteration 1 ends on tool_use; iteration 2 (the final answer) ends on end_turn.
    // The finishReason read after the run must reflect the LAST completion.
    let callIndex = 0;
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (
        _model: string,
        _messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
      ) => {
        callIndex++;
        if (callIndex === 1) {
          await callback(['calling the tool'], {
            inputTokens: 10,
            outputTokens: 5,
            toolsUsed: [{ name: 'ping', arguments: '{}', id: 'tool1' }],
            stopReason: 'tool_use',
          });
        } else {
          await callback(['final answer'], { inputTokens: 5, outputTokens: 2, toolsUsed: [], stopReason: 'end_turn' });
        }
      },
      pushToolMessages: vi.fn(),
    };

    const agent = new ReActAgent(createContext(llm, { tools: [PING_TOOL] }));
    await agent.run('use the tool then answer');

    expect(agent.toCheckpoint().finishReason).toBe('end_turn');
  });

  it('preserves the last non-null stop reason across streaming frames', async () => {
    // The final message_delta carries the stop reason; a trailing usage-only
    // frame must NOT clobber it back to undefined (the `!= null` guard).
    const llm = createFramedLlm([
      [['answer'], { inputTokens: 10, outputTokens: 5, toolsUsed: [], stopReason: 'end_turn' }],
      [[null], { inputTokens: 0, outputTokens: 0, toolsUsed: [] }],
    ]);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('answer me');

    expect(agent.toCheckpoint().finishReason).toBe('end_turn');
  });

  it('leaves finishReason undefined when the backend reports none', async () => {
    const llm = createFramedLlm([[['answer'], { inputTokens: 10, outputTokens: 5, toolsUsed: [] }]]);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('answer me');

    expect(agent.toCheckpoint().finishReason).toBeUndefined();
  });

  it('captures the stop reason through the runIteration() executor path', async () => {
    const llm = createFramedLlm([
      [['done'], { inputTokens: 10, outputTokens: 5, toolsUsed: [], stopReason: 'end_turn' }],
    ]);
    const agent = new ReActAgent(createContext(llm));

    const result = await agent.runIteration('do it', { maxHistoryIterations: 0 });

    expect(result.isComplete).toBe(true);
    expect(result.checkpoint.finishReason).toBe('end_turn');
  });

  it('survives a checkpoint round-trip through fromCheckpoint (AC5)', async () => {
    const llm = createFramedLlm([
      [['done'], { inputTokens: 10, outputTokens: 5, toolsUsed: [], stopReason: 'end_turn' }],
    ]);
    const agent = new ReActAgent(createContext(llm));
    await agent.run('do it');

    // Serialize + restore in a fresh agent, mimicking a continuation Lambda.
    const serialized = JSON.parse(JSON.stringify(agent.toCheckpoint()));
    const resumed = new ReActAgent(createContext(createFramedLlm([[['x'], { toolsUsed: [] }]])));
    resumed.fromCheckpoint(serialized);

    expect(resumed.toCheckpoint().finishReason).toBe('end_turn');
  });
});

describe('ReActAgent on a declined turn', () => {
  // A refusal settled with no answer and no tool calls: the loop must not re-send (and re-bill) it.
  const declinedFrames = (stopReason: string): Array<[(string | null)[], CompletionInfo?]> => [
    [[''], { inputTokens: 10, outputTokens: 0, toolsUsed: [], stopReason }],
  ];

  it.each(['refusal', 'content_filter'])('run() ends after one call on a %s turn', async stopReason => {
    const llm = createFramedLlm(declinedFrames(stopReason));
    const complete = vi.spyOn(llm, 'complete');
    const agent = new ReActAgent(createContext(llm, { maxIterations: 10 }));

    const result = await agent.run('a request the classifier declines');

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.finalAnswer).toBe('The model declined this request');
    expect(result.completionInfo.iterations).toBe(1);
    expect(result.completionInfo.reachedMaxIterations).toBe(false);
    expect(result.completionInfo.finishReason).toBe(stopReason);
  });

  it('runIteration() completes on a refusal turn with the decline as its final answer', async () => {
    const llm = createFramedLlm(declinedFrames('refusal'));
    const complete = vi.spyOn(llm, 'complete');
    const agent = new ReActAgent(createContext(llm, { maxIterations: 10 }));

    const result = await agent.runIteration('a request the classifier declines', { maxHistoryIterations: 0 });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.isComplete).toBe(true);
    expect(result.reachedMaxIterations).toBe(false);
    expect(result.step).toMatchObject({ type: 'final_answer', content: 'The model declined this request' });
  });

  it('keeps text streamed before the refusal as the final answer, as any no-tool turn would', async () => {
    const llm = createFramedLlm([[['Here is the first part'], { toolsUsed: [], stopReason: 'refusal' }]]);
    const complete = vi.spyOn(llm, 'complete');
    const drainFeedback = vi.fn(async () => 'more please');
    const agent = new ReActAgent(createContext(llm, { maxIterations: 10 }));

    const result = await agent.run('a request the classifier declines midway', { drainFeedback });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(drainFeedback).not.toHaveBeenCalled();
    expect(result.finalAnswer).toBe('Here is the first part');
  });
});
