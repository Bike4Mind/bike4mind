import { describe, it, expect } from 'vitest';
import { loadHelpArticles } from '../loadHelpArticles';
import { validateArticles, formatFindings } from '../validate-help-content';

/**
 * CI gate: validate the REAL help corpus (docs-site/docs/{features,admin}) against
 * the shared validator. This runs in the standard test suite, so broken links,
 * missing images, bad anchors, or missing frontmatter fail CI without a bespoke
 * workflow. (Unit-level behavior is covered in validate-help-content.test.ts.)
 */
describe('help corpus validation', () => {
  it('every help article passes link/anchor/image/frontmatter validation', async () => {
    const articles = await loadHelpArticles();
    expect(articles.length).toBeGreaterThan(0);

    const findings = validateArticles(articles);
    expect(findings, `Help content validation failed:\n${formatFindings(findings)}`).toEqual([]);
  });
});
