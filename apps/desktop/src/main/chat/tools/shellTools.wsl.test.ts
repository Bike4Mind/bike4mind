import { describe, expect, it, vi } from 'vitest';
import type { ShellScan } from './shellScan';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

const DEBIAN = '\\\\wsl.localhost\\Debian\\home\\me';

const scanned = vi.hoisted(() => ({ ungranted: [] as string[] }));

vi.mock('./shellScan', async importOriginal => ({
  ...(await importOriginal<typeof import('./shellScan')>()),
  scanShell: async (): Promise<ShellScan> => ({
    commands: [{ text: 'ls', always: 'ls *', coverable: true, words: 'ls' }],
    paths: [...scanned.ungranted],
    directories: [],
    ungranted: scanned.ungranted,
    envFiles: [],
    outbound: [],
    sends: [],
    contained: true,
    readOnly: false,
    writes: [],
    writtenTrees: [],
  }),
}));

const context: Pick<ToolContext, 'roots' | 'signal' | 'protectedPaths'> = {
  roots: [process.cwd()],
  signal: new AbortController().signal,
  protectedPaths: [],
};

describe('a shell command that reaches a WSL distro no root is in', () => {
  it('asks in every mode but full, names the path, and offers no folder to remember', async () => {
    scanned.ungranted = [DEBIAN];

    const prompt = await shellApproval('bash_execute', { command: `ls '${DEBIAN}'` }, context);

    expect(prompt.askInAuto).toBe(true);
    expect(prompt.detail).toContain(`Reaches ${DEBIAN}, in a WSL distro this project has no folder in.`);
    expect(prompt.always?.directories).toEqual([]);
  });

  it('leaves a command that reaches no such distro to the mode', async () => {
    scanned.ungranted = [];

    const prompt = await shellApproval('bash_execute', { command: 'ls' }, context);

    expect(prompt.askInAuto).toBeUndefined();
  });
});
