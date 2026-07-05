import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  stripCodeSpans,
  extractMarkdownLinks,
  getArticleAnchors,
  validateFrontmatter,
  validateArticles,
} from '../validate-help-content';
import type { LoadedHelpArticle } from '../loadHelpArticles';
import type { HelpFrontmatter } from '../types';

const DOCS_ROOT = '/docs';

/** Build a LoadedHelpArticle fixture. `slug`/`relativePath` derived from filePath. */
function makeArticle(relativePath: string, content: string, frontmatter: HelpFrontmatter = {}): LoadedHelpArticle {
  const slug = relativePath.replace(/\.md$/, '').replace(/\/index$/, '');
  return {
    filePath: path.join(DOCS_ROOT, relativePath),
    relativePath,
    slug: slug === 'index' ? '' : slug,
    category: relativePath.split('/')[0],
    accessLevel: 'public',
    frontmatter: { title: 'T', description: 'D', ...frontmatter },
    content,
    headings: [],
  };
}

describe('stripCodeSpans', () => {
  it('blanks fenced code blocks but preserves line count', () => {
    const md = ['before', '```', '[x](./real.md)', '```', 'after'].join('\n');
    const out = stripCodeSpans(md);
    expect(out.split('\n')).toHaveLength(5); // line count preserved
    expect(out).not.toContain('real.md'); // link inside fence is gone
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('blanks inline code and HTML comments', () => {
    expect(stripCodeSpans('use `[x](./y.md)` here')).not.toContain('y.md');
    expect(stripCodeSpans('<!-- [x](./y.md) -->')).not.toContain('y.md');
  });
});

describe('extractMarkdownLinks', () => {
  it('extracts links and images with correct image flag', () => {
    const links = extractMarkdownLinks('[a](./a.md) and ![img](./b.png)');
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ target: './a.md', isImage: false });
    expect(links[1]).toMatchObject({ target: './b.png', isImage: true });
  });

  it('ignores links inside code spans', () => {
    const links = extractMarkdownLinks('`[a](./a.md)` real [b](./b.md)');
    expect(links.map(l => l.target)).toEqual(['./b.md']);
  });

  it('drops a title suffix from the target', () => {
    const links = extractMarkdownLinks('[a](./a.md "Title here")');
    expect(links[0].target).toBe('./a.md');
  });

  it('reports 1-based line numbers', () => {
    const links = extractMarkdownLinks('line1\nline2 [a](./a.md)');
    expect(links[0].line).toBe(2);
  });
});

describe('getArticleAnchors', () => {
  it('computes auto anchors from heading text', () => {
    const anchors = getArticleAnchors('## Getting Started\n### Sub Section');
    expect(anchors.has('getting-started')).toBe(true);
    expect(anchors.has('sub-section')).toBe(true);
  });

  it('honors explicit Docusaurus heading ids and still adds the auto anchor', () => {
    const anchors = getArticleAnchors('## Webhook Issues {#webhooks}');
    expect(anchors.has('webhooks')).toBe(true); // explicit id
    expect(anchors.has('webhook-issues')).toBe(true); // auto anchor of cleaned text
  });
});

describe('validateFrontmatter', () => {
  it('passes a complete frontmatter', () => {
    expect(validateFrontmatter(makeArticle('features/a.md', 'body'))).toEqual([]);
  });

  it('flags missing title and description', () => {
    const article = makeArticle('features/a.md', 'body', { title: '', description: '' });
    const messages = validateFrontmatter(article).map(f => f.message);
    expect(messages).toContain('Missing required frontmatter field: title');
    expect(messages).toContain('Missing required frontmatter field: description');
  });

  it('flags a non-numeric sidebar_position and non-array tags', () => {
    const article = makeArticle('features/a.md', 'body', {
      // @ts-expect-error intentional wrong type for validation test
      sidebar_position: 'first',
      // @ts-expect-error intentional wrong type for validation test
      tags: 'nope',
    });
    const messages = validateFrontmatter(article).map(f => f.message);
    expect(messages.some(m => m.includes('sidebar_position'))).toBe(true);
    expect(messages.some(m => m.includes('tags'))).toBe(true);
  });
});

