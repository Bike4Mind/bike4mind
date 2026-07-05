import { describe, it, expect, vi } from 'vitest';
import { skillTool } from './index';
import type { ToolContext } from '../../base/types';
import type { ISkill } from '@bike4mind/common';

function makeSkill(overrides: Partial<ISkill> = {}): ISkill {
  return {
    id: 's1',
    name: 'summarize',
    description: 'Summarize',
    body: 'Summarize: $ARGUMENTS',
    userId: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ISkill;
}

function makeContext(overrides: {
  findAccessibleByNameForUser?: ReturnType<typeof vi.fn>;
  listAccessibleInvocableForUser?: ReturnType<typeof vi.fn>;
  noSkillsRepo?: boolean;
}): ToolContext {
  const db = overrides.noSkillsRepo
    ? {}
    : {
        skills: {
          findAccessibleByNameForUser: overrides.findAccessibleByNameForUser ?? vi.fn(),
          listAccessibleInvocableForUser: overrides.listAccessibleInvocableForUser ?? vi.fn().mockResolvedValue([]),
        },
      };
  return {
    userId: 'user-1',
    db,
  } as unknown as ToolContext;
}

describe('skillTool', () => {
  it('rejects when name is missing', async () => {
    const tool = skillTool.implementation(makeContext({}), {});
    const result = await tool.toolFn({});
    expect(result).toMatch(/`name` is required/);
  });

  it('returns a configuration error when no skill repository is wired', async () => {
    const tool = skillTool.implementation(makeContext({ noSkillsRepo: true }), {});
    const result = await tool.toolFn({ name: 'summarize' });
    expect(result).toMatch(/skills are not configured/);
  });

  it('returns the expanded body when a skill is found', async () => {
    const findAccessibleByNameForUser = vi.fn().mockResolvedValue(makeSkill({ body: 'Summarize: $ARGUMENTS' }));
    const tool = skillTool.implementation(makeContext({ findAccessibleByNameForUser }), {});
    const result = await tool.toolFn({ name: 'summarize', args: 'hello world' });

    expect(findAccessibleByNameForUser).toHaveBeenCalledWith('user-1', 'summarize');
    expect(result).toContain('Skill: /summarize');
    expect(result).toContain('Summarize: hello world');
  });

  it('strips a leading slash from the name', async () => {
    const findAccessibleByNameForUser = vi.fn().mockResolvedValue(makeSkill());
    const tool = skillTool.implementation(makeContext({ findAccessibleByNameForUser }), {});
    await tool.toolFn({ name: '/summarize' });
    expect(findAccessibleByNameForUser).toHaveBeenCalledWith('user-1', 'summarize');
  });

  it('refuses skills marked disableModelInvocation and lists invocable alternatives', async () => {
    const findAccessibleByNameForUser = vi.fn().mockResolvedValue(makeSkill({ disableModelInvocation: true }));
    const listAccessibleInvocableForUser = vi
      .fn()
      .mockResolvedValue([makeSkill({ name: 'open', disableModelInvocation: false })]);
    const tool = skillTool.implementation(
      makeContext({ findAccessibleByNameForUser, listAccessibleInvocableForUser }),
      {}
    );

    const result = await tool.toolFn({ name: 'summarize' });
    expect(result).toMatch(/not available/);
    expect(result).toContain('open');
  });

  it('returns a "none defined" error when the user has no invocable skills', async () => {
    const findAccessibleByNameForUser = vi.fn().mockResolvedValue(null);
    const listAccessibleInvocableForUser = vi.fn().mockResolvedValue([]);
    const tool = skillTool.implementation(
      makeContext({ findAccessibleByNameForUser, listAccessibleInvocableForUser }),
      {}
    );

    const result = await tool.toolFn({ name: 'summarize' });
    expect(result).toMatch(/no LLM-invocable skills defined/);
  });

  it('parses shell-style args (quoted phrases preserved)', async () => {
    const findAccessibleByNameForUser = vi.fn().mockResolvedValue(makeSkill({ body: 'first=$1 second=$2' }));
    const tool = skillTool.implementation(makeContext({ findAccessibleByNameForUser }), {});
    const result = await tool.toolFn({ name: 'summarize', args: '"hello world" priority-high' });
    expect(result).toContain('first=hello world second=priority-high');
  });

  it('wraps a non-owner (shared) skill body as untrusted content', async () => {
    const findAccessibleByNameForUser = vi
      .fn()
      .mockResolvedValue(makeSkill({ body: 'Do: $ARGUMENTS', userId: 'someone-else' }));
    const tool = skillTool.implementation(makeContext({ findAccessibleByNameForUser }), {});
    const result = await tool.toolFn({ name: 'summarize', args: 'now' });

    expect(result).toContain('UNTRUSTED_SKILL_CONTENT');
    expect(result).toContain('untrusted');
    expect(result).toContain('Do: now');
  });

  it("surfaces a shared skill's allowedTools as a requested tool scope", async () => {
    const findAccessibleByNameForUser = vi
      .fn()
      .mockResolvedValue(makeSkill({ body: 'Do it', userId: 'someone-else', allowedTools: ['web_search', 'skill'] }));
    const tool = skillTool.implementation(makeContext({ findAccessibleByNameForUser }), {});
    const result = await tool.toolFn({ name: 'summarize' });

    expect(result).toContain('intended to use only these tools: web_search, skill');
  });
});
