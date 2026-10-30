import { describe, expect, it } from 'vitest';
import type { SkillSource, SkillSummary } from '@shared/skills';
import {
  highlightedTokens,
  insertSkill,
  matchSkills,
  skillChipColor,
  skillQuery,
  skillSourceLabel,
  type SlashQuery,
} from './skillMenu';

function skill(name: string, source: SkillSummary['source'], description = 'does a thing'): SkillSummary {
  return { name, source, description, filePath: `/tmp/${name}` };
}

describe('skillQuery', () => {
  it('opens on a bare slash', () => {
    expect(skillQuery('/')).toEqual({ query: '', start: 0, end: 1, wholeDraft: true });
  });

  it('filters as the name is typed', () => {
    expect(skillQuery('/rev')?.query).toBe('rev');
  });

  it('opens for a slash typed after a space, mid-sentence', () => {
    expect(skillQuery('fix the bug then /rev')).toEqual({ query: 'rev', start: 17, end: 21, wholeDraft: false });
    expect(skillQuery('first line\n/')?.query).toBe('');
  });

  it('follows the caret, not the end of the draft', () => {
    const draft = 'run /rev on the diff';
    expect(skillQuery(draft, 8)).toEqual({ query: 'rev', start: 4, end: 8, wholeDraft: false });
    // Mid-token: the name has characters glued on after the caret, so nothing is being composed.
    expect(skillQuery(draft, 6)).toBeNull();
    expect(skillQuery(draft, draft.length)).toBeNull();
  });

  it('stays shut for a slash inside a word or a path', () => {
    expect(skillQuery('fix the and/or')).toBeNull();
    expect(skillQuery('look at src/main')).toBeNull();
    expect(skillQuery('//')).toBeNull();
  });

  it('closes once arguments are being typed', () => {
    // The trailing space is what a selection inserts, so this is also what closes the menu
    // after the user picks something.
    expect(skillQuery('/review ')).toBeNull();
    expect(skillQuery('/review src/a.ts')).toBeNull();
  });

  it('calls a leading token the whole draft only when nothing follows it', () => {
    expect(skillQuery('/cle  ', 4)?.wholeDraft).toBe(true);
    expect(skillQuery('/cle and more', 4)?.wholeDraft).toBe(false);
  });
});

describe('insertSkill', () => {
  const at = (text: string, caret: number): SlashQuery => {
    const token = skillQuery(text, caret);
    if (!token) throw new Error('no token');
    return token;
  };

  it('replaces the token at the end of the draft and leaves the caret after a space', () => {
    expect(insertSkill('fix it then /rev', at('fix it then /rev', 16), 'review')).toEqual({
      text: 'fix it then /review ',
      caret: 20,
    });
  });

  it('keeps the words after the token, reusing the space already there', () => {
    expect(insertSkill('run /re on the diff', at('run /re on the diff', 7), 'review')).toEqual({
      text: 'run /review on the diff',
      caret: 12,
    });
  });

  it('adds a space before a following line rather than gluing the name to it', () => {
    expect(insertSkill('/re\nmore', at('/re\nmore', 3), 'review')).toEqual({ text: '/review \nmore', caret: 8 });
  });
});

describe('highlightedTokens', () => {
  const skills = new Set(['review', 'ship-it']);
  const isCommand = (name: string) => name === 'clear';

  it('marks known skills anywhere and leaves unknown names plain', () => {
    expect(highlightedTokens('please /review then /nope and /ship-it.', skills, isCommand)).toEqual([
      { name: 'review', start: 7, end: 14 },
      { name: 'ship-it', start: 30, end: 38 },
    ]);
  });

  it('marks only a leading skill, since later names are its arguments', () => {
    expect(highlightedTokens('/review then /ship-it', skills, isCommand)).toEqual([
      { name: 'review', start: 0, end: 7 },
    ]);
  });

  it('marks a command only where it would run', () => {
    expect(highlightedTokens('/clear', skills, isCommand)).toEqual([{ name: 'clear', start: 0, end: 6 }]);
    expect(highlightedTokens('then /clear', skills, isCommand)).toEqual([]);
  });
});

describe('matchSkills', () => {
  const skills = [
    skill('review', 'global'),
    skill('review-pr', 'project'),
    skill('deploy', 'project', 'ship the review build'),
    skill('lint', 'global'),
  ];

  it('skips the description fallback when namesOnly is set', () => {
    expect(matchSkills(skills, 'ship').map(entry => entry.name)).toEqual(['deploy']);
    expect(matchSkills(skills, 'ship', true)).toEqual([]);
  });

  it('returns everything for an empty query, project skills first', () => {
    expect(matchSkills(skills, '').map(entry => entry.name)).toEqual(['deploy', 'review-pr', 'lint', 'review']);
  });

  it('puts an exact name above a longer one that starts with it', () => {
    expect(matchSkills(skills, 'review').map(entry => entry.name)).toEqual(['review', 'review-pr']);
  });

  it('ignores descriptions while any name matches', () => {
    // 'deploy' only matches through its description. A short query would otherwise drag in most
    // of the list, since a skill description is a paragraph of prose.
    expect(matchSkills(skills, 'rev').map(entry => entry.name)).toEqual(['review-pr', 'review']);
  });

  it('falls back to descriptions when no name matches', () => {
    expect(matchSkills(skills, 'ship the').map(entry => entry.name)).toEqual(['deploy']);
  });

  it('puts account skills after global ones of the same rank', () => {
    const mixed = [skill('a-web', 'account'), skill('z-local', 'global'), skill('m-repo', 'project')];
    expect(matchSkills(mixed, '').map(entry => entry.name)).toEqual(['m-repo', 'z-local', 'a-web']);
  });

  it('is case insensitive', () => {
    expect(matchSkills(skills, 'LINT').map(entry => entry.name)).toEqual(['lint']);
  });

  it('returns nothing for a name no skill has', () => {
    expect(matchSkills(skills, 'nope')).toEqual([]);
  });
});

describe('skill chip presentation', () => {
  it.each([
    ['project', 'warning', 'Project'],
    ['global', 'neutral', 'Global'],
    ['account', 'primary', 'Bike4Mind'],
  ] as const)('presents %s as %s / %s', (source, color, label) => {
    expect(skillChipColor(source)).toBe(color);
    expect(skillSourceLabel(source)).toBe(label);
  });

  it('covers every source, so a new one cannot fall through to the global look', () => {
    const sources: SkillSource[] = ['project', 'global', 'account'];
    expect(sources.map(skillSourceLabel)).toEqual(['Project', 'Global', 'Bike4Mind']);
  });
});
