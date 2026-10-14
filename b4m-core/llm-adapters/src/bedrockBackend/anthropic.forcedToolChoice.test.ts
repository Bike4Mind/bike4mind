/**
 * Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 on Bedrock return 400 for a forced tool_choice
 * (`any` / `tool`). The Bedrock Anthropic body never carries tool_choice at all and honors
 * json_schema by prompt instruction (best-effort), so none of the inputs that force a tool on
 * the direct backend may reach these models' request body. Haiku 5.5 accepts a forced tool_choice
 * on Bedrock, but the body still never carries one, so it is pinned here too.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ResponseFormat } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import type { ICompletionOptionTools } from '../backend';

const MODELS = [
  ChatModels.CLAUDE_5_5_OPUS_BEDROCK,
  ChatModels.CLAUDE_5_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_FABLE_5_1_BEDROCK,
  ChatModels.CLAUDE_5_5_HAIKU_BEDROCK,
];

const tool: ICompletionOptionTools = {
  toolSchema: {
    name: 'get_weather',
    description: 'Get the weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
  toolFn: async () => 'sunny',
};

const responseFormat: ResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'extract_user',
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    strict: true,
  },
};

const backend = new AnthropicBedrockBackend();

function bodyOf(model: string, options: Record<string, unknown>) {
  const payload = backend.getPayload(model, [{ role: 'user', content: 'go' }], { maxTokens: 1024, ...options });
  return JSON.parse(payload.body) as Record<string, unknown> & { tools?: Array<Record<string, unknown>> };
}

describe('AnthropicBedrockBackend never forces a tool on Claude 5.x models', () => {
  it.each(MODELS)('sends no tool_choice for a named or required choice on %s', model => {
    for (const toolChoice of ['required', { type: 'function', function: { name: 'get_weather' } }] as const) {
      const body = bodyOf(model, { tools: [tool], tool_choice: toolChoice });
      expect(body).not.toHaveProperty('tool_choice');
      expect(body.tools?.[0]).not.toHaveProperty('strict');
    }
  });

  it.each(MODELS)('synthesizes no forced tool or output_config.format for json_schema on %s', model => {
    const body = bodyOf(model, { responseFormat });
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('output_format');
  });
});
