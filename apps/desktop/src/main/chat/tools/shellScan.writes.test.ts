import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { scanShell } from './shellScan';

describe('scanShell writes', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-scan-writes-')));
    await mkdir(join(root, 'bin'));
  });

  const writes = async (command: string) => (await scanShell(command, root, [root]))?.writes.sort();

  it.each([
    ["printf 'x' > a.sh && bash a.sh", ['a.sh']],
    ["cat > a.sh <<'EOF'\necho hi\nEOF", ['a.sh']],
    ['echo hi >> logs/out.txt', ['logs/out.txt']],
    ['echo hi | tee a.sh b.sh', ['a.sh', 'b.sh']],
    ['cp src.sh a.sh', ['a.sh']],
    ['mv one.sh two.sh bin', ['bin', 'bin/one.sh', 'bin/two.sh']],
    ['cp -t bin one.sh', ['bin', 'bin/one.sh']],
    ['install -m 755 src.sh bin/a.sh', ['bin/a.sh']],
    ['ln -s target link.sh', ['link.sh']],
    ['cd bin && echo x > a.sh', ['bin/a.sh']],
    ['curl -o a.sh https://example.com/a', ['a.sh']],
    ['curl -sL --output=a.sh https://example.com/a', ['a.sh']],
    ['wget -O a.sh https://example.com/a', ['a.sh']],
    ['curl -fsSLo a.sh https://example.com/a', ['a.sh']],
    ['curl -fsSLoa.sh https://example.com/a', ['a.sh']],
    ['wget -qO a.sh https://example.com/a', ['a.sh']],
    ['wget -qOa.sh https://example.com/a', ['a.sh']],
    ['dd if=src.sh of=a.sh', ['a.sh']],
    ['git config core.hooksPath hooks', ['.git/config']],
    ['git -C bin config user.name x', ['bin/.git/config']],
    ['git config --unset core.editor', ['.git/config']],
    ['npm pkg set scripts.build=x', ['package.json']],
  ])('records what %s writes', async (command, expected) => {
    // A copy into what may be a folder also records the file it would create there.
    expect(await writes(command)).toEqual(expect.arrayContaining(expected.map(path => join(root, path))));
  });

  it('records the global git config', async () => {
    expect(await writes('git config --global core.hooksPath h')).toEqual([join(homedir(), '.gitconfig')]);
  });

  it.each([
    'cat a.sh',
    'echo hi > /dev/null',
    'echo $X > $FILE',
    'git status 2>&1',
    'git config user.email',
    'git config --get user.email',
    'npm pkg get name',
    'curl -O https://example.com/a',
    'curl --output-dir d -O https://example.com/a',
    'curl -sSLO https://example.com/a',
  ])('records nothing for %s', async command => {
    expect(await writes(command)).toEqual([]);
  });
});
