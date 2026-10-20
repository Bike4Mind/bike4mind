import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSubject } from './resolveSubject';

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

  it('resolves symlinked parents for a file that will be created', async () => {
    await mkdir(join(root, 'protected'));
    await symlink(join(root, 'protected'), join(root, 'alias'));
    expect((await resolveSubject({ tool: 'file_write', paths: [join(root, 'alias', 'new.txt')] })).paths).toEqual([
      join(root, 'alias', 'new.txt'),
      join(root, 'protected', 'new.txt'),
    ]);
  });

  it('does not change shell subjects or duplicate physical paths', async () => {
    const subject = { tool: 'web_search' };
    expect(await resolveSubject(subject)).toBe(subject);
    expect((await resolveSubject({ tool: 'glob_files', paths: [root] })).paths).toEqual([root]);
  });
});
