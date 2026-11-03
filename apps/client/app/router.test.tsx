import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  isNotFound,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import {
  adminRoute,
  adminSubscriptionByStripeIdRoute,
  adminSubscriptionDetailRoute,
  adminUserProfileRoute,
  billingRoute,
  feedbackRollupRoute,
  dataLakesRoute,
  integrationsRoute,
  newRoute,
  notebooksIndexRoute,
  router,
  studioRoute,
  subscriptionsIndexRoute,
} from './router';
import { AuditLogFiltersSchema } from '@bike4mind/common';
import { defaultFeedbackRollupWindow } from './utils/feedbackRollupWindow';

// The consent guard bootstraps a session over the network; the redirect tests below are about what
// adminRoute does after it, so it passes here.
vi.mock('./utils/consentGuard', () => ({ enforceConsentRedirect: async () => undefined }));

describe('adminRoute validateSearch', () => {
  const validate = (search: Record<string, unknown>) => adminRoute.options.validateSearch(search);

  it("keeps the console-wide params and every tab's registered params", () => {
    expect(
      validate({
        emergency_access: 'true',
        tab: 'audit-log',
        feedbackId: 'f1',
        category: 'credits',
        entryId: 'e1',
        section: 'security',
        q: 'slack',
      })
    ).toEqual({
      emergency_access: 'true',
      tab: 'audit-log',
      feedbackId: 'f1',
      category: 'credits',
      entryId: 'e1',
      section: 'security',
      q: 'slack',
    });
  });

  it('declares every Audit Log filter key', () => {
    const declared = Object.keys(validate({}));
    expect(declared).toEqual(expect.arrayContaining([...Object.keys(AuditLogFiltersSchema.shape), 'entryId']));
  });

  // TanStack's default parser JSON-decodes values, so ?targetId=123 arrives as a number.
  it('coerces non-string values to strings and drops empty ones', () => {
    expect(validate({ targetId: 123, q: '', tab: undefined })).toEqual({ targetId: '123' });
  });

  it('does not declare unregistered params', () => {
    expect(validate({ tab: 'users', redirectTo: '/x' })).not.toHaveProperty('redirectTo');
  });
});

