import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ code: null as string | null }));

// A folder read can fail with the given code, as a full file table or a failing disk would make it.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = (async (...args: Parameters<typeof actual.readdir>) => {
    if (failure.code !== null) throw Object.assign(new Error(failure.code), { code: failure.code });
    return actual.readdir(...args);
  }) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});

const { globNamesPlain } = await import('./shellScan');

describe('globNamesPlain', () => {
  let base: string;
  const never = (): boolean => false;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-glob-walk-')));
    await mkdir(join(base, 'src'));
    await writeFile(join(base, 'src', 'a.ts'), '');
  });

  afterAll(async () => {
    failure.code = null;
    await rm(base, { recursive: true, force: true });
  });

  it.each([
    [null, true],
    ['ENOENT', true],
    ['ENOTDIR', true],
    ['EACCES', false],
    ['EMFILE', false],
    ['ENAMETOOLONG', false],
    ['EIO', false],
  ])('reads a folder read failing with %s as plain: %s', async (code, plain) => {
    failure.code = code;
    try {
      expect(await globNamesPlain(base, 'src/*', never)).toBe(plain);
    } finally {
      failure.code = null;
    }
  });

  it.each([
    ['a name that is not UTF-8', Buffer.from([0x61, 0xff])],
    ['a name read as magic', Buffer.from(':!x')],
    ['a name read as a glob', Buffer.from('[.]x')],
  ])('is not plain with %s', async (_, name) => {
    const folder = join(base, 'odd');
    await mkdir(folder);
    try {
      await writeFile(Buffer.concat([Buffer.from(`${folder}/`), name]), '');
      expect(await globNamesPlain(folder, '*', never)).toBe(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('stops when the scan is stopped', async () => {
    expect(await globNamesPlain(base, 'src/*', () => true)).toBe(false);
  });
});
