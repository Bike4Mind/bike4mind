import { describe, expect, it } from 'vitest';
import { findSkillMentions } from './skills';
import { findSessionMentions, formatSessionMention } from './sessionMention';

describe('skills', () => {
  describe('findSkillMentions', () => {
    it('finds a leading token and ones after whitespace, with positions', () => {
      expect(findSkillMentions('/review then\n/ship-it now')).toEqual([
        { name: 'review', start: 0, end: 7 },
        { name: 'ship-it', start: 13, end: 21 },
      ]);
    });

    it('ends a name at prose punctuation, including a colon', () => {
      expect(findSkillMentions('can you /summarize? and (/lint) then /review: go').map(m => m.name)).toEqual([
        'summarize',
        'review',
      ]);
    });

    it('keeps the desktop name shapes the web regex does not', () => {
      expect(findSkillMentions('run /plugin:deploy and /Some_Skill').map(m => m.name)).toEqual([
        'plugin:deploy',
        'Some_Skill',
      ]);
    });

    it('ignores paths, URLs and slashes inside words', () => {
      expect(findSkillMentions('cat /etc/hosts, see https://x.dev/a and src/main.ts or and/or')).toEqual([]);
    });

    it('ignores a bare or doubled slash', () => {
      expect(findSkillMentions('a / b // c')).toEqual([]);
    });
  });
});

describe('sessionMention', () => {
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
});
