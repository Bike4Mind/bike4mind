/**
 * Regression test for the Bedrock prompt-caching guard.
 *
 * AWS Bedrock did not retrofit prompt caching support to the OG Claude 3 Haiku
 * (`anthropic.claude-3-haiku-20240307-v1:0`) or the v1 Claude 3.5 Sonnet
 * (`anthropic.claude-3-5-sonnet-20240620-v1:0`). Sending `cache_control` to
 * those endpoints returns:
 *
 *   tools.N.cache_control: Extra inputs are not permitted
 *
 * ...and the assistant turn never resolves. Models in BEDROCK_NO_PROMPT_CACHING_MODELS
 * must NOT receive `cache_control` markers anywhere in the request body, even when
 * `cacheStrategy.enableCaching` is true. Caching-capable Bedrock Claude models MUST
 * still receive the markers (otherwise we silently regress caching).
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import type { IMessage } from '@bike4mind/common';
import type { ICompletionOptionTools } from '../backend';

const backend = new AnthropicBedrockBackend();

const messages: IMessage[] = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi there!' },
  { role: 'user', content: 'What is 2+2?' },
];

const cacheStrategy: ICacheStrategy = {
  enableCaching: true,
  cacheSystemPrompt: true,
  cacheTools: true,
  cacheConversationHistory: true,
  cacheTTL: '5m',
};

const tools: ICompletionOptionTools[] = [
  {
    toolFn: async () => '{}',
    toolSchema: {
      name: 'get_weather',
      description: 'Get the current weather',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: 'City name' } },
        required: ['location'],
      },
    },
  },
];

function bodyOf(model: string) {
  const payload = backend.getPayload(model, messages, { cacheStrategy, tools, maxTokens: 1024 });
  return JSON.parse(payload.body) as Record<string, unknown>;
}

describe('AnthropicBedrockBackend prompt caching guard (#8322)', () => {
  it('does NOT attach cache_control for Claude 3 Haiku on Bedrock', () => {
    const body = bodyOf(ChatModels.CLAUDE_3_HAIKU_BEDROCK);
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  it('does NOT attach cache_control for Claude 3.5 Sonnet v1 on Bedrock', () => {
    const body = bodyOf(ChatModels.CLAUDE_3_5_SONNET_BEDROCK);
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  it('DOES attach cache_control for caching-capable Bedrock Claude (3.5 Haiku)', () => {
    const body = bodyOf(ChatModels.CLAUDE_3_5_HAIKU_BEDROCK);
    expect(JSON.stringify(body)).toContain('cache_control');
  });

  it('DOES attach cache_control for caching-capable Bedrock Claude (3.7 Sonnet)', () => {
    const body = bodyOf(ChatModels.CLAUDE_3_7_SONNET_BEDROCK);
    expect(JSON.stringify(body)).toContain('cache_control');
  });
});
