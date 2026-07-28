/**
 * dispatchProfile consumption on the OpenAI request builder (spec 5.4).
 *
 * Two properties, both required:
 *  1. No profile => the seven hardcoded id arrays decide, byte for byte as
 *     before. Every currently-dispatched id is asserted here.
 *  2. A profile => the profile decides, so a model this build has never heard
 *     of (gpt-5.7) gets max_completion_tokens and the Responses tool transport
 *     instead of the 400-shaped request the arrays would have produced.
 */

import { describe, expect, it, vi } from 'vitest';
import { ChatModels, type ICompletionOptionTools, type ModelInfo } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';

type AnyRecord = Record<string, unknown>;

const terminalChat = () => ({
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 3 },
});

const terminalResponses = () => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
  usage: { input_tokens: 5, output_tokens: 3 },
});

function buildBackend() {
  const backend = new OpenAIBackend('test-key');
  const chatCreate = vi.fn(async (_params: AnyRecord) => terminalChat());
  const responsesCreate = vi.fn(async (_params: AnyRecord) => {
    const payload = terminalResponses();
    return (async function* () {
      yield { type: 'response.completed', response: payload };
    })();
  });
  (backend as unknown as { _api: unknown })._api = {
    chat: { completions: { create: chatCreate } },
    responses: { create: responsesCreate },
  };
  return { backend, chatCreate, responsesCreate };
}

const tool: ICompletionOptionTools = {
  toolSchema: { name: 'lookup', description: 'Look something up.', parameters: { type: 'object', properties: {} } },
};

function modelRecord(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: id as ModelInfo['id'],
    type: 'text',
    name: id,
    backend: 'openai',
    contextWindow: 400_000,
    max_tokens: 128_000,
    supportsImageVariation: false,
    pricing: {},
    ...overrides,
  };
}

async function callChat(
  backend: OpenAIBackend,
  chatCreate: ReturnType<typeof buildBackend>['chatCreate'],
  model: string,
  extra: AnyRecord = {}
): Promise<AnyRecord> {
  await backend.complete(model, [{ role: 'user', content: 'hi' }], { maxTokens: 1234, ...extra }, async () => {});
  return chatCreate.mock.calls[0][0] as AnyRecord;
}

describe('OpenAI request shaping with no dispatchProfile (today behavior)', () => {
  // Every id the seven arrays cover, plus two they do not.
  const usesCompletionTokens = [
    ChatModels.O1_PREVIEW,
    ChatModels.O1_MINI,
    ChatModels.O1,
    ChatModels.O3_MINI,
    ChatModels.O3,
    ChatModels.O4_MINI,
    ChatModels.GPT5,
    ChatModels.GPT5_MINI,
    ChatModels.GPT5_NANO,
    ChatModels.GPT5_CHAT_LATEST,
    ChatModels.GPT5_1,
    ChatModels.GPT5_1_CHAT_LATEST,
    ChatModels.GPT5_2,
    ChatModels.GPT5_2_CHAT_LATEST,
    ChatModels.GPT5_4,
    ChatModels.GPT5_4_MINI,
    ChatModels.GPT5_4_NANO,
    ChatModels.GPT5_5,
    ChatModels.GPT5_6_SOL,
    ChatModels.GPT5_6_LUNA,
    ChatModels.GPT5_6_TERRA,
  ];
  const usesMaxTokens = [ChatModels.GPT4_1, ChatModels.GPT4_1_MINI, ChatModels.GPT4O];

  it.each(usesCompletionTokens)('%s sends max_completion_tokens and streams', async model => {
    const { backend, chatCreate } = buildBackend();
    const params = await callChat(backend, chatCreate, model);
    expect(params.max_completion_tokens).toBe(1234);
    expect(params).not.toHaveProperty('max_tokens');
    expect(params.stream).toBe(true);
  });

  it.each(usesMaxTokens)('%s sends max_tokens', async model => {
    const { backend, chatCreate } = buildBackend();
    const params = await callChat(backend, chatCreate, model);
    expect(params.max_tokens).toBe(1234);
    expect(params).not.toHaveProperty('max_completion_tokens');
  });

  it('keeps the full legacy parameter set for a non-reasoning model', async () => {
    const { backend, chatCreate } = buildBackend();
    const params = await callChat(backend, chatCreate, ChatModels.GPT4_1, {
      temperature: 0.3,
      topP: 0.5,
      stream: true,
    });
    expect(params).toMatchObject({
      model: ChatModels.GPT4_1,
      temperature: 0.3,
      top_p: 0.5,
      n: 1,
      stream: true,
      max_tokens: 1234,
      stream_options: { include_usage: true },
    });
  });

  it('forces temperature 1 only for the fixed-temperature ids', async () => {
    const fixed = buildBackend();
    expect(await callChat(fixed.backend, fixed.chatCreate, ChatModels.GPT5_4, { temperature: 0.3 })).toMatchObject({
      temperature: 1.0,
    });
    // gpt-5-chat-latest uses max_completion_tokens but is NOT fixed-temperature.
    const free = buildBackend();
    expect(
      await callChat(free.backend, free.chatCreate, ChatModels.GPT5_CHAT_LATEST, { temperature: 0.3 })
    ).toMatchObject({ temperature: 0.3 });
  });

  it('routes tool turns to /v1/responses only for the narrator family', async () => {
    const narrator = buildBackend();
    await narrator.backend.complete(
      ChatModels.GPT5,
      [{ role: 'user', content: 'hi' }],
      { tools: [tool] },
      async () => {}
    );
    expect(narrator.responsesCreate).toHaveBeenCalledTimes(1);
    expect(narrator.chatCreate).not.toHaveBeenCalled();

    const chatFamily = buildBackend();
    await chatFamily.backend.complete(
      ChatModels.GPT5_4,
      [{ role: 'user', content: 'hi' }],
      { tools: [tool] },
      async () => {}
    );
    expect(chatFamily.responsesCreate).not.toHaveBeenCalled();
    expect(chatFamily.chatCreate).toHaveBeenCalledTimes(1);
  });

  it('mis-shapes an unknown id, which is the failure the profile exists to fix', async () => {
    const { backend, chatCreate } = buildBackend();
    const params = await callChat(backend, chatCreate, 'gpt-5.7', { temperature: 0.3 });
    expect(params.max_tokens).toBe(1234);
    expect(params.temperature).toBe(0.3);
  });
});

