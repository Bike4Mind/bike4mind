import { describe, expect, it } from 'vitest';
import { findSessionMentions, formatSessionMention } from './sessionMention';

const ID = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';

describe('session mentions', () => {
  it('round-trips a title, flattening what would break the markup', () => {
    const text = `ask ${formatSessionMention(ID, 'Fix [login]\nbug')} about it`;
    expect(text).toContain(`@[Fix [login bug](session:${ID})`);
    const [mention] = findSessionMentions(text);
    expect(mention).toMatchObject({ sessionId: ID, title: 'Fix [login bug' });
    expect(text.slice(mention.start, mention.end)).toBe(formatSessionMention(ID, 'Fix [login]\nbug'));
  });

  it('caps a long title so the mention still parses', () => {
    const text = formatSessionMention(ID, 'a'.repeat(300));
    const [mention] = findSessionMentions(text);
    expect(mention).toMatchObject({ sessionId: ID, title: 'a'.repeat(200) });
    expect(text.slice(mention.start, mention.end)).toBe(text);
  });

  it('ignores lookalikes that do not carry a session id', () => {
    expect(findSessionMentions('@[Docs](https://example.com) and @[x](session:not-an-id)')).toEqual([]);
  });
});
