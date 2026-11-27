/**
 * A Gemini round stamps thought_signature on its tool_use blocks. When that turn falls back to
 * Claude, the history carries them into the Anthropic request, which rejects the unknown field.
 */
import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import type { IMessage } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: Record<string, unknown>[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 2 } };
      },
    },
  };
  return { backend, captured };
}

const geminiRound: IMessage[] = [
  { role: 'user', content: 'what is the weather?' },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'web_search',
        input: { query: 'weather' },
        thought_signature: 'opaque-gemini-signature',
      },
    ],
  } as IMessage,
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny', is_error: false }],
  } as IMessage,
];

describe('AnthropicBackend - Gemini thought_signature on fallback', () => {
  it('drops thought_signature from tool_use blocks and keeps the rest of the block', async () => {
    const { backend, captured } = buildBackend();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      geminiRound,
      {
        tools: [
          {
            toolSchema: { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } },
            toolFn: async () => 'sunny',
          },
        ],
      },
      async () => undefined
    );

    const messages = captured[0].messages as { content: unknown }[];
    const toolUses = messages
      .flatMap(m => (Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []))
      .filter(block => block.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).not.toHaveProperty('thought_signature');
    expect(toolUses[0]).toMatchObject({ id: 'call_1', name: 'web_search', input: { query: 'weather' } });
  });
});
