import { describe, it, expect, afterEach, vi } from 'vitest';
import type { HelpIndexEntry } from '../types';
import { buildIndexFromEntries, compareEntries } from '../build-help-index';

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
