import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CustomCommand } from '@bike4mind/cli/skills';
import { expandSkill, parseSkillInvocation } from './expand';

function command(body: string): CustomCommand {
  return { name: 'demo', description: 'demo', body, source: 'project', filePath: '/tmp/demo/SKILL.md' };
}

describe('parseSkillInvocation', () => {
  it('reads a bare invocation', () => {
    expect(parseSkillInvocation('/review')).toEqual({ name: 'review', args: '' });
  });

  it('keeps the arguments verbatim', () => {
    expect(parseSkillInvocation('/review src/a.ts "be harsh"')).toEqual({
      name: 'review',
      args: 'src/a.ts "be harsh"',
    });
  });

  it('leaves a path alone', () => {
    // A user pasting an absolute path must not have it swallowed as a command name.
    expect(parseSkillInvocation('/etc/hosts is wrong')).toBeNull();
    expect(parseSkillInvocation('/usr/local/bin')).toBeNull();
  });

  it('leaves a slash mid-sentence alone', () => {
    expect(parseSkillInvocation('run the and/or check')).toBeNull();
  });

  it('is not fooled by a lone slash or a doubled one', () => {
    expect(parseSkillInvocation('/')).toBeNull();
    expect(parseSkillInvocation('//review')).toBeNull();
  });
});

describe('expandSkill', () => {
  let base: string;
  let granted: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-expand-')));
    granted = join(base, 'workspace');
    await mkdir(granted, { recursive: true });
  });

  it('substitutes positional and whole-argument patterns', async () => {
    const result = await expandSkill(command('Deploy $1 to $2 ($ARGUMENTS)'), 'app staging', [granted], granted);
    expect(result.body).toBe('Deploy app to staging (app staging)');
    expect(result.errors).toEqual([]);
  });

  it('keeps quoted arguments together', async () => {
    const result = await expandSkill(command('Say $1'), '"one two"', [granted], granted);
    expect(result.body).toBe('Say one two');
  });

  it('inlines an @file inside the granted roots', async () => {
    await writeFile(join(granted, 'notes.txt'), 'remember this', 'utf8');
    const result = await expandSkill(command('Read @notes.txt'), '', [granted], granted);
    expect(result.body).toContain('remember this');
    expect(result.errors).toEqual([]);
  });

  it('refuses an @file that escapes the granted roots', async () => {
    const outside = join(base, 'secret.txt');
    await writeFile(outside, 'do not read me', 'utf8');

    // A skill body is repo-authored, so this is the case that matters: the reference is
    // absolute and points at a real, readable file the session was never granted.
    const result = await expandSkill(command(`Read @${outside}`), '', [granted], granted);
    expect(result.body).not.toContain('do not read me');
    expect(result.errors).toHaveLength(1);
    expect(result.body).toContain('File reference errors');
  });

  it('refuses a traversal out of the working directory', async () => {
    await writeFile(join(base, 'secret.txt'), 'do not read me', 'utf8');
    const result = await expandSkill(command('Read @../secret.txt'), '', [granted], granted);
    expect(result.body).not.toContain('do not read me');
    expect(result.errors).toHaveLength(1);
  });

  it('reads nothing when the session has granted no roots at all', async () => {
    await writeFile(join(granted, 'notes.txt'), 'remember this', 'utf8');
    const result = await expandSkill(command('Read @notes.txt'), '', [], granted);
    expect(result.body).not.toContain('remember this');
    expect(result.errors).toHaveLength(1);
  });
});
