import { ChatModels, ModelBackend, type ModelInfo, type ReasoningEffort } from '@bike4mind/common';
import { AnthropicBackend, AnthropicBedrockBackend, type ICompletionOptions } from '@bike4mind/llm-adapters';
import { describe, expect, it } from 'vitest';
import { chatReasoningOptionsFor } from './chatReasoningOptions';

const model = (id: string, backend: ModelBackend, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id: id as ModelInfo['id'],
  name: id,
  type: 'text',
  backend,
  contextWindow: 200_000,
  max_tokens: 64_000,
  pricing: {},
  supportsImageVariation: false,
  ...extra,
});
const adaptive = { can_think: true, thinkingStyle: 'adaptive' as const };
const on = { enabled: true, budget_tokens: 8000 };
const off = { ...on, enabled: false };
const capturedRequest = new Error('request captured');

async function directRequest(id: string, options: Partial<ICompletionOptions>) {
  const backend = new AnthropicBackend('test-key');
  const requests: Record<string, unknown>[] = [];
  const capture = (request: Record<string, unknown>) => {
    requests.push(request);
    throw capturedRequest;
  };
  (backend as unknown as { _api: unknown })._api = { messages: { stream: capture, create: capture } };
  try {
    await backend.complete(id, [{ role: 'user', content: 'hi' }], { stream: true, ...options }, async () => undefined);
  } catch (error) {
    if (error !== capturedRequest) throw error;
  }
  expect(requests).toHaveLength(1);
  return requests[0];
}

describe('saved chat reasoning options', () => {
  it.each([
    [ChatModels.CLAUDE_5_5_HAIKU, ModelBackend.Anthropic],
    [ChatModels.CLAUDE_5_5_HAIKU_BEDROCK, ModelBackend.Bedrock],
  ] as const)('honors None in the real %s request without changing the raw adapter contract', async (id, backend) => {
    const options = { ...chatReasoningOptionsFor(model(id, backend, adaptive), 'none', on), maxTokens: 800 };
    const request =
      backend === ModelBackend.Anthropic
        ? await directRequest(id, options)
        : (JSON.parse(
            new AnthropicBedrockBackend().getPayload(id, [{ role: 'user', content: 'hi' }], options).body
          ) as Record<string, unknown>);
    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(request.output_config).toBeUndefined();
    expect(request.max_tokens).toBe(800);
  });

  it.each([
    [ChatModels.CLAUDE_5_5_HAIKU, ModelBackend.Anthropic],
    [ChatModels.CLAUDE_5_5_HAIKU_BEDROCK, ModelBackend.Bedrock],
  ] as const)('honors High over Thinking off in the real %s request', async (id, backend) => {
    const options = { ...chatReasoningOptionsFor(model(id, backend, adaptive), 'high', off), maxTokens: 2000 };
    const request =
      backend === ModelBackend.Anthropic
        ? await directRequest(id, options)
        : (JSON.parse(
            new AnthropicBedrockBackend().getPayload(id, [{ role: 'user', content: 'hi' }], options).body
          ) as Record<string, unknown>);
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.output_config).toEqual({ effort: 'high' });
  });

  it.each([on, off, undefined])('leaves Auto on the existing model/toggle defaults (%j)', thinking => {
    const info = model(ChatModels.CLAUDE_5_5_HAIKU, ModelBackend.Anthropic, adaptive);
    expect(chatReasoningOptionsFor(info, undefined, thinking)).toEqual({ reasoningEffort: undefined, thinking });
  });

  it.each([
    [model(ChatModels.GPT5, ModelBackend.OpenAI), 'none', 'low'],
    [model(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.Anthropic, adaptive), 'none', 'low'],
    [model(ChatModels.CLAUDE_4_5_SONNET, ModelBackend.Anthropic, { can_think: true }), 'high', undefined],
    [model('local-model', ModelBackend.Ollama), 'high', 'high'],
  ] satisfies Array<[ModelInfo, ReasoningEffort, ReasoningEffort | undefined]>)(
    'preserves the other model/toggle policies (%j)',
    (info, explicit, expected) => {
      expect(chatReasoningOptionsFor(info, explicit, on)).toEqual({ reasoningEffort: expected, thinking: on });
    }
  );
});
