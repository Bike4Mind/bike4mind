import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vectorize-help-content.ts imports these for its embedding step (unused by the
// functions under test here), but they need a core-package build to resolve. The
// Help Docs Guards CI job runs this suite standalone without one, so mock them out.
vi.mock('@bike4mind/fab-pipeline', () => ({ EmbeddingFactory: vi.fn() }));
vi.mock('@bike4mind/common', () => ({ OpenAIEmbeddingModel: { TEXT_EMBEDDING_3_SMALL: 'text-embedding-3-small' } }));

import { loadAccessLevelMap, resolveAccessLevel, relativePathToSlug, buildChunks } from '../vectorize-help-content';

/**
 * accessLevel is the only gate keeping admin-only help docs out of non-admin
 * users' Help AI chat responses (see apps/client/server/help/retrieval.ts).
 * These tests guard both directions of the same failure: an accessLevel must
 * never be inferred from a broken help-index.json or a slug missing from it -
 * guessing 'public' leaks admin docs, guessing 'admin' hides the public ones.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-vectorize-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeIndex(content: string): string {
  const indexPath = path.join(root, 'help-index.json');
  fs.writeFileSync(indexPath, content);
  return indexPath;
}

function writeArticle(relPath: string, title = 'Test Article'): string {
  const contentRoot = path.join(root, 'content');
  const filePath = path.join(contentRoot, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ntitle: ${title}\n---\n\n# ${title}\n\nSome body text.\n`);
  return contentRoot;
}

describe('loadAccessLevelMap', () => {
  it('loads the slug -> accessLevel mapping from a valid index', () => {
    const indexPath = writeIndex(
      JSON.stringify({
        entries: [
          { slug: 'features/foo', accessLevel: 'public' },
          { slug: 'admin/bar', accessLevel: 'admin' },
        ],
      })
    );

    const map = loadAccessLevelMap(indexPath);

    expect(map.get('features/foo')).toBe('public');
    expect(map.get('admin/bar')).toBe('admin');
  });

  it('throws instead of warning when help-index.json is missing', () => {
    const missingPath = path.join(root, 'does-not-exist.json');

    expect(() => loadAccessLevelMap(missingPath)).toThrow();
  });

  it('throws instead of warning when help-index.json is malformed', () => {
    const indexPath = writeIndex('{ this is not valid JSON');

    expect(() => loadAccessLevelMap(indexPath)).toThrow();
  });

  it('throws when entries is absent, rather than iterating undefined', () => {
    const indexPath = writeIndex(JSON.stringify({ version: 'abc123' }));

    expect(() => loadAccessLevelMap(indexPath)).toThrow(/unexpected artifact shape/);
  });

  it('throws when entries is empty, which would leave every slug unresolvable', () => {
    const indexPath = writeIndex(JSON.stringify({ entries: [] }));

    expect(() => loadAccessLevelMap(indexPath)).toThrow(/unexpected artifact shape/);
  });
});

describe('resolveAccessLevel', () => {
  it('returns the mapped access level for a known slug', () => {
    const map = new Map([['features/foo', 'public' as const]]);

    expect(resolveAccessLevel('features/foo', map)).toBe('public');
  });

  it('throws on an unmapped slug rather than inferring a level in either direction', () => {
    const map = new Map([['features/foo', 'public' as const]]);

    expect(() => resolveAccessLevel('features/unmapped', map)).toThrow(/features\/unmapped/);
  });
});

describe('relativePathToSlug', () => {
  it('strips the .md extension', () => {
    expect(relativePathToSlug('features/notebooks.md')).toBe('features/notebooks');
  });

  it('collapses a directory index to the directory itself', () => {
    expect(relativePathToSlug('features/notebooks/index.md')).toBe('features/notebooks');
    expect(relativePathToSlug('index.md')).toBe('');
  });

  it('normalizes Windows separators, which would otherwise miss every index entry', () => {
    expect(relativePathToSlug('features\\notebooks.md')).toBe('features/notebooks');
  });

  it('agrees with filePathToSlug on a Windows directory index', () => {
    // filePathToSlug (loadHelpArticles.ts) also strips `/index` before normalizing
    // separators, so on Windows both leave the trailing `index` in place. What
    // matters is that the index builder and this consumer agree; the shared quirk
    // is worth fixing in one place once the three slug copies are collapsed.
    expect(relativePathToSlug('features\\notebooks\\index.md')).toBe('features/notebooks/index');
  });
});

describe('buildChunks', () => {
  it('resolves accessLevel from the index for both public and admin articles', async () => {
    writeArticle('features/foo.md', 'Public Article');
    const contentRoot = writeArticle('admin/bar.md', 'Admin Article');
    const indexPath = writeIndex(
      JSON.stringify({
        entries: [
          { slug: 'features/foo', accessLevel: 'public' },
          { slug: 'admin/bar', accessLevel: 'admin' },
        ],
      })
    );

    const chunks = await buildChunks({ contentRoot, indexPath });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.filter(chunk => chunk.slug === 'features/foo').every(chunk => chunk.accessLevel === 'public')).toBe(
      true
    );
    expect(chunks.filter(chunk => chunk.slug === 'admin/bar').every(chunk => chunk.accessLevel === 'admin')).toBe(true);
  });

  it('throws when a bundled article has no index entry, naming the offending slug', async () => {
    const contentRoot = writeArticle('admin/unindexed.md');
    const indexPath = writeIndex(JSON.stringify({ entries: [{ slug: 'features/foo', accessLevel: 'public' }] }));

    await expect(buildChunks({ contentRoot, indexPath })).rejects.toThrow(/admin\/unindexed/);
  });

  it('names every unresolvable slug in one error, not just the first', async () => {
    writeArticle('admin/one.md');
    const contentRoot = writeArticle('admin/two.md');
    const indexPath = writeIndex(JSON.stringify({ entries: [{ slug: 'features/foo', accessLevel: 'public' }] }));

    await expect(buildChunks({ contentRoot, indexPath })).rejects.toThrow(/admin\/one.*admin\/two/s);
  });

  it('propagates the loadAccessLevelMap failure instead of vectorizing with an empty map', async () => {
    const contentRoot = writeArticle('features/foo.md');
    const missingPath = path.join(root, 'does-not-exist.json');

    await expect(buildChunks({ contentRoot, indexPath: missingPath })).rejects.toThrow();
  });
});
