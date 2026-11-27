import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
}));
const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
vi.mock('../../wsl/wslPath', async importOriginal => {
  const actual = await importOriginal<typeof import('../../wsl/wslPath')>();
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslCommandEnv: async () => ({}),
  };
});

import { listDistroFiles } from './wslFiles';

const FOLDER = '\\\\wsl$\\Ubuntu\\home\\me\\projects';
const IGNORED = new Set(['node_modules', '.git']);

function child(output: string, code: number | null = 0) {
  const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
  setImmediate(() => {
    fake.stdout.write(output);
    fake.stdout.end();
    setImmediate(() => fake.emit('close', code));
  });
  return fake;
}

const record = (size: number, seconds: number, path: string) => `${size} ${seconds} ./${path}\0`;

describe('listing the files of a WSL folder', () => {
  beforeEach(() => spawn.mockReset());

  it('asks the distro for them, below the folder, without the folders a search skips', async () => {
    spawn.mockReturnValueOnce(child(record(12, 1700000000.5, 'a/b c.ts') + record(3, 1700000001, 'top.md')));

    const listing = await listDistroFiles(FOLDER, IGNORED, 100, new AbortController().signal);

    expect(listing).toEqual({
      complete: true,
      files: [
        { path: 'a/b c.ts', size: 12, modified: 1700000000500 },
        { path: 'top.md', size: 3, modified: 1700000001000 },
      ],
    });
    const [file, args] = spawn.mock.calls[0] as [string, string[]];
    expect(file).toMatch(/wsl\.exe$/i);
    expect(args.slice(0, 8)).toEqual([
      '-d',
      'Ubuntu',
      '--exec',
      '/bin/sh',
      '-c',
      expect.any(String),
      'b4m-wsl',
      '/home/me/projects',
    ]);
    const find = args.slice(8);
    expect(find[0]).toBe('find');
    expect(find).toEqual(expect.arrayContaining(['-prune', '-printf', '-type', 'f']));
    for (const name of ['node_modules', '.git', '.?*']) expect(find).toContain(name);
  });

  it('stops at the limit and says the list is not whole', async () => {
    const fake = child(record(1, 1, 'a') + record(1, 1, 'b') + record(1, 1, 'c'), null);
    spawn.mockReturnValueOnce(fake);

    const listing = await listDistroFiles(FOLDER, IGNORED, 2, new AbortController().signal);

    expect(listing?.complete).toBe(false);
    expect(listing?.files.map(file => file.path)).toEqual(['a', 'b']);
    expect(fake.kill).toHaveBeenCalled();
  });

  it('keeps what find listed when it could not read one folder', async () => {
    spawn.mockReturnValueOnce(child(record(1, 1, 'a'), 1));
    expect((await listDistroFiles(FOLDER, IGNORED, 10, new AbortController().signal))?.files).toHaveLength(1);
  });

  it.each([
    ['a distro without find', 127],
    ['a folder that is gone', 125],
    ['find failing before it listed anything', 1],
  ])('hands back to the caller for %s', async (_name, code) => {
    spawn.mockReturnValueOnce(child('', code));
    expect(await listDistroFiles(FOLDER, IGNORED, 10, new AbortController().signal)).toBeNull();
  });

  // What wsl.exe hands to Linux, run here directly against a real folder.
  it.runIf(process.platform === 'linux')('lists what the walk it stands in for lists, and no hidden file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'b4m-distro-find-'));
    try {
      for (const file of ['top.md', 'a/b.ts', 'a/.npmrc', '.env', '.netrc', 'b/node_modules', 'x/.config.json']) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), 'x');
      }
      for (const folder of ['.git/objects', '.hidden', 'node_modules/pkg', 'a/node_modules']) {
        mkdirSync(join(root, folder), { recursive: true });
        writeFileSync(join(root, folder, 'inside.ts'), 'x');
      }
      symlinkSync(join(root, 'top.md'), join(root, 'link.md'));
      spawn.mockImplementationOnce((_file: string, args: string[]) => {
        const [, , , shell, ...rest] = args;
        return child(spawnSync(shell as string, rest, { encoding: 'utf8' }).stdout);
      });

      const folder = `\\\\wsl$\\Ubuntu${root.replaceAll('/', '\\')}`;
      const listing = await listDistroFiles(folder, IGNORED, 100, new AbortController().signal);

      expect(listing?.files.map(file => file.path).sort()).toEqual(['a/b.ts', 'b/node_modules', 'top.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is not used for a folder outside a distro', async () => {
    expect(await listDistroFiles('C:\\repo', IGNORED, 10, new AbortController().signal)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});
