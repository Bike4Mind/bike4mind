import { describe, it, expect } from 'vitest';
import { feedbackRollupRoute, dataLakesRoute, newRoute, router } from './router';
import { defaultFeedbackRollupWindow } from './utils/feedbackRollupWindow';

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

describe('Video studio route', () => {
  it('renders /studio/video inside the notebook layout', () => {
    const ids = router.matchRoutes('/studio/video', {}).map(match => match.routeId);
    expect(ids).toContain('/layout');
    expect(ids.some(id => id.endsWith('/studio/video'))).toBe(true);
  });
});
