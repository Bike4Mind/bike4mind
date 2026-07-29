import { ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { ChoiceEndReason, ChoiceStatus } from '../backend';
import MoonshotBedrockBackend from './moonshot';

const backend = new MoonshotBedrockBackend();
const messages: IMessage[] = [{ role: 'user', content: 'hello' } as IMessage];

const bodyOf = (model: string, options = {}) => JSON.parse(backend.getPayload(model, messages, options).body);

describe('MoonshotBedrockBackend payload', () => {
  it('uses the bedrock-runtime model ids, whose prefixes genuinely disagree', () => {
    // Not a typo, and not ours to normalize: AWS publishes k2.5 as `moonshotai.`
    // and k2-thinking as `moonshot.` on this endpoint.
    expect(backend.getPayload(ChatModels.KIMI_K2_5_BEDROCK, messages, {}).modelId).toBe('moonshotai.kimi-k2.5');
    expect(backend.getPayload(ChatModels.KIMI_K2_THINKING_BEDROCK, messages, {}).modelId).toBe(
      'moonshot.kimi-k2-thinking'
    );
  });

  it('clamps max_tokens to the 16K Bedrock ceiling rather than passing the direct-API limit', () => {
    // Direct Moonshot allows 262144; asking Bedrock for it is a validation error.
    expect(bodyOf(ChatModels.KIMI_K2_5_BEDROCK, { maxTokens: 262_144 }).max_tokens).toBe(16_384);
  });

  it('always sends max_tokens, which the Invoke body requires', () => {
    expect(bodyOf(ChatModels.KIMI_K2_5_BEDROCK)).toHaveProperty('max_tokens');
  });

  it('passes temperature and top_p through, unlike the direct-served family', () => {
    const body = bodyOf(ChatModels.KIMI_K2_5_BEDROCK, { temperature: 0.4, topP: 0.8 });
    expect(body.temperature).toBe(0.4);
    expect(body.top_p).toBe(0.8);
  });

  it('omits sampling params it was not given rather than inventing defaults', () => {
    const body = bodyOf(ChatModels.KIMI_K2_5_BEDROCK);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('drops empty-content messages that Bedrock would reject', () => {
    const withEmpty: IMessage[] = [
      { role: 'user', content: '' } as IMessage,
      { role: 'user', content: 'real' } as IMessage,
    ];
    const body = JSON.parse(backend.getPayload(ChatModels.KIMI_K2_5_BEDROCK, withEmpty, {}).body);
    expect(body.messages).toEqual([{ role: 'user', content: 'real' }]);
  });
});

describe('MoonshotBedrockBackend response translation', () => {
  it("maps OpenAI's usage names onto the normalized chunk's, so a turn can settle", () => {
    // The base class reads choices[0].usage.input_tokens; Kimi quotes
    // prompt_tokens. Without this mapping every Bedrock Kimi turn bills zero.
    const { chunk } = backend.translateChunk(ChatModels.KIMI_K2_5_BEDROCK, {
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 34 },
    });
    expect(chunk.choices[0].usage).toEqual({ input_tokens: 120, output_tokens: 34 });
  });

  it('wraps reasoning_content in the <think> envelope the client already renders', () => {
    const { chunk } = backend.translateChunk(ChatModels.KIMI_K2_THINKING_BEDROCK, {
      choices: [{ message: { content: 'answer', reasoning_content: 'because' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(chunk.choices[0].status).toBe(ChoiceStatus.END);
    expect('chunkText' in chunk.choices[0] && chunk.choices[0].chunkText).toBe('<think>because</think>answer');
  });

  it('reports zero usage rather than throwing when the response omits it', () => {
    const { chunk } = backend.translateChunk(ChatModels.KIMI_K2_5_BEDROCK, {
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    });
    expect(chunk.choices[0].usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('tolerates a response with no choices at all', () => {
    expect(backend.translateChunk(ChatModels.KIMI_K2_5_BEDROCK, {}).chunk.choices).toEqual([]);
  });
});

describe('MoonshotBedrockBackend tool calling', () => {
  const toolSchema = { name: 'search', description: 'search the web', parameters: { type: 'object' } };
  const tools = [{ toolSchema, toolFn: async () => 'ok' }] as never;

  it('sends tools in the OpenAI shape Moonshot takes on the Invoke path', () => {
    const body = JSON.parse(backend.getPayload(ChatModels.KIMI_K2_5_BEDROCK, messages, { tools }).body);
    expect(body.tools).toEqual([{ type: 'function', function: toolSchema }]);
  });

  it('omits tools and tool_choice entirely when the caller sent none', () => {
    const body = JSON.parse(backend.getPayload(ChatModels.KIMI_K2_5_BEDROCK, messages, {}).body);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('emits TOOL_USE with the tool payload the base class reads', () => {
    // base.ts keys entirely off statusEndReason === TOOL_USE and choice.tool; a
    // response that carried tool_calls without these would run nothing.
    const { chunk } = backend.translateChunk(ChatModels.KIMI_K2_THINKING_BEDROCK, {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'search:0', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    expect(chunk.choices).toHaveLength(1);
    expect(chunk.choices[0].statusEndReason).toBe(ChoiceEndReason.TOOL_USE);
    expect('tool' in chunk.choices[0] && chunk.choices[0].tool).toEqual({
      id: 'search:0',
      name: 'search',
      parameters: '{"q":"x"}',
    });
  });

  it('prefers tool calls over reasoning, so a thinking model still runs its tool', () => {
    // The direct backend had this inverted at first: handling reasoning first
    // returned the monologue as the whole answer and silently ran no tool.
    const { chunk } = backend.translateChunk(ChatModels.KIMI_K2_THINKING_BEDROCK, {
      choices: [
        {
          message: {
            content: '',
            reasoning_content: 'I should search',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(chunk.choices[0].statusEndReason).toBe(ChoiceEndReason.TOOL_USE);
  });

  it('emits one choice per tool call so several in a turn can be assembled', () => {
    const { chunk } = backend.translateChunk(ChatModels.KIMI_K2_5_BEDROCK, {
      choices: [
        {
          message: {
            tool_calls: [
              { index: 0, id: 'a', function: { name: 'one', arguments: '{}' } },
              { index: 1, id: 'b', function: { name: 'two', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(chunk.choices.map(c => c.index)).toEqual([0, 1]);
  });

  it('round-trips a tool result as OpenAI-shaped history with the name Moonshot expects', () => {
    const history: IMessage[] = [];
    backend.pushToolMessages(history, { id: 't1', name: 'search', parameters: '{"q":"x"}' }, 'the answer');
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ role: 'tool', tool_call_id: 't1', name: 'search' });
  });
});

describe('MoonshotBedrockBackend streaming', () => {
  it('opens <think> once across many reasoning deltas and closes it when prose starts', () => {
    // Delegating translateStreamChunk to translateChunk wrapped EVERY delta,
    // rendering one thinking block per token.
    const fresh = new MoonshotBedrockBackend();
    // getPayload resets the block state, mirroring the start of a real request.
    fresh.getPayload(ChatModels.KIMI_K2_THINKING_BEDROCK, messages, {});

    const deltas = [{ reasoning_content: 'first' }, { reasoning_content: ' second' }, { content: 'answer' }];
    const rendered = deltas
      .map(delta => fresh.translateStreamChunk(ChatModels.KIMI_K2_THINKING_BEDROCK, { choices: [{ delta }] }))
      .map(({ chunk }) => ('chunkText' in chunk.choices[0] ? chunk.choices[0].chunkText : ''))
      .join('');

    expect(rendered).toBe('<think>first second</think>answer');
    expect(rendered.match(/<think>/g)).toHaveLength(1);
  });

  it('does not inherit the previous request thinking state', () => {
    const fresh = new MoonshotBedrockBackend();
    fresh.getPayload(ChatModels.KIMI_K2_THINKING_BEDROCK, messages, {});
    fresh.translateStreamChunk(ChatModels.KIMI_K2_THINKING_BEDROCK, {
      choices: [{ delta: { reasoning_content: 'unclosed' } }],
    });

    // A new request starts clean, so the next reasoning delta opens its own tag
    // rather than continuing the abandoned one.
    fresh.getPayload(ChatModels.KIMI_K2_THINKING_BEDROCK, messages, {});
    const { chunk } = fresh.translateStreamChunk(ChatModels.KIMI_K2_THINKING_BEDROCK, {
      choices: [{ delta: { reasoning_content: 'again' } }],
    });
    expect('chunkText' in chunk.choices[0] && chunk.choices[0].chunkText).toBe('<think>again');
  });

  it('still wraps a whole non-streaming reasoning payload in one block', () => {
    const { chunk } = backend.translateChunk(ChatModels.KIMI_K2_THINKING_BEDROCK, {
      choices: [{ message: { content: 'answer', reasoning_content: 'because' }, finish_reason: 'stop' }],
    });
    expect('chunkText' in chunk.choices[0] && chunk.choices[0].chunkText).toBe('<think>because</think>answer');
  });
});
