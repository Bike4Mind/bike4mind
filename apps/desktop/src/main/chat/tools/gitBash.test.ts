import { describe, expect, it } from 'vitest';
import { findGitBash, GitBashMissing, resolveGitBash, type GitBashProbe } from './gitBash';

const ENV = {
  ProgramW6432: 'C:\\Program Files',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
};

/** Each root is a complete Git for Windows install: its `bin\bash.exe` and MSYS runtime exist. */
function probe(
  roots: readonly string[],
  outputs: Record<string, string> = {},
  extraFiles: readonly string[] = [],
  path = ''
): GitBashProbe & { checked: string[]; ran: string[]; files: Set<string> } {
  const files = new Set([
    ...roots.flatMap(root => [`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\msys-2.0.dll`]),
    ...extraFiles,
  ]);
  const checked: string[] = [];
  const ran: string[] = [];
  return {
    env: { ...ENV, Path: path },
    checked,
    ran,
    files,
    exists: async file => {
      checked.push(file);
      return files.has(file);
    },
    run: async (file, args) => {
      const command = [file, ...args].join(' ');
      ran.push(command);
      return outputs[command] ?? '';
    },
  };
}

const REG = 'C:\\Windows\\System32\\reg.exe';
const REG_MACHINE = `${REG} query HKLM\\SOFTWARE\\GitForWindows /v InstallPath`;
const REG_USER = `${REG} query HKCU\\SOFTWARE\\GitForWindows /v InstallPath`;

const registered = (hive: string, path: string) =>
  `\r\n${hive}\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    ${path}\r\n\r\n`;

