import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSubject } from './resolveSubject';
import { PermissionRuleSet, compileRule, parseRule } from './rules';

describe('resolveSubject', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'permission-paths-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('preserves requested paths and checks symlink targets', async () => {
    const target = join(root, 'secret.txt');
    const alias = join(root, 'alias.txt');
    await writeFile(target, 'secret');
    await symlink(target, alias);
    expect((await resolveSubject({ tool: 'file_read', paths: [alias] })).paths).toEqual([alias, target]);
  });

  it('resolves a name too long to exist lexically instead of failing', async () => {
    const message = join(root, `fix: ${'a long commit message line '.repeat(20)}\n\nwith a body`);
    expect((await resolveSubject({ tool: 'bash_execute', paths: [message] })).paths).toEqual([message]);
  });

  it('resolves symlinked parents for a file that will be created', async () => {
    await mkdir(join(root, 'protected'));
    await symlink(join(root, 'protected'), join(root, 'alias'));
    expect((await resolveSubject({ tool: 'file_write', paths: [join(root, 'alias', 'new.txt')] })).paths).toEqual([
      join(root, 'alias', 'new.txt'),
      join(root, 'protected', 'new.txt'),
    ]);
  });

  it('resolves dangling links before allowing creation of their targets', async () => {
    const protectedRoot = join(root, 'protected');
    const target = join(protectedRoot, 'permission-rules.json');
    const alias = join(root, 'alias.txt');
    await mkdir(protectedRoot);
    await symlink('protected/permission-rules.json', alias);
    const subject = await resolveSubject({ tool: 'file_write', paths: [alias] });
    expect(subject.paths).toEqual([alias, target]);

    const parsed = parseRule('Write');
    if (!parsed.ok) throw new Error(parsed.reason);
    const compiled = compileRule(parsed.rule, 'allow', { id: 'test', label: 'Test' }, { home: root, root, cwd: root });
    if (!compiled) throw new Error('Could not compile Write rule');
    expect(new PermissionRuleSet([compiled], [protectedRoot]).evaluate(subject).decision).toBeNull();
  });

  it('resolves chains of dangling links and missing descendants of their targets', async () => {
    const target = join(root, 'protected', 'missing');
    await mkdir(join(root, 'protected'));
    await symlink('protected/missing', join(root, 'first'));
    await symlink('first', join(root, 'second'));
    const path = join(root, 'second', 'new.txt');
    expect((await resolveSubject({ tool: 'file_write', paths: [path] })).paths).toEqual([
      path,
      join(target, 'new.txt'),
    ]);
  });

  it('resolves shell operands through dangling links before protected-path checks', async () => {
    const protectedRoot = join(root, 'protected');
    const target = join(protectedRoot, 'permission-rules.json');
    const alias = join(root, 'alias.txt');
    await mkdir(protectedRoot);
    await symlink(target, alias);
    const command = `touch ${alias}`;
    const subject = await resolveSubject({
      tool: 'bash_execute',
      shell: { script: command, commands: [{ text: command, coverable: true }], directories: [], paths: [alias] },
    });
    expect(subject.shell?.paths).toEqual([alias, target]);
    const parsed = parseRule('Bash(touch:*)');
    if (!parsed.ok) throw new Error(parsed.reason);
    const compiled = compileRule(parsed.rule, 'allow', { id: 'test', label: 'Test' }, { home: root, root, cwd: root });
    if (!compiled) throw new Error('Could not compile Bash rule');
    expect(new PermissionRuleSet([compiled], [protectedRoot]).evaluate(subject).decision).toBeNull();
  });

  it('preserves kernel parent traversal in the target of a dangling link', async () => {
    await mkdir(join(root, 'origin'));
    await mkdir(join(root, 'elsewhere', 'nested'), { recursive: true });
    await symlink(join(root, 'elsewhere', 'nested'), join(root, 'origin', 'link'));
    const alias = join(root, 'alias');
    await symlink('origin/link/../missing.txt', alias);
    expect((await resolveSubject({ tool: 'file_write', paths: [alias] })).paths).toEqual([
      alias,
      join(root, 'elsewhere', 'missing.txt'),
    ]);
  });

  it('does not change shell subjects or duplicate physical paths', async () => {
    const subject = { tool: 'web_search' };
    expect(await resolveSubject(subject)).toBe(subject);
    expect((await resolveSubject({ tool: 'glob_files', paths: [root] })).paths).toEqual([root]);
  });
});
