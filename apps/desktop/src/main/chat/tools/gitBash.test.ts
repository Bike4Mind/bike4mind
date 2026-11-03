import { describe, expect, it } from 'vitest';
import { findGitBash, type GitBashProbe } from './gitBash';

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
  extraFiles: readonly string[] = []
): GitBashProbe & { checked: string[]; ran: string[] } {
  const files = new Set([
    ...roots.flatMap(root => [`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\msys-2.0.dll`]),
    ...extraFiles,
  ]);
  const checked: string[] = [];
  const ran: string[] = [];
  return {
    env: ENV,
    checked,
    ran,
    exists: async path => {
      checked.push(path);
      return files.has(path);
    },
    run: async (file, args) => {
      ran.push(file);
      return outputs[[file, ...args].join(' ')] ?? '';
    },
  };
}

const REG = 'C:\\Windows\\System32\\reg.exe';
const REG_MACHINE = `${REG} query HKLM\\SOFTWARE\\GitForWindows /v InstallPath`;
const REG_USER = `${REG} query HKCU\\SOFTWARE\\GitForWindows /v InstallPath`;
const WHERE = 'C:\\Windows\\System32\\where.exe git';

const registered = (hive: string, path: string) =>
  `\r\n${hive}\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    ${path}\r\n\r\n`;

describe('findGitBash', () => {
  it('runs reg.exe and where.exe from System32 by absolute path', async () => {
    const machine = probe([]);
    await findGitBash(machine);
    expect(machine.ran).toEqual(expect.arrayContaining([REG, 'C:\\Windows\\System32\\where.exe']));
    expect(machine.ran.every(file => /^[A-Z]:\\/i.test(file))).toBe(true);
  });

  it('uses the install path Git for Windows registered for the machine', async () => {
    const machine = probe(['D:\\Tools\\Git', 'C:\\Program Files\\Git'], {
      [REG_MACHINE]: registered('HKEY_LOCAL_MACHINE', 'D:\\Tools\\Git'),
    });
    expect(await findGitBash(machine)).toBe('D:\\Tools\\Git\\bin\\bash.exe');
  });

  it('uses a per-user registration when there is no machine one', async () => {
    const user = probe(['E:\\Mine\\Git', 'C:\\Program Files\\Git'], {
      [REG_USER]: registered('HKEY_CURRENT_USER', 'E:\\Mine\\Git'),
    });
    expect(await findGitBash(user)).toBe('E:\\Mine\\Git\\bin\\bash.exe');
  });

  it('prefers the machine registration, then the user one, then PATH, then standard folders', async () => {
    const outputs = {
      [REG_MACHINE]: registered('HKEY_LOCAL_MACHINE', 'D:\\Machine\\Git'),
      [REG_USER]: registered('HKEY_CURRENT_USER', 'D:\\User\\Git'),
      [WHERE]: 'D:\\Path\\Git\\cmd\\git.exe\r\n',
      'D:\\Path\\Git\\cmd\\git.exe --exec-path': 'D:/Path/Git/mingw64/libexec/git-core\n',
    };
    const all = ['D:\\Machine\\Git', 'D:\\User\\Git', 'D:\\Path\\Git', 'C:\\Program Files\\Git'];
    expect(await findGitBash(probe(all, outputs))).toBe('D:\\Machine\\Git\\bin\\bash.exe');
    expect(await findGitBash(probe(all.slice(1), outputs))).toBe('D:\\User\\Git\\bin\\bash.exe');
    expect(await findGitBash(probe(all.slice(2), outputs))).toBe('D:\\Path\\Git\\bin\\bash.exe');
    expect(await findGitBash(probe(all.slice(3), outputs))).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('finds the install from the exec path of the git on PATH', async () => {
    const arm = probe(['E:\\Git'], {
      [WHERE]: 'E:\\Git\\cmd\\git.exe\r\n',
      'E:\\Git\\cmd\\git.exe --exec-path': 'E:/Git/clangarm64/libexec/git-core\r\n',
    });
    expect(await findGitBash(arm)).toBe('E:\\Git\\bin\\bash.exe');
  });

  it('follows a shim on PATH to the install it runs', async () => {
    const scoop = probe(['C:\\Users\\someone\\scoop\\apps\\git\\current'], {
      [WHERE]: 'C:\\Users\\someone\\scoop\\shims\\git.exe\r\n',
      'C:\\Users\\someone\\scoop\\shims\\git.exe --exec-path':
        'C:/Users/someone/scoop/apps/git/current/mingw64/libexec/git-core\n',
    });
    expect(await findGitBash(scoop)).toBe('C:\\Users\\someone\\scoop\\apps\\git\\current\\bin\\bash.exe');
    expect(scoop.checked).not.toContain('C:\\Users\\someone\\scoop\\bin\\bash.exe');
  });

  it('skips a bin\\bash.exe without the MSYS runtime beside it', async () => {
    const lookalike = probe(
      ['C:\\Program Files\\Git'],
      {
        [WHERE]: 'D:\\Other\\cmd\\git.exe\r\n',
        'D:\\Other\\cmd\\git.exe --exec-path': 'D:/Other/mingw64/libexec/git-core\n',
      },
      ['D:\\Other\\bin\\bash.exe']
    );
    expect(await findGitBash(lookalike)).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('falls back to the standard install folders', async () => {
    const perUser = probe(['C:\\Users\\someone\\AppData\\Local\\Programs\\Git']);
    expect(await findGitBash(perUser)).toBe('C:\\Users\\someone\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });

  it('never returns a bash under the Windows folder, which is the WSL launcher', async () => {
    const wsl = probe(['C:\\Windows', 'C:\\Windows\\System32'], {
      [REG_MACHINE]: registered('HKEY_LOCAL_MACHINE', 'C:\\Windows'),
      [WHERE]: 'C:\\Windows\\System32\\git.exe\r\n',
      'C:\\Windows\\System32\\git.exe --exec-path': 'C:/Windows/System32/mingw64/libexec/git-core\n',
    });
    expect(await findGitBash(wsl)).toBeNull();
    expect(wsl.checked.some(path => path.toLowerCase().startsWith('c:\\windows\\'))).toBe(false);
  });

  it('returns null when Git for Windows is not installed', async () => {
    expect(await findGitBash(probe([]))).toBeNull();
  });
});
