import { ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { ChoiceStatus } from '../backend';
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
