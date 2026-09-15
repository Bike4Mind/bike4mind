import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { loadHelpArticles, type LoadedHelpArticle } from '@bike4mind/scripts/help/loadHelpArticles';
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

describe('help content rendering', () => {
  let articles: LoadedHelpArticle[];

  beforeAll(async () => {
    articles = await loadHelpArticles();
  });

  it('loads a non-empty help corpus', () => {
    expect(articles.length).toBeGreaterThan(0);
  });

  // Renders the ENTIRE help corpus synchronously through the markdown pipeline, so wall-clock
  // scales with corpus size and CPU availability - not a latency assertion. Under the sharded
  // CI test gate (many packages' vitest pools contend for cores) the default 5s timeout flakes;
  // give it generous headroom so a slow-but-correct render doesn't fail the required check.
  it('renders every help article through the Help Panel markdown pipeline without error', () => {
    const failures: { file: string; error: string }[] = [];

    for (const article of articles) {
      try {
        const html = renderArticle(article.content);
        // A non-trivial article should produce some rendered output.
        if (article.content.trim().length > 0 && html.trim().length === 0) {
          failures.push({ file: article.relativePath, error: 'rendered to empty output' });
        }
      } catch (err) {
        failures.push({ file: article.relativePath, error: (err as Error).message });
      }
    }

    expect(failures, `Articles failed to render:\n${failures.map(f => `  ${f.file}: ${f.error}`).join('\n')}`).toEqual(
      []
    );
  }, 30_000);

  it('renders a markdown <details>/<summary> block through the accordion pipeline', () => {
    // Exercises the rehype-raw + details/summary path the renderer supports.
    const md = ['<details>', '<summary>More info</summary>', '', 'Hidden accordion body.', '', '</details>'].join('\n');
    const html = renderArticle(md);
    // The summary label and body survive sanitization and render (not stripped away).
    expect(html).toContain('More info');
    expect(html).toContain('Hidden accordion body.');
  });
});
