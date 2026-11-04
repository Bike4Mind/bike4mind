import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_ENV, WINDOWS_COMMAND_ARGS, commandEnv, launchCommand } from './commandLaunch';
import { COMMAND_TAG_ENV } from './commandTree';

vi.mock('./gitBash', async importOriginal => ({
  ...(await importOriginal<typeof import('./gitBash')>()),
  resolveGitBash: async () => 'C:\\Program Files\\Git\\bin\\bash.exe',
}));
vi.mock('./userPath', () => ({ resolveUserPath: async () => 'C:\\Tools' }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // The distro's user environment probe.
    spawn: (file: string, args: string[], options: object) => {
      if (!args.includes('b4m-env')) return actual.spawn(file, args, options);
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
      setTimeout(() => {
        child.stdout.end('__B4M_ENV__/home/me/.nvm/bin:/usr/bin__B4M_ENV__/home/me__B4M_ENV__');
        child.emit('close', 0);
      }, 0);
      return child;
    },
  };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const onWindows = () => Object.defineProperty(process, 'platform', { value: 'win32' });

describe('launchCommand on Windows', () => {
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
  });

  it('runs Git Bash with a fixed argv and the command in the environment', async () => {
    onWindows();
    const command = "printf '%s|' C:\\\\Users 'a\\\\b' *.json";
    const launch = await launchCommand(command, [], [], 'C:\\project');

    expect(launch.executable).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(launch.args).toEqual(['-c', 'export -n B4M_DESKTOP_COMMAND; eval "$B4M_DESKTOP_COMMAND"']);
    expect(launch.args).toEqual(WINDOWS_COMMAND_ARGS);
    expect(launch.args.join(' ')).not.toContain('Users');
    expect(launch.env).toEqual({ [COMMAND_ENV]: command });
  });

  // The same bash semantics Git Bash has, run here.
  it.runIf(process.platform !== 'win32')(
    'runs the command as written, keeps it from child processes, and quotes it alone in a syntax error',
    () => {
      const run = (command: string) =>
        spawnSync('bash', [...WINDOWS_COMMAND_ARGS], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, [COMMAND_ENV]: command },
        });
      expect(run("printf '%s|' 'a\\\\b' \"$((1 + 2))\"").stdout).toBe('a\\\\b|3|');
      expect(run('bash -c \'echo "child=${B4M_DESKTOP_COMMAND:-unset}"\'').stdout).toBe('child=unset\n');
      const failed = run('echo (');
      // bash 5 (Git Bash) exits 2 on an eval syntax error; macOS's /bin/bash 3.2 exits 1.
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain('`echo (');
      expect(failed.stderr).not.toContain('export');
      expect(failed.stderr).not.toContain(COMMAND_ENV);
    }
  );

  it('tags each command and passes the tag and the command to the child', async () => {
    onWindows();
    const first = await launchCommand('echo one', [], [], 'C:\\project');
    const second = await launchCommand('echo two', [], [], 'C:\\project');
    expect(first.processTag).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.processTag).not.toBe(first.processTag);

    const env = await commandEnv(first, { B4M_DESKTOP_BACKGROUND: '1', [COMMAND_ENV]: 'stale' });
    expect(env[COMMAND_TAG_ENV]).toBe(first.processTag);
    expect(env[COMMAND_ENV]).toBe('echo one');
    expect(env.B4M_DESKTOP_BACKGROUND).toBe('1');
    expect(env.PATH).toBe('C:\\Tools');
  });
});

describe('launchCommand in a WSL folder', () => {
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
  });

  it("runs the distro's bash in the folder and passes only the named variables into Linux", async () => {
    onWindows();
    const launch = await launchCommand('pnpm test', [], [], '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
    expect(launch.executable).toMatch(/^[A-Z]:\\.*\\System32\\wsl\.exe$/i);
    expect(launch.wslDistro).toBe('Ubuntu');
    expect(launch.args.slice(0, 2)).toEqual(['-d', 'Ubuntu']);
    expect(launch.args.slice(-4)).toEqual(['/home/me/repo', 'bash', '-c', 'pnpm test']);

    const env = await commandEnv(launch, { B4M_DESKTOP_BACKGROUND: '1' });
    expect(env.WSLENV?.split(':')).toEqual(
      expect.arrayContaining(['B4M_DESKTOP_BACKGROUND', COMMAND_TAG_ENV, 'B4M_DESKTOP_LINUX_PATH'])
    );
    expect(env.WSLENV?.split(':')).not.toContain('PATH');
    expect(env[COMMAND_TAG_ENV]).toBe(launch.processTag);
    expect(env.B4M_DESKTOP_LINUX_PATH).toBe('/home/me/.nvm/bin:/usr/bin');
    expect(env.WSL_UTF8).toBe('1');
  });
});

describe('launchCommand on POSIX', () => {
  it.skipIf(process.platform === 'win32')('passes the command to bash -c with no tag', async () => {
    const launch = await launchCommand('echo hi', [], [], '/tmp');
    expect(launch).toMatchObject({ executable: '/bin/bash', args: ['-c', 'echo hi'] });
    expect(launch.processTag).toBeUndefined();
    expect((await commandEnv(launch))[COMMAND_TAG_ENV]).toBeUndefined();
  });
});
