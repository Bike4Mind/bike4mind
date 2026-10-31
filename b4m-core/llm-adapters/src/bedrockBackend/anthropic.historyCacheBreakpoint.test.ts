/**
 * `IMessage.cache` on a user/assistant message has to survive the Bedrock path too.
 *
 * Bedrock forwards IMessage objects into the request body, unlike the direct API backend which
 * rebuilds each wire message from role/content. A breakpoint flag declared on a history message
 * therefore has to be translated into cache_control here, and the flag itself must never be
 * serialized - the Anthropic message schema has no such field.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';

type Block = {
  type: 'text';
  text: string;
  cache_control?: { type: string; ttl?: string };
};
type WireMessage = { role: string; content: string | Block[]; cache?: boolean };

const backend = new AnthropicBedrockBackend();

const cacheStrategy: ICacheStrategy = {
  enableCaching: true,
  cacheSystemPrompt: true,
  cacheTools: true,
  cacheConversationHistory: true,
  cacheTTL: '5m',
};

const messages: IMessage[] = [
  { role: 'system', content: 'Stable head.' },
  { role: 'user', content: 'First question' },
  { role: 'assistant', content: 'Earlier answer', cache: true },
  { role: 'user', content: 'Second question' },
];

const wireMessages = (model: string, strategy: ICacheStrategy = cacheStrategy): WireMessage[] => {
  const payload = backend.getPayload(model, messages, { cacheStrategy: strategy, maxTokens: 1024 });
  return (JSON.parse(payload.body) as { messages: WireMessage[] }).messages;
};

const blocksOf = (message: WireMessage): Block[] =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;

const cachedBlocks = (sent: WireMessage[]): Block[] =>
  sent.flatMap(message => blocksOf(message)).filter(block => block.cache_control);

describe('AnthropicBedrockBackend history cache breakpoint', () => {
  it('marks the flagged history message and never serializes the control flag', () => {
    const sent = wireMessages(ChatModels.CLAUDE_4_6_SONNET_BEDROCK);

    // The end-of-array anchor from the caching adapter is off in this suite's assertions because
    // it would decorate the last message; what matters is the flagged one carries one too.
    expect(cachedBlocks(sent)).toContainEqual({
      type: 'text',
      text: 'Earlier answer',
      cache_control: { type: 'ephemeral' },
    });
    expect(sent.some(message => 'cache' in message)).toBe(false);
  });

  it('carries the configured TTL, matching the other breakpoints on the request', () => {
    const sent = wireMessages(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, { ...cacheStrategy, cacheTTL: '1h' });

    expect(cachedBlocks(sent).find(block => block.text === 'Earlier answer')?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('strips the flag without a breakpoint when caching is off', () => {
    const sent = wireMessages(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, { ...cacheStrategy, enableCaching: false });

    expect(JSON.stringify(sent)).not.toContain('cache_control');
    expect(sent.some(message => 'cache' in message)).toBe(false);
  });

  it('marks a flagged tool_result that ends history and keeps the current prompt after it', () => {
    const toolTurn: IMessage[] = [
      { role: 'system', content: 'Stable head.' },
      { role: 'user', content: 'What time is it?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'current_datetime', input: {} }] as IMessage['content'],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'noon' }] as IMessage['content'],
        cache: true,
      },
      { role: 'user', content: 'And tomorrow?' },
    ];
    const payload = backend.getPayload(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, backend.formatMessages(toolTurn), {
      cacheStrategy: { ...cacheStrategy, cacheConversationHistory: false },
      maxTokens: 1024,
    });
    const sent = (JSON.parse(payload.body) as { messages: Array<{ role: string; content: unknown }> }).messages;

    expect(sent.at(-2)?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'noon', cache_control: { type: 'ephemeral' } },
    ]);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'And tomorrow?' });
  });

  it('strips the flag without a breakpoint for a model that rejects cache_control', () => {
    // Sending cache_control to these returns a deserialization error and the turn never resolves.
    const sent = wireMessages(ChatModels.CLAUDE_3_HAIKU_BEDROCK);

    expect(JSON.stringify(sent)).not.toContain('cache_control');
    expect(sent.some(message => 'cache' in message)).toBe(false);
  });
});

// Bedrock reports cache writes without a 5m/1h split, so settlement prices every write at the request
// TTL. A caller's own marker therefore has to carry that TTL, or its 5m writes bill at the 1h rate.
describe('AnthropicBedrockBackend caller cache_control on a 1h request', () => {
  const callerMarked: IMessage[] = [
    { role: 'system', content: 'Stable head.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Long document', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Question about it' },
      ] as IMessage['content'],
    },
  ];
  const sentContent = (strategy: ICacheStrategy): unknown => {
    const payload = backend.getPayload(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, callerMarked, {
      cacheStrategy: strategy,
      maxTokens: 1024,
    });
    return (JSON.parse(payload.body) as { messages: Array<{ content: unknown }> }).messages[0]?.content;
  };

  // A one-shot call from a non-CLI caller: the server places no breakpoint of its own.
  const oneShot: ICacheStrategy = { ...cacheStrategy, enableCaching: false, cacheConversationHistory: false };

  it('stamps the request TTL onto a caller marker', () => {
    expect(sentContent({ ...oneShot, cacheTTL: '1h' })).toEqual([
      { type: 'text', text: 'Long document', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'Question about it' },
    ]);
  });

  it('stamps a caller marker nested in a tool_result body', () => {
    const payload = backend.getPayload(
      ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
      [
        { role: 'user', content: 'What time is it?' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'current_datetime', input: {} }] as IMessage['content'],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'noon', cache_control: { type: 'ephemeral' } }],
            },
          ] as IMessage['content'],
        },
      ],
      { cacheStrategy: { ...oneShot, cacheTTL: '1h' }, maxTokens: 1024 }
    );
    const sent = (JSON.parse(payload.body) as { messages: Array<{ content: unknown }> }).messages;

    expect(sent.at(-1)?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'text', text: 'noon', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
    ]);
  });

  it('leaves a caller marker as sent on a 5m request', () => {
    expect(sentContent({ ...oneShot, cacheTTL: '5m' })).toEqual([
      { type: 'text', text: 'Long document', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Question about it' },
    ]);
  });
});