// validateSearch is what makes a bare /feedback/rollup URL load at all (see the route's own
// comment) - rollup.test.tsx mocks '@client/app/router' wholesale, so this is the only place the
// fallback branches actually run.
describe('feedbackRollupRoute validateSearch', () => {
  it('fills both bounds from the default window when the search is empty', () => {
    const fallback = defaultFeedbackRollupWindow();
    const result = feedbackRollupRoute.options.validateSearch({});

    expect(result.from).toBe(fallback.from);
    expect(result.to).toBe(fallback.to);
  });

  it('fills both bounds from the default window when the search carries garbage', () => {
    const fallback = defaultFeedbackRollupWindow();
    const result = feedbackRollupRoute.options.validateSearch({ from: 123, to: '' });

    expect(result.from).toBe(fallback.from);
    expect(result.to).toBe(fallback.to);
  });

  it('keeps a valid caller-supplied window instead of the default', () => {
    const result = feedbackRollupRoute.options.validateSearch({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    expect(result).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
  });
});

describe('Data Lake article deep link keeps ?passage=', () => {
  const search = { article: 'f1', passage: 'some cited text' };

  it('survives /data-lakes validateSearch', () => {
    expect(dataLakesRoute.options.validateSearch?.(search)).toEqual(search);
  });

  it('survives /new validateSearch', () => {
    expect(newRoute.options.validateSearch?.(search)).toMatchObject(search);
  });

  it('is forwarded by the /data-lakes redirect to /new', () => {
    let thrown: unknown;
    try {
      (dataLakesRoute.options.beforeLoad as (ctx: unknown) => void)({ search });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ options: { to: '/new', search } });
  });

  it('omits passage from the redirect when there is none', () => {
    let thrown: unknown;
    try {
      (dataLakesRoute.options.beforeLoad as (ctx: unknown) => void)({ search: { article: 'f1' } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ options: { to: '/new', search: { article: 'f1' } } });
  });
});

describe('QA status routes', () => {
  const chain = (path: string) => router.matchRoutes(path, {}).map(m => m.routeId);

  it.each(['/status', '/status/runs/abc', '/status/tests/a%2Fb'])('%s renders outside the notebook layout', path => {
    const ids = chain(path);
    expect(ids).toContain('/qa-status-layout');
    expect(ids).not.toContain('/layout');
  });

  it('keeps regular app pages inside the notebook layout', () => {
    expect(chain('/new')).toContain('/layout');
  });
});

describe('Studio route', () => {
  const studioMatch = (pathname: string) =>
    router.matchRoutes(pathname, {}).find(match => match.routeId.endsWith('/studio/$modality'));

  it('renders /studio/video inside the notebook layout', () => {
    const ids = router.matchRoutes('/studio/video', {}).map(match => match.routeId);
    expect(ids).toContain('/layout');
    expect(studioMatch('/studio/video')).toMatchObject({ params: { modality: 'video' } });
    expect(studioMatch('/studio/video')?.paramsError).toBeUndefined();
  });

  it('treats an unknown modality as not found', () => {
    expect(isNotFound(studioMatch('/studio/hologram')?.paramsError)).toBe(true);
  });

  // The assertion above only sees the match's paramsError. This renders the route with its own params wiring
  // (studioRoute.options.params) to pin what the user gets: the not-found page, not the error boundary. The tree
  // is rebuilt here rather than through the app router because the notebook layout's auth guard redirects to
  // /login before the 404 is reached.
  it('renders the not-found page, not the error boundary, for an unknown modality', async () => {
    const root = createRootRoute({
      component: () => <Outlet />,
      notFoundComponent: () => <div data-testid="probe-not-found" />,
      errorComponent: () => <div data-testid="probe-error" />,
    });
    const route = createRoute({
      getParentRoute: () => root,
      path: '/studio/$modality',
      params: studioRoute.options.params,
      component: () => <div data-testid="probe-studio" />,
    });
    const probe = createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ['/studio/hologram'] }),
    });

    render(<RouterProvider router={probe} />);

    expect(await screen.findByTestId('probe-not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('probe-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('probe-studio')).not.toBeInTheDocument();
  });
});

describe('billingRoute forwards /billing/<view> to the modal deep link', () => {
  const forwardOf = (view: string) => {
    try {
      (billingRoute.options.beforeLoad as (ctx: unknown) => unknown)({ params: { view } });
    } catch (thrown) {
      return (thrown as { options: { href?: string; replace?: boolean } }).options;
    }
    throw new Error('expected beforeLoad to redirect');
  };

  it.each([
    ['credits', '/new?billing=credits'],
    ['plans', '/new?billing=plans'],
    ['bogus', '/new'],
  ])('/billing/%s -> %s', (view, href) => {
    expect(forwardOf(view)).toMatchObject({ href, replace: true });
  });
});

describe('guessed index URLs redirect instead of 404ing', () => {
  const redirectOf = (route: { options: { beforeLoad?: unknown } }) => {
    try {
      (route.options.beforeLoad as (ctx: unknown) => unknown)({});
    } catch (thrown) {
      return (thrown as { options: { to?: string; href?: string; replace?: boolean } }).options;
    }
    throw new Error('expected beforeLoad to redirect');
  };

  it('/notebooks -> the app home', () => {
    expect(redirectOf(notebooksIndexRoute)).toMatchObject({ to: '/', replace: true });
  });

  it('/subscriptions -> the plans modal', () => {
    expect(redirectOf(subscriptionsIndexRoute)).toMatchObject({ href: '/new?billing=plans', replace: true });
  });

  it.each(['/notebooks', '/subscriptions'])('%s matches its redirect route, not the 404', path => {
    const ids = router.matchRoutes(path).map(m => m.routeId);
    expect(ids.some(id => id.endsWith(path))).toBe(true);
  });
});

