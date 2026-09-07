/**
 * `IMessage.cache` on a system message has to survive the Bedrock path.
 *
 * This backend used to join every system message into one string before assigning
 * `body.system`, so a breakpoint declared part-way down the stack had nowhere to attach and
 * the caching adapter's own end-of-system marker was the only one that ever shipped. That
 * made the shareable-prefix breakpoint a silent no-op on Bedrock - the request looked
 * identical to one built without it, and only a cache-read count on a second differing-tail
 * caller could tell the difference.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: string; ttl?: string } };

const backend = new AnthropicBedrockBackend();

const cacheStrategy: ICacheStrategy = {
  enableCaching: true,
  cacheSystemPrompt: true,
  cacheTools: true,
  cacheConversationHistory: true,
  cacheTTL: '5m',
};

const SHARED_HEAD = 'Deployment-wide guidance every caller sees.';
const PER_CALLER_TAIL = 'Content only this caller sees.';

const messagesWithBreakpoint: IMessage[] = [
  { role: 'system', content: SHARED_HEAD, cache: true },
  { role: 'system', content: PER_CALLER_TAIL },
  { role: 'user', content: 'What is 2+2?' },
];

function systemOf(model: string, messages: IMessage[], strategy?: ICacheStrategy) {
  const payload = backend.getPayload(model, messages, { cacheStrategy: strategy, maxTokens: 1024 });
  return (JSON.parse(payload.body) as { system?: string | SystemBlock[] }).system;
}

describe('AnthropicBedrockBackend system cache breakpoint', () => {
  it('emits the block form with cache_control on the marked block', () => {
    const system = systemOf(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, messagesWithBreakpoint, cacheStrategy);

    expect(Array.isArray(system)).toBe(true);
    const blocks = system as SystemBlock[];
    expect(blocks[0].text).toBe(SHARED_HEAD);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].text).toBe(PER_CALLER_TAIL);
  });

  it('keeps the identity reminder last, so the shared-head breakpoint never anchors on the model id', () => {
    const blocks = systemOf(
      ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
      messagesWithBreakpoint,
      cacheStrategy
    ) as SystemBlock[];

    // The identity reminder names the model, so a prefix ending on it would be busted by every
    // model change. It still collects the end-of-system breakpoint applyCaching has always added.
    const last = blocks[blocks.length - 1];
    expect(last.text).toContain(ChatModels.CLAUDE_4_6_SONNET_BEDROCK);
    expect(blocks.findIndex(block => block.text === SHARED_HEAD)).toBeLessThan(blocks.length - 1);
  });

  it('still applies the end-of-system breakpoint the caching adapter owns', () => {
    const blocks = systemOf(
      ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
      messagesWithBreakpoint,
      cacheStrategy
    ) as SystemBlock[];

    // Two breakpoints: the shared head, and the end of the stack. Applied by different code
    // paths, so a regression in either one leaves the other in place and looks healthy.
    expect(blocks.filter(block => block.cache_control).length).toBe(2);
  });

  it('carries a 1h TTL through to the shared-head breakpoint', () => {
    const blocks = systemOf(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, messagesWithBreakpoint, {
      ...cacheStrategy,
      cacheTTL: '1h',
    }) as SystemBlock[];

    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('adds no mid-stack breakpoint when no system message declares one', () => {
    // applyCaching promotes the joined string to a one-element array to mark it, so the shape is
    // an array either way. What must not appear is a SECOND breakpoint part-way down.
    const system = systemOf(
      ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
      [
        { role: 'system', content: SHARED_HEAD },
        { role: 'system', content: PER_CALLER_TAIL },
        { role: 'user', content: 'What is 2+2?' },
      ],
      cacheStrategy
    ) as SystemBlock[];

    expect(system.filter(block => block.cache_control).length).toBe(1);
    expect(JSON.stringify(system)).toContain(SHARED_HEAD);
    expect(JSON.stringify(system)).toContain(PER_CALLER_TAIL);
  });

  it('keeps the joined-string form when caching is off, so the flag alone cannot introduce cache_control', () => {
    const system = systemOf(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, messagesWithBreakpoint, {
      ...cacheStrategy,
      enableCaching: false,
    });

    expect(typeof system).toBe('string');
    expect(JSON.stringify(system)).not.toContain('cache_control');
  });

  it('sends no cache_control at all for a Bedrock Claude that rejects it', () => {
    // BEDROCK_NO_PROMPT_CACHING_MODELS: sending cache_control returns a deserialization
    // error and the assistant turn never resolves, so the flag must not open a second route in.
    const system = systemOf(ChatModels.CLAUDE_3_HAIKU_BEDROCK, messagesWithBreakpoint, cacheStrategy);

    expect(typeof system).toBe('string');
    expect(JSON.stringify(system)).not.toContain('cache_control');
  });
});

describe('AnthropicBedrockBackend system cache breakpoint survives formatMessages', () => {
  // The real path never hands getPayload the raw messages: base.ts runs formatMessages first,
  // and that merges the whole consecutive system run into ONE message. A test that skips the
  // merge passes while production silently falls back to the joined single-block form, which is
  // exactly how the Bedrock no-op went unnoticed.
  const PER_CALLER_SYSTEM = 'Session prompt only this caller has.';

  const realStack: IMessage[] = [
    { role: 'system', content: 'Date: Wednesday, August 19, 2026' },
    { role: 'system', content: 'Artifact guidance.' },
    { role: 'system', content: SHARED_HEAD, cache: true },
    { role: 'system', content: PER_CALLER_SYSTEM },
    { role: 'user', content: 'What is 2+2?' },
  ];

  it('does not merge the per-caller block into the marked shared head', () => {
    const merged = backend.formatMessages(realStack).filter(m => m.role === 'system');

    expect(merged).toHaveLength(2);
    expect(merged[0].cache).toBe(true);
    expect(merged[1].cache).not.toBe(true);
  });

  it('emits the shared head and the per-caller tail as separate blocks after the merge', () => {
    const merged = backend.formatMessages(realStack);
    const blocks = systemOf(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, merged, cacheStrategy) as SystemBlock[];

    expect(Array.isArray(blocks)).toBe(true);
    const marked = blocks.findIndex(block => block.cache_control);
    expect(marked).toBeGreaterThanOrEqual(0);
    // The head carries the deployment-wide text; the per-caller block sits BEHIND the breakpoint,
    // which is the whole point - it must not be inside the shared prefix.
    expect(blocks[marked].text).toContain(SHARED_HEAD);
    expect(blocks[marked].text).not.toContain(PER_CALLER_SYSTEM);
    expect(JSON.stringify(blocks)).toContain(PER_CALLER_SYSTEM);
  });

  it('still merges a run that declares no breakpoint, so ordinary turns are unchanged', () => {
    const plain: IMessage[] = [
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
      { role: 'system', content: 'three' },
      { role: 'user', content: 'hi' },
    ];

    expect(backend.formatMessages(plain).filter(m => m.role === 'system')).toHaveLength(1);
  });
});
