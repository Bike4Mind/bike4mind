import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
let exitCode: number | null = 127;
let streamed = '';
let closeSignal: string | null = null;

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
      if (!probe) child.stdout.write(streamed);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', probe ? 0 : exitCode, closeSignal);
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
    streamed = '';
    closeSignal = null;
  });

  it('runs the distro rg with the pattern as given, and treats a missing rg as unavailable for a while', async () => {
    const pattern = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
    expect(await search('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', pattern)).toBe('unavailable');

    expect(spawned).toHaveLength(1);
    const [run] = spawned;
    expect(run?.file).toMatch(/^[A-Z]:\\.*\\System32\\wsl\.exe$/i);
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
    expect(spawned.map(run => run.file)).toEqual([expect.stringMatching(/^[A-Z]:\\.*\\System32\\wsl\.exe$/i), 'rg']);
  });

  it.each([125, 4294967295, -1])(
    'does not report a clean miss when the WSL wrapper exits %d before rg ran',
    async code => {
      exitCode = code;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(await search(`\\\\wsl.localhost\\Alpine${code}\\srv`, 'x')).toBe('unsupported');
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    }
  );

  const streamOneFile = () => {
    const record = (type: string, data: object) => `${JSON.stringify({ type, data })}\n`;
    streamed =
      record('begin', { path: { text: './a.ts' } }) +
      record('match', { line_number: 1, lines: { text: 'x\n' } }) +
      record('end', {});
  };
  const searchFiles = async (cwd: string, platform: NodeJS.Platform) => {
    const files: string[] = [];
    const outcome = await ripgrepSearch({
      pattern: 'x',
      cwd,
      ignoreCase: false,
      context: 0,
      exclude: [],
      maxFileBytes: 1_000_000,
      signal: new AbortController().signal,
      onFile: file => (files.push(file.path), true),
      platform,
    });
    return { outcome, files };
  };

  it.each([9, 4294967295])(
    'keeps what rg already streamed when it is killed mid-search (wsl.exe exits %d)',
    async code => {
      streamOneFile();
      exitCode = code;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const { outcome, files } = await searchFiles(`\\\\wsl.localhost\\Gentoo${code}\\srv`, 'win32');

      expect(outcome).toBe('cut-short');
      expect(files).toEqual(['a.ts']);
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    }
  );

  it('keeps what rg already streamed when a signal other than ours kills it on the host', async () => {
    streamOneFile();
    closeSignal = 'SIGKILL';
    exitCode = null;

    const { outcome, files } = await searchFiles('/repo', 'linux');

    expect(outcome).toBe('cut-short');
    expect(files).toEqual(['a.ts']);
  });

  it('lets the JS scan run when a signal other than ours kills the host rg before it reported a file', async () => {
    closeSignal = 'SIGKILL';
    exitCode = null;

    const { outcome, files } = await searchFiles('/repo', 'linux');

    expect(outcome).toBe('unsupported');
    expect(files).toEqual([]);
  });

  it('still reports a clean miss when the distro rg finds nothing', async () => {
    exitCode = 1;
    expect(await search('\\\\wsl.localhost\\Arch\\srv', 'x')).toBe('done');
  });

  it('remembers a missing rg for a distro whatever case its name is written in', async () => {
    expect(await search('\\\\wsl.localhost\\Fedora\\home\\me', 'x')).toBe('unavailable');
    expect(await search('\\\\wsl$\\FEDORA\\home\\me', 'x')).toBe('unavailable');

    expect(spawned).toHaveLength(1);
  });
});
