/**
 * `reasoningEffort` on the Anthropic adapters (direct and Bedrock).
 *
 * The motivating failure: a completions caller asking claude-sonnet-5 for 800 tokens got
 * none back, because the model thinks adaptively by default and spent the whole budget
 * reasoning. `none` has to switch thinking off without touching the caller's max_tokens.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import type { ICompletionOptions } from './backend';

const SENTINEL = new Error('captured-params-sentinel');

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: Record<string, unknown>[] = [];
  const capture = (apiParams: Record<string, unknown>) => {
    captured.push(apiParams);
    throw SENTINEL;
  };
  (backend as unknown as { _api: unknown })._api = {
    messages: { create: async (apiParams: Record<string, unknown>) => capture(apiParams), stream: capture },
  };
  return { backend, getCaptured: () => captured };
}

async function run(model: string, options: Partial<ICompletionOptions>) {
  const { backend, getCaptured } = buildBackend();
  try {
    await backend.complete(
      model,
      [{ role: 'user', content: 'hi' }],
      { stream: true, ...options },
      async () => undefined
    );
  } catch (err) {
    if (err !== SENTINEL) throw err;
  }
  // isThinkingEnabled drives replaying thinking blocks on a tool turn; the API 400s without them.
  const thinkingEnabled = (backend as unknown as { isThinkingEnabled: boolean }).isThinkingEnabled;
  return { request: getCaptured()[0], thinkingEnabled };
}

async function requestFor(model: string, options: Partial<ICompletionOptions>): Promise<Record<string, unknown>> {
  return (await run(model, options)).request;
}

const jsonSchemaFormat: ICompletionOptions['responseFormat'] = {
  type: 'json_schema',
  json_schema: { name: 'answer', schema: { type: 'object', properties: {} }, strict: true },
};

describe('AnthropicBackend reasoningEffort', () => {
  it('switches thinking off for `none` and keeps the caller max_tokens', async () => {
    const request = await requestFor(ChatModels.CLAUDE_5_SONNET, { reasoningEffort: 'none', maxTokens: 800 });

    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(request.output_config).toBeUndefined();
    expect(request.max_tokens).toBe(800);
  });

  it('sends adaptive thinking at the requested effort', async () => {
    const request = await requestFor(ChatModels.CLAUDE_5_OPUS, { reasoningEffort: 'low', maxTokens: 2000 });

    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.output_config).toEqual({ effort: 'low' });
    expect(request.max_tokens).toBe(2000);
  });

  it('sends a clamped thinking budget to a legacy model, with temperature 1 and no top_p', async () => {
    const request = await requestFor(ChatModels.CLAUDE_4_5_SONNET, {
      reasoningEffort: 'high',
      maxTokens: 8192,
      temperature: 0.2,
      topP: 0.9,
    });

    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 7192 });
    expect(request.temperature).toBe(1);
    expect(request.top_p).toBeUndefined();
    expect(request.max_tokens).toBe(8192);
  });

  it('lets an explicit thinking request win over reasoningEffort', async () => {
    const request = await requestFor(ChatModels.CLAUDE_5_SONNET, {
      reasoningEffort: 'none',
      thinking: { enabled: true, budget_tokens: 8000 },
    });

    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.output_config).toEqual({ effort: 'high' });
  });

  it.each([
    [ChatModels.CLAUDE_5_OPUS, 'medium', true],
    [ChatModels.CLAUDE_4_5_SONNET, 'high', true],
    [ChatModels.CLAUDE_5_SONNET, 'none', false],
  ] as const)('marks thinking on for %s at %s: %s', async (model, reasoningEffort, expected) => {
    const { thinkingEnabled } = await run(model, { reasoningEffort, maxTokens: 8192 });

    expect(thinkingEnabled).toBe(expected);
  });

  it('keeps thinking off under the forced response_format tool, which cannot run alongside it', async () => {
    const request = await requestFor(ChatModels.CLAUDE_4_5_SONNET, {
      reasoningEffort: 'high',
      maxTokens: 8192,
      responseFormat: jsonSchemaFormat,
    });

    expect(request.tool_choice).toMatchObject({ type: 'tool' });
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
  });

  it('still honours `none` under the forced response_format tool', async () => {
    const request = await requestFor(ChatModels.CLAUDE_5_SONNET, {
      reasoningEffort: 'none',
      maxTokens: 800,
      responseFormat: jsonSchemaFormat,
    });

    expect(request.thinking).toEqual({ type: 'disabled' });
  });

  it('sends no thinking config when reasoningEffort is absent', async () => {
    const request = await requestFor(ChatModels.CLAUDE_5_SONNET, { maxTokens: 800 });

    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
  });
});

describe('AnthropicBedrockBackend reasoningEffort', () => {
  const backend = new AnthropicBedrockBackend();
  const messages: IMessage[] = [{ role: 'user', content: 'hi' }];
  const bodyFor = (model: string, options: Partial<ICompletionOptions>) =>
    JSON.parse(backend.getPayload(model, messages, options).body) as Record<string, unknown>;

  it('switches thinking off for `none` and keeps the caller max_tokens', () => {
    const body = bodyFor(ChatModels.CLAUDE_5_SONNET_BEDROCK, { reasoningEffort: 'none', maxTokens: 800 });

    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(800);
  });

  it('uses `between_tools` as the off switch on Sonnet 5.5', () => {
    const body = bodyFor(ChatModels.CLAUDE_5_5_SONNET_BEDROCK, { reasoningEffort: 'none', maxTokens: 800 });

    expect(body.thinking).toEqual({ type: 'between_tools' });
  });

  it('sends adaptive thinking at the requested effort', () => {
    const body = bodyFor(ChatModels.CLAUDE_5_5_OPUS_BEDROCK, { reasoningEffort: 'medium', maxTokens: 2000 });

    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.max_tokens).toBe(2000);
  });
});
