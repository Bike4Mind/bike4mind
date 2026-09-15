import { describe, it, expect, vi } from 'vitest';
import type { ISkill } from '@bike4mind/common';
import { getFirstIterationSkillsPreamble } from './getFirstIterationSkillsPreamble';

const makeSkill = (overrides: Partial<ISkill> = {}): ISkill =>
  ({
    id: 'skill-1',
    name: 'share-demo',
    body: 'Share a demo of $ARGUMENTS.',
    userId: 'user-1',
    description: 'demo',
    ...overrides,
  }) as ISkill;

const makeLogger = () => ({ log: vi.fn(), error: vi.fn() });

const makeRepo = (skills: ISkill[], impl?: () => Promise<ISkill[]>) => ({
  findAccessibleByNamesForUser: impl
    ? vi.fn(impl)
    : vi.fn(async (_userId: string, names: string[]) => skills.filter(s => names.includes(s.name))),
});

describe('getFirstIterationSkillsPreamble', () => {
  it('returns empty string when the message has no skill mentions', async () => {
    const repo = makeRepo([]);
    const result = await getFirstIterationSkillsPreamble('just a normal message', 'user-1', repo, makeLogger());
    expect(result).toBe('');
    expect(repo.findAccessibleByNamesForUser).not.toHaveBeenCalled();
  });

  it('expands an owner-authored skill with arguments substituted', async () => {
    const repo = makeRepo([makeSkill()]);
    const result = await getFirstIterationSkillsPreamble('/share-demo hello world', 'user-1', repo, makeLogger());

    expect(repo.findAccessibleByNamesForUser).toHaveBeenCalledWith('user-1', ['share-demo']);
    expect(result).toContain('## Skill Invoked: /share-demo');
    expect(result).toContain('Share a demo of hello world.');
    expect(result.startsWith('\n\n')).toBe(true);
  });

  it('wraps a non-owner skill body as untrusted content', async () => {
    const repo = makeRepo([makeSkill({ userId: 'someone-else' })]);
    const result = await getFirstIterationSkillsPreamble('/share-demo x', 'user-1', repo, makeLogger());

    expect(result).toContain('untrusted content');
    expect(result).toContain('<<<UNTRUSTED_SKILL_CONTENT>>>');
  });

  it('skips and logs a mention that does not resolve to an accessible skill', async () => {
    const repo = makeRepo([]);
    const logger = makeLogger();
    const result = await getFirstIterationSkillsPreamble('/unknown-skill', 'user-1', repo, logger);

    expect(result).toBe('');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('/unknown-skill'));
  });

  it('expands multiple mentions in one message', async () => {
    const repo = makeRepo([makeSkill({ name: 'one', body: 'First.' }), makeSkill({ name: 'two', body: 'Second.' })]);
    const result = await getFirstIterationSkillsPreamble('/one then /two', 'user-1', repo, makeLogger());

    expect(result).toContain('First.');
    expect(result).toContain('Second.');
  });

  it('returns empty string and logs when resolution throws (best-effort)', async () => {
    const repo = makeRepo([], async () => {
      throw new Error('mongo down');
    });
    const logger = makeLogger();
    const result = await getFirstIterationSkillsPreamble('/share-demo', 'user-1', repo, logger);

    expect(result).toBe('');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve'),
      expect.objectContaining({ error: 'mongo down' })
    );
  });
});
