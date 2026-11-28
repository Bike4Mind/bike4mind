import { afterEach, describe, it, expect } from 'vitest';
import {
  CONTRIBUTED_ADMIN_VIEW_PATH_PREFIX,
  CONTRIBUTED_VIEW_ID_PREFIX,
  FEATURE_PATH_PREFIXES,
  MAX_CONTRIBUTED_VIEWS,
  MAX_CONTRIBUTED_VIEW_DESCRIPTION_LENGTH,
  MAX_CONTRIBUTED_VIEW_ID_LENGTH,
  MAX_CONTRIBUTED_VIEW_KEYWORDS,
  MAX_CONTRIBUTED_VIEW_KEYWORD_LENGTH,
  MAX_CONTRIBUTED_VIEW_LABEL_LENGTH,
  getCurrentPathFromContext,
  getFilteredViews,
  getViewSummaryForLLM,
  isNavigableFeaturePath,
  registerContributedViews,
  resetContributedViews,
  resolveNavigationIntents,
  getViewById,
  VIEW_REGISTRY,
  getAdminViewSummaryForLLM,
  type NavigableView,
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

describe('VIEW_REGISTRY admin waitlist', () => {
  it('labels the waitlist tab Waitlist and keeps its tab target', () => {
    const view = getViewById('admin.subscribers');
    expect(view?.label).toBe('Waitlist');
    expect(view?.target).toBe('12');
  });
});

describe('VIEW_REGISTRY opti family consoles', () => {
  const optiActions = VIEW_REGISTRY.filter(v => v.section === 'opti' && v.navigationType === 'action');
  // Derived from the registry so a new family console cannot be added without its sub-tabs.
  const families = optiActions.filter(v => v.id.split('.').length === 2).map(v => v.id.slice('opti.'.length));

  it('names its workspace surface on every action view, and only on views that lead into one', () => {
    expect(optiActions.filter(v => !v.surface)).toEqual([]);
    const adminOrGlobal = VIEW_REGISTRY.filter(v => v.section !== 'opti');
    expect(adminOrGlobal.filter(v => v.surface)).toEqual([]);
  });

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

describe('getAdminViewSummaryForLLM', () => {
  // Sent on every admin assistant turn outside the cached prefix, so growth costs tokens per turn.
  const ADMIN_SUMMARY_CHAR_BUDGET = 16_000;

  it('stays within its size budget', () => {
    expect(getAdminViewSummaryForLLM().length).toBeLessThanOrEqual(ADMIN_SUMMARY_CHAR_BUDGET);
  });

  it('sends keywords the label and description do not already say', () => {
    const usersLine = getAdminViewSummaryForLLM()
      .split('\n')
      .find(line => line.startsWith('- admin.users:'));
    expect(usersLine).toContain('(also: ');
    expect(usersLine).toContain('manage users');
  });

  it('dedupes keywords by whole word, not substring', () => {
    const holdsLine = getAdminViewSummaryForLLM()
      .split('\n')
      .find(line => line.startsWith('- admin.signup_domain_holds:'));
    // "domain holds" is in the label; "disposable email" is not, though "email" is.
    expect(holdsLine).not.toMatch(/also:.*domain holds/);
    expect(holdsLine).toContain('disposable email');
    const rateLimitsLine = getAdminViewSummaryForLLM()
      .split('\n')
      .find(line => line.startsWith('- admin.rate_limits:'));
    // "rate limit" is a substring of the label "Rate limits" but not a whole word in it.
    expect(rateLimitsLine).toContain('(also: rate limit, ');
  });

  it('names AI advisories on every tab that shows them', () => {
    for (const id of ['admin.dashboard', 'admin.users', 'admin.shadow_detections', 'admin.signup_domain_holds']) {
      expect(getViewById(id)?.description.toLowerCase(), id).toContain('ai advisory');
    }
  });
});

describe('contributed views', () => {
  afterEach(resetContributedViews);

  const contributed = (overrides: Record<string, unknown> = {}): NavigableView =>
    ({
      id: 'admin.ext.example',
      section: 'admin',
      label: 'Example page',
      description: 'An example page used by tests',
      navigationType: 'route',
      target: '/admin/ext/example',
      keywords: ['sample', 'demo'],
      requiresAdmin: true,
      ...overrides,
    }) as NavigableView;

  const lineLimits = {
    id: MAX_CONTRIBUTED_VIEW_ID_LENGTH - CONTRIBUTED_VIEW_ID_PREFIX.length,
    label: MAX_CONTRIBUTED_VIEW_LABEL_LENGTH,
    description: MAX_CONTRIBUTED_VIEW_DESCRIPTION_LENGTH,
    keyword: MAX_CONTRIBUTED_VIEW_KEYWORD_LENGTH,
  };

  // Every field at its limit, with keywords the label and description do not already say.
  const atEveryLimit = (i: number): NavigableView =>
    contributed({
      id: `${CONTRIBUTED_VIEW_ID_PREFIX}${`v${i}`.padEnd(lineLimits.id, 'x')}`,
      target: `${CONTRIBUTED_ADMIN_VIEW_PATH_PREFIX}v${i}`,
      label: `L${i}`.padEnd(lineLimits.label, 'x'),
      description: `D${i}`.padEnd(lineLimits.description, 'x'),
      keywords: Array.from({ length: MAX_CONTRIBUTED_VIEW_KEYWORDS }, (_, k) =>
        `k${i}_${k}`.padEnd(lineLimits.keyword, 'x')
      ),
    });

  it('pins the reserved id and path prefixes and the limits', () => {
    expect(CONTRIBUTED_VIEW_ID_PREFIX).toBe('admin.ext.');
    expect(CONTRIBUTED_ADMIN_VIEW_PATH_PREFIX).toBe('/admin/ext/');
    expect([
      MAX_CONTRIBUTED_VIEWS,
      MAX_CONTRIBUTED_VIEW_ID_LENGTH,
      MAX_CONTRIBUTED_VIEW_LABEL_LENGTH,
      MAX_CONTRIBUTED_VIEW_DESCRIPTION_LENGTH,
      MAX_CONTRIBUTED_VIEW_KEYWORDS,
      MAX_CONTRIBUTED_VIEW_KEYWORD_LENGTH,
    ]).toEqual([8, 60, 60, 160, 6, 30]);
  });

  it('registers a valid view', () => {
    expect(registerContributedViews([contributed()])).toEqual({
      registered: ['admin.ext.example'],
      duplicates: [],
      rejected: [],
    });
    expect(getViewById('admin.ext.example')?.target).toBe('/admin/ext/example');
  });

  it('accepts every field exactly at its limit', () => {
    const view = atEveryLimit(0);
    expect(view.id).toHaveLength(MAX_CONTRIBUTED_VIEW_ID_LENGTH);
    expect(registerContributedViews([view]).registered).toEqual([view.id]);
  });

  describe('rejects', () => {
    const rejectedCases: Array<[string, Record<string, unknown>]> = [
      ['an id without the reserved prefix', { id: 'example' }],
      ['an id in another section namespace', { id: 'admin.example' }],
      ['an id that is only the prefix', { id: 'admin.ext.' }],
      ['an id with an uppercase letter', { id: 'admin.ext.Example' }],
      ['an id segment that starts with a digit', { id: 'admin.ext.1example' }],
      ['an id with an empty segment', { id: 'admin.ext.a..b' }],
      ['an id with a hyphen', { id: 'admin.ext.a-b' }],
      ['an id with a trailing newline', { id: 'admin.ext.example\n' }],
      ['an id one past the length limit', { id: `admin.ext.${'a'.repeat(MAX_CONTRIBUTED_VIEW_ID_LENGTH - 9)}` }],
      ['an id past the length limit', { id: `admin.ext.${'a'.repeat(MAX_CONTRIBUTED_VIEW_ID_LENGTH)}` }],
      ['a non-string id', { id: 7 }],
      ['another section', { section: 'global' }],
      ['the opti section', { section: 'opti' }],
      ['a tab navigation type', { navigationType: 'tab' }],
      ['an action navigation type', { navigationType: 'action' }],
      ['a view that does not require admin', { requiresAdmin: false }],
      ['a view with no admin flag', { requiresAdmin: undefined }],
      ['a target outside the reserved path', { target: '/admin/users' }],
      ['a target on the bare admin path', { target: '/admin' }],
      ['a target that is the prefix without the trailing slash', { target: '/admin/ext' }],
      ['a target that is only the prefix', { target: '/admin/ext/' }],
      ['a target that is an absolute URL', { target: 'https://example.com/admin/ext/example' }],
      ['a target with a route parameter marker', { target: '/admin/ext/$id' }],
      ['a target with a query string', { target: '/admin/ext/example?a=1' }],
      ['a target with a fragment', { target: '/admin/ext/example#top' }],
      ['a target with whitespace', { target: '/admin/ext/exa mple' }],
      ['a target with a dot segment', { target: '/admin/ext/../users' }],
      ['a target with an encoded dot segment', { target: '/admin/ext/%2e%2e/users' }],
      ['a target with a backslash', { target: '/admin/ext/example\\x' }],
      ['a target with a NUL', { target: '/admin/ext/exa\u0000mple' }],
      ['a non-string target', { target: 5 }],
      ['an empty label', { label: '' }],
      ['a label with surrounding whitespace', { label: ' Example page ' }],
      ['a label past the length limit', { label: 'x'.repeat(MAX_CONTRIBUTED_VIEW_LABEL_LENGTH + 1) }],
      ['a label with a newline', { label: 'Example\npage' }],
      ['a label with a carriage return', { label: 'Example\rpage' }],
      ['a label with a tab', { label: 'Example\tpage' }],
      ['a label with a line separator', { label: 'Example\u2028page' }],
      ['a label with a bidi override', { label: 'Example\u202epage' }],
      ['a non-string label', { label: 1 }],
      ['an empty description', { description: '' }],
      ['a whitespace-only description', { description: '   ' }],
      ['a description past the length limit', { description: 'x'.repeat(MAX_CONTRIBUTED_VIEW_DESCRIPTION_LENGTH + 1) }],
      ['a description with a newline', { description: 'An example\npage' }],
      ['a description with a NEL', { description: 'An example\u0085page' }],
      ['a non-string description', { description: null }],
      ['keywords that are not an array', { keywords: 'example' }],
      ['missing keywords', { keywords: undefined }],
      [
        'more keywords than the limit',
        { keywords: Array.from({ length: MAX_CONTRIBUTED_VIEW_KEYWORDS + 1 }, (_, k) => `kw${k}`) },
      ],
      ['an empty keyword', { keywords: ['sample', ''] }],
      ['a keyword past the length limit', { keywords: ['x'.repeat(MAX_CONTRIBUTED_VIEW_KEYWORD_LENGTH + 1)] }],
      ['a keyword with a newline', { keywords: ['two\nlines'] }],
      ['a whitespace-only keyword', { keywords: ['sample', '  '] }],
      ['a non-string keyword', { keywords: ['sample', 3] }],
    ];

    it.each(rejectedCases)('%s', (_name, overrides) => {
      const viewCount = getFilteredViews({ isAdmin: true }).length;
      const result = registerContributedViews([contributed(overrides)]);
      expect(result.registered).toEqual([]);
      expect(result.duplicates).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(getFilteredViews({ isAdmin: true })).toHaveLength(viewCount);
    });

    it('a static view id', () => {
      const clash = contributed({ id: 'admin.ext.clash' });
      VIEW_REGISTRY.push(clash);
      try {
        const result = registerContributedViews([contributed({ id: 'admin.ext.clash', label: 'Other' })]);
        expect(result).toEqual({ registered: [], duplicates: [], rejected: ['admin.ext.clash'] });
        expect(getViewById('admin.ext.clash')).toBe(clash);
      } finally {
        VIEW_REGISTRY.splice(VIEW_REGISTRY.indexOf(clash), 1);
      }
    });

    it.each([null, undefined, 'admin.ext.example', 42, [], () => undefined])('a non-object entry (%s)', entry => {
      const result = registerContributedViews([entry as unknown as NavigableView]);
      expect(result).toEqual({ registered: [], duplicates: [], rejected: ['(no id)'] });
    });

    it('reports the id of a rejected view and keeps registering the valid ones around it', () => {
      const result = registerContributedViews([
        contributed({ id: 'admin.ext.first' }),
        contributed({ id: 'admin.ext.bad', target: '/admin/users' }),
        null as unknown as NavigableView,
        contributed({ id: 'admin.ext.last' }),
      ]);
      expect(result).toEqual({
        registered: ['admin.ext.first', 'admin.ext.last'],
        duplicates: [],
        rejected: ['admin.ext.bad', '(no id)'],
      });
    });
  });

  it('keeps the first view when a different object reuses an id', () => {
    const first = contributed();
    const second = contributed({ label: 'Other page' });
    expect(registerContributedViews([first]).registered).toEqual(['admin.ext.example']);
    expect(registerContributedViews([second])).toEqual({
      registered: [],
      duplicates: ['admin.ext.example'],
      rejected: [],
    });
    expect(getViewById('admin.ext.example')).toBe(first);
  });

  it('does not call the same object registered twice a duplicate', () => {
    const view = contributed();
    registerContributedViews([view]);
    expect(registerContributedViews([view])).toEqual({ registered: [], duplicates: [], rejected: [] });
    expect(registerContributedViews([view, view])).toEqual({ registered: [], duplicates: [], rejected: [] });
    expect(getFilteredViews({ isAdmin: true }).filter(v => v.id === view.id)).toHaveLength(1);
  });

  it('caps the contributed views and rejects a valid view past the cap', () => {
    const views = Array.from({ length: MAX_CONTRIBUTED_VIEWS }, (_, i) => contributed({ id: `admin.ext.v${i}` }));
    expect(registerContributedViews(views).registered).toHaveLength(MAX_CONTRIBUTED_VIEWS);

    const overflow = contributed({ id: 'admin.ext.overflow' });
    expect(registerContributedViews([overflow])).toEqual({
      registered: [],
      duplicates: [],
      rejected: ['admin.ext.overflow'],
    });
    expect(getViewById('admin.ext.overflow')).toBeUndefined();

    // At the cap, a repeat of a registered view is still a repeat, not an overflow.
    expect(registerContributedViews([views[0]])).toEqual({ registered: [], duplicates: [], rejected: [] });
    expect(registerContributedViews([contributed({ id: 'admin.ext.v0', label: 'Other' })]).duplicates).toEqual([
      'admin.ext.v0',
    ]);
  });

  it('keeps the valid views either side of an invalid one when the list overflows the cap', () => {
    const views = Array.from({ length: MAX_CONTRIBUTED_VIEWS - 1 }, (_, i) => contributed({ id: `admin.ext.v${i}` }));
    views.splice(2, 0, contributed({ id: 'admin.ext.bad', target: '/admin/users' }));
    views.push(contributed({ id: 'admin.ext.last' }), contributed({ id: 'admin.ext.overflow' }));

    const result = registerContributedViews(views);
    expect(result.registered).toHaveLength(MAX_CONTRIBUTED_VIEWS);
    expect(result.registered).toContain('admin.ext.last');
    expect(result.rejected).toEqual(['admin.ext.bad', 'admin.ext.overflow']);
    expect(getViewById('admin.ext.overflow')).toBeUndefined();
  });

  it('leaves VIEW_REGISTRY and the feature path prefixes untouched', () => {
    const staticIds = VIEW_REGISTRY.map(v => v.id);
    const prefixes = [...FEATURE_PATH_PREFIXES];
    registerContributedViews([contributed()]);
    expect(VIEW_REGISTRY.map(v => v.id)).toEqual(staticIds);
    expect(FEATURE_PATH_PREFIXES).toEqual(prefixes);
  });

  it('resets to the static registry', () => {
    registerContributedViews([contributed()]);
    resetContributedViews();
    expect(getViewById('admin.ext.example')).toBeUndefined();
    expect(getAdminViewSummaryForLLM()).not.toContain('admin.ext.example');
  });

  describe('once registered', () => {
    it('is found by getViewById, with static views still first', () => {
      registerContributedViews([contributed()]);
      expect(getViewById('admin.ext.example')?.label).toBe('Example page');
      expect(getViewById('admin.users')?.label).toBe('User Management');
    });

    it('is listed by getFilteredViews after the static views, for an admin only', () => {
      registerContributedViews([contributed()]);
      const adminViews = getFilteredViews({ isAdmin: true });
      expect(adminViews.at(-1)?.id).toBe('admin.ext.example');
      expect(adminViews).toHaveLength(VIEW_REGISTRY.length + 1);
      expect(getFilteredViews({ isAdmin: true, section: 'admin' }).map(v => v.id)).toContain('admin.ext.example');
      expect(getFilteredViews({ isAdmin: true, section: 'opti' }).map(v => v.id)).not.toContain('admin.ext.example');
      expect(getFilteredViews({ isAdmin: false }).map(v => v.id)).not.toContain('admin.ext.example');
      expect(getFilteredViews().map(v => v.id)).not.toContain('admin.ext.example');
    });

    it('is appended to getAdminViewSummaryForLLM as a line like the static ones', () => {
      const before = getAdminViewSummaryForLLM();
      registerContributedViews([contributed()]);
      const after = getAdminViewSummaryForLLM();
      expect(after.startsWith(before)).toBe(true);
      expect(after.slice(before.length)).toBe(
        '\n- admin.ext.example: Example page \u2014 An example page used by tests (also: sample, demo)'
      );
    });

    it('does not change getViewSummaryForLLM for a non-admin', () => {
      const before = [getViewSummaryForLLM({ isAdmin: false }), getViewSummaryForLLM()];
      registerContributedViews([contributed()]);
      expect([getViewSummaryForLLM({ isAdmin: false }), getViewSummaryForLLM()]).toEqual(before);
      expect(before[0]).not.toContain('admin.ext.');
    });

    it('resolves to a route intent for an admin and is dropped for a non-admin', () => {
      registerContributedViews([contributed()]);
      const suggestions = [{ viewId: 'admin.ext.example', reason: 'Open it' }];
      expect(resolveNavigationIntents(suggestions, true)).toEqual([
        {
          viewId: 'admin.ext.example',
          label: 'Example page',
          description: 'An example page used by tests',
          navigationType: 'route',
          target: '/admin/ext/example',
          reason: 'Open it',
        },
      ]);
      expect(resolveNavigationIntents(suggestions, false)).toEqual([]);
      expect(resolveNavigationIntents(suggestions)).toEqual([]);
    });
  });

  it('adds a bounded number of characters to the admin summary, even with every field at its limit', () => {
    const before = getAdminViewSummaryForLLM().length;
    const views = Array.from({ length: MAX_CONTRIBUTED_VIEWS }, (_, i) => atEveryLimit(i));
    expect(registerContributedViews(views).registered).toHaveLength(MAX_CONTRIBUTED_VIEWS);
    const added = getAdminViewSummaryForLLM().length - before;

    // "- " id ": " label " \u2014 " description " (also: " keywords ")" plus the joining newline.
    const keywordsChars = MAX_CONTRIBUTED_VIEW_KEYWORDS * lineLimits.keyword + (MAX_CONTRIBUTED_VIEW_KEYWORDS - 1) * 2;
    const lineChars =
      2 +
      MAX_CONTRIBUTED_VIEW_ID_LENGTH +
      2 +
      lineLimits.label +
      3 +
      lineLimits.description +
      ' (also: '.length +
      keywordsChars +
      ')'.length +
      1;
    expect(added).toBe(MAX_CONTRIBUTED_VIEWS * lineChars);
    expect(added).toBeLessThanOrEqual(4_000);
  });
});
