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

import { describe, it, expect, beforeEach } from 'vitest';
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

/**
 * Characterization test for `translateStreamChunk` and its 11 stream type-guards.
 * These are the surface the `any`->`unknown`+`isRecord` refactor touched, and had no
 * prior runtime coverage (the streaming suites override `translateStreamChunk` in a
 * test subclass). Feeds representative raw Bedrock chunks and asserts the decoded
 * output, plus the malformed-input paths that must not throw.
 */
describe('translateStreamChunk', () => {
  // Fresh instance per test - the backend carries stateful `isInThinkingBlock`, so a
  // shared instance would leak thinking-block state across cases.
  let backend: AnthropicBedrockBackend;
  beforeEach(() => {
    backend = new AnthropicBedrockBackend();
  });
  const first = (chunk: unknown) => backend.translateStreamChunk('claude', chunk).chunk?.choices[0];

  it('message_start surfaces input/cache usage', () => {
    const r = backend.translateStreamChunk('claude', {
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } },
    });
    expect(r.done).toBe(false);
    expect(r.chunk?.choices[0].usage?.input_tokens).toBe(10);
  });

  it('content_block_start tool_use surfaces the tool name + id', () => {
    const c = first({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'get_weather', id: 'tool_1' },
    });
    expect(c?.tool).toEqual({ name: 'get_weather', id: 'tool_1' });
  });

  it('content_block_start thinking opens a <think> block', () => {
    expect(first({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })?.chunkText).toBe(
      '<think>'
    );
  });

  it('content_block_stop closes an open <think> block and resets thinking state', () => {
    // Same backend instance (isInThinkingBlock is stateful): open thinking, then stop.
    first({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    expect(first({ type: 'content_block_stop', index: 0 })?.chunkText).toBe('</think>');
    // Flag reset - a subsequent stop with no open thinking block emits no close tag.
    expect(first({ type: 'content_block_stop', index: 0 })?.chunkText).toBe('');
  });

  it('content_block_stop with no open thinking block emits no close tag', () => {
    expect(first({ type: 'content_block_stop', index: 0 })?.chunkText).toBe('');
  });

  it('text_delta / input_json_delta / thinking_delta surface their payloads', () => {
    expect(first({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } })?.chunkText).toBe(
      'Hi'
    );
    expect(
      first({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } })
        ?.chunkText
    ).toBe('{"a":');
    expect(
      first({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })?.chunkText
    ).toBe('hmm');
  });

  it('message_delta surfaces output tokens; message_stop ends the stream', () => {
    expect(first({ type: 'message_delta', usage: { output_tokens: 20 } })?.usage?.output_tokens).toBe(20);
    expect(backend.translateStreamChunk('claude', { type: 'message_stop' }).done).toBe(true);
  });

  it('does not throw on null / primitive / unknown-type chunks', () => {
    expect(() => backend.translateStreamChunk('claude', null)).not.toThrow();
    expect(() => backend.translateStreamChunk('claude', 'garbage')).not.toThrow();
    expect(backend.translateStreamChunk('claude', { type: 'nope' }).done).toBe(false);
  });
});
