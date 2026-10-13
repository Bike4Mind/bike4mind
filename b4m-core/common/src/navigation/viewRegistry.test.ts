import { describe, it, expect } from 'vitest';
import {
  FEATURE_PATH_PREFIXES,
  getCurrentPathFromContext,
  isNavigableFeaturePath,
  resolveNavigationIntents,
  getViewById,
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

describe('VIEW_REGISTRY opti family consoles', () => {
  const optiActions = VIEW_REGISTRY.filter(v => v.section === 'opti' && v.navigationType === 'action');
  // Derived from the registry so a new family console cannot be added without its sub-tabs.
  const families = optiActions.filter(v => v.id.split('.').length === 2).map(v => v.id.slice('opti.'.length));

  it('has unique view ids', () => {
    const ids = VIEW_REGISTRY.map(v => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers Problem and Solvers sub-tabs for every family console', () => {
    expect(families.length).toBeGreaterThan(1);
    const missing = families.flatMap(f =>
      ['problem', 'solvers'].map(tab => `opti.${f}.${tab}`).filter(id => !getViewById(id))
    );
    expect(missing).toEqual([]);
  });

  it('registers gantt and qwork sub-tabs only for scheduling', () => {
    const offenders = optiActions
      .filter(v => /\.(gantt|qwork)$/.test(v.id) && !v.id.startsWith('opti.scheduling.'))
      .map(v => v.id);
    expect(offenders).toEqual([]);
  });

  // useNavigationExecutor splits an action target on its first '.' into family and sub-tab.
  it('targets each action by its id minus the opti. prefix', () => {
    const offenders = optiActions.filter(v => v.target !== v.id.slice('opti.'.length)).map(v => v.id);
    expect(offenders).toEqual([]);
  });

  it('resolves a non-scheduling family sub-tab to an action intent', () => {
    expect(resolveNavigationIntents([{ viewId: 'opti.routing.problem', reason: 'edit the routes' }])).toEqual([
      expect.objectContaining({ viewId: 'opti.routing.problem', navigationType: 'action', target: 'routing.problem' }),
    ]);
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
