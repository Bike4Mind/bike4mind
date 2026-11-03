import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  shareName,
  shareRelativePath,
  toLinuxArgument,
  toWindowsPath,
  type UserEnvironmentProbe,
  withWslEnv,
  wslCommand,
  wslCommandEnv,
  wslEnvNames,
  wslLocation,
  wslOperandPlaces,
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

  // The spelling read off \\wsl.localhost and \\wsl$ from Windows for files the distro created.
  it('spells a Linux name the way the share lists and opens it', () => {
    expect(shareName('a\\b:c*d?e"f<g>h|i')).toBe(
      'a\u{f05c}b\u{f03a}c\u{f02a}d\u{f03f}e\u{f022}f\u{f03c}g\u{f03e}h\u{f07c}i'
    );
    expect(shareName('t\tn\nc\u{1}u\u{1f}')).toBe('t\u{f009}n\u{f00a}c\u{f001}u\u{f01f}');
    for (const kept of ['trail.', 'trail ', '...', 'del\u{7f}', 'lit\u{f05c}', 'caf\u{e9}.md']) {
      expect(shareName(kept)).toBe(kept);
    }
    expect(shareRelativePath('src/a\\..\\b/x?.ts')).toBe('src/a\u{f05c}..\u{f05c}b/x\u{f03f}.ts');
  });

  it('keeps a backslash in a Linux name inside that name on the share', () => {
    expect(wslUncPath(location, '/home/me/repo/a\\..\\..\\b')).toBe(
      '\\\\wsl$\\Ubuntu\\home\\me\\repo\\a\u{f05c}..\u{f05c}..\u{f05c}b'
    );
    expect(toWindowsPath(location, '/home/me/x:y')).toBe('\\\\wsl$\\Ubuntu\\home\\me\\x\u{f03a}y');
  });

  it('reads a share path back to the Linux names it spells', () => {
    const share = '\\\\wsl$\\Ubuntu\\home\\me\\repo\\a\u{f05c}b\\x\u{f03f}y';
    expect(parseWslPath(share)?.linuxPath).toBe('/home/me/repo/a\\b/x?y');
    expect(wslUncPath(location, parseWslPath(share)?.linuxPath ?? '')).toBe(share);
    expect(toLinuxArgument(location, share)).toBe('/home/me/repo/a\\b/x?y');
  });

  it('reads back each character the share spells as that character', () => {
    const spelled = [...Array.from({ length: 31 }, (_, index) => String.fromCharCode(index + 1)), ...'"*:<>?\\|'];
    for (const char of spelled) {
      const share = wslUncPath(location, `/home/me/a${char}b`);
      expect(share).toBe(`\\\\wsl$\\Ubuntu\\home\\me\\a${String.fromCharCode(0xf000 + char.charCodeAt(0))}b`);
      expect(parseWslPath(share)?.linuxPath).toBe(`/home/me/a${char}b`);
    }
  });

  it('reads back a Linux name that holds one of the share spelling characters itself as that name', () => {
    for (const held of ['\u{f05c}', '\u{f03a}', '\u{f001}', '\u{f07c}']) {
      const linuxPath = `/home/me/a${held}b\\c`;
      expect(parseWslPath(wslUncPath(location, linuxPath))?.linuxPath).toBe(linuxPath);
    }
    // Windows is given the share's own spelling, which the share opens as `a\b`.
    expect(toWindowsPath(location, '/home/me/a\u{f05c}b')).toBe('\\\\wsl$\\Ubuntu\\home\\me\\a\u{f05c}b');
    expect(wslOperandPlaces({ ...location, linuxPath: '/home/me/a\u{f05c}b' }, 'x\\y', 'windows')).toEqual([
      wslUncPath(location, '/home/me/a\u{f05c}b/x\\y'),
      '\\\\wsl$\\Ubuntu\\home\\me\\a\u{f05c}b\\x\\y',
    ]);
  });

  it('reads a UNC operand of a Windows program only as the share it names', () => {
    expect(wslOperandPlaces(location, '//fileserver/share/x', 'windows')).toEqual(['\\\\fileserver\\share\\x']);
    expect(wslOperandPlaces(location, '\\\\fileserver\\share\\x', 'windows')).toEqual(['\\\\fileserver\\share\\x']);
    expect(wslOperandPlaces(location, '//fileserver/share/x')).toEqual(['\\\\wsl$\\Ubuntu\\fileserver\\share\\x']);
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
    expect(command.file).toMatch(/^[A-Z]:\\.*\\System32\\wsl\.exe$/i);
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

  it('reads a home whose name holds a backslash as that Linux name, spelled on the share as the share spells it', () => {
    const found = parseUserEnvironment('__B4M_ENV__/usr/bin__B4M_ENV__/home/a\\b__B4M_ENV__');

    expect(found).toEqual({ path: '/usr/bin', home: '/home/a\\b' });
    expect(wslUncPath({ host: 'wsl.localhost', distro: 'Ubuntu' }, found?.home ?? '')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\a\u{f05c}b'
    );
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

  it('answers null when wsl.exe cannot be started', async () => {
    vi.stubEnv('PATH', '');
    try {
      expect(await wslUserEnvironment(`b4m-missing-${randomUUID()}`)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  const FOUND = { path: '/usr/bin', home: '/home/me' };

  it('asks again 30 s after a failure, 10 minutes after a timeout, and never after a success', async () => {
    let clock = 0;
    const results: UserEnvironmentProbe[] = [
      { found: null, timedOut: false },
      { found: null, timedOut: true },
      { found: FOUND, timedOut: false },
    ];
    const probe = vi.fn(async () => results.shift() as UserEnvironmentProbe);
    const distro = `b4m-${randomUUID()}`;
    const ask = () => wslUserEnvironment(distro, () => clock, probe);

    expect(await ask()).toBeNull();
    clock += 29_000;
    expect(await ask()).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    clock += 2_000;
    expect(await ask()).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
    clock += 5 * 60_000;
    expect(await ask()).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
    clock += 6 * 60_000;
    expect(await ask()).toEqual(FOUND);
    clock += 24 * 60 * 60_000;
    expect(await ask()).toEqual(FOUND);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('hands a command the absolute entries of the distro user PATH and no others', async () => {
    const distro = `b4m-${randomUUID()}`;
    const found = { path: '/home/me/.nvm/bin::bin:./node_modules/.bin:/usr/bin:.', home: '/home/me' };
    await wslUserEnvironment(distro, Date.now, async () => ({ found, timedOut: false }));

    const env = await wslCommandEnv({ PATH: 'C:\\Windows' }, distro);
    expect(env.B4M_DESKTOP_LINUX_PATH).toBe('/home/me/.nvm/bin:/usr/bin');

    const bare = `b4m-${randomUUID()}`;
    await wslUserEnvironment(bare, Date.now, async () => ({
      found: { path: '.:bin', home: '/home/me' },
      timedOut: false,
    }));
    expect((await wslCommandEnv({}, bare)).B4M_DESKTOP_LINUX_PATH).toBeUndefined();
  });

  it('keeps one probe for a distro however its name is cased', async () => {
    const name = `B4M-${randomUUID()}`;
    const probe = vi.fn(async (): Promise<UserEnvironmentProbe> => ({ found: FOUND, timedOut: false }));

    await wslUserEnvironment(name, Date.now, probe);
    expect(await wslUserEnvironment(name.toLowerCase(), Date.now, probe)).toEqual(FOUND);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('lets a caller that joins a running probe go on without it after 2 s', async () => {
    vi.useFakeTimers();
    try {
      let finish: (probe: UserEnvironmentProbe) => void = () => undefined;
      const probe = vi.fn(() => new Promise<UserEnvironmentProbe>(resolve => (finish = resolve)));
      const distro = `b4m-${randomUUID()}`;
      const started = wslUserEnvironment(distro, Date.now, probe);
      const joined = wslUserEnvironment(distro, Date.now, probe);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await joined).toBeNull();
      finish({ found: FOUND, timedOut: false });
      expect(await started).toEqual(FOUND);
      expect(await wslUserEnvironment(distro, Date.now, probe)).toEqual(FOUND);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
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
    mkdirSync(join(root, 'project\n'));
    symlinkSync('../project\n', join(root, 'project', 'sibling'));
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

  it('keeps a trailing newline in the answer, so a sibling folder named like the project is not the project', () => {
    expect(answers([`${root}/project/sibling/x`, `${root}/project/src`])).toEqual([
      `${root}/project\n/x`,
      `${root}/project/src`,
    ]);
    expect(answers([`${root}/project/sibling`])).toEqual([`${root}/project\n`]);
  });
});

describe('WSLENV', () => {
  it('appends names once, keeping what WSLENV already lists', () => {
    expect(withWslEnv({ WSLENV: 'USERPROFILE/p' }, ['A', 'B']).WSLENV).toBe('USERPROFILE/p:A:B');
    expect(withWslEnv({ WSLENV: 'A/u' }, ['A']).WSLENV).toBe('A/u');
    expect(withWslEnv({}, ['A']).WSLENV).toBe('A');
  });

  it('drops the w flag from a listed name that must reach Linux, and leaves other entries alone', () => {
    expect(withWslEnv({ WSLENV: 'A/w:B/pw:C/w' }, ['A', 'B']).WSLENV).toBe('A:B/p:C/w');
  });

  it('lists only the names that cross into Linux', () => {
    expect(wslEnvNames({ WSLENV: 'A:B/p:C/w:D/pw:E/u::' })).toEqual(['A', 'B', 'E']);
    expect(wslEnvNames({})).toEqual([]);
  });
});
