import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawned: { file: string; cwd: string }[] = [];
const program = vi.hoisted(() => ({ rg: 'C:\\tools\\rg.exe' as string | null }));

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (file: string, _args: string[], options: { cwd: string }) => {
    spawned.push({ file, cwd: options.cwd });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setTimeout(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 1);
    }, 0);
    return child;
  },
}));
vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: async () => 'C:\\tools',
  hostProgram: async () => program.rg,
}));

const { ripgrepSearch } = await import('./ripgrep');

const search = () =>
  ripgrepSearch({
    pattern: 'x',
    cwd: '/repo/tools',
    ignoreCase: false,
    context: 0,
    exclude: [],
    maxFileBytes: 1_000_000,
    signal: new AbortController().signal,
    onFile: () => true,
  });

describe('ripgrep on the host', () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it('runs rg from its resolved path in the search folder', async () => {
    expect(await search()).toBe('done');
    expect(spawned).toEqual([{ file: 'C:\\tools\\rg.exe', cwd: '/repo/tools' }]);
  });

  it('is unavailable, without spawning, when there is no rg to run', async () => {
    program.rg = null;
    expect(await search()).toBe('unavailable');
    expect(spawned).toEqual([]);
  });
});
