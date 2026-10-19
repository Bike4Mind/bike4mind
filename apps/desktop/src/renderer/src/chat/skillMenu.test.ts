import { describe, expect, it } from 'vitest';
import type { SkillSource, SkillSummary } from '@shared/skills';
import { matchSkills, skillChipColor, skillQuery, skillSourceLabel } from './skillMenu';

function skill(name: string, source: SkillSummary['source'], description = 'does a thing'): SkillSummary {
  return { name, source, description, filePath: `/tmp/${name}` };
}

describe('skillQuery', () => {
  it('opens on a bare slash', () => {
    expect(skillQuery('/')).toBe('');
  });

  it('filters as the name is typed', () => {
    expect(skillQuery('/rev')).toBe('rev');
  });

  it('stays shut for a slash mid-sentence', () => {
    expect(skillQuery('fix the and/or check')).toBeNull();
    expect(skillQuery('look at src/main.ts')).toBeNull();
  });

  it('closes once arguments are being typed', () => {
    // The trailing space is what a selection inserts, so this is also what closes the menu
    // after the user picks something.
    expect(skillQuery('/review ')).toBeNull();
    expect(skillQuery('/review src/a.ts')).toBeNull();
  });
});

describe('matchSkills', () => {
  const skills = [
    skill('review', 'global'),
    skill('review-pr', 'project'),
    skill('deploy', 'project', 'ship the review build'),
    skill('lint', 'global'),
  ];

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
