import { describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';

const model = {
  id: 'gpt-test-2026-01-01',
  backend: ModelBackend.OpenAI,
  contextWindow: 128000,
  pricing: { 128000: { input: 1e-6, output: 2e-6, cache_read: 1e-7 } },
} as ModelInfo;
function setup() {
  const backend = new OpenAIBackend('test-key');
  backend.setDispatchModel(model);
  const create = vi.fn(async (_params: unknown, _options: unknown) => ({
    model: model.id,
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  }));
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, create };
}
describe('OpenAI evaluation admission', () => {
  it('admits the final floored output before dispatch with SDK retries disabled', async () => {
    const { backend, create } = setup();
    const admit = vi.fn(async () => {
      expect(create).not.toHaveBeenCalled();
    });
    const reconcile = vi.fn(async () => {});
    await backend.complete(
      model.id,
      [{ role: 'user', content: 'hi' }],
      {
        stream: true,
        maxTokens: 8,
        executeTools: false,
        _internal: { evaluation: { admit, reconcile, unknown: vi.fn() } },
      },
      async () => {}
    );
    expect(admit).toHaveBeenCalledWith(model, model.id, 16);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 0 })
    );
  });
  it('never dispatches rejected admission and never retries an ambiguous transport error', async () => {
    const { backend, create } = setup();
    const evaluation = {
      admit: vi.fn(async () => {
        throw new Error('denied');
      }),
      reconcile: vi.fn(),
      unknown: vi.fn(),
    };
    await expect(
      backend.complete(
        model.id,
        [{ role: 'user', content: 'hi' }],
        { maxTokens: 20, _internal: { evaluation } },
        async () => {}
      )
    ).rejects.toThrow('denied');
    expect(create).not.toHaveBeenCalled();
    evaluation.admit.mockResolvedValueOnce(undefined);
    create.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(
      backend.complete(
        model.id,
        [{ role: 'user', content: 'hi' }],
        { maxTokens: 20, _internal: { evaluation } },
        async () => {}
      )
    ).rejects.toThrow('fetch failed');
    expect(create).toHaveBeenCalledOnce();
    expect(evaluation.reconcile).not.toHaveBeenCalled();
  });
  it('leaves normal SDK retry settings and response delivery unchanged', async () => {
    const { backend, create } = setup();
    const callback = vi.fn(async () => {});
    await backend.complete(model.id, [{ role: 'user', content: 'hi' }], { stream: false, maxTokens: 20 }, callback);
    expect(create.mock.calls[0][1]).not.toHaveProperty('maxRetries');
    expect(callback).toHaveBeenCalled();
  });
  it('admits Responses tools once and reconciles only terminal provider usage', async () => {
    const { backend } = setup();
    backend.setDispatchModel({ ...model, dispatchProfile: { toolTransport: 'responses' } } as ModelInfo);
    const admit = vi.fn(async () => {});
    const reconcile = vi.fn(async () => {});
    const create = vi.fn(async (_params: unknown, _options: unknown) =>
      (async function* () {
        yield {
          type: 'response.completed',
          response: {
            model: model.id,
            output: [],
            usage: {
              input_tokens: 20,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 10 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        };
      })()
    );
    (backend as unknown as { _api: unknown })._api = { responses: { create } };
    await backend.complete(
      model.id,
      [{ role: 'user', content: 'hi' }],
      {
        maxTokens: 20,
        executeTools: false,
        tools: [
          { toolSchema: { name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} } } },
        ],
        _internal: { evaluation: { admit, reconcile, unknown: vi.fn() } },
      },
      async () => {}
    );
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    expect(admit).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 10,
      reasoningTokens: 2,
    });
  });
});
