import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundProcessRegistry } from './BackgroundProcessRegistry';
import { launchCommand, spawnFailure } from './commandLaunch';
import { bashExecute } from './shellTools';

vi.mock('./userPath', () => ({ resolveUserPath: async () => process.env.PATH ?? '' }));
vi.mock('./commandLaunch', async importOriginal => {
  const actual = await importOriginal<typeof import('./commandLaunch')>();
  return { ...actual, launchCommand: vi.fn(actual.launchCommand) };
});

describe.skipIf(process.platform === 'win32')('a command launched in a working folder that is gone', () => {
  let base: string;
  let folder: string;
  let registry: BackgroundProcessRegistry;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-gone-')));
    folder = join(base, 'project');
    await mkdir(folder);
    registry = new BackgroundProcessRegistry({ status: () => undefined, output: () => undefined });
  });

  afterEach(async () => {
    await registry.shutdown();
    await rm(base, { recursive: true, force: true });
  });

  const foreground = (cwd: string): Promise<string> =>
    bashExecute
      .run(
        { command: 'echo ran' },
        { roots: [cwd], workingDirectory: cwd, signal: new AbortController().signal, protectedPaths: [] }
      )
      .then(String, (error: Error) => error.message);

  const background = async (cwd: string): Promise<string> => {
    const started = await registry
      .start({ sessionId: 's', command: 'echo ran', cwd, roots: [cwd], protectedPaths: [] })
      .catch((error: Error) => error);
    if (started instanceof Error) return `failed: ${started.message}`;
    await registry.settle(started.id, 5_000);
    const info = registry.get(started.id, 's');
    return `${info?.status}: ${info?.error ?? ''}`;
  };

  it('says the folder no longer exists, not that bash is missing', async () => {
    await rm(folder, { recursive: true });

    const ran = await foreground(folder);
    expect(ran).toContain(`The working folder ${folder} no longer exists`);
    expect(ran).not.toMatch(/ENOENT|spawn/);

    const started = await background(folder);
    expect(started).toContain(`failed: The working folder ${folder} no longer exists`);
    expect(started).not.toMatch(/ENOENT|spawn/);
  });

  it('says a file used as the working folder is not a directory', async () => {
    const file = join(base, 'notes.txt');
    await writeFile(file, 'x');

    const ran = await foreground(file);
    expect(ran).toContain(`The working folder ${file} is not a directory`);
    expect(ran).toContain('the command was not run');
    expect(ran).not.toMatch(/ENOTDIR|spawn/);

    const started = await background(file);
    expect(started).toContain(`failed: The working folder ${file} is not a directory`);
    expect(started).not.toMatch(/ENOTDIR|spawn/);
  });

  it('still blames the shell when the folder is there and the shell is not', async () => {
    const shell = join(base, 'no-such-shell');
    const missingShell = { executable: shell, args: [], cleanup: async () => undefined };

    vi.mocked(launchCommand).mockResolvedValueOnce(missingShell);
    expect(await foreground(folder)).toBe(`spawn ${shell} ENOENT`);

    vi.mocked(launchCommand).mockResolvedValueOnce(missingShell);
    expect(await background(folder)).toBe(`failed: spawn ${shell} ENOENT`);
  });
});

describe('spawnFailure on a WSL folder', () => {
  it.each(['ENOENT', 'ENOTDIR'])('hands a %s back unchanged without looking at the folder', code => {
    const error = Object.assign(new Error(`spawn ${code}`), { code });
    expect(spawnFailure(error, '/no/such/folder', { wslDistro: 'Ubuntu' })).toBe(error);
  });
});
