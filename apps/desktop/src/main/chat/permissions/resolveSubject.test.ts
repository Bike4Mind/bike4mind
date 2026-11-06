import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_WALK_NAMES } from '../tools/paths';
import { resolveSubject } from './resolveSubject';
import { PermissionRuleSet, compileRule, parseRule } from './rules';

const eisdir = vi.hoisted(() => ({ on: false }));
// macOS realpath(3) and readlink(2) refuse any path of PATH_MAX (1024) bytes or more, whatever its
// components. `overflows` is a link whose text takes realpath past that limit, so it fails there too.
const pathMax = vi.hoisted(() => ({ bytes: Infinity, overflows: undefined as string | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const tooLong = (path: unknown, realpath: boolean): boolean =>
    Buffer.byteLength(String(path)) >= pathMax.bytes ||
    (realpath && pathMax.overflows !== undefined && String(path).startsWith(pathMax.overflows));
  const refusal = () => Promise.reject(Object.assign(new Error('long'), { code: 'ENAMETOOLONG' }));
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) =>
      eisdir.on
        ? Promise.reject(Object.assign(new Error('dir'), { code: 'EISDIR' }))
        : tooLong(args[0], true)
          ? refusal()
          : actual.realpath(...args),
    readlink: (...args: Parameters<typeof actual.readlink>) =>
      tooLong(args[0], false) ? refusal() : actual.readlink(...args),
  };
});

const PATH_MAX_CASES = [
  ['as this platform allows', Infinity],
  ['under the macOS PATH_MAX', 1024],
] as const;

describe('resolveSubject', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'permission-paths-')));
  });
  afterEach(async () => {
    pathMax.bytes = Infinity;
    pathMax.overflows = undefined;
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

  it.each(PATH_MAX_CASES)('resolves a missing path over PATH_MAX made of short components, %s', async (_, bytes) => {
    const deep = join(root, ...Array.from({ length: 60 }, () => 'd'.repeat(100)));
    pathMax.bytes = bytes;
    expect((await resolveSubject({ tool: 'file_read', paths: [deep] })).paths).toEqual([deep]);
  });

  it.each(PATH_MAX_CASES)(
    'resolves a multi-line command argument longer than PATH_MAX as a missing path, %s',
    async (_, bytes) => {
      const lines = Array.from(
        { length: 70 },
        (_, i) => `see apps/desktop/src/main/chat/tools/paths.ts line ${i} for details`
      );
      const message = join(root, `fix(desktop): x\n\n${lines.join('\n')}`);
      expect(Buffer.byteLength(message)).toBeGreaterThan(4096);
      pathMax.bytes = bytes;
      expect((await resolveSubject({ tool: 'bash_execute', paths: [message] })).paths).toEqual([message]);
    }
  );

  it.each(PATH_MAX_CASES)(
    'follows a dangling link past PATH_MAX reached through links that shrink the path, %s',
    async (_, bytes) => {
      const loop = 'L'.repeat(250);
      await mkdir(join(root, 'prot'));
      await symlink('.', join(root, loop));
      await symlink(join('prot', 'new'), join(root, 'dang'));
      const long = join(root, ...Array.from({ length: 17 }, () => loop), 'dang');
      expect(Buffer.byteLength(long)).toBeGreaterThan(4096);
      pathMax.bytes = bytes;
      expect((await resolveSubject({ tool: 'file_write', paths: [long] })).paths).toEqual([
        long,
        join(root, 'prot', 'new'),
        join(root, 'dang'),
      ]);
    }
  );

  it('refuses a name past PATH_MAX under a folder that exists, which could be a link', async () => {
    await mkdir(join(root, 'dir'));
    pathMax.bytes = Buffer.byteLength(join(root, 'dir')) + 50;
    const past = join(root, 'dir', 'n'.repeat(100), 'x');
    await expect(resolveSubject({ tool: 'file_write', paths: [past] })).rejects.toMatchObject({
      code: 'ENAMETOOLONG',
    });
    const underMissing = join(root, 'gone', 'n'.repeat(100), 'x');
    expect((await resolveSubject({ tool: 'file_write', paths: [underMissing] })).paths).toEqual([underMissing]);
  });

  // node:path stays win32 on a Windows runner, so faking darwin there would mix the two.
  it.skipIf(process.platform === 'win32')(
    'refuses a long UTF-8 name past the macOS PATH_MAX, which APFS could hold as a link',
    async () => {
      const dir = join(root, 'd'.repeat(250));
      await mkdir(dir);
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        pathMax.bytes = 1024;
        const name = '中'.repeat(255);
        expect(Buffer.byteLength(join(dir, name))).toBeGreaterThanOrEqual(1024);
        await expect(resolveSubject({ tool: 'file_write', paths: [join(dir, name, 'x')] })).rejects.toMatchObject({
          code: 'ENAMETOOLONG',
        });
        const short = join(root, '中'.repeat(100), 'x');
        expect((await resolveSubject({ tool: 'file_write', paths: [short] })).paths).toEqual([short]);
      } finally {
        Object.defineProperty(process, 'platform', platform!);
      }
    }
  );

  it('refuses a path of more names than MAX_WALK_NAMES', async () => {
    const most = join(root, ...Array.from({ length: MAX_WALK_NAMES }, () => 'a'));
    expect((await resolveSubject({ tool: 'file_read', paths: [most] })).paths).toEqual([most]);
    await expect(resolveSubject({ tool: 'file_read', paths: [join(most, 'a')] })).rejects.toMatchObject({
      code: 'ENAMETOOLONG',
    });
  });

  // Windows applies `..` to the name before it, so it never reaches the missing folder.
  it.skipIf(process.platform === 'win32')('refuses `..` under a missing folder', async () => {
    await mkdir(join(root, 'prot'));
    await symlink(join(root, 'prot'), join(root, 'link'));
    const path = [root, 'missing', '..', 'link', 'x'].join(sep);
    await expect(resolveSubject({ tool: 'file_write', paths: [path] })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a link that leads back to itself through a path realpath cannot read', async () => {
    // macOS caps a link's target text at its 1024-byte PATH_MAX: keep the target under it, past the mocked limit.
    const loop = 'L'.repeat(100);
    await symlink('.', join(root, loop));
    const link = join(root, 'x');
    await symlink(join(root, ...Array.from({ length: 5 }, () => loop), 'x'), link);
    pathMax.bytes = 512;
    pathMax.overflows = link;
    await expect(resolveSubject({ tool: 'file_write', paths: [join(link, 'new')] })).rejects.toMatchObject({
      code: 'ELOOP',
    });
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

  it('denies an unlink of a link spelled through an alias of its folder', async () => {
    await mkdir(join(root, 'home', 'prot'), { recursive: true });
    await symlink(join(root, 'home'), join(root, 'alias'));
    const lnk = join(root, 'home', 'prot', 'lnk');
    await symlink(join(root, 'out', 'x'), lnk);
    const parsed = parseRule(`Edit(/${lnk})`);
    if (!parsed.ok) throw new Error(parsed.reason);
    const compiled = compileRule(parsed.rule, 'deny', { id: 'test', label: 'Test' }, { home: root, root, cwd: root });
    if (!compiled) throw new Error('Could not compile Edit rule');
    const subject = await resolveSubject({ tool: 'file_edit', paths: [join(root, 'alias', 'prot', 'lnk')] });
    expect(subject.paths).toContain(lnk);
    expect(new PermissionRuleSet([compiled], []).evaluate(subject).decision).toBe('deny');
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
