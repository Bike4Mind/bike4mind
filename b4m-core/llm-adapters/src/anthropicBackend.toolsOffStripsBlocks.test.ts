/**
 * A replayed history turn (utils.ts Priority 2) can carry perfectly-paired tool_use/
 * tool_result blocks from a PRIOR turn even when the CURRENT turn offers no tools
 * (e.g. toolMode switched off between turns). Anthropic rejects any tool_use/
 * tool_result block when `tools` is absent from the request regardless of pairing,
 * and the balanced count means the mismatch-repair path never fires - so this needs
 * its own proactive strip, checked here directly against the pre-API guard.
 */
import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { IMessage } from '@bike4mind/common';

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

const replayedMessages: IMessage[] = [
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'reply 1' },
      { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
    ],
  } as IMessage,
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false }],
  } as IMessage,
  { role: 'user', content: 'and tomorrow?' },
];

describe('AnthropicBackend - strips tool blocks when the current turn offers no tools', () => {
  it('strips paired tool_use/tool_result blocks from a replayed turn when options.tools is empty', async () => {
    const { backend, getCaptured } = buildBackend();

    await backend.complete(ChatModels.CLAUDE_4_8_OPUS, replayedMessages, { tools: [] }, async () => undefined);

    const sent = getCaptured()[0];
    const messages = sent.messages as { content: unknown }[];
    const hasToolBlock = messages.some(
      m => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use' || b.type === 'tool_result')
    );
    expect(hasToolBlock).toBe(false);
    expect(sent.tools).toBeUndefined();
  });

  it('leaves tool blocks intact when the current turn DOES offer tools', async () => {
    const { backend, getCaptured } = buildBackend();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      replayedMessages,
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

    const sent = getCaptured()[0];
    const messages = sent.messages as { content: unknown }[];
    const hasToolUse = messages.some(
      m => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use')
    );
    expect(hasToolUse).toBe(true);
  });
});
