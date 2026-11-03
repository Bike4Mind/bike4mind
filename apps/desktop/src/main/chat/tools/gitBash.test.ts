import { describe, expect, it } from 'vitest';
import { findGitBash, type GitBashProbe } from './gitBash';

const ENV = {
  ProgramW6432: 'C:\\Program Files',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
};

function probe(
  installed: readonly string[],
  outputs: Record<string, string> = {}
): GitBashProbe & { checked: string[] } {
  const checked: string[] = [];
  return {
    env: ENV,
    checked,
    exists: async path => {
      checked.push(path);
      return installed.includes(path);
    },
    run: async (file, args) => outputs[[file, ...args].join(' ')] ?? '',
  };
}

const REG_MACHINE = 'reg.exe query HKLM\\SOFTWARE\\GitForWindows /v InstallPath';
const WHERE = 'where.exe git';

describe('findGitBash', () => {
  it('uses the install path Git for Windows registered', async () => {
    const machine = probe(['D:\\Tools\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'], {
      [REG_MACHINE]:
        '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    D:\\Tools\\Git\r\n\r\n',
    });
    expect(await findGitBash(machine)).toBe('D:\\Tools\\Git\\bin\\bash.exe');
  });

  it('finds the install from the git on PATH, whichever folder of it is on PATH', async () => {
    const fromCmd = probe(['E:\\Git\\bin\\bash.exe'], { [WHERE]: 'E:\\Git\\cmd\\git.exe\r\n' });
    expect(await findGitBash(fromCmd)).toBe('E:\\Git\\bin\\bash.exe');

    const fromMingw = probe(['E:\\Git\\bin\\bash.exe'], { [WHERE]: 'E:\\Git\\mingw64\\bin\\git.exe\r\n' });
    expect(await findGitBash(fromMingw)).toBe('E:\\Git\\bin\\bash.exe');
  });

  it('falls back to the standard install folders', async () => {
    const perUser = probe(['C:\\Users\\someone\\AppData\\Local\\Programs\\Git\\bin\\bash.exe']);
    expect(await findGitBash(perUser)).toBe('C:\\Users\\someone\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });

  it('never returns a bash under the Windows folder, which is the WSL launcher', async () => {
    const wsl = probe(['C:\\Windows\\bin\\bash.exe', 'C:\\Windows\\System32\\bin\\bash.exe'], {
      [WHERE]: 'C:\\Windows\\System32\\cmd\\git.exe\r\nC:\\Windows\\cmd\\git.exe\r\n',
    });
    expect(await findGitBash(wsl)).toBeNull();
    expect(wsl.checked.some(path => path.toLowerCase().startsWith('c:\\windows\\'))).toBe(false);
  });

  it('returns null when Git for Windows is not installed', async () => {
    expect(await findGitBash(probe([]))).toBeNull();
  });
});
