import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundProcessRegistry } from './BackgroundProcessRegistry';
import { launchCommand } from './commandLaunch';
import { bashExecute } from './shellTools';

vi.mock('./commandLaunch', async importOriginal => ({
  ...(await importOriginal<typeof import('./commandLaunch')>()),
  launchCommand: vi.fn(async () => {
    throw new Error('stopped before spawning');
  }),
}));

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
const FOLDER = `${ROOT}\\packages\\app`;
const OTHER_ROOT = 'C:\\other';

beforeEach(() => {
  vi.mocked(launchCommand).mockClear();
});

describe('where a command is launched', () => {
  it('hands bash_execute the folder it runs in, which decides whether it runs in a distro', async () => {
    const context = {
      roots: [OTHER_ROOT, ROOT],
      signal: new AbortController().signal,
      protectedPaths: [],
      workingDirectory: FOLDER,
    };

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
