/**
 * A history truncated mid-turn can start with a user message holding only a tool_result whose
 * tool_use appears later (or nowhere before it). The API rejects it, so the direct backend must
 * repair the payload the same way the Bedrock backend does - checked here against the request
 * the SDK actually receives.
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
  return { backend, getCaptured: () => captured };
}

const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } };
const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false };

const leadingOrphanHistory = [
  { role: 'user', content: [toolResult] },
  { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }, toolUse] },
  { role: 'user', content: [toolResult] },
  { role: 'user', content: 'and tomorrow?' },
] as IMessage[];

type WireMessage = { role: string; content: unknown };

const blocksOf = (message: WireMessage | undefined) =>
  Array.isArray(message?.content) ? (message.content as Array<{ type?: string; id?: string }>) : [];

describe('AnthropicBackend - leading orphaned tool_result', () => {
  it('sends no tool_result before its tool_use and keeps the valid pair', async () => {
    const { backend, getCaptured } = buildBackend();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      leadingOrphanHistory,
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

    const messages = getCaptured()[0].messages as WireMessage[];
    expect(messages[0].role).toBe('user');
    expect(blocksOf(messages[0]).some(block => block.type === 'tool_result')).toBe(false);

    const toolUseIndex = messages.findIndex(message => blocksOf(message).some(block => block.type === 'tool_use'));
    expect(toolUseIndex).toBeGreaterThan(0);
    expect(
      blocksOf(messages[toolUseIndex + 1]).some(
        block => block.type === 'tool_result' && (block as { tool_use_id?: string }).tool_use_id === 'toolu_1'
      )
    ).toBe(true);
  });
});
