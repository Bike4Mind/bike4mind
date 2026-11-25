import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { loadHelpArticles } from '@bike4mind/scripts/help/loadHelpArticles';
import { remarkPlugins, rehypePlugins, markdownComponents } from './HelpContent';

/**
 * Integration test: every user-facing help article must render through the SAME
 * markdown pipeline the in-app Help Panel uses, without throwing.
 *
 * To guarantee true parity (and prevent the test from silently drifting when the
 * renderer's plugins/components change), this imports the ACTUAL `remarkPlugins`,
 * `rehypePlugins`, and `markdownComponents` exported by HelpContent.tsx - including
 * rehype-raw and the <details>/<summary> accordion handling - rather than
 * reconstructing an approximation of them here.
 */

function renderArticle(content: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

// Loaded at collection so each article is its own test: the corpus renders in well over the
// per-test budget as one test, and a failure then names its article.
const articles = await loadHelpArticles();

describe('help content rendering', () => {
  it('loads a non-empty help corpus', () => {
    expect(articles.length).toBeGreaterThan(0);
  });

  it.each(articles.map(article => [article.relativePath, article] as const))(
    'renders every help article through the Help Panel markdown pipeline without error: %s',
    (_path, article) => {
      const html = renderArticle(article.content);
      // A non-trivial article should produce some rendered output.
      if (article.content.trim().length > 0) expect(html.trim().length, 'rendered to empty output').toBeGreaterThan(0);
    }
  );

  it('renders a markdown <details>/<summary> block through the accordion pipeline', () => {
    // Exercises the rehype-raw + details/summary path the renderer supports.
    const md = ['<details>', '<summary>More info</summary>', '', 'Hidden accordion body.', '', '</details>'].join('\n');
    const html = renderArticle(md);
    // The summary label and body survive sanitization and render (not stripped away).
    expect(html).toContain('More info');
    expect(html).toContain('Hidden accordion body.');
  });
});
