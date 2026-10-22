import { describe, expect, it } from 'vitest';
import { findSkillMentions } from './skills';

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
