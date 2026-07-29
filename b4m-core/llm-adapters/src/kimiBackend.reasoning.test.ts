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

  /**
   * Moonshot's `prompt_tokens` is CACHE-INCLUSIVE. Verified live 2026-07-28: a
   * repeated 1220-token prompt came back `prompt_tokens: 1220` WITH
   * `cached_tokens: 1220` - the same tokens counted once, not 1220 fresh plus 1220
   * cached. getTextModelCost expects Anthropic's cache-EXCLUSIVE convention, so the
   * backend has to split them or the user pays the full input rate ($0.95/MTok on
   * k2.6) for tokens Moonshot billed at $0.16.
   */
  it('splits cache-inclusive prompt_tokens so a hit is billed at the cache rate', async () => {
    const { backend } = backendReturning([{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }], {
      prompt_tokens: 1220,
      completion_tokens: 31,
      cached_tokens: 1220,
    } as never);

    const frames = await runTurn(backend, ChatModels.KIMI_K2_6, { cacheStrategy: { enableCaching: true } });
    const info = frames.at(-1)!.info;

    // All 1220 were cache reads, so nothing remains at the full input rate.
    expect(info.inputTokens).toBe(0);
    expect(info.cacheReadInputTokens).toBe(1220);
    // The two must sum back to what the provider reported, or the turn is either
    // over- or under-billed.
    expect((info.inputTokens ?? 0) + (info.cacheReadInputTokens ?? 0)).toBe(1220);
  });

  it('reads the nested OpenAI cached_tokens spelling too, since Moonshot sends both', async () => {
    const { backend } = backendReturning([{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }], {
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 40 },
    } as never);

    const info = (await runTurn(backend, ChatModels.KIMI_K2_6, { cacheStrategy: { enableCaching: true } })).at(
      -1
    )!.info;
    expect(info.inputTokens).toBe(60);
    expect(info.cacheReadInputTokens).toBe(40);
  });

  it('leaves inputTokens whole and claims no cache read when nothing was cached', async () => {
    const { backend } = backendReturning([{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }], {
      prompt_tokens: 100,
      completion_tokens: 5,
    } as never);

    const info = (await runTurn(backend, ChatModels.KIMI_K2_6)).at(-1)!.info;
    expect(info.inputTokens).toBe(100);
    expect(info.cacheReadInputTokens).toBeUndefined();
  });

  it('never reports negative input if a feed claims more cached than prompt tokens', async () => {
    // A negative input count would silently credit the user.
    const { backend } = backendReturning([{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }], {
      prompt_tokens: 50,
      completion_tokens: 5,
      cached_tokens: 900,
    } as never);

    const info = (await runTurn(backend, ChatModels.KIMI_K2_6)).at(-1)!.info;
    expect(info.inputTokens).toBe(0);
    expect(info.cacheReadInputTokens).toBe(50);
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
    await expect(runTurn(backend, ChatModels.KIMI_K2_6, { executeTools: false, tools: [] })).resolves.not.toThrow();
  });
});
