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

const { globNames } = await import('./shellScan');

/** `e` and a combining acute accent, which NFC composes into one character. */
const NFD = `e${String.fromCharCode(0x301)}`;

describe('globNames', () => {
  let base: string;
  const never = (): boolean => false;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-glob-walk-')));
    await mkdir(join(base, 'src'));
    await writeFile(join(base, 'src', 'a.ts'), '');
    await mkdir(join(base, 'app', '[[...slug]]'), { recursive: true });
    await writeFile(join(base, 'app', '[[...slug]]', 'page.tsx'), '');
  });

  afterAll(async () => {
    failure.code = null;
    await rm(base, { recursive: true, force: true });
  });

  it.each([
    [null, ['src/a.ts']],
    ['ENOENT', []],
    ['ENOTDIR', []],
    ['EACCES', null],
    ['EMFILE', null],
    ['ENAMETOOLONG', null],
    ['EIO', null],
  ])('reads a folder read failing with %s as %j', async (code, names) => {
    failure.code = code;
    try {
      expect(await globNames(base, 'src/*', never)).toEqual(names);
    } finally {
      failure.code = null;
    }
  });

  it('gives each name as bash passes it', async () => {
    expect(await globNames(base, 'app/*/page.tsx', never)).toEqual(['app/[[...slug]]/page.tsx']);
  });

  // APFS refuses a name that is not UTF-8 (EILSEQ), so macOS cannot plant one.
  it.skipIf(process.platform === 'darwin')('gives up on a name that is not UTF-8', async () => {
    const folder = join(base, 'odd');
    await mkdir(folder);
    try {
      await writeFile(Buffer.concat([Buffer.from(`${folder}/a`), Buffer.from([0xff])]), '');
      expect(await globNames(folder, '*', never)).toBeNull();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.each([
    ['darwin', null],
    ['linux', [NFD]],
  ])('on %s reads a name that is not NFC as %j', async (platform, names) => {
    const folder = join(base, 'nfd');
    await mkdir(folder);
    const real = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    try {
      await writeFile(join(folder, NFD), '');
      Object.defineProperty(process, 'platform', { value: platform });
      expect(await globNames(folder, '*', never)).toEqual(names);
    } finally {
      Object.defineProperty(process, 'platform', real);
      await rm(folder, { recursive: true, force: true });
    }
  });

  describe('matching', () => {
    let folder: string;
    let long: string;

    beforeAll(async () => {
      folder = join(base, 'm');
      long = join(base, 'long');
      await mkdir(folder);
      await mkdir(long);
      for (const name of ['a', 'ab', 'a\nb.ts', 'README.md', '.x']) await writeFile(join(folder, name), '');
      for (const name of ['a'.repeat(56), 'component-library-settings-panel-test.md']) {
        await writeFile(join(long, name), '');
      }
    });

    it.each([
      ['a*a', []],
      ['*ab*b', []],
      ['a**b', ['ab']],
      ['*b', ['ab']],
      ['a*', ['a', 'a\nb.ts', 'ab']],
      ['*.ts', ['a\nb.ts']],
      ['read*', ['README.md']],
      ['.*', ['.x']],
    ])('matches %j to %j', async (pattern, names) => {
      expect((await globNames(folder, pattern, never))?.sort()).toEqual(names);
    });

    it.each([['********.ts'], ['*a*a*a*a*a*a*a*a*b']])(
      'matches %s in linear time',
      async pattern => {
        const started = performance.now();
        expect(await globNames(long, pattern, never)).toEqual([]);
        expect(performance.now() - started).toBeLessThan(2000);
      },
      2000
    );
  });

  it('stops when the scan is stopped', async () => {
    expect(await globNames(base, 'src/*', () => true)).toBeNull();
  });
});
