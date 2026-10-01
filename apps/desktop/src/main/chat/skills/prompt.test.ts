import { describe, expect, it } from 'vitest';
import type { CustomCommand } from '@bike4mind/cli/skills';
import { MAX_SKILLS_PROMPT_BYTES, buildSkillsSection } from './prompt';

function command(name: string, description: string, source: CustomCommand['source'] = 'global'): CustomCommand {
  return { name, description, body: 'body', source, filePath: `/skills/${name}/SKILL.md` };
}

describe('buildSkillsSection', () => {
  it('says nothing when there is nothing to list', () => {
    expect(buildSkillsSection([])).toBe('');
  });

  it('lists each name with the description that decides when to use it', () => {
    const section = buildSkillsSection([command('address-review', 'Use whenever the user says "address review".')]);
    expect(section).toContain('address-review');
    expect(section).toContain('Use whenever the user says "address review".');
  });

  it('never carries a body into the prompt', () => {
    expect(buildSkillsSection([command('ship', 'Ship it.')])).not.toContain('body');
  });

  it('separates the project list from the global one', () => {
    const section = buildSkillsSection([command('deploy', 'Deploy.', 'project'), command('ship', 'Ship.')]);
    expect(section).toContain('Project Skills');
    expect(section).toContain('Global Skills');
    expect(section.indexOf('deploy')).toBeLessThan(section.indexOf('ship'));
  });

  it('stays inside the budget, and says what it left out', () => {
    const long = 'Use whenever the user asks for this particular thing, '.repeat(20);
    const many = Array.from({ length: 200 }, (_, index) => command(`skill-${index}`, long));

    const section = buildSkillsSection(many);
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(MAX_SKILLS_PROMPT_BYTES);
    expect(section).toMatch(/further skills are not listed here; the skill tool still runs any of them by name/);
  });

  it('spends the budget on project skills first', () => {
    const long = 'Use whenever the user asks for this particular thing, '.repeat(20);
    const section = buildSkillsSection([
      ...Array.from({ length: 100 }, (_, index) => command(`global-${index}`, long)),
      command('deploy', 'Deploy this repository.', 'project'),
    ]);
    expect(section).toContain('deploy');
  });

  it('keeps a skill whose own description would fill the budget, rather than listing nothing', () => {
    const section = buildSkillsSection([command('huge', 'x'.repeat(MAX_SKILLS_PROMPT_BYTES * 2))]);
    expect(section).toContain('huge');
  });
});
