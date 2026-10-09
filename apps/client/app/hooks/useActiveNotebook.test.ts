import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveNotebook } from './useActiveNotebook';

const { routerState, sessionState } = vi.hoisted(() => ({
  routerState: { pathname: '/new' },
  sessionState: { currentSessionId: null as string | null },
}));

vi.mock('@tanstack/react-router', () => ({
  useMatchRoute:
    () =>
    ({ to }: { to: string }) => {
      if (to === '/new') return routerState.pathname === '/new' ? {} : false;
      if (to === '/notebooks/$id') {
        const match = /^\/notebooks\/([^/]+)\/?$/.exec(routerState.pathname);
        return match ? { id: match[1] } : false;
      }
      return false;
    },
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: sessionState.currentSessionId }),
}));

describe('useActiveNotebook', () => {
  beforeEach(() => {
    routerState.pathname = '/new';
    sessionState.currentSessionId = null;
  });

  it.each([
    { name: '/new with no current id', pathname: '/new', current: null, expected: { onScreen: true, sessionId: null } },
    { name: '/new with a current id', pathname: '/new', current: 's1', expected: { onScreen: true, sessionId: 's1' } },
    {
      name: '/notebooks/s1 when s1 is current',
      pathname: '/notebooks/s1',
      current: 's1',
      expected: { onScreen: true, sessionId: 's1' },
    },
    {
      name: 'a trailing slash on the notebook route',
      pathname: '/notebooks/s1/',
      current: 's1',
      expected: { onScreen: true, sessionId: 's1' },
    },
    {
      name: '/notebooks/s2 while s1 is still current (switch window)',
      pathname: '/notebooks/s2',
      current: 's1',
      expected: { onScreen: false },
    },
    {
      name: '/notebooks/s1 with no current id',
      pathname: '/notebooks/s1',
      current: null,
      expected: { onScreen: false },
    },
    { name: 'a project page', pathname: '/projects/p1', current: 's1', expected: { onScreen: false } },
    { name: '/notebooks with no id', pathname: '/notebooks', current: 's1', expected: { onScreen: false } },
  ])('$name', ({ pathname, current, expected }) => {
    routerState.pathname = pathname;
    sessionState.currentSessionId = current;
    const { result } = renderHook(() => useActiveNotebook());
    expect(result.current).toEqual(expected);
  });
});
