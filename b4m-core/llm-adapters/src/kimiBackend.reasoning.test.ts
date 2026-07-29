import { ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { KimiBackend } from './kimiBackend';
import type { CompletionInfo } from './backend';

/**
 * The non-streaming reasoning path. Every case here was a real defect in the first
 * cut of this backend, and each one is silent: no error, no log, just a wrong or
 * missing answer.
 */

type Choice = {
  index: number;
  message: Record<string, unknown>;
  finish_reason?: string;
};

/** A KimiBackend whose OpenAI client is replaced by a canned non-streaming reply. */
function backendReturning(choices: Choice[], usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  const backend = new KimiBackend('test-key');
  const create = vi.fn().mockResolvedValue({ choices, usage });
  // The client is private; swapping it is the seam that keeps this a unit test
  // rather than a live Moonshot call.
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, create };
}

const userMessages = (): IMessage[] => [{ role: 'user', content: 'hi' } as IMessage];

async function runTurn(backend: KimiBackend, model: string, options = {}) {
  const frames: Array<{ text: (string | null | undefined)[]; info: CompletionInfo }> = [];
  await backend.complete(model, userMessages(), { stream: false, ...options }, async (text, info) => {
    frames.push({ text, info });
  });
  return frames;
}

describe('KimiBackend reasoning capture', () => {
  it('keeps reasoning_content even when no reasoning parameter was sent', async () => {
    // The original gate derived "did the model think" from "did we send a thinking
    // parameter". K3 always reasons and kimiReasoningParams sends nothing unless an
    // explicit effort was set, which is the default - so reasoning was billed as
    // output tokens and then thrown away on the common path.
    const { backend } = backendReturning([
      { index: 0, message: { content: 'the answer', reasoning_content: 'my thinking' }, finish_reason: 'stop' },
    ]);

    const frames = await runTurn(backend, ChatModels.KIMI_K3);
    expect(frames.at(-1)?.text[0]).toBe('<think>my thinking</think>the answer');
  });

  it('runs the tool when a turn carries BOTH reasoning and tool calls', async () => {
    // Handling reasoning first returned the monologue as the entire answer and ran
    // nothing. k2.7-code cannot disable thinking, so for the agentic models this
    // was the normal case rather than an edge one.
    const toolFn = vi.fn().mockResolvedValue('tool output');
    const { backend, create } = backendReturning([
      {
        index: 0,
        message: {
          content: '',
          reasoning_content: 'I should call the tool',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ]);
    // Second turn: the recursive call after the tool result resolves.
    create.mockResolvedValueOnce({
      choices: [
        {
          index: 0,
          message: {
            content: '',
            reasoning_content: 'I should call the tool',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    create.mockResolvedValue({
      choices: [{ index: 0, message: { content: 'final answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });

    const frames = await runTurn(backend, ChatModels.KIMI_K2_7_CODE, {
      tools: [
        {
          toolSchema: { name: 'search', description: 'search', parameters: { type: 'object' } },
          toolFn,
        },
      ],
    });

    expect(toolFn).toHaveBeenCalledOnce();
    expect(frames.at(-1)?.text[0]).toBe('final answer');
    expect(frames.at(-1)?.info.toolsUsed?.map(t => t.name)).toEqual(['search']);
  });

  it('throws a diagnosable error when reasoning consumed the whole output budget', async () => {
    // A K3 turn that hits max_completion_tokens mid-reasoning returns empty
    // content, which used to surface as a blank reply with no error at all.
    const { backend } = backendReturning([{ index: 0, message: { content: '' }, finish_reason: 'length' }]);

    await expect(runTurn(backend, ChatModels.KIMI_K3)).rejects.toThrow(/output budget was exhausted/);
  });

  it('does not fire the empty guard for a turn that legitimately only called a tool', async () => {
    const { backend } = backendReturning([
      {
        index: 0,
        message: {
          content: '',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ]);

    // executeTools: false makes the tool turn terminal, so the guard would be
    // reached if it were keyed on text alone.
    await expect(
      runTurn(backend, ChatModels.KIMI_K2_6, { executeTools: false, tools: [] })
    ).resolves.not.toThrow();
  });
});
