import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSubject } from './resolveSubject';
import { PermissionRuleSet, compileRule, parseRule } from './rules';

const eisdir = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) =>
      eisdir.on ? Promise.reject(Object.assign(new Error('dir'), { code: 'EISDIR' })) : actual.realpath(...args),
  };
});

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

  it('resolves a missing path over PATH_MAX made of short components', async () => {
    const deep = join(root, ...Array.from({ length: 60 }, () => 'd'.repeat(100)));
    expect((await resolveSubject({ tool: 'file_read', paths: [deep] })).paths).toEqual([deep]);
  });

  it('resolves a multi-line command argument longer than PATH_MAX as a missing path', async () => {
    const lines = Array.from(
      { length: 70 },
      (_, i) => `see apps/desktop/src/main/chat/tools/paths.ts line ${i} for details`
    );
    const message = join(root, `fix(desktop): x\n\n${lines.join('\n')}`);
    expect(Buffer.byteLength(message)).toBeGreaterThan(4096);
    expect((await resolveSubject({ tool: 'bash_execute', paths: [message] })).paths).toEqual([message]);
  });

  it('follows a dangling link past PATH_MAX reached through links that shrink the path', async () => {
    const loop = 'L'.repeat(250);
    await mkdir(join(root, 'prot'));
    await symlink('.', join(root, loop));
    await symlink(join('prot', 'new'), join(root, 'dang'));
    const long = join(root, ...Array.from({ length: 17 }, () => loop), 'dang');
    expect(Buffer.byteLength(long)).toBeGreaterThan(4096);
    expect((await resolveSubject({ tool: 'file_write', paths: [long] })).paths).toEqual([
      long,
      join(root, 'prot', 'new'),
    ]);
  });

  it('retries the JS realpath on win32 when the async realpath throws EISDIR', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    eisdir.on = true;
    try {
      expect((await resolveSubject({ tool: 'file_read', paths: [root] })).paths).toEqual([root]);
    } finally {
      eisdir.on = false;
      Object.defineProperty(process, 'platform', platform!);
    }
  });

  it('resolves a name holding a NUL as a missing file below its existing folder', async () => {
    const kept = join(root, 'x\0\u{f05c}', 'notes.txt');
    const command = 'cat notes.txt';
    const subject = await resolveSubject({
      tool: 'bash_execute',
      shell: { script: command, commands: [{ text: command, coverable: true }], directories: [], paths: [kept] },
    });
    expect(subject.shell?.paths).toEqual([kept]);
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
