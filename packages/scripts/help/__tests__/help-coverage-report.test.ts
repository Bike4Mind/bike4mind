import { describe, it, expect } from 'vitest';
import { extractRouteSegments, isDocumented } from '../help-coverage-report';
import type { LoadedHelpArticle } from '../loadHelpArticles';

function article(slug: string, tags: string[] = []): LoadedHelpArticle {
  return {
    filePath: `/docs/${slug}.md`,
    relativePath: `${slug}.md`,
    slug,
    category: slug.split('/')[0],
    accessLevel: 'public',
    frontmatter: { title: 'T', description: 'D', tags },
    content: '',
    headings: [],
  };
}

describe('extractRouteSegments', () => {
  it('extracts distinct top-level segments, skipping params', () => {
    const src = `
      path: '/notebooks/$id',
      path: '/projects',
      path: '/agents/$id/edit',
      path: '/',
    `;
    expect(extractRouteSegments(src)).toEqual(['notebooks', 'projects', 'agents'].sort());
  });
});

describe('isDocumented', () => {
  const articles = [article('features/notebooks', ['notebooks']), article('features/agents', ['agent'])];

  it('matches by slug segment', () => {
    expect(isDocumented('notebooks', articles)).toBe(true);
  });

  it('matches with simple plural/singular tolerance', () => {
    // route "agents" should match an article tagged "agent"
    expect(isDocumented('agents', articles)).toBe(true);
  });

  it('returns false when nothing documents the segment', () => {
    expect(isDocumented('nonexistent-feature', articles)).toBe(false);
  });
});
