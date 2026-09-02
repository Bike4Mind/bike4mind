import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAccessLevelMap, resolveAccessLevel, buildChunks } from '../vectorize-help-content';

/**
 * accessLevel is the only gate keeping admin-only help docs out of non-admin
 * users' Help AI chat responses (see apps/client/server/help/retrieval.ts).
 * These tests guard against a fail-open regression: a broken help-index.json
 * (or a slug missing from it) must never resolve to the less restrictive
 * 'public' level.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-vectorize-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

function writeArticle(relPath: string): string {
  const contentRoot = path.join(root, 'content');
  const filePath = path.join(contentRoot, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '---\ntitle: Test Article\n---\n\n# Test Article\n\nSome body text.\n');
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
});

describe('resolveAccessLevel', () => {
  it('returns the mapped access level for a known slug', () => {
    const map = new Map([['features/foo', 'public' as const]]);

    expect(resolveAccessLevel('features/foo', map)).toBe('public');
  });

  it('defaults an unmapped slug to admin, not public', () => {
    const map = new Map([['features/foo', 'public' as const]]);

    expect(resolveAccessLevel('features/unmapped', map)).toBe('admin');
  });

  it('defaults every slug to admin when the map is empty', () => {
    expect(resolveAccessLevel('anything', new Map())).toBe('admin');
  });
});

describe('buildChunks', () => {
  it('fails closed: every chunk defaults to admin when the index has no matching entries', async () => {
    const contentRoot = writeArticle('features/foo.md');
    const indexPath = writeIndex(JSON.stringify({ entries: [] }));

    const chunks = await buildChunks({ contentRoot, indexPath });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(chunk => chunk.accessLevel === 'admin')).toBe(true);
  });

  it('resolves accessLevel from the index when a slug is present', async () => {
    const contentRoot = writeArticle('features/foo.md');
    const indexPath = writeIndex(JSON.stringify({ entries: [{ slug: 'features/foo', accessLevel: 'public' }] }));

    const chunks = await buildChunks({ contentRoot, indexPath });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(chunk => chunk.accessLevel === 'public')).toBe(true);
  });

  it('propagates the loadAccessLevelMap failure instead of vectorizing with an empty map', async () => {
    const contentRoot = writeArticle('features/foo.md');
    const missingPath = path.join(root, 'does-not-exist.json');

    await expect(buildChunks({ contentRoot, indexPath: missingPath })).rejects.toThrow();
  });
});
