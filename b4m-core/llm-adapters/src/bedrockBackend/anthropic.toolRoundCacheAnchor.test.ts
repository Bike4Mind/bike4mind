/**
 * Bedrock arm of anthropicBackend.toolRoundCacheAnchor.test.ts: a tool round re-sends the previous
 * round's tool_use/tool_result, so the end of the array is history again and takes the adapter's
 * end-of-array anchor, which the caller turned off for the first call (the volatile current turn).
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';

type Block = { type: string; text?: string; cache_control?: unknown };
type WireMessage = { role: string; content: string | Block[] };

const MODEL = ChatModels.CLAUDE_4_6_SONNET_BEDROCK;

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

const messages: IMessage[] = [
  { role: 'system', content: 'stable head' },
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: HISTORY_ANCHOR, cache: true },
  { role: 'user', content: 'the prompt' },
  { role: 'assistant', content: 'working on it' },
  { role: 'user', content: TURN_END },
];

const wireMessages = (toolCallCount: number): WireMessage[] => {
  const backend = new AnthropicBedrockBackend();
  const payload = backend.getPayload(MODEL, messages, {
    cacheStrategy: strategy,
    maxTokens: 1024,
    _internal: { toolCallCount },
  });
  return (JSON.parse(payload.body) as { messages: WireMessage[] }).messages;
};

const marked = (sent: WireMessage[], text: string) => {
  const content = sent.find(m => JSON.stringify(m.content).includes(text))?.content;
  return Array.isArray(content) && content.some(block => block.cache_control);
};

describe('AnthropicBedrockBackend history anchor on a tool round', () => {
  it('leaves the end-of-array anchor off on the first call, where it is the current turn', () => {
    const sent = wireMessages(0);

    expect(JSON.stringify(sent.at(-1)?.content)).toContain(TURN_END);
    expect(marked(sent, TURN_END)).toBe(false);
    expect(marked(sent, HISTORY_ANCHOR)).toBe(true);
  });

  it('anchors the end of the array on a later round, which the next round re-sends', () => {
    const sent = wireMessages(1);

    expect(JSON.stringify(sent.at(-1)?.content)).toContain(TURN_END);
    expect(marked(sent, TURN_END)).toBe(true);
    expect(marked(sent, HISTORY_ANCHOR)).toBe(true);
  });
});
