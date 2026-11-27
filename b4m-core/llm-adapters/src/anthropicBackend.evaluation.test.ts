import { describe, expect, it, vi } from 'vitest';
import { ChatModels, type ModelInfo } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import { assertAnthropicEvaluationWire, anthropicEvaluationUsage } from './anthropicEvaluation';

const modelId = ChatModels.CLAUDE_4_8_OPUS;
const usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 90,
  cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 50 },
};
function setup() {
  const backend = new AnthropicBackend('test-key');
  const model = backend.getModelInfoList().find(m => m.id === modelId)! as ModelInfo;
  backend.setDispatchModel(model);
  const create = vi.fn(async (_params: unknown, _options: unknown) => ({
    model: modelId,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage,
  }));
  (backend as unknown as { _api: unknown })._api = { messages: { create } };
  const evaluation = {
    admit: vi.fn(async () => {
      expect(create).not.toHaveBeenCalled();
    }),
    reconcile: vi.fn(async () => {}),
    unknown: vi.fn(async () => {}),
  };
  return { backend, model, create, evaluation };
}
describe('Anthropic evaluation transport', () => {
  it.each(['5m', '1h'] as const)('admits final %s cache wire with one SDK attempt and full usage split', async ttl => {
    const { backend, model, create, evaluation } = setup();
    await backend.complete(
      modelId,
      [
        { role: 'system', content: 'stable', cache: true },
        { role: 'user', content: 'hello' },
      ],
      {
        stream: true,
        maxTokens: 100,
        executeTools: false,
        cacheStrategy: {
          enableCaching: true,
          cacheSystemPrompt: true,
          cacheTools: true,
          cacheConversationHistory: true,
          cacheTTL: ttl,
        },
        _internal: { evaluation },
      },
      async () => {}
    );
    expect(evaluation.admit).toHaveBeenCalledWith(model, modelId, 100);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    expect(create.mock.calls[0][0]).toMatchObject({ stream: false });
    expect(JSON.stringify(create.mock.calls[0][0])).toContain(ttl === '1h' ? '"ttl":"1h"' : '"type":"ephemeral"');
    expect(evaluation.reconcile).toHaveBeenCalledWith({
      inputTokens: 130,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWrite5mTokens: 40,
      cacheWrite1hTokens: 50,
    });
  });
  it('does not dispatch when admission fails and does not retry a transport failure', async () => {
    const { backend, create, evaluation } = setup();
    evaluation.admit.mockRejectedValueOnce(new Error('denied'));
    const options = { maxTokens: 100, executeTools: false, _internal: { evaluation } };
    await expect(backend.complete(modelId, [{ role: 'user', content: 'hi' }], options, async () => {})).rejects.toThrow(
      'denied'
    );
    expect(create).not.toHaveBeenCalled();
    create.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(backend.complete(modelId, [{ role: 'user', content: 'hi' }], options, async () => {})).rejects.toThrow(
      'fetch failed'
    );
    expect(create).toHaveBeenCalledOnce();
    expect(evaluation.reconcile).not.toHaveBeenCalled();
  });
  it('rejects identity drift, missing cache splits and paid server tool usage', () => {
    expect(() => anthropicEvaluationUsage({ model: 'alias', usage }, modelId)).toThrow('identity');
    expect(() =>
      anthropicEvaluationUsage({ model: modelId, usage: { ...usage, cache_creation: undefined } }, modelId)
    ).toThrow('classes');
    expect(() =>
      anthropicEvaluationUsage(
        { model: modelId, usage: { ...usage, server_tool_use: { web_search_requests: 1 } } },
        modelId
      )
    ).toThrow('charge');
  });
  it('does not relax and retry strict schemas in evaluation mode', async () => {
    const { backend, create, evaluation } = setup();
    create.mockRejectedValueOnce(
      Object.assign(new Error('tools.0.custom.input_schema: schema is not supported in strict mode'), { status: 400 })
    );
    await expect(
      backend.complete(
        modelId,
        [{ role: 'user', content: 'hi' }],
        {
          maxTokens: 100,
          executeTools: false,
          responseFormat: {
            type: 'json_schema',
            json_schema: {
              name: 'answer',
              schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
              },
            },
          },
          _internal: { evaluation },
        },
        async () => {}
      )
    ).rejects.toThrow('strict mode');
    expect(create).toHaveBeenCalledOnce();
    expect(evaluation.reconcile).not.toHaveBeenCalled();
  });
  it('never reconciles an alias response, and leaves its receipt unknown instead of failing the billed call', async () => {
    const { backend, create, evaluation } = setup();
    create.mockResolvedValueOnce({ model: 'alias', stop_reason: 'end_turn', content: [], usage });
    const options = { maxTokens: 100, executeTools: false, _internal: { evaluation } };
    await expect(
      backend.complete(modelId, [{ role: 'user', content: 'hi' }], options, async () => {})
    ).resolves.not.toThrow();
    expect(evaluation.reconcile).not.toHaveBeenCalled();
    expect(evaluation.unknown).toHaveBeenCalledOnce();
  });
  it('leaves the receipt unknown when reconcile itself fails after dispatch', async () => {
    const { backend, evaluation } = setup();
    evaluation.reconcile.mockRejectedValueOnce(new Error('write failed'));
    const options = { maxTokens: 100, executeTools: false, _internal: { evaluation } };
    await expect(
      backend.complete(modelId, [{ role: 'user', content: 'hi' }], options, async () => {})
    ).resolves.not.toThrow();
    expect(evaluation.unknown).toHaveBeenCalledOnce();
  });
  it('supports deferred regex/BM25 tools but fails closed on other provider tools and media', () => {
    for (const type of ['tool_search_tool_regex_20251119', 'tool_search_tool_bm25_20251119'])
      expect(() =>
        assertAnthropicEvaluationWire(
          {
            tools: [
              { type, name: 'search' },
              { name: 'lookup', defer_loading: true, input_schema: { type: 'object' } },
            ],
            messages: [],
          },
          10000
        )
      ).not.toThrow();
    for (const type of ['web_search_20250305', 'code_execution_20250522', 'image', 'document'])
      expect(() => assertAnthropicEvaluationWire({ tools: [{ type }] }, 10000)).toThrow();
  });
});
