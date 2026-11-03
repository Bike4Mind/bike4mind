import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
let exitCode = 127;

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    // The user environment probe: a distro that answers with its login PATH.
    const probe = args.includes('b4m-env');
    if (!probe) spawned.push({ file, args, env: options.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setTimeout(() => {
      if (probe) child.stdout.write('__B4M_ENV__/home/me/.cargo/bin:/usr/bin__B4M_ENV__/home/me__B4M_ENV__');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', probe ? 0 : exitCode);
    }, 0);
    return child;
  },
}));

const { ripgrepSearch } = await import('./ripgrep');

const search = (cwd: string, pattern: string) =>
  ripgrepSearch({
    pattern,
    cwd,
    ignoreCase: false,
    context: 0,
    exclude: [],
    maxFileBytes: 1_000_000,
    signal: new AbortController().signal,
    onFile: () => true,
    platform: 'win32',
  });

describe('ripgrep in a WSL folder', () => {
  beforeEach(() => {
    spawned.length = 0;
    exitCode = 127;
  });

  it('runs the distro rg with the pattern as given, and treats a missing rg as unavailable for a while', async () => {
    const pattern = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
    expect(await search('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', pattern)).toBe('unavailable');

    expect(spawned).toHaveLength(1);
    const [run] = spawned;
    expect(run?.file).toBe('wsl.exe');
    expect(run?.args.slice(0, 2)).toEqual(['-d', 'Ubuntu']);
    expect(run?.args[(run?.args.indexOf('--regexp') ?? 0) + 1]).toBe(pattern);
    expect(run?.args.slice(-2)).toEqual(['--', '.']);
    expect(run?.env.WSL_UTF8).toBe('1');
    expect(run?.env.B4M_DESKTOP_LINUX_PATH).toBe('/home/me/.cargo/bin:/usr/bin');
    expect(run?.env.WSLENV?.split(':')).toContain('B4M_DESKTOP_LINUX_PATH');

    expect(await search('\\\\wsl.localhost\\Ubuntu\\home\\me\\other', 'x')).toBe('unavailable');
    expect(spawned).toHaveLength(1);
  });

  it('keeps each distro, and the host rg, separate', async () => {
    expect(await search('\\\\wsl.localhost\\Debian\\srv', 'x')).toBe('unavailable');
    exitCode = 1;
    expect(await search('C:\\repo', 'x')).toBe('done');
    expect(spawned.map(run => run.file)).toEqual(['wsl.exe', 'rg']);
  });
});
