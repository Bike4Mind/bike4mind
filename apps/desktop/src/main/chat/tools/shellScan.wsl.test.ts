import { posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBash } from './bashParser';

// The parser finds its wasm by this host's path rules, so it is loaded before Windows rules are mocked in.
(await parseBash('true'))?.delete();

const touched: string[] = [];
const asked: string[] = [];
const distroUser: { current: { path: string; home: string } | null } = {
  current: { path: '/usr/bin', home: '/home/me' },
};

const unresolvable = { current: false };
/** Symlinks in the distro, Linux path to Linux target. */
const links = new Map<string, string>();
/** Files Windows can read over the share, by share path. */
const shareFiles = new Map<string, string>();

const followLinks = (linuxPath: string): string => {
  const path = posix.normalize(linuxPath);
  for (const [link, target] of links) {
    if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length);
  }
  return path;
};

vi.doMock('node:path', async () => {
  const { win32 } = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...win32, default: win32 };
});
vi.doMock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const recorded = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? async (...args: unknown[]) => {
            touched.push(...args.filter((arg): arg is string => typeof arg === 'string'));
            const file = typeof args[0] === 'string' ? shareFiles.get(args[0]) : undefined;
            if (file !== undefined && name === 'readFile') return file;
            if (file !== undefined && name === 'stat') return { isFile: () => true, isDirectory: () => false, size: 1 };
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
        : value,
    ])
  );
  return { ...recorded, default: recorded };
});
vi.doMock('../../wsl/wslPath', async () => {
  const actual = await vi.importActual<typeof import('../../wsl/wslPath')>('../../wsl/wslPath');
  return {
    ...actual,
    wslLocation: (directory: string) => actual.parseWslPath(directory),
    wslUserEnvironment: async () => distroUser.current,
    wslRealpath: async (distro: string, linuxPath: string) => {
      asked.push(`${distro}:${linuxPath}`);
      return unresolvable.current ? null : followLinks(linuxPath);
    },
  };
});

const { scanShell } = await import('./shellScan');
const { shareName } = await import('../../wsl/wslPath');

const OTHER = '\\\\wsl.localhost\\Debian\\etc\\hosts';
/** Paths read over the Debian share or asked of Debian; a name in another distro may still spell `Debian`. */
const inDebian = (paths: string[]) => paths.filter(path => /^(\\\\wsl\.localhost\\debian\\|debian:)/i.test(path));

