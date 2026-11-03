import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseWslPath,
  toLinuxArgument,
  toWindowsPath,
  withWslEnv,
  wslCommand,
  wslLocation,
  wslUncPath,
} from './wslPath';

describe('parseWslPath', () => {
  it('reads both share names, either slash, and keeps the share as written', () => {
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')).toEqual({
      host: 'wsl.localhost',
      distro: 'Ubuntu',
      linuxPath: '/home/me/repo',
    });
    expect(parseWslPath('\\\\wsl$\\Debian-12\\srv\\app\\')).toEqual({
      host: 'wsl$',
      distro: 'Debian-12',
      linuxPath: '/srv/app',
    });
    expect(parseWslPath('//WSL.LOCALHOST/Ubuntu/tmp')?.linuxPath).toBe('/tmp');
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu')?.linuxPath).toBe('/');
  });

  it('leaves other paths alone', () => {
    expect(parseWslPath('C:\\Users\\me\\repo')).toBeNull();
    expect(parseWslPath('\\\\fileserver\\share\\repo')).toBeNull();
    expect(parseWslPath('/home/me/repo')).toBeNull();
    expect(parseWslPath('\\\\wsl.localhost')).toBeNull();
  });

  it('only treats them as WSL on Windows', () => {
    expect(wslLocation('\\\\wsl.localhost\\Ubuntu\\home', 'win32')?.distro).toBe('Ubuntu');
    expect(wslLocation('\\\\wsl.localhost\\Ubuntu\\home', 'linux')).toBeNull();
  });
});

describe('mapping between Linux and Windows paths', () => {
  const location = { host: 'wsl$', distro: 'Ubuntu', linuxPath: '/home/me/repo' } as const;

  it('maps a Linux path back onto the share the folder was opened from', () => {
    expect(toWindowsPath(location, '/home/me/repo/.git')).toBe('\\\\wsl$\\Ubuntu\\home\\me\\repo\\.git');
    expect(toWindowsPath(location, 'relative/path')).toBe('relative/path');
    expect(wslUncPath(location, '/')).toBe('\\\\wsl$\\Ubuntu\\');
  });

  it('maps a folder argument in the same distro, and nothing else', () => {
    expect(toLinuxArgument(location, '\\\\wsl.localhost\\ubuntu\\home\\me\\repo\\.b4m\\worktrees\\x')).toBe(
      '/home/me/repo/.b4m/worktrees/x'
    );
    expect(toLinuxArgument(location, '\\\\wsl.localhost\\Debian\\home')).toBe('\\\\wsl.localhost\\Debian\\home');
    expect(toLinuxArgument(location, '--porcelain')).toBe('--porcelain');
  });
});

describe('wslCommand', () => {
  // What wsl.exe hands to Linux, run here directly: everything after `--exec`.
  it.runIf(process.platform !== 'win32')('enters the folder or fails, and never runs elsewhere', () => {
    const inLinux = (linuxPath: string, env: NodeJS.ProcessEnv = {}) => {
      const [, , , shell, ...rest] = wslCommand({ host: 'wsl.localhost', distro: 'Ubuntu', linuxPath }, 'sh', [
        '-c',
        'pwd; echo "$PATH"',
      ]).args;
      return spawnSync(shell as string, rest, { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    };
    expect(inLinux('/').stdout.split('\n')[0]).toBe('/');
    const missing = inLinux('/no/such/folder/b4m');
    expect(missing.status).toBe(125);
    expect(missing.stdout).toBe('');
    expect(inLinux('/', { B4M_DESKTOP_LINUX_PATH: '/usr/bin:/bin' }).stdout.split('\n')[1]).toBe('/usr/bin:/bin');
  });

  it('runs the program through --exec in the folder, with folder arguments mapped', () => {
    const location = parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
    if (!location) throw new Error('unparsed');
    const command = wslCommand(location, 'git', ['worktree', 'add', '\\\\wsl.localhost\\Ubuntu\\home\\me\\wt', 'main']);
    expect(command.file).toBe('wsl.exe');
    expect(command.args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh']);
    expect(command.args.slice(-7)).toEqual([
      'b4m-wsl',
      '/home/me/repo',
      'git',
      'worktree',
      'add',
      '/home/me/wt',
      'main',
    ]);
  });
});

describe('withWslEnv', () => {
  it('appends names once, keeping what WSLENV already lists', () => {
    expect(withWslEnv({ WSLENV: 'USERPROFILE/p' }, ['A', 'B']).WSLENV).toBe('USERPROFILE/p:A:B');
    expect(withWslEnv({ WSLENV: 'A/u' }, ['A']).WSLENV).toBe('A/u');
    expect(withWslEnv({}, ['A']).WSLENV).toBe('A');
  });
});
