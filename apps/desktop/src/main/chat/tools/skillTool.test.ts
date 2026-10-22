import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomCommand } from '@bike4mind/cli/skills';
import { skillTool } from './skillTool';
import type { SkillContext, ToolContext, ToolReporter } from './types';

function command(name: string, body: string, extra: Partial<CustomCommand> = {}): CustomCommand {
  return {
    name,
    description: `does ${name}`,
    body,
    source: 'global',
    filePath: `/skills/${name}/SKILL.md`,
    ...extra,
  };
}

/**
 * The context the tool is handed is already filtered - see SkillContext - so what is proven here
 * is what the tool does with a list, not how the list is chosen. SkillCatalog.test.ts owns that.
 */
function contextFor(
  available: readonly CustomCommand[],
  roots: readonly string[] = [],
  report?: ToolReporter
): ToolContext {
  const skills: SkillContext = { available: () => Promise.resolve(available) };
  return { roots, signal: new AbortController().signal, skills, ...(report ? { report } : {}) };
}

function reporter(): ToolReporter {
  return {
    progress: vi.fn(),
    media: vi.fn(),
    notice: vi.fn(),
    label: vi.fn(),
    diff: vi.fn(),
    detail: vi.fn(),
    image: vi.fn(),
    moved: vi.fn(),
    ownContent: vi.fn(),
  };
}

describe('the skill tool', () => {
  it('returns the skill body for the model to follow', async () => {
    const context = contextFor([command('ship', 'Run the deploy script, then post in the channel.')]);
    const result = await skillTool.run({ skill: 'ship' }, context);
    expect(result).toContain('Run the deploy script, then post in the channel.');
    expect(result).toContain('/skills/ship/SKILL.md');
  });

  it('accepts the name with the leading slash the user would have typed', async () => {
    const context = contextFor([command('ship', 'Ship it.')]);
    await expect(skillTool.run({ skill: '/ship' }, context)).resolves.toContain('Ship it.');
  });

  it('substitutes arguments the same way the composer does', async () => {
    const context = contextFor([command('review', 'Review PR $1 for $2. All of it: $ARGUMENTS.')]);
    const result = await skillTool.run({ skill: 'review', args: '123 "the auth change"' }, context);
    expect(result).toContain('Review PR 123 for the auth change.');
    // $ARGUMENTS gets the parsed arguments, with the quoting that split them already spent.
    expect(result).toContain('All of it: 123 the auth change.');
  });

  it('names what does exist when the name is wrong, rather than failing bare', async () => {
    // The observed failure this guards: a model told only "not found" abandons the skill and
    // improvises the job from the name it guessed at.
    const context = contextFor([command('address-review', 'x'), command('pick-issue', 'y')]);
    await expect(skillTool.run({ skill: 'addressreview' }, context)).rejects.toThrow(
      /no skill called "addressreview".*address-review, pick-issue/s
    );
  });

  it('says so plainly when there are no skills at all', async () => {
    await expect(skillTool.run({ skill: 'ship' }, contextFor([]))).rejects.toThrow(/has none available/);
  });

  it('refuses a skill the context withheld, however the model names it', async () => {
    // A not-model-invocable skill, or one from an untrusted project, never reaches `available`;
    // the tool has no second route to it.
    const context = contextFor([command('ship', 'Ship it.')]);
    await expect(skillTool.run({ skill: 'private-notes' }, context)).rejects.toThrow(/no skill called/);
  });

  it('refuses when the conversation has no catalog', async () => {
    const bare: ToolContext = { roots: [], signal: new AbortController().signal };
    await expect(skillTool.run({ skill: 'ship' }, bare)).rejects.toThrow(/no skills available/);
  });

  it('refuses an empty body rather than sending the model nothing to do', async () => {
    await expect(skillTool.run({ skill: 'ship' }, contextFor([command('ship', '  \n ')]))).rejects.toThrow(
      /empty body/
    );
  });

  it('requires a name', async () => {
    await expect(skillTool.run({}, contextFor([command('ship', 'x')]))).rejects.toThrow(/"skill" argument/);
  });
});

describe('the skill tool and where the skill came from', () => {
  it("vouches for a skill in the user's own folder", async () => {
    const report = reporter();
    await skillTool.run({ skill: 'ship' }, contextFor([command('ship', 'Ship it.', { source: 'global' })], [], report));

    expect(report.ownContent).toHaveBeenCalledTimes(1);
  });

  it('vouches for a skill from a project the user trusted', async () => {
    const report = reporter();
    await skillTool.run(
      { skill: 'ship' },
      contextFor([command('ship', 'Ship it.', { source: 'project' })], [], report)
    );

    expect(report.ownContent).toHaveBeenCalledTimes(1);
  });

  it("does not vouch for an account skill, which may be someone else's", async () => {
    const report = reporter();
    await skillTool.run({ skill: 'ship' }, contextFor([command('ship', 'Ship it.', { source: 'remote' })], [], report));

    expect(report.ownContent).not.toHaveBeenCalled();
  });

  it('returns a Skill Market import wrapped as untrusted, never told to follow it as is', async () => {
    const report = reporter();
    const result = await skillTool.run(
      { skill: 'market-pick' },
      contextFor([command('market-pick', 'Do the thing.', { source: 'remote', untrusted: true })], [], report)
    );

    expect(result).toContain('is a Skill Market import written by someone else');
    expect(result).not.toContain('Follow them.');
    expect(result).toMatch(
      /<<<UNTRUSTED_SKILL_CONTENT [0-9a-f]{16}>>>\nDo the thing\.\n<<<END_UNTRUSTED_SKILL_CONTENT/
    );
    expect(report.ownContent).not.toHaveBeenCalled();
  });
});

describe('the skill tool and the granted roots', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-skilltool-')));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'policy.md'), 'The release policy.', 'utf8');
  });

  it('inlines a reference inside a granted folder', async () => {
    const context = contextFor([command('ship', `Follow @${join(root, 'docs', 'policy.md')}`)], [root]);
    await expect(skillTool.run({ skill: 'ship' }, context)).resolves.toContain('The release policy.');
  });

  it('denies one outside it, and still runs the rest of the skill', async () => {
    // The skill body is repo- or model-authored text, so its references pass the same check
    // every file tool passes - and a refused reference is reported, not silently dropped.
    const context = contextFor([command('ship', 'Follow @/etc/hosts')], [root]);
    const result = await skillTool.run({ skill: 'ship' }, context);
    expect(result).toContain('Follow @/etc/hosts');
    expect(result).toContain('Access denied');
  });
});