describe('OpenAI request shaping with a dispatchProfile', () => {
  const unknownReasoner = modelRecord('gpt-5.7', {
    can_think: true,
    dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'responses' },
  });

  it('sends max_completion_tokens for an id no array covers', async () => {
    const { backend, chatCreate } = buildBackend();
    backend.setDispatchModel(unknownReasoner);
    const params = await callChat(backend, chatCreate, 'gpt-5.7', { temperature: 0.3 });
    expect(params.max_completion_tokens).toBe(1234);
    expect(params).not.toHaveProperty('max_tokens');
    expect(params.stream).toBe(true);
    // A reasoning model rejects any temperature but 1.
    expect(params.temperature).toBe(1.0);
  });

  it('routes its tool turns to /v1/responses', async () => {
    const { backend, chatCreate, responsesCreate } = buildBackend();
    backend.setDispatchModel(unknownReasoner);
    await backend.complete('gpt-5.7', [{ role: 'user', content: 'hi' }], { tools: [tool] }, async () => {});
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it('keeps tool turns on /v1/chat/completions when the profile says chat', async () => {
    const { backend, chatCreate, responsesCreate } = buildBackend();
    backend.setDispatchModel(
      modelRecord('gpt-5.7', {
        dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
      })
    );
    await backend.complete('gpt-5.7', [{ role: 'user', content: 'hi' }], { tools: [tool] }, async () => {});
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it('overrides the arrays when a profile disagrees with them', async () => {
    const { backend, chatCreate } = buildBackend();
    // A seeded id whose array membership says max_completion_tokens, told otherwise.
    backend.setDispatchModel(
      modelRecord(ChatModels.GPT5_4, {
        dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'chat' },
      })
    );
    const params = await callChat(backend, chatCreate, ChatModels.GPT5_4);
    expect(params.max_tokens).toBe(1234);
    expect(params).not.toHaveProperty('max_completion_tokens');
  });

  it('ignores a record that describes a different model', async () => {
    const { backend, chatCreate } = buildBackend();
    backend.setDispatchModel(unknownReasoner);
    const params = await callChat(backend, chatCreate, ChatModels.GPT4_1);
    expect(params.max_tokens).toBe(1234);
    expect(params).not.toHaveProperty('max_completion_tokens');
  });

  // ModelRecordPatchRead makes every dispatchProfile key optional, so a sparse
  // row reaches the builders even though the write type says otherwise.
  const partialProfile = {} as ModelInfo['dispatchProfile'];

  it('falls through to the arrays for the fields a partial profile does not state', async () => {
    // An absent key is "not stated", not a negative assertion - reading it as one
    // takes GPT-5 off /v1/responses and onto max_tokens, a hard 400.
    const transport = buildBackend();
    transport.backend.setDispatchModel(modelRecord(ChatModels.GPT5, { dispatchProfile: partialProfile }));
    await transport.backend.complete(
      ChatModels.GPT5,
      [{ role: 'user', content: 'hi' }],
      { tools: [tool] },
      async () => {}
    );
    expect(transport.responsesCreate).toHaveBeenCalledTimes(1);
    expect(transport.chatCreate).not.toHaveBeenCalled();

    const shape = buildBackend();
    shape.backend.setDispatchModel(modelRecord(ChatModels.GPT5, { dispatchProfile: partialProfile }));
    const params = await callChat(shape.backend, shape.chatCreate, ChatModels.GPT5);
    expect(params.max_completion_tokens).toBe(1234);
    expect(params).not.toHaveProperty('max_tokens');
  });

  it('does not pin temperature on a seeded model whose row states nothing about the request shape', async () => {
    // gpt-5-chat-latest is not fixed-temperature; a row merely existing must not
    // make it one just because the merged record reports can_think.
    const { backend, chatCreate } = buildBackend();
    backend.setDispatchModel(
      modelRecord(ChatModels.GPT5_CHAT_LATEST, { can_think: true, dispatchProfile: partialProfile })
    );
    const params = await callChat(backend, chatCreate, ChatModels.GPT5_CHAT_LATEST, { temperature: 0.3 });
    expect(params.temperature).toBe(0.3);
  });

  it('drops the system role when the profile marks the o1 message format', async () => {
    const { backend, chatCreate } = buildBackend();
    backend.setDispatchModel(
      modelRecord('o5-mini', {
        dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat', messageFormat: 'o1' },
      })
    );
    await backend.complete(
      'o5-mini',
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      { maxTokens: 10 },
      async () => {}
    );
    const params = chatCreate.mock.calls[0][0] as AnyRecord;
    const messages = params.messages as Array<{ role: string }>;
    expect(messages.some(m => m.role === 'system')).toBe(false);
  });
});
