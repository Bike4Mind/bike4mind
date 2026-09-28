import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';

/**
 * The notebook shell must keep ONE SessionContainer (and so one chat provider) mounted across
 * /new -> /notebooks/<optimistic id> -> /notebooks/<real id>, while each child's route effects
 * still mount on entering their route. Driven through a real TanStack router with the same
 * shape as router.tsx (pathless parent, children without components), since that nesting is
 * what decides what remounts.
 */

const h = vi.hoisted(() => ({
  containerMounts: 0,
  containerIds: [] as (string | undefined)[],
  newPageMounts: 0,
  newPageUnmounts: 0,
  notebookPageMounts: 0,
}));

vi.mock('@client/app/components/Session/SessionContainer', () => {
  const SessionContainerStub = ({ currentSessionId }: { currentSessionId?: string }) => {
    useEffect(() => {
      h.containerMounts++;
    }, []);
    h.containerIds.push(currentSessionId);
    return <div data-testid="session-container">{currentSessionId ?? 'new'}</div>;
  };
  return { default: SessionContainerStub };
});
vi.mock('@client/app/components/Session/NotebookFilepondProvider', () => ({
  NotebookFilepondProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@client/app/components/datalake/DataLakeChatSurface', () => ({
  default: ({ chat }: { chat: React.ReactNode }) => <>{chat}</>,
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useGetSession: () => ({ isPending: false }),
}));
vi.mock('./new', () => {
  const NewNotebookPageStub = () => {
    useEffect(() => {
      h.newPageMounts++;
      return () => {
        h.newPageUnmounts++;
      };
    }, []);
    return null;
  };
  return { default: NewNotebookPageStub };
});
vi.mock('./$id', () => {
  const NotebookPageStub = () => {
    useEffect(() => {
      h.notebookPageMounts++;
    }, []);
    return null;
  };
  return { default: NotebookPageStub };
});

import NotebookShell from './shell';

const buildRouter = (initialPath: string) => {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: 'notebook-shell', component: NotebookShell });
  const newRoute = createRoute({ getParentRoute: () => shellRoute, path: '/new' });
  const notebookRoute = createRoute({ getParentRoute: () => shellRoute, path: '/notebooks/$id' });
  return createRouter({
    routeTree: rootRoute.addChildren([shellRoute.addChildren([newRoute, notebookRoute])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
};

type TestRouter = ReturnType<typeof buildRouter>;

const go = async (router: TestRouter, path: string) => {
  await act(async () => {
    await router.navigate({ to: path });
  });
};

const shown = () => screen.getByTestId('session-container').textContent;

beforeEach(() => {
  h.containerMounts = 0;
  h.containerIds = [];
  h.newPageMounts = 0;
  h.newPageUnmounts = 0;
  h.notebookPageMounts = 0;
});

describe('notebook shell', () => {
  it('keeps one SessionContainer mounted through a first send (/new -> optimistic -> real)', async () => {
    const router = buildRouter('/new');
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId('session-container')).toBeTruthy();
    expect(shown()).toBe('new');

    await go(router, '/notebooks/optimistic-session-1');
    expect(shown()).toBe('optimistic-session-1');
    await go(router, '/notebooks/real-1');
    expect(shown()).toBe('real-1');

    expect(h.containerMounts).toBe(1);
    expect(h.containerIds).toContain(undefined);
    expect(h.containerIds).toContain('optimistic-session-1');
  });

  it('switches between notebooks in the same container, with the route effects mounted once', async () => {
    const router = buildRouter('/notebooks/a');
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId('session-container')).toBeTruthy();

    await go(router, '/notebooks/b');

    expect(shown()).toBe('b');
    expect(h.containerMounts).toBe(1);
    expect(h.notebookPageMounts).toBe(1);
    expect(h.newPageMounts).toBe(0);
  });

  it("re-runs /new's reset on entering /new from a notebook, without remounting the chat", async () => {
    const router = buildRouter('/new');
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId('session-container')).toBeTruthy();
    expect(h.newPageMounts).toBe(1);

    await go(router, '/notebooks/a');
    expect(h.newPageUnmounts).toBe(1);

    await go(router, '/new');
    expect(shown()).toBe('new');
    expect(h.newPageMounts).toBe(2);
    expect(h.containerMounts).toBe(1);
  });
});
