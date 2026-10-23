import { describe, expect, it } from 'vitest';
import type { CustomCommand } from '@bike4mind/cli/skills';
import { resolveInlineSkills } from './inline';

function command(name: string): CustomCommand {
  return { name, description: name, body: 'x', source: 'global', filePath: `/g/${name}/SKILL.md` };
}

/** `all` is every skill the user may run; `model` the subset the model may (the rest are user-only). */
function catalog(all: readonly string[], model: readonly string[] = all) {
  return {
    get: async (_root: string | null, name: string) => (all.includes(name) ? command(name) : undefined),
    forModel: async () => model.map(command),
  };
}

describe('resolveInlineSkills', () => {
  it('says nothing for a message with no slash tokens', async () => {
    expect(await resolveInlineSkills('just prose and/or a path src/a.ts', catalog(['review']), null)).toEqual({
      note: null,
    });
  });

  it('leaves a name that is no skill as prose', async () => {
    expect(await resolveInlineSkills('try /nope here', catalog(['review']), null)).toEqual({ note: null });
  });

  it('notes each skill named mid-message, once', async () => {
    const result = await resolveInlineSkills(
      'fix it, then /review and /ship-it, then /review again',
      catalog(['review', 'ship-it']),
      null
    );
    expect(result).toEqual({ note: expect.stringContaining('the skills /review, /ship-it in this message') });
    expect('note' in result && result.note).toContain('skill tool');
  });

  it('refuses a user-only skill the tool could not run, rather than sending it as literal text', async () => {
    expect(await resolveInlineSkills('then /my-notes please', catalog(['my-notes'], []), null)).toEqual({
      error: expect.stringContaining('/my-notes can only be run at the start of a message'),
    });
  });
});
