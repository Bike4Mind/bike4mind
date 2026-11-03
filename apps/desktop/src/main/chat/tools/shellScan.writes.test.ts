import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { scanShell } from './shellScan';

describe('scanShell writes', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-scan-writes-')));
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'repo/.git'), { recursive: true });
    await mkdir(join(root, 'repo/sub'));
    const diff = 'diff --git a/x.sh b/x.sh\n--- a/x.sh\n+++ b/x.sh\n@@ -1 +1 @@\n-a\n+b\n';
    await writeFile(join(root, 'fix.diff'), diff, 'utf8');
    await writeFile(join(root, 'repo/fix.diff'), diff.replace(/x\.sh/g, 'sub/x.sh'), 'utf8');
  });

  const writes = async (command: string) => (await scanShell(command, root, [root]))?.writes.sort();
  const trees = async (command: string) => (await scanShell(command, root, [root]))?.writtenTrees.sort();

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
    ["sed -i 's/a/b/' a.sh", ['a.sh']],
    ["sed -i '' -e 's/a/b/' a.sh", ['a.sh']],
    ["sed -Ei.bak 's/a/b/' a.sh b.sh", ['a.sh', 'b.sh']],
    ['sed --in-place -f edit.sed a.sh', ['a.sh']],
    ["/usr/bin/sed -ni 's/a/b/p' a.sh", ['a.sh']],
    ["perl -pi -e 's/a/b/' a.sh", ['a.sh']],
    ["perl -i.bak -pe 's/a/b/' a.sh", ['a.sh']],
    ["ruby -pi -e 'gsub(/a/, %q(b))' a.rb", ['a.rb']],
    ["gawk -i inplace '{print}' a.sh", ['a.sh']],
    ['patch -p1 < fix.diff', ['x.sh']],
    ['patch -p1 -i fix.diff', ['x.sh']],
    ['patch --input=fix.diff', ['x.sh']],
    ["patch -p1 <<'EOF'\n--- a/y.sh\n+++ b/y.sh\n@@ -1 +1 @@\n-a\n+b\nEOF", ['y.sh']],
    ['patch a.sh fix.diff', ['a.sh', 'x.sh']],
    ['patch -o out.sh a.sh < fix.diff', ['a.sh', 'out.sh']],
    ['patch -d bin -p1 < fix.diff', ['bin/x.sh']],
    ['gunzip a.sh.gz', ['a.sh']],
    ['gzip -d bin/a.sh.gz', ['bin/a.sh']],
    ['xz -dk a.tar.xz', ['a.tar']],
    ['zstd -d a.zst -o out.sh', ['out.sh']],
    ['git apply fix.diff', ['x.sh']],
    ['cd repo/sub && git apply ../fix.diff', ['repo/sub/x.sh']],
    ['rsync -a src.sh bin/', ['bin', 'bin/src.sh']],
    ['scp host:/tmp/a.sh a.sh', ['a.sh']],
    ["sudo sed -i 's/a/b/' a.sh", ['a.sh']],
    ['env LC_ALL=C sed -i -e s/a/b/ a.sh', ['a.sh']],
    ['timeout 5 patch -p1 -i fix.diff', ['x.sh']],
    ['echo x | sudo tee a.sh', ['a.sh']],
  ])('records what %s writes', async (command, expected) => {
    // A copy into what may be a folder also records the file it would create there.
    expect(await writes(command)).toEqual(expect.arrayContaining(expected.map(path => join(root, path))));
  });

  it.each([
    ['tar -xzf a.tgz', ['.']],
    ['tar xzf a.tgz -C bin', ['bin']],
    ['tar -xf a.tar -Cbin', ['bin']],
    ['tar --extract --file a.tar --directory=bin', ['bin']],
    ['tar -xf a.tar scripts/run.sh', ['scripts/run.sh']],
    ['bsdtar -xf a.tar', ['.']],
    ['unzip a.zip', ['.']],
    ['unzip -o a.zip -d bin', ['bin']],
    ['unzip -q a.zip run.sh -x docs/*', ['run.sh']],
    ['7z x a.7z -obin', ['bin']],
    ['cpio -idv < a.cpio', ['.']],
    ['patch -p1 < missing.diff', ['.']],
    ['cat fix.diff | patch -p1', ['.']],
    ['git checkout -- bin', ['bin']],
    ['git checkout HEAD~1 bin/a.sh', ['bin/a.sh']],
    ['git checkout main -- src/*.sh', ['src']],
    ['git restore --source HEAD~1 bin', ['bin']],
    ['git -C repo checkout -- .', ['repo']],
    ["sed -i 's/a/b/' bin/*.sh", ['bin']],
    ['cp -r tools bin', ['bin']],
    ['rsync -a src/ out/', ['out']],
  ])('records the folder %s may rewrite', async (command, expected) => {
    expect(await trees(command)).toEqual(expected.map(path => join(root, path)));
  });

  it.each([
    'tar -tf a.tar',
    'tar -czf a.tgz bin',
    'unzip -l a.zip',
    'unzip -p a.zip run.sh',
    '7z l a.7z',
    'git checkout main',
    'git checkout -b feature origin/main',
    'git switch main',
    "sed -i '/TODO*/d' a.txt",
    "gawk -i inplace '/[0-9]/{print}' a.txt",
    'cp a.sh bin',
  ])('records no folder for %s', async command => {
    expect(await trees(command)).toEqual([]);
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
    "sed 's/a/b/' a.sh",
    "sed -n '/x/p' a.sh",
    "perl -pe 's/a/b/' a.sh",
    "awk '{print}' a.sh",
    'gzip a.sh',
    'gunzip -c a.sh.gz',
    'gzip -dc a.sh.gz',
    'patch --dry-run -p1 < fix.diff',
    'git apply --check fix.diff',
    'git apply --cached fix.diff',
    'tar -xOf a.tar run.sh',
  ])('records nothing for %s', async command => {
    expect(await writes(command)).toEqual([]);
  });

  it.each([
    ["sed -i 's/a/b/' a.sh", ['a.sh']],
    ["sed -i '' 's/a/b/' a.sh", ['a.sh']],
    ["sed -ie 's/a/b/' a.sh", ['a.sh']],
    ["sed --expression 's/a/b/' -i a.sh", ['a.sh']],
    ['perl -i script.pl a.txt', ['a.txt']],
    ["perl -pie 's/a/b/' a.txt", ['a.txt']],
    ["gawk -iinplace '{print}' a.sh", ['a.sh']],
  ])('records only the edited files for %s, not the program', async (command, expected) => {
    expect(await writes(command)).toEqual(expected.map(path => join(root, path)));
  });
});
