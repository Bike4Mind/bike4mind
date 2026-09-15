import { describe, it, expect } from 'vitest';
import {
  FEATURE_PATH_PREFIXES,
  getCurrentPathFromContext,
  isNavigableFeaturePath,
  VIEW_REGISTRY,
} from './viewRegistry';

describe('FEATURE_PATH_PREFIXES', () => {
  it('is derived from the registry, not hardcoded', () => {
    const expected = new Set(
      VIEW_REGISTRY.filter(v => v.navigationType === 'route' && v.target.startsWith('/') && v.target !== '/').map(
        v => `/${v.target.split('/')[1]}`
      )
    );
    expect(new Set(FEATURE_PATH_PREFIXES)).toEqual(expected);
  });

  it('does not include the main chat root', () => {
    expect(FEATURE_PATH_PREFIXES).not.toContain('/');
  });
});

describe('VIEW_REGISTRY descriptions', () => {
  // Every description is spliced verbatim into the navigate_view system prompt by
  // getViewSummaryForLLM, so a stale one misinforms the model with nothing to catch it.
  // Counts of things this repo cannot count are the drift-prone case: the catalogues they
  // quantify live in packages this one does not import, so no build error ever fires.
  // opti.root carried such a count until it had gone badly stale. Describe, do not tally.
  const INVENTORY_COUNT = /\b\d+\b[^.]*\b(famil|pattern|solver|card)/i;

  it('quantify no catalogue this package cannot count', () => {
    const offenders = VIEW_REGISTRY.filter(v => INVENTORY_COUNT.test(v.description)).map(v => v.id);
    expect(offenders).toEqual([]);
  });
});

describe('getCurrentPathFromContext', () => {
  it('returns null for undefined or empty input', () => {
    expect(getCurrentPathFromContext(undefined)).toBeNull();
    expect(getCurrentPathFromContext([])).toBeNull();
  });

  it('returns null when no view-context system message is present', () => {
    expect(getCurrentPathFromContext([{ content: 'some unrelated message' }])).toBeNull();
  });

  it('extracts the path from the canonical client-injected format', () => {
    const ctx = [{ content: '[Current View Context] OptiHashi Optimizer Path: /opti' }];
    expect(getCurrentPathFromContext(ctx)).toBe('/opti');
  });

  it('returns null when the marker is present but Path: is missing', () => {
    expect(getCurrentPathFromContext([{ content: '[Current View Context] no path here' }])).toBeNull();
  });

  it('ignores non-string content (e.g. multimodal arrays)', () => {
    expect(getCurrentPathFromContext([{ content: [{ type: 'image' }] }])).toBeNull();
  });
});

describe('isNavigableFeaturePath', () => {
  it('returns false for null, undefined, empty, and the chat root', () => {
    expect(isNavigableFeaturePath(null)).toBe(false);
    expect(isNavigableFeaturePath(undefined)).toBe(false);
    expect(isNavigableFeaturePath('')).toBe(false);
    expect(isNavigableFeaturePath('/')).toBe(false);
  });

  it('matches registered top-level routes exactly', () => {
    expect(isNavigableFeaturePath('/opti')).toBe(true);
    expect(isNavigableFeaturePath('/admin')).toBe(true);
    expect(isNavigableFeaturePath('/profile')).toBe(true);
  });

  it('matches nested paths under a registered prefix', () => {
    expect(isNavigableFeaturePath('/profile/security')).toBe(true);
    expect(isNavigableFeaturePath('/admin/users/123')).toBe(true);
  });

  it('does not match unrelated paths that merely share a string prefix', () => {
    expect(isNavigableFeaturePath('/admin-emergency')).toBe(false);
    expect(isNavigableFeaturePath('/login')).toBe(false);
    expect(isNavigableFeaturePath('/optimizer-blog')).toBe(false);
  });
});
