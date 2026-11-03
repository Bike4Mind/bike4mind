import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  REALPATH_SCRIPT,
  USER_ENV_PRINT,
  USER_ENV_SCRIPT,
  parseUserEnvironment,
  parseWslPath,
  toLinuxArgument,
  toWindowsPath,
  withWslEnv,
  wslCommand,
  wslLocation,
  wslUncPath,
  wslUserEnvironment,
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

  it('reads the long and device spellings of the share', () => {
    expect(parseWslPath('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me')).toEqual({
      host: 'wsl.localhost',
      distro: 'Ubuntu',
      linuxPath: '/home/me',
    });
    expect(parseWslPath('\\\\.\\UNC\\wsl$\\Ubuntu\\srv')).toEqual({
      host: 'wsl$',
      distro: 'Ubuntu',
      linuxPath: '/srv',
    });
    expect(parseWslPath('\\\\?\\C:\\Users')).toBeNull();
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

  it('runs the program through --exec in the folder, passing every argument through as given', () => {
    const location = parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
    if (!location) throw new Error('unparsed');
    const pattern = '\\\\wsl.localhost\\Ubuntu\\home\\me\\wt';
    const command = wslCommand(location, 'rg', ['--regexp', pattern, '--', '.']);
    expect(command.file).toBe('wsl.exe');
    expect(command.args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh']);
    expect(command.args.slice(-7)).toEqual(['b4m-wsl', '/home/me/repo', 'rg', '--regexp', pattern, '--', '.']);
  });
});

describe('the user environment probe', () => {
  it('reads PATH and home past whatever the startup files printed', () => {
    expect(
      parseUserEnvironment('Welcome!\n__B4M_ENV__/home/me/.nvm/bin:/usr/bin__B4M_ENV__/home/me__B4M_ENV__bye')
    ).toEqual({ path: '/home/me/.nvm/bin:/usr/bin', home: '/home/me' });
    expect(parseUserEnvironment('no markers')).toBeNull();
    expect(parseUserEnvironment('__B4M_ENV__/usr/bin__B4M_ENV____B4M_ENV__')).toBeNull();
  });

  // What wsl.exe hands to Linux, run here directly.
  it.runIf(process.platform === 'linux')('asks the login shell from the passwd entry', () => {
    const run = spawnSync('/bin/sh', ['-c', USER_ENV_SCRIPT, 'b4m-env', USER_ENV_PRINT], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TERM: 'dumb' },
      timeout: 20_000,
    });
    const found = parseUserEnvironment(run.stdout);
    expect(found?.home).toMatch(/^\//);
    expect(found?.path.split(':').length).toBeGreaterThan(0);
  });

  it('asks again after a failure instead of keeping it', async () => {
    let clock = 0;
    const distro = `b4m-missing-${Date.now()}`;
    vi.stubEnv('PATH', '');
    try {
      expect(await wslUserEnvironment(distro, () => clock)).toBeNull();
      const again = wslUserEnvironment(distro, () => clock);
      expect(again).toBe(wslUserEnvironment(distro, () => clock));
      clock += 60_000;
      expect(wslUserEnvironment(distro, () => clock)).not.toBe(again);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe.runIf(process.platform === 'linux')('REALPATH_SCRIPT', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-wsl-realpath-')));
    mkdirSync(join(root, 'project', 'src'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, 'project', 'docs'));
    symlinkSync('../..', join(root, 'project', 'src', 'up'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const answers = (paths: string[]) =>
    spawnSync('bash', ['-c', REALPATH_SCRIPT], { input: paths.map(path => `${path}\0`).join(''), encoding: 'utf8' })
      .stdout.split('\0')
      .slice(0, -1);

  it('follows links to an outside folder and up the tree, as the kernel would, one answer per path', () => {
    expect(
      answers([
        `${root}/project/docs/new-file`,
        `${root}/project/src/up/outside`,
        `${root}/project/src/up/../x`,
        `${root}/project/src/file`,
      ])
    ).toEqual([
      `${root}/outside/new-file`,
      `${root}/outside`,
      `${root.slice(0, root.lastIndexOf('/'))}/x`,
      `${root}/project/src/file`,
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
