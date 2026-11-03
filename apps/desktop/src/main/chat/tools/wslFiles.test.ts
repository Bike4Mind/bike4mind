import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
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

  it('is not used for a folder outside a distro', async () => {
    expect(await listDistroFiles('C:\\repo', IGNORED, 10, new AbortController().signal)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});
