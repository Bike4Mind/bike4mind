import { describe, it, expect } from 'vitest';
import { CATEGORY_ACCESS_LEVELS, INCLUDED_CATEGORIES, accessLevelForCategory } from '../loadHelpArticles';

/**
 * The producer half of the access-level split. Every consumer of `accessLevel` is fail-closed
 * (see `isPublicAccessLevel` in ../utils.ts), but that is worth nothing if the value itself
 * defaults to 'public' - an unmapped category would be copied into the unauthenticated public
 * root by bundle-help-content.ts on a green build.
 */
describe('accessLevelForCategory', () => {
  it('maps every included category', () => {
    // The real guard: adding to INCLUDED_CATEGORIES without adding to CATEGORY_ACCESS_LEVELS is
    // the mistake this pins, and it fails here rather than at publish time.
    for (const category of INCLUDED_CATEGORIES) {
      expect(() => accessLevelForCategory(category)).not.toThrow();
    }
  });

  it('resolves the declared levels', () => {
    expect(accessLevelForCategory('features')).toBe('public');
    expect(accessLevelForCategory('admin')).toBe('admin');
  });

  it('throws for an unmapped category instead of defaulting to public', () => {
    expect(() => accessLevelForCategory('internal-runbooks')).toThrow(/no CATEGORY_ACCESS_LEVELS/);
  });

  it('names the offending category, so the build error is actionable', () => {
    expect(() => accessLevelForCategory('internal-runbooks')).toThrow(/internal-runbooks/);
  });

  it('does not treat inherited Object properties as a mapping', () => {
    // CATEGORY_ACCESS_LEVELS is a plain object, so a category literally named `constructor` or
    // `toString` would otherwise resolve to a truthy prototype member and skip the throw.
    expect(() => accessLevelForCategory('constructor')).toThrow(/no CATEGORY_ACCESS_LEVELS/);
    expect(() => accessLevelForCategory('toString')).toThrow(/no CATEGORY_ACCESS_LEVELS/);
  });

  it('declares no level outside the HelpAccessLevel union', () => {
    for (const level of Object.values(CATEGORY_ACCESS_LEVELS)) {
      expect(['public', 'admin']).toContain(level);
    }
  });
});