// The page's analytics entry point. Only the known sources survive, so a hand-edited or stale
// ?source= reads as a direct visit rather than landing an arbitrary string in the event.
describe('integrationsRoute validateSearch', () => {
  it.each(['profile_menu', 'profile_tab_link', 'direct'])('keeps %s', source => {
    expect(integrationsRoute.options.validateSearch?.({ source })).toEqual({ source });
  });

  it.each([{}, { source: 'newsletter' }, { source: 42 }, { source: ['profile_menu'] }])('drops %o', search => {
    expect(integrationsRoute.options.validateSearch?.(search)).toEqual({ source: undefined });
  });
});

describe('admin layout', () => {
  it('mounts the console and the user profile under one layout route', () => {
    const consoleParent = adminRoute.options.getParentRoute();
    expect(adminUserProfileRoute.options.getParentRoute()).toBe(consoleParent);
    expect(consoleParent.id).toBe('/admin-layout');
    expect(adminRoute.fullPath).toBe('/admin');
    expect(adminUserProfileRoute.fullPath).toBe('/admin/users/$userId');
  });
});

describe('admin user profile route', () => {
  const USER_ID = '0123456789abcdef01234567';
  const adminBeforeLoad = (search: Record<string, unknown>) =>
    (adminRoute.options.beforeLoad as (ctx: unknown) => Promise<unknown>)({
      location: { pathname: '/admin', searchStr: '', hash: '' },
      search,
    });

  it('redirects an old /admin?userId= link to /admin/users/$userId', async () => {
    const thrown: unknown = await adminBeforeLoad(adminRoute.options.validateSearch({ userId: USER_ID })).catch(
      (error: unknown) => error
    );
    expect((thrown as { options: unknown }).options).toMatchObject({
      to: '/admin/users/$userId',
      params: { userId: USER_ID },
      replace: true,
    });
  });

  it('leaves /admin alone without a valid userId', async () => {
    await expect(adminBeforeLoad(adminRoute.options.validateSearch({ tab: 'users' }))).resolves.toBeUndefined();
    await expect(
      adminBeforeLoad(adminRoute.options.validateSearch({ userId: '../organizations' }))
    ).resolves.toBeUndefined();
  });

  it('deep-links a tab through ?tab=', () => {
    const validate = (search: Record<string, unknown>) => adminUserProfileRoute.options.validateSearch(search);
    expect(validate({ tab: 'admin' })).toEqual({ tab: 'admin' });
    expect({ tab: 'nope', ...validate({ tab: 'nope' }) }.tab).toBeUndefined();
  });
});

describe('admin subscription detail routes', () => {
  it('mounts both under the admin layout', () => {
    const layout = adminRoute.options.getParentRoute();
    expect(adminSubscriptionDetailRoute.options.getParentRoute()).toBe(layout);
    expect(adminSubscriptionByStripeIdRoute.options.getParentRoute()).toBe(layout);
    expect(adminSubscriptionDetailRoute.fullPath).toBe('/admin/subscriptions/$subscriptionId');
    expect(adminSubscriptionByStripeIdRoute.fullPath).toBe('/admin/subscriptions/by-stripe/$stripeSubscriptionId');
  });

  it('deep-links a tab through ?tab=', () => {
    const validate = (search: Record<string, unknown>) => adminSubscriptionDetailRoute.options.validateSearch(search);
    expect(validate({ tab: 'admin' })).toEqual({ tab: 'admin' });
    expect(validate({ tab: 'overview' })).toEqual({ tab: undefined });
    expect(validate({ tab: 'nope' })).toEqual({ tab: undefined });
  });

  it('matches the static by-stripe path before the $subscriptionId param', () => {
    const match = (pathname: string) => router.getMatchedRoutes(pathname)[2]?.id;
    expect(match('/admin/subscriptions/by-stripe/sub_123')).toBe(adminSubscriptionByStripeIdRoute.id);
    expect(match('/admin/subscriptions/0123456789abcdef01234567')).toBe(adminSubscriptionDetailRoute.id);
  });
});
