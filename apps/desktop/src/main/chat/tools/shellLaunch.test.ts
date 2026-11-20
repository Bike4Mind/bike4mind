import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundProcessRegistry } from './BackgroundProcessRegistry';
import { launchCommand } from './commandLaunch';
import { bashExecute } from './shellTools';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('./commandLaunch', async importOriginal => ({
  ...(await importOriginal<typeof import('./commandLaunch')>()),
  launchCommand: vi.fn(async () => {
    throw new Error('stopped before spawning');
  }),
  commandEnv: async () => ({ ...process.env }),
}));

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
const FOLDER = `${ROOT}\\packages\\app`;
const OTHER_ROOT = 'C:\\other';

const echo = (wslDistro?: string) => ({
  executable: '/bin/echo',
  args: ['hi'],
  processTag: 'tag',
  cleanup: async () => undefined,
  ...(wslDistro ? { wslDistro } : {}),
});

const context = {
  roots: [OTHER_ROOT, ROOT],
  signal: new AbortController().signal,
  protectedPaths: [],
  workingDirectory: FOLDER,
};

beforeEach(() => {
  vi.mocked(launchCommand).mockClear();
  vi.mocked(spawn).mockClear();
});

describe('where a command is launched', () => {
  it('hands bash_execute the folder it runs in, which decides whether it runs in a distro', async () => {
    await expect(bashExecute.run({ command: 'ls' }, context)).rejects.toThrow('stopped before spawning');

    expect(launchCommand).toHaveBeenCalledWith('ls', [OTHER_ROOT, ROOT], [], FOLDER);
  });

  it('hands a background command the folder it runs in', async () => {
    const registry = new BackgroundProcessRegistry({ status: () => undefined, output: () => undefined });

    await expect(
      registry.start({
        sessionId: 's',
        command: 'pnpm dev',
        cwd: FOLDER,
        roots: [OTHER_ROOT, ROOT],
        protectedPaths: [],
      })
    ).rejects.toThrow('stopped before spawning');

    expect(vi.mocked(launchCommand).mock.calls[0]?.slice(1)).toEqual([[OTHER_ROOT, ROOT], [], FOLDER]);
  });
});

describe('how a command is spawned', () => {
  const options = () => vi.mocked(spawn).mock.calls.at(-1)?.[2] as { detached?: boolean };

  it('keeps a command in a distro attached to the app, since wsl.exe without a console loses its output', async () => {
    vi.mocked(launchCommand).mockResolvedValueOnce(echo('Ubuntu'));
    await bashExecute.run({ command: 'ls' }, { ...context, workingDirectory: process.cwd(), roots: [process.cwd()] });
    expect(options().detached).toBe(false);

    vi.mocked(launchCommand).mockResolvedValueOnce(echo('Ubuntu'));
    const registry = new BackgroundProcessRegistry({ status: () => undefined, output: () => undefined });
    await registry.start({ sessionId: 's', command: 'ls', cwd: process.cwd(), roots: [], protectedPaths: [] });
    expect(options().detached).toBe(false);
    await registry.shutdown();
  });

  it('gives any other command its own process group', async () => {
    vi.mocked(launchCommand).mockResolvedValueOnce(echo());
    await bashExecute.run({ command: 'ls' }, { ...context, workingDirectory: process.cwd(), roots: [process.cwd()] });
    expect(options().detached).toBe(true);

    vi.mocked(launchCommand).mockResolvedValueOnce(echo());
    const registry = new BackgroundProcessRegistry({ status: () => undefined, output: () => undefined });
    await registry.start({ sessionId: 's', command: 'ls', cwd: process.cwd(), roots: [], protectedPaths: [] });
    expect(options().detached).toBe(true);
    await registry.shutdown();
  });
});
