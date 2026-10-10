import { describe, it, expect } from 'vitest';
import { WORKSPACE_SURFACES } from '@bike4mind/common';
import { hostedWorkspaceAt, matchesRoutePath, workspaceSessionHref } from './premiumHostedWorkspace';

// Found by shape rather than by name, so these cases follow whichever workspace the registry carries.
const workspace = WORKSPACE_SURFACES.find(surface => surface.id !== null);
if (!workspace?.id) throw new Error('expected a registered workspace');
const ID = workspace.id;

describe('matchesRoutePath', () => {
  it('matches the exact path, ignoring a trailing slash', () => {
    expect(matchesRoutePath('/desk', '/desk')).toBe(true);
    expect(matchesRoutePath('/desk/', '/desk')).toBe(true);
  });

  it('lets a $param segment stand for exactly one segment', () => {
    expect(matchesRoutePath('/desk/abc', '/desk/$id')).toBe(true);
    expect(matchesRoutePath('/desk', '/desk/$id')).toBe(false);
    expect(matchesRoutePath('/desk/abc/def', '/desk/$id')).toBe(false);
  });

  it('matches neither a sub-path nor a longer sibling', () => {
    expect(matchesRoutePath('/desk/abc', '/desk')).toBe(false);
    expect(matchesRoutePath('/desktop', '/desk')).toBe(false);
  });
});

describe('hostedWorkspaceAt', () => {
  it('returns the workspace on its own route, with or without contributed routes', () => {
    expect(hostedWorkspaceAt(workspace.routePrefix, [])).toBe(ID);
  });

  it('returns the workspace an app-shell route declares it hosts', () => {
    const routes = [{ path: '/desk', appShell: true, hostsWorkspace: ID }];

    expect(hostedWorkspaceAt('/desk', routes)).toBe(ID);
  });

  it('matches a parameterised hosting route', () => {
    const routes = [{ path: '/desk/$id', appShell: true, hostsWorkspace: ID }];

    expect(hostedWorkspaceAt('/desk/s1', routes)).toBe(ID);
    expect(hostedWorkspaceAt('/desk', routes)).toBeNull();
  });

  it('ignores a route that does not declare it, or is not in the app shell', () => {
    expect(hostedWorkspaceAt('/desk', [{ path: '/desk', appShell: true }])).toBeNull();
    expect(hostedWorkspaceAt('/desk', [{ path: '/desk', hostsWorkspace: ID }])).toBeNull();
  });

  it('ignores a declared workspace this repo does not register, and the main list', () => {
    expect(hostedWorkspaceAt('/desk', [{ path: '/desk', appShell: true, hostsWorkspace: 'unregistered' }])).toBeNull();
    expect(hostedWorkspaceAt('/desk', [{ path: '/desk', appShell: true, hostsWorkspace: '' }])).toBeNull();
  });

  it('returns null on the main list routes and anywhere else', () => {
    expect(hostedWorkspaceAt('/notebooks/abc', [])).toBeNull();
    expect(hostedWorkspaceAt(`${workspace.routePrefix}/sub`, [])).toBeNull();
  });
});

describe('workspaceSessionHref', () => {
  const queryShaped = {
    ...workspace,
    sessionHref: (id: string) => `${workspace.routePrefix}?view=board&session=${id}`,
  };
  const hosting = [{ path: '/hub/$view', appShell: true, hostsWorkspace: ID }];

  it('keeps the query shape on the current page when that page hosts the workspace', () => {
    expect(workspaceSessionHref(queryShaped, 'a b', '/hub/plan', hosting)).toBe('/hub/plan?view=board&session=a b');
  });

  it("uses the workspace's link on a page that hosts another workspace or none", () => {
    const other = [{ path: '/hub/$view', appShell: true, hostsWorkspace: 'not-registered' }];

    expect(workspaceSessionHref(queryShaped, 's1', '/hub/plan', other)).toBe(queryShaped.sessionHref('s1'));
    expect(workspaceSessionHref(queryShaped, 's1', '/elsewhere', hosting)).toBe(queryShaped.sessionHref('s1'));
  });

  it('ignores a hosting route outside the app shell', () => {
    const bare = [{ path: '/hub/$view', hostsWorkspace: ID }];

    expect(workspaceSessionHref(queryShaped, 's1', '/hub/plan', bare)).toBe(queryShaped.sessionHref('s1'));
  });

  it("does not rewrite a presented link onto the workspace's own route", () => {
    const presented = { ...workspace, sessionHref: (id: string) => `/desk?session=${id}` };

    expect(workspaceSessionHref(presented, 's1', workspace.routePrefix, hosting)).toBe('/desk?session=s1');
  });

  it('keeps a link that carries the id in its path', () => {
    const pathShaped = { ...workspace, sessionHref: (id: string) => `/desk/${id}?tab=chat` };

    expect(workspaceSessionHref(pathShaped, 's1', '/hub/plan', hosting)).toBe('/desk/s1?tab=chat');
  });

  it('never rewrites the main notebook list', () => {
    const main = WORKSPACE_SURFACES.find(surface => surface.id === null);
    if (!main) throw new Error('expected the main notebook list');

    expect(workspaceSessionHref(main, 's1', '/hub/plan', hosting)).toBe(main.sessionHref('s1'));
  });
});
