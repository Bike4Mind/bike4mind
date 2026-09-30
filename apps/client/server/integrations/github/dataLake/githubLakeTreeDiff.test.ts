import { describe, it, expect } from 'vitest';
import { diffGitHubLakeTree } from './githubLakeTreeDiff';

const candidate = (path: string, sha: string) => ({ path, sha, size: 1 });
const copy = (id: string, githubPath: string, githubBlobSha: string, createdAt = '2026-01-01T00:00:00Z') => ({
  id,
  githubPath,
  githubBlobSha,
  createdAt: new Date(createdAt),
});

describe('diffGitHubLakeTree', () => {
  it('splits the tree into add, changed, removed and skip', () => {
    const diff = diffGitHubLakeTree(
      [candidate('same.md', 's1'), candidate('edited.md', 's2-new'), candidate('new.md', 's3')],
      [copy('a', 'same.md', 's1'), copy('b', 'edited.md', 's2-old'), copy('c', 'gone.md', 's4')]
    );
    expect(diff.adds).toEqual([candidate('new.md', 's3')]);
    expect(diff.changed).toEqual([
      { candidate: candidate('edited.md', 's2-new'), prior: copy('b', 'edited.md', 's2-old') },
    ]);
    expect(diff.removed.map(c => c.id)).toEqual(['c']);
    expect(diff.duplicates).toEqual([]);
  });

  it('keeps the newest copy of a live path and retires the rest', () => {
    const newest = copy('new', 'a.md', 's1', '2026-03-01T00:00:00Z');
    const older = copy('old', 'a.md', 's1', '2026-01-01T00:00:00Z');
    const oldest = copy('oldest', 'a.md', 's0', '2025-01-01T00:00:00Z');
    const diff = diffGitHubLakeTree([candidate('a.md', 's1')], [older, oldest, newest]);
    expect(diff.duplicates).toEqual([{ keep: newest, retire: [older, oldest] }]);
    expect(diff.changed).toEqual([]);
    expect(diff.adds).toEqual([]);
  });

  it('diffs a duplicated path against its newest copy', () => {
    const newest = copy('new', 'a.md', 's1', '2026-03-01T00:00:00Z');
    const older = copy('old', 'a.md', 's2', '2026-01-01T00:00:00Z');
    const diff = diffGitHubLakeTree([candidate('a.md', 's2')], [older, newest]);
    expect(diff.changed).toEqual([{ candidate: candidate('a.md', 's2'), prior: newest }]);
    expect(diff.duplicates).toEqual([{ keep: newest, retire: [older] }]);
  });

  it('removes every copy of a path that left the tree', () => {
    const diff = diffGitHubLakeTree(
      [],
      [copy('x', 'gone.md', 's1'), copy('y', 'gone.md', 's1', '2026-02-01T00:00:00Z')]
    );
    expect(diff.removed.map(c => c.id).sort()).toEqual(['x', 'y']);
    expect(diff.duplicates).toEqual([]);
  });

  it('ignores a stored row that carries no githubPath', () => {
    const diff = diffGitHubLakeTree([candidate('a.md', 's1')], [{ id: 'z', createdAt: new Date() }]);
    expect(diff.adds).toEqual([candidate('a.md', 's1')]);
    expect(diff.removed).toEqual([]);
  });

  it('processes a duplicate path once, not once per repeated candidate', () => {
    const diff = diffGitHubLakeTree([candidate('a.md', 's1'), candidate('a.md', 's1')], [copy('old', 'a.md', 's0')]);
    expect(diff.changed).toEqual([{ candidate: candidate('a.md', 's1'), prior: copy('old', 'a.md', 's0') }]);
    expect(diff.duplicates).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('keeps a retained (still-in-tree but gated) path out of removed without re-ingesting it', () => {
    const diff = diffGitHubLakeTree(
      [candidate('small.md', 's1')],
      [copy('a', 'small.md', 's1'), copy('b', 'grew.md', 's2'), copy('c', 'gone.md', 's3')],
      ['grew.md']
    );
    expect(diff.removed).toEqual([copy('c', 'gone.md', 's3')]);
    expect(diff.adds).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});
