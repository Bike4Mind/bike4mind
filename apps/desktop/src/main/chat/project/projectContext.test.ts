import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { git } from './git';
import {
  MAX_INSTRUCTIONS_BYTES,
  MAX_TREE_BYTES,
  MAX_TREE_LINES,
  ProjectContextCache,
  loadProjectContext,
  renderTree,
} from './projectContext';

async function scratch(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'b4m-context-')));
}

async function gitRepo(): Promise<string> {
  const dir = await scratch();
  await git(dir, ['init', '--initial-branch=main', '--quiet']);
  return dir;
}

describe('loadProjectContext instructions', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scratch();
  });

  it('prefers CLAUDE.md over AGENTS.md', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), 'claude rules', 'utf8');
    await writeFile(join(dir, 'AGENTS.md'), 'agents rules', 'utf8');
    const block = await loadProjectContext(dir, dir);
    expect(block).toContain('claude rules');
    expect(block).not.toContain('agents rules');
  });

  it('falls back to AGENTS.md', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'agents rules', 'utf8');
    expect(await loadProjectContext(dir, dir)).toContain('agents rules');
  });

  it('falls back to the project directory when the worktree has none', async () => {
    const worktree = await scratch();
    await writeFile(join(dir, 'CLAUDE.md'), 'main rules', 'utf8');
    expect(await loadProjectContext(worktree, dir)).toContain('main rules');
  });

  it('prefers the worktree copy over the project directory copy', async () => {
    const worktree = await scratch();
    await writeFile(join(dir, 'CLAUDE.md'), 'main rules', 'utf8');
    await writeFile(join(worktree, 'CLAUDE.md'), 'branch rules', 'utf8');
    const block = await loadProjectContext(worktree, dir);
    expect(block).toContain('branch rules');
    expect(block).not.toContain('main rules');
  });

  it('omits everything for an empty directory', async () => {
    expect(await loadProjectContext(dir, dir)).toBe('');
  });

  it('truncates a large file on a line boundary and says how to read the rest', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`);
    await writeFile(join(dir, 'CLAUDE.md'), lines.join('\n'), 'utf8');
    const block = await loadProjectContext(dir, dir);
    expect(block.length).toBeLessThan(MAX_INSTRUCTIONS_BYTES + 2_000);
    const shown = /first (\d+) lines/.exec(block);
    expect(shown).not.toBeNull();
    const count = Number(shown?.[1]);
    expect(block).toContain(`file_read on ${join(dir, 'CLAUDE.md')} with offset ${count + 1}`);
    expect(block).toContain(`line ${count} `);
    expect(block).not.toContain(`line ${count + 1} `);
  });
});

describe('renderTree', () => {
  it('lists top-level files, one level down, and collapses deeper directories to counts', () => {
    const tree = renderTree([
      'README.md',
      'src/index.ts',
      'src/util/a.ts',
      'src/util/b.ts',
      'src/util/deep/c.ts',
      'docs/guide.md',
    ]);
    expect(tree.split('\n')).toEqual([
      'README.md',
      'docs/ (1 file)',
      '  guide.md',
      'src/ (4 files)',
      '  util/ (3 files)',
      '  index.ts',
    ]);
  });

  it('keeps breadth by limiting files per directory', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `big/f${String(i).padStart(2, '0')}.ts`);
    const tree = renderTree([...paths, 'zzz/only.ts']);
    expect(tree).toContain('... 18 more files');
    expect(tree).toContain('zzz/ (1 file)');
  });

  it('caps lines and marks the truncation', () => {
    const paths = Array.from({ length: 400 }, (_, i) => `d${String(i).padStart(3, '0')}/f.ts`);
    const lines = renderTree(paths).split('\n');
    expect(lines).toHaveLength(MAX_TREE_LINES + 1);
    expect(lines.at(-1)).toMatch(/truncated, \d+ more entries/);
  });

  it('caps bytes and marks the truncation', () => {
    const paths = Array.from({ length: 100 }, (_, i) => `${'n'.repeat(120)}${i}/f.ts`);
    const tree = renderTree(paths);
    expect(Buffer.byteLength(tree)).toBeLessThan(MAX_TREE_BYTES + 200);
    expect(tree).toMatch(/truncated/);
  });
});

describe('loadProjectContext tree', () => {
  it('leaves out ignored files in a git repository', async () => {
    const dir = await gitRepo();
    await writeFile(join(dir, '.gitignore'), 'secret.log\nout/\n', 'utf8');
    await writeFile(join(dir, 'secret.log'), 'x', 'utf8');
    await writeFile(join(dir, 'keep.ts'), 'x', 'utf8');
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'out', 'bundle.js'), 'x', 'utf8');
    const block = await loadProjectContext(dir, dir);
    expect(block).toContain('keep.ts');
    expect(block).not.toContain('secret.log');
    expect(block).not.toContain('bundle.js');
  });

  it('falls back to a directory walk that skips node_modules, .git, dist and build', async () => {
    const dir = await scratch();
    for (const skipped of ['node_modules', '.git', 'dist', 'build']) {
      await mkdir(join(dir, skipped));
      await writeFile(join(dir, skipped, 'x.js'), 'x', 'utf8');
    }
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'main.ts'), 'x', 'utf8');
    const block = await loadProjectContext(dir, dir);
    expect(block).toContain('src/ (1 file)');
    expect(block).toContain('main.ts');
    expect(block).not.toMatch(/node_modules|dist\/|build\/|\.git\//);
  });

  it('omits the tree for a directory that does not exist', async () => {
    expect(await loadProjectContext(join(tmpdir(), 'b4m-nope-does-not-exist'), '/nonexistent')).toBe('');
  });
});

describe('ProjectContextCache', () => {
  it('returns the same snapshot even after files change, until the working directory changes', async () => {
    const dir = await scratch();
    const other = await scratch();
    await writeFile(join(dir, 'first.ts'), 'x', 'utf8');
    await writeFile(join(other, 'other.ts'), 'x', 'utf8');
    const cache = new ProjectContextCache();

    const before = await cache.get('s1', dir, dir);
    await writeFile(join(dir, 'created-later.ts'), 'x', 'utf8');
    const after = await cache.get('s1', dir, dir);

    expect(after).toBe(before);
    expect(after).not.toContain('created-later.ts');

    const moved = await cache.get('s1', other, other);
    expect(moved).toContain('other.ts');
    expect(moved).not.toBe(before);
  });

  it('keeps sessions apart', async () => {
    const dir = await scratch();
    const cache = new ProjectContextCache();
    await writeFile(join(dir, 'a.ts'), 'x', 'utf8');
    const a = await cache.get('a', dir, dir);
    await writeFile(join(dir, 'b.ts'), 'x', 'utf8');
    expect(await cache.get('b', dir, dir)).toContain('b.ts');
    expect(await cache.get('a', dir, dir)).toBe(a);
  });
});
