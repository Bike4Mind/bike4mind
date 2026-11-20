import { ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicBackend } from './anthropicBackend';
import { DeepSeekBackend } from './deepseekBackend';
import { convertOpenAIToolHistoryToCanonical } from './messageFormatConverter';

/**
 * A DeepSeek stream that dies mid tool loop falls back to another provider with the
 * same message array, which DeepSeek has already extended with OpenAI-shape tool
 * rounds. ChatCompletionProcess normalizes it on a cross-backend hop; this pins that
 * the normalized array is one Anthropic accepts.
 */
// The hop carries the turn's tools; without them Anthropic strips the tool blocks as orphans.
const searchTools = () => [
  {
    toolSchema: { name: 'search', description: 'search', parameters: { type: 'object' } },
    toolFn: vi.fn().mockResolvedValue('found'),
  },
];

describe('DeepSeek tool history on a fallback hop to Anthropic', () => {
  async function deepSeekHistoryAfterMidLoopFailure(): Promise<IMessage[]> {
    const backend = new DeepSeekBackend('test-key');
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [
          {
            index: 0,
            message: {
              content: '',
              reasoning_content: 'search twice',
              tool_calls: [
                { id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"a"}' } },
                { id: 't2', type: 'function', function: { name: 'search', arguments: '{"q":"b"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .mockRejectedValueOnce(new TypeError('terminated'));
    (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };

    const messages = [{ role: 'user', content: 'find a and b' }] as IMessage[];
    await expect(
      backend.complete(
        ChatModels.DEEPSEEK_FLASH,
        messages,
        { stream: false, tools: searchTools() } as never,
        async () => {}
      )
    ).rejects.toThrow('terminated');
    return messages;
  }

  function anthropicCapturing() {
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const anthropic = new AnthropicBackend('test-key', logger as never);
    (anthropic as unknown as { _api: unknown })._api = { messages: { create } };
    const send = async (history: IMessage[], options: Record<string, unknown> = {}) => {
      await anthropic.complete(
        ChatModels.CLAUDE_4_8_OPUS,
        history,
        { stream: false, tools: searchTools(), executeTools: false, ...options } as never,
        async () => {}
      );
      return (create.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0];
    };
    return { send };
  }

  it('produces a message array Anthropic accepts', async () => {
    const history = convertOpenAIToolHistoryToCanonical(await deepSeekHistoryAfterMidLoopFailure());

    const request = await anthropicCapturing().send(history);

    const sent = request.messages as Array<{ role: string; content: unknown }>;
    expect(sent.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    for (const m of sent) expect(m.content === null || m.content === undefined).toBe(false);
    expect(sent[1].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } },
      { type: 'tool_use', id: 't2', name: 'search', input: { q: 'b' } },
    ]);
    expect((sent[2].content as Array<{ type: string; tool_use_id: string }>).map(b => [b.type, b.tool_use_id])).toEqual(
      [
        ['tool_result', 't1'],
        ['tool_result', 't2'],
      ]
    );
  });

  it('skips thinking for the hop, which the API refuses on a tool turn with no thinking block', async () => {
    const history = convertOpenAIToolHistoryToCanonical(await deepSeekHistoryAfterMidLoopFailure());

    const request = await anthropicCapturing().send(history, { thinking: { enabled: true, budget_tokens: 2048 } });

    expect(request.thinking).toBeUndefined();
  });

  it('keeps thinking off for the later tool rounds of the hop model', async () => {
    // Round 1 runs without thinking, so its tool_use goes back with no thinking block either;
    // re-enabling thinking on round 2 would draw the same 400.
    const history = convertOpenAIToolHistoryToCanonical(await deepSeekHistoryAfterMidLoopFailure());
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't3', name: 'search', input: { q: 'c' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const anthropic = new AnthropicBackend('test-key', logger as never);
    (anthropic as unknown as { _api: unknown })._api = { messages: { create } };

    await anthropic.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      history,
      { stream: false, tools: searchTools(), thinking: { enabled: true, budget_tokens: 2048 } } as never,
      async () => {}
    );

    expect(create).toHaveBeenCalledTimes(2);
    for (const [request] of create.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(request.thinking).toBeUndefined();
    }
  });

  it('keeps thinking on for a history that does not continue a tool turn', async () => {
    const request = await anthropicCapturing().send([{ role: 'user', content: 'hi' }] as IMessage[], {
      thinking: { enabled: true, budget_tokens: 2048 },
    });

    expect(request.thinking).toBeDefined();
  });
});