describe('findGitBash', () => {
  it('runs reg.exe from System32 by absolute path, and reads PATH from the environment', async () => {
    const machine = probe([]);
    await findGitBash(machine);
    expect(machine.ran).toEqual([REG_MACHINE, REG_USER]);
  });

  it('uses the install path Git for Windows registered for the machine, and asks nothing more', async () => {
    const machine = probe(['D:\\Tools\\Git', 'C:\\Program Files\\Git'], {
      [REG_MACHINE]: registered('HKEY_LOCAL_MACHINE', 'D:\\Tools\\Git'),
    });
    expect(await findGitBash(machine)).toBe('D:\\Tools\\Git\\bin\\bash.exe');
    expect(machine.ran).toEqual([REG_MACHINE]);
  });

  it('uses a per-user registration when there is no machine one', async () => {
    const user = probe(['E:\\Mine\\Git', 'C:\\Program Files\\Git'], {
      [REG_USER]: registered('HKEY_CURRENT_USER', 'E:\\Mine\\Git'),
    });
    expect(await findGitBash(user)).toBe('E:\\Mine\\Git\\bin\\bash.exe');
    expect(user.ran).toEqual([REG_MACHINE, REG_USER]);
  });

  it('prefers the machine registration, then the user one, then PATH, then standard folders', async () => {
    const outputs = {
      [REG_MACHINE]: registered('HKEY_LOCAL_MACHINE', 'D:\\Machine\\Git'),
      [REG_USER]: registered('HKEY_CURRENT_USER', 'D:\\User\\Git'),
    };
    const all = ['D:\\Machine\\Git', 'D:\\User\\Git', 'D:\\Path\\Git', 'C:\\Program Files\\Git'];
    const onPath = ['D:\\Path\\Git\\cmd\\git.exe'];
    const path = 'D:\\Path\\Git\\cmd';
    expect(await findGitBash(probe(all, outputs, onPath, path))).toBe('D:\\Machine\\Git\\bin\\bash.exe');
    expect(await findGitBash(probe(all.slice(1), outputs, onPath, path))).toBe('D:\\User\\Git\\bin\\bash.exe');
    expect(await findGitBash(probe(all.slice(2), outputs, onPath, path))).toBe('D:\\Path\\Git\\bin\\bash.exe');
    expect(await findGitBash(probe(all.slice(3), outputs, onPath, path))).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('takes only the first git on PATH, and its own install before asking git', async () => {
    const machine = probe(
      ['E:\\Git'],
      {},
      ['E:\\Git\\cmd\\git.exe', 'F:\\Other\\cmd\\git.exe'],
      'C:\\Missing;relative\\bin;"E:\\Git\\cmd";F:\\Other\\cmd'
    );
    expect(await findGitBash(machine)).toBe('E:\\Git\\bin\\bash.exe');
    expect(machine.checked).not.toContain('F:\\Other\\cmd\\git.exe');
    expect(machine.checked.some(file => file.startsWith('relative'))).toBe(false);
    expect(machine.ran).toEqual([REG_MACHINE, REG_USER]);
  });

  it('finds the install from the exec path of the git on PATH', async () => {
    const arm = probe(
      ['E:\\Git'],
      { 'E:\\Git\\clangarm64\\bin\\git.exe --exec-path': 'E:/Git/clangarm64/libexec/git-core\r\n' },
      ['E:\\Git\\clangarm64\\bin\\git.exe'],
      'E:\\Git\\clangarm64\\bin'
    );
    expect(await findGitBash(arm)).toBe('E:\\Git\\bin\\bash.exe');
  });

  it('follows a shim on PATH to the install it runs', async () => {
    const scoop = probe(
      ['C:\\Users\\someone\\scoop\\apps\\git\\current'],
      {
        'C:\\Users\\someone\\scoop\\shims\\git.exe --exec-path':
          'C:/Users/someone/scoop/apps/git/current/mingw64/libexec/git-core\n',
      },
      ['C:\\Users\\someone\\scoop\\shims\\git.exe'],
      'C:\\Users\\someone\\scoop\\shims'
    );
    expect(await findGitBash(scoop)).toBe('C:\\Users\\someone\\scoop\\apps\\git\\current\\bin\\bash.exe');
  });

  it('skips a bin\\bash.exe without the MSYS runtime beside it', async () => {
    const lookalike = probe(
      ['C:\\Program Files\\Git'],
      { 'D:\\Other\\cmd\\git.exe --exec-path': 'D:/Other/mingw64/libexec/git-core\n' },
      ['D:\\Other\\bin\\bash.exe', 'D:\\Other\\cmd\\git.exe'],
      'D:\\Other\\cmd'
    );
    expect(await findGitBash(lookalike)).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('skips a registered install path that is not absolute', async () => {
    const relative = probe(['Git', 'C:\\Program Files\\Git'], {
      [REG_MACHINE]: registered('HKEY_LOCAL_MACHINE', 'Git'),
    });
    expect(await findGitBash(relative)).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(relative.checked).not.toContain('Git\\bin\\bash.exe');
  });

  it('falls back to the standard install folders', async () => {
    const perUser = probe(['C:\\Users\\someone\\AppData\\Local\\Programs\\Git']);
    expect(await findGitBash(perUser)).toBe('C:\\Users\\someone\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });

  it('never returns a bash under the Windows folder, which is the WSL launcher', async () => {
    const wsl = probe(
      ['C:\\Windows', 'C:\\Windows\\System32'],
      {
        [REG_MACHINE]: registered('HKEY_LOCAL_MACHINE', 'C:\\Windows'),
        'C:\\Windows\\System32\\git.exe --exec-path': 'C:/Windows/System32/mingw64/libexec/git-core\n',
      },
      ['C:\\Windows\\System32\\git.exe'],
      'C:\\Windows\\System32'
    );
    expect(await findGitBash(wsl)).toBeNull();
    expect(wsl.checked.some(path => /^c:\\windows\\.*bash\.exe$/i.test(path))).toBe(false);
  });

  it('returns null when Git for Windows is not installed', async () => {
    expect(await findGitBash(probe([]))).toBeNull();
  });
});

describe('resolveGitBash', () => {
  it('keeps a hit while it exists, and searches again once it is gone', async () => {
    const machine = probe(['C:\\Program Files\\Git']);
    expect(await resolveGitBash(machine)).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(await resolveGitBash(machine)).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(machine.ran).toHaveLength(2);

    machine.files.clear();
    await expect(resolveGitBash(machine)).rejects.toBeInstanceOf(GitBashMissing);
    machine.files.add('D:\\Git\\bin\\bash.exe').add('D:\\Git\\usr\\bin\\msys-2.0.dll');
    machine.env.ProgramFiles = 'D:\\';
    machine.env.ProgramW6432 = 'D:\\';
    expect(await resolveGitBash(machine)).toBe('D:\\Git\\bin\\bash.exe');
  });
});
