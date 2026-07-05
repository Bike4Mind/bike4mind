/**
 * Unit tests for the graceful context-overflow pruning helper.
 *
 * When a Bedrock payload exceeds the model context window, BaseBedrockBackend
 * drops the oldest non-system messages and retries instead of throwing an
 * unrecoverable "Context overflow" error. Pruning must preserve two invariants:
 *
 *   1. System messages (prompt/instructions) and the final message (the current
 *      user turn) are always kept.
 *   2. The kept window starts with a clean `user` turn - Anthropic/Bedrock rejects
 *      a window that begins with an assistant message or an unmatched `tool_result`.
 */

import { describe, it, expect } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';

// pruneOldestConversationMessages is protected - expose it through a typed view
// rather than `any` so the test still benefits from the signature.
const backend = new AnthropicBedrockBackend() as unknown as {
  pruneOldestConversationMessages(messages: IMessage[], dropCount: number): IMessage[];
};
const prune = (messages: IMessage[], dropCount: number) => backend.pruneOldestConversationMessages(messages, dropCount);

const toolUse = (id: string): IMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'search', input: {} }] as unknown as IMessage['content'],
});
const toolResult = (id: string): IMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] as unknown as IMessage['content'],
});

describe('pruneOldestConversationMessages (#8573)', () => {
  it('preserves system messages and the final user turn while dropping the oldest', () => {
    const messages: IMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'latest' },
    ];

    const pruned = prune(messages, 2);

    expect(pruned[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(pruned[pruned.length - 1]).toEqual({ role: 'user', content: 'latest' });
    expect(pruned.length).toBeLessThan(messages.length);
    // Dropped the two oldest conversation messages.
    expect(pruned).not.toContainEqual({ role: 'user', content: 'first' });
  });

  it('never drops the final message even when dropCount exceeds history', () => {
    const messages: IMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'final' },
    ];

    const pruned = prune(messages, 999);

    expect(pruned).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'final' },
    ]);
  });

  it('cascade-drops a leading orphaned tool_result so the window starts on a user turn', () => {
    // Dropping the first user+assistant pair would leave the matching tool_result
    // at the head with no preceding tool_use - that orphan must cascade away.
    const messages: IMessage[] = [
      { role: 'user', content: 'q1' },
      toolUse('t1'),
      toolResult('t1'),
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'final' },
    ];

    // Drop the first two (user 'q1' + the tool_use). The tool_result for t1 is now
    // a leading orphan and must be dropped too.
    const pruned = prune(messages, 2);

    expect(pruned[0]).toEqual({ role: 'user', content: 'q2' });
    expect(pruned[pruned.length - 1]).toEqual({ role: 'user', content: 'final' });
    // No unmatched tool_result remains at the head.
    expect(
      Array.isArray(pruned[0].content) &&
        (pruned[0].content as Array<{ type?: string }>).some(b => b.type === 'tool_result')
    ).toBe(false);
  });

  it('does not drop a tool_result that still has its matching tool_use in the window', () => {
    const messages: IMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      toolUse('t1'),
      toolResult('t1'),
      { role: 'user', content: 'final' },
    ];

    // Drop only the oldest two - the tool_use/tool_result pair stays intact.
    const pruned = prune(messages, 2);

    expect(pruned[0]).toEqual({ role: 'user', content: 'q2' });
    expect(pruned).toContainEqual(toolUse('t1'));
    expect(pruned).toContainEqual(toolResult('t1'));
  });

  it('returns the input unchanged when only system + final message remain', () => {
    const messages: IMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'final' },
    ];

    expect(prune(messages, 5)).toEqual(messages);
  });
});
