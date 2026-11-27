/**
 * A turn that calls tools re-enters complete() with the previous round's tool_use/tool_result
 * appended. The caller turns the adapter's end-of-array anchor off on the first call, because there
 * the last message is the volatile current turn; by the next round it is history again, so the round
 * after it can read back an already-cached prefix instead of re-writing it.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

type Block = { type: string; text?: string; cache_control?: unknown };
type Captured = { messages: Array<{ role: string; content: string | Block[] }> };

const MODEL = ChatModels.CLAUDE_4_8_OPUS;

// The caller flags its own breakpoint on the last history message and turns the adapter's off.
const strategy: ICacheStrategy = {
  enableCaching: true,
  cacheSystemPrompt: false,
  cacheTools: false,
  cacheConversationHistory: false,
  cacheTTL: '5m',
};

const HISTORY_ANCHOR = 'earlier answer';
const TURN_END = 'tool result';

// The system prompt travels in its own parameter, so index into `messages` never lines up with the
// array handed to complete(). Look the message up by its text instead.
const messages: IMessage[] = [
  { role: 'system', content: 'stable head' },
  { role: 'assistant', content: HISTORY_ANCHOR, cache: true },
  { role: 'user', content: 'the prompt' },
  { role: 'assistant', content: 'working on it' },
  { role: 'user', content: TURN_END },
];

const capture = async (toolCallCount: number, sent: IMessage[] = messages): Promise<Captured> => {
  const backend = new AnthropicBackend('test-key');
  const captured: Captured[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (params: Captured) => {
        captured.push(params);
        return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };

  await backend.complete(
    MODEL,
    sent,
    { stream: false, tools: [], cacheStrategy: strategy, _internal: { toolCallCount } },
    async () => {}
  );
  return captured[0];
};

const marked = (request: Captured, text: string) => {
  const content = request.messages.find(m => JSON.stringify(m.content).includes(text))?.content;
  return Array.isArray(content) && content.some(block => block.cache_control);
};

describe('AnthropicBackend history anchor on a tool round', () => {
  it('leaves the end-of-array anchor off on the first call, where it is the current turn', async () => {
    const request = await capture(0);

    expect(marked(request, TURN_END)).toBe(false);
    // The caller's own breakpoint on the last history message is untouched.
    expect(marked(request, HISTORY_ANCHOR)).toBe(true);
  });

  it('anchors the end of the array on a later round, which the next round re-sends', async () => {
    const request = await capture(1);

    expect(marked(request, TURN_END)).toBe(true);
    expect(marked(request, HISTORY_ANCHOR)).toBe(true);
  });

  describe('with a lookback breakpoint flagged ahead of the history anchor', () => {
    const LOOKBACK = 'older answer';
    const withLookback: IMessage[] = [
      { role: 'system', content: 'stable head' },
      { role: 'user', content: 'older question' },
      { role: 'assistant', content: LOOKBACK, cache: true },
      ...messages.slice(1),
    ];

    it('keeps both flags on the first call', async () => {
      const request = await capture(0, withLookback);

      expect(marked(request, LOOKBACK)).toBe(true);
      expect(marked(request, HISTORY_ANCHOR)).toBe(true);
    });

    it('drops the spent lookback flag on a later round, keeping the newest flag and the end anchor', async () => {
      const request = await capture(1, withLookback);

      expect(marked(request, LOOKBACK)).toBe(false);
      expect(marked(request, HISTORY_ANCHOR)).toBe(true);
      expect(marked(request, TURN_END)).toBe(true);
    });
  });
});
