import { describe, it, expect } from 'vitest';
import { resolveHelpLinkSlug } from './HelpContent';

/**
 * Unit tests for resolveHelpLinkSlug - the relative-link resolution used by the
 * Help Panel renderer. Regression coverage: index-page relative links must
 * resolve against the article FILE path, not its slug (whose "/index" segment is
 * dropped). Uses the real resolveRelativePath (no utils mock).
 */
describe('resolveHelpLinkSlug', () => {
  it('resolves a relative link from an index page against its file path (the bug)', () => {
    // Slug drops "/index"; resolving against the slug would wrongly yield "features/scheduling".
    expect(resolveHelpLinkSlug('./scheduling.md', 'features/opti/index.md', 'features/opti')).toBe(
      'features/opti/scheduling'
    );
  });

  it('resolves a relative link from a regular (non-index) page', () => {
    // For non-index pages the file base equals the slug, so behavior is unchanged.
    expect(resolveHelpLinkSlug('./billing.md', 'features/opti/scheduling.md', 'features/opti/scheduling')).toBe(
      'features/opti/billing'
    );
  });

  it('resolves a parent-directory link from an index page against its directory', () => {
    // The index file lives in "features/opti/", so "../" goes up to "features/".
    expect(resolveHelpLinkSlug('../billing.md', 'features/opti/index.md', 'features/opti')).toBe('features/billing');
  });

  it('resolves an absolute path independent of the current article', () => {
    expect(resolveHelpLinkSlug('/admin/users.md', 'features/opti/index.md', 'features/opti')).toBe('admin/users');
  });

  it('falls back to the slug when the file path is not yet known', () => {
    // Before the article resolves, currentFilePath is undefined; resolution uses the slug.
    expect(resolveHelpLinkSlug('./scheduling.md', undefined, 'features/opti/scheduling')).toBe(
      'features/opti/scheduling'
    );
  });

  // The target-side half: a relative link TO an index page must collapse the
  // trailing "/index" so it matches the index article's canonical slug.
  it('collapses a "./index.md" back-link to the parent index slug (the bug)', () => {
    // Integrations "Overview" back-link: resolves to features/integrations/index -> features/integrations.
    expect(
      resolveHelpLinkSlug(
        './index.md',
        'features/integrations/github-integration.md',
        'features/integrations/github-integration'
      )
    ).toBe('features/integrations');
  });

  it('collapses an extensionless "./index" back-link', () => {
    expect(
      resolveHelpLinkSlug(
        './index',
        'features/integrations/github-integration.md',
        'features/integrations/github-integration'
      )
    ).toBe('features/integrations');
  });

  it('collapses a cross-directory "../dir/index.md" link', () => {
    expect(
      resolveHelpLinkSlug('../technical_docs/b4m-wiki/index.md', 'roadmap/battle-plan.md', 'roadmap/battle-plan')
    ).toBe('technical_docs/b4m-wiki');
  });

  it('collapses an absolute "/dir/index.md" link', () => {
    expect(resolveHelpLinkSlug('/deployment/index.md', 'features/opti/scheduling.md', 'features/opti/scheduling')).toBe(
      'deployment'
    );
  });

  it('does not collapse a bare root "index" to empty (preserves the home slug)', () => {
    // The renderer's home page uses the literal slug 'index'; it must not become ''.
    expect(resolveHelpLinkSlug('/index.md', 'features/opti/scheduling.md', 'features/opti/scheduling')).toBe('index');
    expect(resolveHelpLinkSlug('./index.md', 'getting-started.md', 'getting-started')).toBe('index');
  });

  it('resolves a "../.." link that walks past the docs root to the home slug (documented divergence)', () => {
    // A link that climbs above the root resolves to bare 'index' and lands on the
    // panel home page. This is the intentional divergence from the validator's
    // normalizeSlug (which maps bare 'index' -> ''); pinned here so it stays visible.
    expect(resolveHelpLinkSlug('../../index.md', 'features/opti/index.md', 'features/opti')).toBe('index');
  });
});
