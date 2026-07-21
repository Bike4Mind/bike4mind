import { describe, it, expect } from 'vitest';
import path from 'path';
import type { HelpIndexEntry } from '../types';
import { DOCS_ROOT, I18N_ROOT, DEFAULT_LOCALE, localeContentRoot, discoverLocales } from '../loadHelpArticles';
import { applyLocaleFallback } from '../build-help-index';

const entry = (slug: string, title: string): HelpIndexEntry => ({
  slug,
  title,
  description: '',
  category: 'features',
  sidebarPosition: 1,
  tags: [],
  headings: [],
  filePath: `features/${slug.split('/').pop()}.md`,
  accessLevel: 'public',
});

describe('locale content roots', () => {
  it('resolves English to DOCS_ROOT and other locales under I18N_ROOT', () => {
    expect(localeContentRoot(DEFAULT_LOCALE)).toBe(DOCS_ROOT);
    expect(localeContentRoot('es')).toBe(path.join(I18N_ROOT, 'es'));
  });

  it('always includes English in discovered locales', () => {
    expect(discoverLocales()).toContain(DEFAULT_LOCALE);
  });
});

describe('applyLocaleFallback', () => {
  const en = [entry('features/a', 'A'), entry('features/b', 'B'), entry('features/c', 'C')];

  it('replaces English entries with translated ones by slug and falls back for the rest', () => {
    const localized = [entry('features/b', 'B (es)')];
    const merged = applyLocaleFallback(en, localized);

    expect(merged.map(e => e.title)).toEqual(['A', 'B (es)', 'C']);
    // Slug coverage always matches English, regardless of how much is translated.
    expect(merged.map(e => e.slug)).toEqual(en.map(e => e.slug));
  });

  it('preserves English order even when translations arrive in a different order', () => {
    const localized = [entry('features/c', 'C (es)'), entry('features/a', 'A (es)')];
    const merged = applyLocaleFallback(en, localized);
    expect(merged.map(e => e.title)).toEqual(['A (es)', 'B', 'C (es)']);
  });

  it('ignores translated entries whose slug is not in the English set', () => {
    const localized = [entry('features/ghost', 'Ghost (es)')];
    const merged = applyLocaleFallback(en, localized);
    expect(merged.map(e => e.title)).toEqual(['A', 'B', 'C']);
  });
});
