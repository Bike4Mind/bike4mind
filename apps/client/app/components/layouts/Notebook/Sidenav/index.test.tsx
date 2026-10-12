import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';

const h = vi.hoisted(() => ({
  pathname: '/new',
  routes: [] as { path: string; appShell?: boolean; hostsWorkspace?: string }[],
  workspaceSidenav: null as ComponentType | null,
}));

// CombinedNotebooks is the only dynamic() import here; stand in for it with a marker.
vi.mock('next/dynamic', async () => {
  const { createElement } = await import('react');
  return { default: () => () => createElement('div', { 'data-testid': 'default-notebook-list' }) };
});
vi.mock('./Header', () => ({ default: () => null }));
vi.mock('./Footer', () => ({ default: () => null }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => false }));
vi.mock('..', () => ({ useNotebookLayout: () => [true, vi.fn()] }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: h.pathname }),
}));
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({
  get premiumRoutes() {
    return h.routes;
  },
}));
vi.mock('@client/app/premium-generated/premiumNotebookSidenav.generated', () => ({
  get premiumNotebookSidenav() {
    return h.workspaceSidenav;
  },
}));

import { createElement } from 'react';
import { WORKSPACE_SURFACES } from '@bike4mind/common';
import NotebookSideNav from './index';

// Found by shape rather than by name, so these cases follow whichever workspace the registry carries.
const workspace = WORKSPACE_SURFACES.find(surface => surface.id !== null);
if (!workspace?.id) throw new Error('expected a registered workspace');

const WorkspaceList = () => createElement('div', { 'data-testid': 'workspace-conversation-list' });

/**
 * The sidebar draws a workspace's own conversation list on the workspace's route, and on any app-shell
 * premium route that declares it hosts that workspace - without core naming the hosting route.
 */
describe('NotebookSideNav conversation list', () => {
  beforeEach(() => {
    h.pathname = '/new';
    h.routes = [{ path: '/desk', appShell: true, hostsWorkspace: workspace.id ?? undefined }];
    h.workspaceSidenav = WorkspaceList;
  });

  const shows = (testId: string) => {
    render(<NotebookSideNav />);
    return screen.queryByTestId(testId);
  };

  it("draws the workspace's list on the workspace's own route", () => {
    h.pathname = workspace.routePrefix;
    expect(shows('workspace-conversation-list')).not.toBeNull();
  });

  it('draws the workspace list on a contributed route that hosts it', () => {
    h.pathname = '/desk';
    expect(shows('workspace-conversation-list')).not.toBeNull();
  });

  it('draws the default list on a contributed route that does not host it', () => {
    h.routes = [{ path: '/desk', appShell: true }];
    h.pathname = '/desk';
    expect(shows('default-notebook-list')).not.toBeNull();
  });

  it('draws the default list everywhere else', () => {
    h.pathname = '/notebooks/abc';
    expect(shows('default-notebook-list')).not.toBeNull();
  });

  it('draws the default list on a hosting route when the build carries no workspace list', () => {
    h.workspaceSidenav = null;
    h.pathname = '/desk';
    expect(shows('default-notebook-list')).not.toBeNull();
  });
});
