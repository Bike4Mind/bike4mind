import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActiveNotebook, useActiveNotebook } from './useActiveNotebook';

const { sessionState } = vi.hoisted(() => ({
  sessionState: { currentSessionId: null as string | null },
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: sessionState.currentSessionId }),
}));

function Probe() {
  return createElement('output', { 'data-testid': 'active-notebook' }, JSON.stringify(useActiveNotebook()));
}

async function renderAt(pathname: string): Promise<ActiveNotebook> {
  const rootRoute = createRootRoute({ component: Probe });
  const routeTree = rootRoute.addChildren(
    ['/new', '/notebooks/$id', '/projects'].map(path => createRoute({ getParentRoute: () => rootRoute, path }))
  );
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [pathname] }) });
  await router.load();
  render(createElement(RouterProvider, { router }));
  const output = await screen.findByTestId('active-notebook');
  return JSON.parse(output.textContent ?? '') as ActiveNotebook;
}

describe('useActiveNotebook', () => {
  beforeEach(() => {
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
      name: '/notebooks/s1 while s0 is still current (switch window)',
      pathname: '/notebooks/s1',
      current: 's0',
      expected: { onScreen: false },
    },
    {
      name: '/notebooks/s1 with no current id',
      pathname: '/notebooks/s1',
      current: null,
      expected: { onScreen: false },
    },
    { name: '/projects', pathname: '/projects', current: 's1', expected: { onScreen: false } },
  ])('$name', async ({ pathname, current, expected }) => {
    sessionState.currentSessionId = current;
    expect(await renderAt(pathname)).toEqual(expected);
  });
});
