import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './chat';
import { classifyMessagesOutcome, snippetOf } from './agentOutcome';

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a', role: 'assistant', content: 'done', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('classifyMessagesOutcome', () => {
  it('is no-reply without an assistant message', () => {
    expect(classifyMessagesOutcome([])).toBe('no-reply');
    expect(classifyMessagesOutcome([{ ...assistant(), role: 'user' }])).toBe('no-reply');
  });

  it('classifies the last assistant message', () => {
    expect(classifyMessagesOutcome([assistant({ error: 'boom' })])).toBe('failed');
    expect(classifyMessagesOutcome([assistant({ stopReason: 'aborted' })])).toBe('aborted');
    expect(classifyMessagesOutcome([assistant({ stopReason: 'context_limit' })])).toBe('context-limit');
    expect(classifyMessagesOutcome([assistant({ stopReason: 'max_tokens' })])).toBe('max-tokens');
    expect(classifyMessagesOutcome([assistant()])).toBe('finished');
  });

  it('ignores an earlier failed turn once a later one is clean', () => {
    expect(classifyMessagesOutcome([assistant({ id: 'a1', error: 'boom' }), assistant({ id: 'a2' })])).toBe('finished');
  });
});

describe('snippetOf', () => {
  it('collapses whitespace and trims', () => {
    expect(snippetOf('  a\n\nb  ')).toBe('a b');
  });

  it('cuts to the budget with a trailing ellipsis', () => {
    const snippet = snippetOf('x'.repeat(200));
    expect(snippet).toHaveLength(160);
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('leaves empty text empty', () => {
    expect(snippetOf('')).toBe('');
  });
});
