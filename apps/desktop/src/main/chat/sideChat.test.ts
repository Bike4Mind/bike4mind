import type { ChatMessage } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { parentExcerpt, SIDE_CHAT_SELECTION_LIMIT, sideChatOpening } from './sideChat';

let next = 0;
function message(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m${next++}`, role, content, createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

describe('parentExcerpt', () => {
  it('labels each speaker, oldest first', () => {
    const excerpt = parentExcerpt([message('user', 'Hi'), message('assistant', 'Hello'), message('user', 'Bye')]);
    expect(excerpt).toBe('User: Hi\n\nAssistant: Hello\n\nUser: Bye');
  });

  it('starts at the last boundary, keeping its summary', () => {
    const excerpt = parentExcerpt([
      message('user', 'forgotten'),
      message('user', 'Summary of earlier work', { boundary: { kind: 'compact' } }),
      message('assistant', 'after'),
    ]);
    expect(excerpt).not.toContain('forgotten');
    expect(excerpt).toContain('Summary of earlier work');
    expect(excerpt).toContain('Assistant: after');
  });

  it('keeps the newest messages that fit the budget and drops older ones', () => {
    const excerpt = parentExcerpt([message('user', 'a'.repeat(50)), message('assistant', 'newest')], 30);
    expect(excerpt).toBe('Assistant: newest');
  });

  it('skips empty messages and marks app-written ones', () => {
    const excerpt = parentExcerpt([message('assistant', '  '), message('user', 'child report', { system: true })]);
    expect(excerpt).toBe('App: child report');
  });
});

describe('sideChatOpening', () => {
  const parent = {
    title: 'Monads',
    messages: [message('user', 'What is a monad?'), message('assistant', 'A monoid in endofunctors.')],
  };

  it('gives the model the parent title, an excerpt and the quoted passage', () => {
    const opening = sideChatOpening(parent, '  monoid\nin endofunctors  ');
    expect(opening.content).toContain('"Monads"');
    expect(opening.content).toContain('User: What is a monad?');
    expect(opening.content).toContain('> monoid\n> in endofunctors');
    expect(opening.selection).toBe('monoid\nin endofunctors');
  });

  it('shows the user only the quoted passage', () => {
    expect(sideChatOpening(parent, 'monoid').display).toBe('> monoid');
  });

  it('cuts an over-long selection', () => {
    const opening = sideChatOpening(parent, 'y'.repeat(SIDE_CHAT_SELECTION_LIMIT + 10));
    expect(opening.selection.endsWith(' [...]')).toBe(true);
  });
});