describe('a path in a distro no root is in', () => {
  it.each([
    ['a WSL project', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'],
    ['a Windows project', 'C:\\repo'],
  ])('is outside in %s, named without reading it over the share', async (_kind, root) => {
    touched.length = 0;
    asked.length = 0;

    const scan = await scanShell(`cat '${OTHER}'`, root, [root]);

    expect(scan?.ungranted).toEqual([OTHER]);
    expect(scan?.paths ?? []).not.toContain(OTHER);
    expect(inDebian(touched)).toEqual([]);
    expect(inDebian(asked)).toEqual([]);
  });

  it.each([
    ['a file', OTHER],
    ['a folder', '\\\\wsl.localhost\\Debian\\home\\me\\notes'],
    ['the distro root', '\\\\wsl.localhost\\Debian\\'],
  ])('offers no folder grant for %s', async (_kind, operand) => {
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

    const scan = await scanShell(`ls '${operand}'`, root, [root]);

    expect(scan?.ungranted).toHaveLength(1);
    expect(scan?.directories).toEqual([]);
  });

  it.each([
    ['a WSL project', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'],
    ['a Windows project', 'C:\\repo'],
  ])('is named, not read, as the operand of a program that does not open files, in %s', async (_kind, root) => {
    touched.length = 0;
    asked.length = 0;

    const scan = await scanShell(`sed -n p '${OTHER}'`, root, [root]);

    expect(scan?.ungranted).toEqual([OTHER]);
    expect(inDebian(touched)).toEqual([]);
    expect(inDebian(asked)).toEqual([]);
  });

  it.each(['node build.js C:/out', 'node build.js --base=//cdn.example.com/x', 'node build.js /usr/lib/x'])(
    'scans %s from a WSL project as an ordinary command',
    async command => {
      const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

      const scan = await scanShell(command, root, [root]);

      expect(scan?.commands.map(entry => entry.coverable)).toEqual([true]);
      expect(scan?.ungranted).toEqual([]);
    }
  );

  it('fails the scan for an operand in its own distro that the distro cannot resolve', async () => {
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
    unresolvable.current = true;
    try {
      await expect(scanShell('sed -n p notes.txt', root, [root])).rejects.toThrow();
      await expect(scanShell('sed -n p C:/out', root, [root])).rejects.toThrow();
      await expect(scanShell('sed --version', root, [root])).resolves.not.toBeNull();
    } finally {
      unresolvable.current = false;
    }
  });

  it('reads a Windows-looking operand of a Linux program as the Linux path it is, in the folder', async () => {
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

    const scan = await scanShell('node build.js C:/out', root, [root]);

    expect(scan?.paths).toContain(`${root}\\C\u{f03a}\\out`);
    expect(scan?.directories).toEqual([]);
  });
});

describe('the folders a command in a WSL project may reach unasked', () => {
  const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

  it("takes the distro's /tmp as the temp folder", async () => {
    const scan = await scanShell('cat /tmp/out.txt', root, [root]);

    expect(scan?.directories).toEqual([]);
    expect(scan?.ungranted).toEqual([]);
  });

  it('still asks about another folder of the distro', async () => {
    const scan = await scanShell('cat /var/log/out.txt', root, [root]);

    expect(scan?.directories).toEqual(['\\\\wsl.localhost\\Ubuntu\\var\\log']);
  });

  it.each([
    "grep -rn 'foo\\|bar' src",
    "git log --grep='fix\\b'",
    "grep -n 'foo\\.bar' notes.txt",
    "sed -n 's/\\t/ /p' notes.txt",
    "printf 'a\\n'",
    "echo -e 'x\\ty'",
    "node -e 'console.log(1)\\n'",
    "cat 'a\\nb.txt'",
    "ls 'dir\\sub'",
  ])('scans %s, reading a backslash in an operand as part of a Linux name', async command => {
    const scan = await scanShell(command, root, [root]);

    expect(scan).not.toBeNull();
    expect(scan?.directories).toEqual([]);
    expect(scan?.ungranted).toEqual([]);
  });

  it('names the Linux folder an operand with a backslash lands in, outside the project', async () => {
    const scan = await scanShell("cat '/var/x\\..\\..\\home\\me\\repo\\f'", root, [root]);

    expect(scan?.directories).toEqual(['\\\\wsl.localhost\\Ubuntu\\var']);
    expect(scan?.paths).not.toContain(`${root}\\f`);
  });

  it("lets a read-only probe look at the distro user's toolchain folder, and asks about a secret in it", async () => {
    const toolchain = await scanShell('ls ~/.cargo/bin', root, [root]);
    const secret = await scanShell('ls ~/.cargo/credentials.toml', root, [root]);

    expect(toolchain?.directories).toEqual([]);
    expect(secret?.directories).toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\me\\.cargo']);
  });
});

describe('where a command in a WSL project lands after a cd, by Linux rules', () => {
  const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
  const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me';

  it.each([
    ['a share path', `mkdir -p '${root}\\a\\b' && cd '${root}\\a\\b' && cat ../../notes.txt`, [HOME]],
    ['a share path', `mkdir -p '${root}\\a\\b' && cd '${root}\\a\\b' && echo x >> ../../notes.txt`, [HOME]],
    ['a ~ path', "mkdir -p ~/repo/'a\\b' && cd ~/repo/'a\\b' && cat ../../notes.txt", [HOME]],
    ['a ~ path', "mkdir -p ~/repo/'a\\b' && cd ~/repo/'a\\b' && echo x >> ../../notes.txt", [HOME]],
    ['a ~ path', "cd ~/'q\\..\\repo\\sub' && cat ../notes.txt", [HOME]],
    ['a $HOME path', "cd $HOME/'q\\..\\repo\\sub' && cat ../notes.txt", [HOME]],
    ['a // path', 'cd //home/me/repo/sub && cat ../../notes.txt', [HOME]],
  ])(
    'names the folder outside the project that a relative operand reaches after a cd to %s: %s',
    async (_kind, command, expected) => {
      const scan = await scanShell(command, root, [root]);

      expect(scan?.directories).toEqual(expected);
    }
  );

  it.each([
    'cd src && cat ../package.json',
    `cd '${root}\\src' && cat ../package.json`,
    "cd 'a\\b' && cat ../package.json",
    'cd ~/repo/src && cat ../package.json',
    "grep -rn 'foo\\|bar' src",
    "printf 'a\\n'",
  ])('still scans %s as contained in the project', async command => {
    const scan = await scanShell(command, root, [root]);

    expect(scan?.directories).toEqual([]);
    expect(scan?.ungranted).toEqual([]);
    expect(scan?.contained).toBe(true);
  });

  it('checks a share path given to a program at the place the share names too', async () => {
    const scan = await scanShell(`cat '${HOME}\\notes.txt'`, root, [root]);

    expect(scan?.directories).toEqual([HOME]);
  });

  it('records a write to a share-spelled name at the Linux name bash writes, and at the share place', async () => {
    const scan = await scanShell(`echo x > '${root}\\out.txt'`, root, [root]);

    expect(scan?.writes).toEqual([`${root}\\${shareName(`${root}\\out.txt`)}`, `${root}\\out.txt`]);
  });

  it('records a write after a cd at the Linux place bash writes', async () => {
    const scan = await scanShell("cd 'a\\b' && echo x > ../s.sh && cp 'x\\run.sh' ../bin/", root, [root]);

    expect(scan?.writes).toEqual([`${root}\\s.sh`, `${root}\\bin`, `${root}\\bin\\x\u{f05c}run.sh`]);
  });

  it('joins a home whose Linux name holds a backslash by Linux rules', async () => {
    distroUser.current = { path: '/usr/bin', home: '/home/a\\b' };
    try {
      const inside = '\\\\wsl.localhost\\Ubuntu\\home\\a\u{f05c}b\\repo';

      expect((await scanShell('cat ~/repo/notes.txt', inside, [inside]))?.directories).toEqual([]);
      expect((await scanShell('cat ~/notes.txt', inside, [inside]))?.directories).toEqual([
        '\\\\wsl.localhost\\Ubuntu\\home\\a\u{f05c}b',
      ]);
    } finally {
      distroUser.current = { path: '/usr/bin', home: '/home/me' };
    }
  });
});

describe('a Windows program run from a WSL project', () => {
  const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

  it.each([
    ["cmd.exe /c type 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["/mnt/c/Windows/System32/cmd.exe /c type 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["powershell.exe -Command Get-Content 'C:/Users/me/notes.txt'", ['C:\\Users\\me']],
    ['notepad.exe C:notes.txt', ['C:\\']],
    ["notepad.exe '..\\..\\notes.txt'", ['\\\\wsl.localhost\\Ubuntu\\home']],
    ["cmd.exe /c type '\\\\fileserver\\share\\notes.txt'", ['\\\\fileserver\\share\\']],
    ['notepad.exe //fileserver/share/notes.txt', ['\\\\fileserver\\share\\']],
    ['notepad.exe //wsl.localhost/Ubuntu/etc/hosts', ['\\\\wsl.localhost\\Ubuntu\\etc']],
    ['notepad.exe C\\:\\\\Users\\\\me\\\\notes.txt', ['C:\\Users\\me']],
    ['cmd.exe /c type "C:\\Users\\me\\notes.txt"', ['C:\\Users\\me']],
    ['cmd.exe /c type C:\\Users\\me\\notes.txt', ['C:\\']],
    ['notepad.exe "--file=..\\..\\secret.txt"', ['\\\\wsl.localhost\\Ubuntu\\home']],
    ["notepad.exe 'a=b\\..\\..\\secret.txt'", ['\\\\wsl.localhost\\Ubuntu\\home\\me']],
    ['notepad.exe "--out=C:\\Users\\me\\x.txt"', ['C:\\Users\\me']],
    ["notepad.exe --out='C:\\Users\\me\\x.txt'", ['C:\\Users\\me']],
    ["more.com 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["run.bat 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["run.cmd 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["NOTEPAD.EXE 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["/mnt/C/tools/viewer 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["/mnt/c/tools/viewer 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ['cmd.ex"e" /c type \'C:\\Users\\me\\notes.txt\'', ['C:\\Users\\me']],
    ["nohup notepad.exe 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["timeout -s KILL 5 notepad.exe 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["env -u TERM notepad.exe 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["sudo -u me notepad.exe 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
    ["xargs -I {} notepad.exe 'C:\\Users\\me\\notes.txt'", ['C:\\Users\\me']],
  ])('names the Windows place a Windows path operand opens: %s', async (command, expected) => {
    touched.length = 0;

    const scan = await scanShell(command, root, [root]);

    expect(scan?.directories).toEqual(expected);
    expect(touched.filter(path => /^[\\/]{2}fileserver/.test(path))).toEqual([]);
  });

  it.each([
    'sudo -u root',
    'sudo -uroot',
    'sudo -gdocker',
    'sudo -Eu root',
    'sudo -Euroot',
    'sudo --user root',
    'sudo --user=root',
    'sudo --host build',
    'sudo --host=build',
    'sudo A=1 -- B=2',
    'env -u TERM',
    'env -uTERM',
    'env -iu TERM',
    'env -iuTERM',
    'env --unset TERM',
    'env -- A=1',
    'command -p',
    'exec -a n',
    'exec -an',
    'exec -ca n',
    'exec -can',
    'nohup',
    'nice -n +5',
    'nice -n+5',
    'nice --adjustment +5',
    'nice -5',
    "time -f '%e'",
    'time -f%e',
    "time -pf '%e'",
    'time -ofoo',
    'time --output foo',
    'time A=1',
    'timeout 5',
    'timeout -s KILL 5',
    'timeout -sKILL 5',
    'timeout -vs KILL 5',
    'timeout --signal KILL 5',
    'timeout --kill-after=1 5',
    'xargs -I {}',
    'xargs -Id',
    'xargs -rI {}',
    'xargs -rId',
    'xargs -ia',
    'xargs --max-procs 4',
    'xargs -J %',
    'xargs -R 1 -I %',
    'xargs -S 512 -I %',
    'sudo -u root timeout -s KILL 5',
    'nice --adj 5',
    'xargs --max-a 1',
    'timeout --kill 5 10',
    'timeout --sig KILL 5',
    'sudo --us bob',
    'sudo --login',
  ])('finds the Windows program %s runs', async wrapper => {
    const scan = await scanShell(`${wrapper} notepad.exe 'C:\\Users\\me\\notes.txt'`, root, [root]);

    expect(scan?.directories).toEqual(['C:\\Users\\me']);
  });

  it.each(['cmd.exe /c dir', 'git.exe status', 'explorer.exe .', 'cmd.exe /c type notes.txt'])(
    'asks about no folder for %s',
    async command => {
      const scan = await scanShell(command, root, [root]);

      expect(scan?.directories).toEqual([]);
    }
  );

  it('leaves a Windows-looking operand of a Linux program to Linux rules', async () => {
    const scan = await scanShell('sed -n p C:/Users/me/notes.txt', root, [root]);

    expect(scan?.directories).toEqual([]);
  });
});

describe('a script that names the home folder before the distro has said where it is', () => {
  const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

  afterEach(() => {
    distroUser.current = { path: '/usr/bin', home: '/home/me' };
  });

  it.each([
    'cat ~/notes.txt',
    'cat $HOME/notes.txt',
    'cat ~me/notes.txt',
    'cd',
    'cd ~ && ls',
    'echo hi > ~/out.txt',
    'grep --file=~/patterns x',
  ])('gets no scan for %s, so it is asked about with nothing to remember', async command => {
    distroUser.current = null;

    expect(await scanShell(command, root, [root])).toBeNull();
  });

  it('still scans a script that never names the home folder', async () => {
    distroUser.current = null;

    const scan = await scanShell('cat README.md && ls /tmp', root, [root]);

    expect(scan?.commands.map(entry => entry.coverable)).toEqual([true, true]);
  });

  it('scans the same script once the distro has answered', async () => {
    const scan = await scanShell('cat ~/notes.txt', root, [root]);

    expect(scan?.directories).toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\me']);
  });
});

describe('symlinks and odd names in a WSL project, followed by the distro', () => {
  const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
  const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me';
  /** A Linux name holding U+F05C itself, which the share also uses to spell `\`. */
  const odd = 'x\u{f05c}';

  afterEach(() => {
    links.clear();
    shareFiles.clear();
  });

  it('asks the distro about a name holding a share spelling character under its own Linux name', async () => {
    links.set(`/home/me/repo/${odd}`, '/home/me');
    asked.length = 0;

    const scan = await scanShell(`cat '${odd}/notes.txt'`, root, [root]);

    expect(asked).toContain(`Ubuntu:/home/me/repo/${odd}/notes.txt`);
    expect(scan?.directories).toHaveLength(1);
  });

  it('resolves operands after a cd into such a name against that same name', async () => {
    links.set(`/home/me/repo/${odd}/up`, '/home/me');

    expect((await scanShell(`cd '${odd}' && cat up/notes.txt`, root, [root]))?.directories).toHaveLength(1);
    expect((await scanShell(`cd '${odd}' && cat notes.txt`, root, [root]))?.directories).toEqual([]);
  });

  it('records a write after a cd through a symlink in the folder the link leads to', async () => {
    links.set('/home/me/repo/link', '/home/me/repo/a/b');

    const scan = await scanShell('cd link && echo x > out.txt', root, [root]);

    expect(scan?.writes).toEqual([`${root}\\a\\b\\out.txt`]);
  });

  it('tracks a cd to a share-spelled name as the Linux name bash enters, asking about nothing', async () => {
    const scan = await scanShell(`cd '\\\\wsl.localhost\\Ubuntu\\etc' && cat ../notes.txt`, root, [root]);

    expect(scan?.directories).toEqual([]);
    expect(scan?.paths).toContain(`${root}\\notes.txt`);
  });

  it('judges a name in a toolchain folder by how it is written as well as where it links', async () => {
    links.set('/home/me/.cargo/credentials.toml', '/home/me/.cargo/bin');

    const scan = await scanShell('ls ~/.cargo/credentials.toml', root, [root]);

    expect(scan?.directories).toEqual([`${HOME}\\.cargo`]);
  });

  it.each([
    ['tar -xf a.tar -C out a/c.txt', [`${root}\\out\\a\\c.txt`]],
    ['unzip a.zip a/c.txt -d out', [`${root}\\out\\a\\c.txt`]],
  ])('records the folder an archive member lands in by Linux rules: %s', async (command, expected) => {
    expect((await scanShell(command, root, [root]))?.writtenTrees).toEqual(expected);
  });

  it('records what git -C rewrites in the folder named by Linux rules', async () => {
    const scan = await scanShell("git -C 'a\\b' checkout -- x.txt", root, [root]);

    expect(scan?.writtenTrees).toContain(`${root}\\a\u{f05c}b\\x.txt`);
    expect(scan?.writtenTrees).not.toContain(`${root}\\a\\b\\x.txt`);
  });

  it('reads the patch fed to patch on standard input from the Linux name', async () => {
    shareFiles.set(
      `${root}\\d\u{f05c}fix.diff`,
      'diff --git a/x.sh b/x.sh\n--- a/x.sh\n+++ b/x.sh\n@@ -1 +1 @@\n-a\n+b\n'
    );

    const scan = await scanShell("patch -p1 < 'd\\fix.diff'", root, [root]);

    expect(scan?.writes).toContain(`${root}\\x.sh`);
    expect(scan?.writtenTrees).toEqual([]);
  });
});
