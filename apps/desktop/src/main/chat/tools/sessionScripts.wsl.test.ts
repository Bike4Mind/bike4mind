import { posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBash } from './bashParser';
import type { ToolContext } from './types';

// The parser finds its wasm by this host's path rules, so it is loaded before Windows rules are mocked in.
(await parseBash('true'))?.delete();

vi.doMock('node:path', async () => {
  const { win32 } = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...win32, default: win32 };
});
vi.doMock('node:os', async () => ({
  ...(await vi.importActual<typeof import('node:os')>('node:os')),
  homedir: () => 'C:\\Users\\me',
}));
vi.doMock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const missing = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? async () => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
        : value,
    ])
  );
  return { ...missing, default: missing };
});
vi.doMock('../../wsl/wslPath', async () => {
  const actual = await vi.importActual<typeof import('../../wsl/wslPath')>('../../wsl/wslPath');
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslUserEnvironment: async () => ({ path: '/usr/bin', home: '/home/me' }),
    wslRealpath: async (_distro: string, linuxPath: string) => posix.normalize(linuxPath),
  };
});

const { forgetSessionWrites, recordSessionWrite, sessionScriptRun } = await import('./sessionScripts');
const { scanShell } = await import('./shellScan');

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
const session = 'wsl-session-scripts';
const context = { sessionId: session } as ToolContext;

describe('the scripts a command in a WSL project runs, by Linux rules', () => {
  beforeEach(async () => {
    await recordSessionWrite(context, `${ROOT}\\s.sh`);
  });

  afterEach(async () => {
    await forgetSessionWrites(session);
  });

  it.each([
    "mkdir -p 'a\\b' && cd 'a\\b' && sh ../s.sh",
    `mkdir -p '${ROOT}\\a\\b' && cd '${ROOT}\\a\\b' && sh ../s.sh`,
    "mkdir -p ~/repo/'a\\b' && cd ~/repo/'a\\b' && sh ../s.sh",
    "cd $HOME/repo/'a\\b' && sh ../s.sh",
    'cd src && sh ../s.sh',
  ])('finds the script this session wrote that %s runs', async command => {
    expect((await sessionScriptRun(command, ROOT, session))?.names).toEqual(['../s.sh']);
  });

  it.each(["cd 'a\\b' && cat ../s.sh", 'sh other.sh', "cd 'a\\b' && sh ../../s.sh"])(
    'finds no written script that %s runs',
    async command => {
      expect(await sessionScriptRun(command, ROOT, session)).toBeNull();
    }
  );

  it('finds a script a shell command wrote after a cd, where bash wrote it', async () => {
    const scan = await scanShell("cd 'a\\b' && echo x > ../t.sh", ROOT, [ROOT]);
    for (const written of scan?.writes ?? []) await recordSessionWrite(context, written);

    expect((await sessionScriptRun('sh t.sh', ROOT, session))?.names).toEqual(['t.sh']);
    expect((await sessionScriptRun("cd 'a\\b' && sh ../t.sh", ROOT, session))?.names).toEqual(['../t.sh']);
  });

  it('finds a written project file in a folder whose Linux name holds a backslash', async () => {
    await recordSessionWrite(context, `${ROOT}\\a\u{f05c}b\\package.json`);

    expect((await sessionScriptRun("cd 'a\\b' && npm test", ROOT, session))?.names).toEqual(['a\\b/package.json']);
  });
});