describe('validateArticles — links', () => {
  const opts = (existing: string[] = []) => ({
    docsRoot: DOCS_ROOT,
    fileExists: (p: string) => existing.map(e => path.join(DOCS_ROOT, e)).includes(p),
  });

  it('accepts a relative link to an existing article file', () => {
    const articles = [makeArticle('features/a.md', '[b](./b.md)'), makeArticle('features/b.md', '')];
    const findings = validateArticles(articles, opts(['features/b.md']));
    expect(findings.filter(f => f.type === 'link')).toEqual([]);
  });

  it('flags a relative link to a missing article file', () => {
    const articles = [makeArticle('features/a.md', '[gone](./missing.md)')];
    const findings = validateArticles(articles, opts([]));
    expect(findings.filter(f => f.type === 'link')).toHaveLength(1);
  });

  it('resolves ../ against the article file directory', () => {
    const articles = [makeArticle('features/sub/a.md', '[up](../overview.md)')];
    const ok = validateArticles(articles, opts(['features/overview.md']));
    expect(ok.filter(f => f.type === 'link')).toEqual([]);
    const bad = validateArticles(articles, opts([]));
    expect(bad.filter(f => f.type === 'link')).toHaveLength(1);
  });

  it('resolves an index page link to <path>/index.md', () => {
    // From features/integrations/sub.md, ./index.md -> features/integrations/index.md
    const articles = [makeArticle('features/integrations/sub.md', '[home](./index.md)')];
    const findings = validateArticles(articles, opts(['features/integrations/index.md']));
    expect(findings.filter(f => f.type === 'link')).toEqual([]);
  });

  it('resolves an absolute Docusaurus /docs/ link by stripping the base', () => {
    const articles = [makeArticle('features/a.md', '[cli](/docs/features/tavern/cli)')];
    const findings = validateArticles(articles, opts(['features/tavern/cli.md']));
    expect(findings.filter(f => f.type === 'link')).toEqual([]);
  });

  it('skips external links', () => {
    const articles = [makeArticle('features/a.md', '[ext](https://example.com/page.md)')];
    const findings = validateArticles(articles, opts([]));
    expect(findings.filter(f => f.type === 'link')).toEqual([]);
  });
});

describe('validateArticles — anchors', () => {
  const noFiles = { docsRoot: DOCS_ROOT, fileExists: () => false };

  it('accepts a same-page anchor that matches a heading', () => {
    const articles = [makeArticle('features/a.md', '## Setup\n[go](#setup)')];
    expect(validateArticles(articles, noFiles).filter(f => f.type === 'anchor')).toEqual([]);
  });

  it('flags a same-page anchor with no matching heading', () => {
    const articles = [makeArticle('features/a.md', '## Setup\n[go](#missing)')];
    expect(validateArticles(articles, noFiles).filter(f => f.type === 'anchor')).toHaveLength(1);
  });

  it('flags a cross-article anchor missing in the target article', () => {
    const articles = [
      makeArticle('features/a.md', '[b](./b.md#nope)'),
      makeArticle('features/b.md', '## Real Section'),
    ];
    const findings = validateArticles(articles, {
      docsRoot: DOCS_ROOT,
      fileExists: (p: string) => p === path.join(DOCS_ROOT, 'features/b.md'),
    });
    expect(findings.filter(f => f.type === 'anchor')).toHaveLength(1);
  });

  it('accepts a cross-article anchor present in the target article', () => {
    const articles = [
      makeArticle('features/a.md', '[b](./b.md#real-section)'),
      makeArticle('features/b.md', '## Real Section'),
    ];
    const findings = validateArticles(articles, {
      docsRoot: DOCS_ROOT,
      fileExists: (p: string) => p === path.join(DOCS_ROOT, 'features/b.md'),
    });
    expect(findings.filter(f => f.type === 'anchor')).toEqual([]);
  });
});

describe('validateArticles — images', () => {
  it('flags a missing image and accepts an existing one', () => {
    const missing = [makeArticle('features/a.md', '![x](./img/pic.png)')];
    expect(
      validateArticles(missing, { docsRoot: DOCS_ROOT, fileExists: () => false }).filter(f => f.type === 'image')
    ).toHaveLength(1);

    const present = [makeArticle('features/a.md', '![x](./img/pic.png)')];
    expect(
      validateArticles(present, {
        docsRoot: DOCS_ROOT,
        fileExists: (p: string) => p === path.join(DOCS_ROOT, 'features/img/pic.png'),
      }).filter(f => f.type === 'image')
    ).toEqual([]);
  });
});
