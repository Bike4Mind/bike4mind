import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { arityPrefix } from './bashArity';
import { scanShell } from './shellScan';

const home = '/Users/tester';
vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => home,
}));
const homedir = () => home;

describe('scanShell', () => {
  const root = join(home, 'proj');

  const scan = async (command: string) => {
    const result = await scanShell(command, root, [root]);
    if (!result) throw new Error('did not parse');
    return result;
  };
  const texts = async (command: string) => (await scan(command)).commands.map(entry => entry.text);

  describe('splitting a script into commands', () => {
    it('finds each side of &&, ||, ; and a pipe', async () => {
      expect(await texts('git add . && git commit -m x || echo no; ls | wc -l')).toEqual([
        'git add .',
        'git commit -m x',
        'echo no',
        'ls',
        'wc -l',
      ]);
    });

    it('finds commands in a subshell, a substitution and a multi-line script', async () => {
      expect(await texts('(cd sub && ls)\necho "$(whoami)"\nfor f in a b; do rm "$f"; done')).toEqual([
        'ls',
        'whoami',
        'echo "$(whoami)"',
        'rm "$f"',
      ]);
    });

    it('finds the commands around a heredoc', async () => {
      expect(await texts("cat <<'EOF' > out.txt\nhello\nEOF\nls")).toEqual(["cat <<'EOF' > out.txt\nhello\nEOF", 'ls']);
    });

    it('does not count a bare assignment, and keeps the command after one', async () => {
      expect(await texts('FOO=1 make build')).toEqual(['FOO=1 make build']);
      expect(await texts('FOO=1')).toEqual([]);
    });

    it('returns null when the script does not parse', async () => {
      expect(await scanShell('if then fi ((', root, [root])).toBeNull();
    });
  });

  describe('paths outside the project', () => {
    it('flags rm of a path outside every root', async () => {
      expect((await scan('rm -rf /etc/x')).directories).toEqual(['/etc']);
    });

    it('treats ~ and $HOME as outside unless inside a root', async () => {
      expect((await scan('cat ~/.ssh/id_rsa')).directories).toEqual([join(homedir(), '.ssh')]);
      expect((await scan('cat $HOME/.ssh/id_rsa')).directories).toEqual([join(homedir(), '.ssh')]);
      expect((await scan(`cat ~/proj/sub/x`)).directories).toEqual([]);
    });

    it('allows the temp directories', async () => {
      expect((await scan(`cp a ${tmpdir()}/x && touch /tmp/y && mv a /private/tmp/z`)).directories).toEqual([]);
    });

    it('allows paths inside the project, relative or absolute', async () => {
      expect((await scan(`mkdir -p sub/new && cat ${root}/sub/a ./b`)).directories).toEqual([]);
    });

    it('skips an argument built from a variable or a substitution', async () => {
      expect((await scan('rm "$TARGET" $(pwd)/x `pwd`/y')).directories).toEqual([]);
    });

    it('checks the target of a redirect but not /dev/null', async () => {
      expect((await scan('echo hi > /etc/motd 2>/dev/null')).directories).toEqual(['/etc']);
    });

    it('finds the path in a nested command', async () => {
      expect((await scan('echo "$(cat /etc/hosts)"')).directories).toEqual(['/etc']);
    });
  });

  describe('tracking cd', () => {
    it('resolves later commands against a relative cd', async () => {
      expect((await scan('cd sub && cat ../../x')).directories).toEqual([join(root, '..')]);
      expect((await scan('cd sub/deep && cat ../../ok')).directories).toEqual([]);
    });

    it('asks about a cd whose target is outside, and tracks it', async () => {
      const result = await scan('cd /etc && cat hosts');
      expect(result.directories).toEqual(['/etc']);
    });

    it('does not ask about a cd inside the project', async () => {
      expect((await scan('cd sub; cd deep; cd ../..; pwd')).directories).toEqual([]);
    });

    it('pushd and popd move and restore the directory', async () => {
      expect((await scan('pushd sub/deep && popd && cat sub/x')).directories).toEqual([]);
      expect((await scan('pushd sub && cat ../../x')).directories).toEqual([join(root, '..')]);
    });

    it('does not let a subshell cd leak out', async () => {
      expect((await scan('(cd sub/deep) && cat ../../ok')).directories).toEqual(['/Users']);
    });

    it('does not list cd as a command to allow', async () => {
      expect((await scan('cd sub && ls')).commands.map(entry => entry.always)).toEqual(['ls *']);
    });
  });

  describe('what always allow remembers', () => {
    it('derives the prefix per sub-command', async () => {
      expect((await scan('git commit -m x && npm run dev --port 3 | tee log')).commands.map(c => c.always)).toEqual([
        'git commit *',
        'npm run dev *',
        'tee *',
      ]);
    });
  });
});

describe('arityPrefix', () => {
  it.each([
    [['git', 'commit', '-m', 'x'], 'git commit'],
    [['npm', 'run', 'dev', '--port', '3'], 'npm run dev'],
    [['ls', '-la'], 'ls'],
    [['docker', 'compose', 'up', '-d'], 'docker compose up'],
    [['./script.sh', 'a'], './script.sh'],
  ])('%j -> %s', (tokens, expected) => {
    expect(arityPrefix(tokens).join(' ')).toBe(expected);
  });
});
