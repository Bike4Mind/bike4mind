import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HelpIndexEntry } from '../types';
import { buildHelpIndex, buildIndexFromEntries, compareEntries } from '../build-help-index';
import type { LoadedHelpArticle } from '../loadHelpArticles';

function makeEntry(overrides: Partial<HelpIndexEntry> & Pick<HelpIndexEntry, 'slug'>): HelpIndexEntry {
  return {
    title: overrides.slug,
    description: '',
    category: 'features',
    sidebarPosition: 1,
    tags: [],
    headings: [],
    filePath: `${overrides.slug}.md`,
    accessLevel: 'public',
    ...overrides,
  };
}

describe('buildIndexFromEntries version', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is identical across repeated builds of the same corpus, regardless of wall-clock time', () => {
    const entries = [makeEntry({ slug: 'features/a' }), makeEntry({ slug: 'features/b' })];

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const first = buildIndexFromEntries(entries);

    vi.setSystemTime(new Date('2030-06-15T12:00:00.000Z'));
    const second = buildIndexFromEntries(entries);

    expect(second.version).toBe(first.version);
  });

  it('is identical regardless of the order entries were discovered in', () => {
    const entries = [makeEntry({ slug: 'features/a' }), makeEntry({ slug: 'features/b' })];
    const shuffled = [...entries].reverse();

    expect(buildIndexFromEntries(shuffled).version).toBe(buildIndexFromEntries(entries).version);
  });

  it('changes when article content changes', () => {
    const before = [makeEntry({ slug: 'features/a', title: 'Old title' })];
    const after = [makeEntry({ slug: 'features/a', title: 'New title' })];

    expect(buildIndexFromEntries(after).version).not.toBe(buildIndexFromEntries(before).version);
  });
});

describe('compareEntries', () => {
  it('orders a shallow index article before deeper same-position siblings, tied by slug', () => {
    const indexArticle = makeEntry({ slug: 'features', sidebarPosition: 1 });
    const integrations = makeEntry({ slug: 'features/integrations', sidebarPosition: 1 });
    const knowledgeManagement = makeEntry({ slug: 'features/knowledge-management', sidebarPosition: 1 });
    const expectedSlugs = [indexArticle, integrations, knowledgeManagement].map(e => e.slug);

    const ascending = [indexArticle, integrations, knowledgeManagement];
    const descending = [knowledgeManagement, integrations, indexArticle];

    expect(
      ascending
        .slice()
        .sort(compareEntries)
        .map(e => e.slug)
    ).toEqual(expectedSlugs);
    expect(
      descending
        .slice()
        .sort(compareEntries)
        .map(e => e.slug)
    ).toEqual(expectedSlugs);
  });
});

/**
 * The empty-corpus guard. The client `prebuild` runs this script, so a docs tree that
 * is missing from the build context has to redden the build rather than overwrite the
 * index with an empty one.
 */
describe('buildHelpIndex', () => {
  let root: string;

  const outputPath = () => path.join(root, 'help-index.json');

  function article(overrides: Partial<LoadedHelpArticle> = {}): LoadedHelpArticle {
    return {
      filePath: '/docs/features/a.md',
      relativePath: 'features/a.md',
      slug: 'features/a',
      category: 'features',
      accessLevel: 'public',
      frontmatter: { title: 'A' },
      content: '# A\n',
      headings: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-index-test-'));
    // The builder narrates every step; keep test output quiet.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes an index for a non-empty corpus', async () => {
    await buildHelpIndex({ outputPath: outputPath(), loadArticles: async () => [article()] });

    const index = JSON.parse(fs.readFileSync(outputPath(), 'utf-8'));
    expect(index.entries.map((e: { slug: string }) => e.slug)).toEqual(['features/a']);
  });

  it('throws and writes nothing when the corpus is empty', async () => {
    await expect(buildHelpIndex({ outputPath: outputPath(), loadArticles: async () => [] })).rejects.toThrow(
      /No indexable help articles found/
    );

    expect(fs.existsSync(outputPath())).toBe(false);
  });

  it('throws when articles are found but none is indexable', async () => {
    const untitled = article({ frontmatter: {} });

    await expect(buildHelpIndex({ outputPath: outputPath(), loadArticles: async () => [untitled] })).rejects.toThrow(
      /1 markdown files scanned/
    );

    expect(fs.existsSync(outputPath())).toBe(false);
  });

  it('leaves an existing index untouched when it refuses to write', async () => {
    fs.writeFileSync(outputPath(), 'previous-index');

    await expect(buildHelpIndex({ outputPath: outputPath(), loadArticles: async () => [] })).rejects.toThrow();

    expect(fs.readFileSync(outputPath(), 'utf-8')).toBe('previous-index');
  });
});
