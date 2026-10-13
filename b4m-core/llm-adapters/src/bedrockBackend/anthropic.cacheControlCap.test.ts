/**
 * Bedrock marks every `cache: true` system message, then applyCaching adds its own breakpoints,
 * and caller content blocks can arrive already marked. The body that goes out must never carry
 * more than Anthropic's four `cache_control` markers.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage, type MessageContent } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';

type Block = { type: string; text?: string; cache_control?: unknown };
type Body = { system?: string | Block[]; messages: Array<{ role: string; content: string | Block[] }> };

const backend = new AnthropicBedrockBackend();
const MODEL = ChatModels.CLAUDE_4_6_SONNET_BEDROCK;

const cacheStrategy: ICacheStrategy = {
  enableCaching: true,
  cacheSystemPrompt: true,
  cacheTools: true,
  cacheConversationHistory: true,
  cacheTTL: '5m',
};

function bodyOf(messages: IMessage[], strategy: ICacheStrategy = cacheStrategy): Body {
  return JSON.parse(backend.getPayload(MODEL, messages, { cacheStrategy: strategy, maxTokens: 1024 }).body) as Body;
}

function markers(body: Body): Block[] {
  const system = Array.isArray(body.system) ? body.system : [];
  const messages = body.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []));
  return [...system, ...messages].filter(b => b.cache_control);
}

const marked = (text: string): MessageContent =>
  [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] as unknown as MessageContent;

describe('AnthropicBedrockBackend cache_control cap', () => {
  it('caps system breakpoints plus caller-marked content at four, keeping the latest message', () => {
    const body = bodyOf([
      { role: 'system', content: 'shared head', cache: true },
      { role: 'system', content: 'retrieval one', cache: true },
      { role: 'system', content: 'retrieval two', cache: true },
      { role: 'system', content: 'session', cache: true },
      { role: 'user', content: marked('u1') },
      { role: 'assistant', content: marked('a1') },
      { role: 'user', content: marked('u2') },
    ]);

    expect(markers(body).length).toBe(4);
    expect(markers(body).map(b => b.text)).toContain('u2');
    expect(markers(body).map(b => b.text)).toContain('shared head');
    const system = body.system as Block[];
    expect(system.map(b => b.text).slice(0, 4)).toEqual(['shared head', 'retrieval one', 'retrieval two', 'session']);
  });

  it('leaves a within-cap body untouched', () => {
    const body = bodyOf([
      { role: 'system', content: 'shared head', cache: true },
      { role: 'system', content: 'tail' },
      { role: 'user', content: 'hi' },
    ]);

    // Shared head, end-of-system and history anchor: three, all kept.
    expect(markers(body).length).toBe(3);
  });
});
