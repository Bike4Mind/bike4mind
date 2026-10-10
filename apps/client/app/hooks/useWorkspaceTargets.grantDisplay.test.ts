import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  user: { currentUser: { id: 'user-1', tags: [] as string[] }, isAdmin: false } as Record<string, unknown>,
  entitlements: [] as string[],
  routes: [] as { path: string }[],
  copyEntitlements: {} as Record<string, string[]>,
  displays: {} as Record<string, { key: string; label: string; sessionHref?: string }[]>,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: Record<string, unknown>) => unknown) => selector(h.user),
}));
vi.mock('@client/app/hooks/data/entitlements', () => ({ useEntitlements: () => ({ data: h.entitlements }) }));
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({
  get premiumRoutes() {
    return h.routes;
  },
}));
vi.mock('@client/app/premium-generated/premiumWorkspaceCopyEntitlements.generated', () => ({
  get premiumWorkspaceCopyEntitlements() {
    return h.copyEntitlements;
  },
}));
vi.mock('@client/app/premium-generated/premiumWorkspaceGrantDisplays.generated', () => ({
  get premiumWorkspaceGrantDisplays() {
    return h.displays;
  },
}));

import { WORKSPACE_SURFACES, type SurfaceAccessUser } from '@bike4mind/common';
import {
  presentWorkspace,
  surfaceRouteExists,
  useWorkspacePresenter,
  useWorkspaceTargets,
} from './useWorkspaceTargets';

// Found by shape rather than by name, so these cases follow whichever gated workspace the registry carries.
const gated = WORKSPACE_SURFACES.find(surface => surface.id !== null && surface.requiredEntitlement !== null);
if (!gated?.id || !gated.requiredEntitlement) throw new Error('expected an entitlement-gated workspace');
const GATED = gated.id;
const OWN_KEY = gated.requiredEntitlement;
const main = WORKSPACE_SURFACES.find(surface => surface.id === null);
if (!main) throw new Error('expected the main notebook list');
const GRANTED = 'partner:pro';

const grantHolder = (entitlements: string[] = [GRANTED]): SurfaceAccessUser => ({
  isAdmin: false,
  tags: [],
  entitlements,
  copyEntitlements: { [GATED]: [GRANTED, 'second:pro'] },
});

/**
 * A user whose only way into a workspace is a copy grant must not see the workspace under a product
 * name they do not hold, nor be sent to that product's page after a fork. The overlay declares what
 * to show instead (`PremiumWorkspaceGrantDisplay`); everyone else keeps the registry's values.
 */
describe('presentWorkspace', () => {
  const displays = {
    [GATED]: [{ key: GRANTED, label: 'Partner Desk', sessionHref: '/desk?session={sessionId}' }],
  };

  it('shows a grant-only holder the declared label, link and route', () => {
    const shown = presentWorkspace(gated, grantHolder(), displays);

    expect(shown.id).toBe(GATED);
    expect(shown.label).toBe('Partner Desk');
    expect(shown.routePrefix).toBe('/desk');
    expect(shown.sessionHref('a/b c')).toBe('/desk?session=a%2Fb%20c');
    expect(shown.requiredEntitlement).toBe(gated.requiredEntitlement);
  });

  it('keeps the registry link and route when the display declares only a label', () => {
    const shown = presentWorkspace(gated, grantHolder(), { [GATED]: [{ key: GRANTED, label: 'Partner Desk' }] });

    expect(shown.label).toBe('Partner Desk');
    expect(shown.routePrefix).toBe(gated.routePrefix);
    expect(shown.sessionHref('s1')).toBe(gated.sessionHref('s1'));
  });

  it('derives the route from a path-segment slot', () => {
    const shown = presentWorkspace(gated, grantHolder(), {
      [GATED]: [{ key: GRANTED, label: 'Partner Desk', sessionHref: '/desk/{sessionId}' }],
    });

    expect(shown.routePrefix).toBe('/desk');
    expect(shown.sessionHref('s1')).toBe('/desk/s1');
  });

  it('matches the held key case-insensitively', () => {
    expect(presentWorkspace(gated, grantHolder(['Partner:PRO']), displays).label).toBe('Partner Desk');
  });

  it("leaves the workspace as registered for a holder of the workspace's own key", () => {
    expect(presentWorkspace(gated, grantHolder([GRANTED, OWN_KEY]), displays)).toBe(gated);
  });

  it('leaves the workspace as registered for an admin', () => {
    expect(presentWorkspace(gated, { ...grantHolder(), isAdmin: true }, displays)).toBe(gated);
  });

  it('leaves the workspace as registered when no display matches a held key', () => {
    expect(presentWorkspace(gated, grantHolder(['second:pro']), displays)).toBe(gated);
    expect(presentWorkspace(gated, grantHolder(), {})).toBe(gated);
  });

  it('uses the first declared display the user holds', () => {
    const shown = presentWorkspace(gated, grantHolder(['second:pro', GRANTED]), {
      [GATED]: [
        { key: GRANTED, label: 'Partner Desk' },
        { key: 'second:pro', label: 'Second Desk' },
      ],
    });

    expect(shown.label).toBe('Partner Desk');
  });

  it('never changes the main notebook list', () => {
    expect(presentWorkspace(main, grantHolder(), displays)).toBe(main);
  });
});

describe('useWorkspaceTargets and useWorkspacePresenter with grant displays', () => {
  beforeEach(() => {
    h.user = { currentUser: { id: 'user-1', tags: [] }, isAdmin: false };
    h.entitlements = [GRANTED];
    h.routes = [{ path: gated.routePrefix }, { path: '/desk' }];
    h.copyEntitlements = { [GATED]: [GRANTED] };
    h.displays = { [GATED]: [{ key: GRANTED, label: 'Partner Desk', sessionHref: '/desk?session={sessionId}' }] };
  });

  it('names the current workspace and its copy-in-place target with the declared label', () => {
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: GATED }));

    expect(result.current.current?.label).toBe('Partner Desk');
    expect(result.current.copyTargets.map(surface => surface.label)).toEqual(['Partner Desk', main.label]);
    expect(result.current.moveTargets.map(surface => surface.label)).toEqual([main.label]);
  });

  it("shows the registry label to a holder of the workspace's own key", () => {
    h.entitlements = [GRANTED, OWN_KEY];
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: GATED }));

    expect(result.current.current?.label).toBe(gated.label);
  });

  it('opens a forked session at the declared link, which the build ships', () => {
    const { result } = renderHook(() => useWorkspacePresenter());
    const home = result.current(gated);

    expect(surfaceRouteExists(home)).toBe(true);
    expect(home.sessionHref('s1')).toBe('/desk?session=s1');
  });

  it('reports the declared route missing when the build does not ship it', () => {
    h.routes = [{ path: gated.routePrefix }];
    const { result } = renderHook(() => useWorkspacePresenter());

    expect(surfaceRouteExists(result.current(gated))).toBe(false);
  });
});
