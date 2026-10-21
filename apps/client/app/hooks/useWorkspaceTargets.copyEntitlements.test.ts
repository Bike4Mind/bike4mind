import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  user: { currentUser: { id: 'user-1', tags: [] as string[] }, isAdmin: false } as Record<string, unknown>,
  entitlements: [] as string[],
  routes: [] as { path: string }[],
  copyEntitlements: {} as Record<string, string[]>,
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

import { WORKSPACE_SURFACES } from '@bike4mind/common';
import { useWorkspaceTargets } from './useWorkspaceTargets';

// Found by shape rather than by name, so these cases follow whichever gated workspace the registry carries.
const gated = WORKSPACE_SURFACES.find(surface => surface.id !== null && surface.requiredEntitlement !== null);
if (!gated?.id) throw new Error('expected an entitlement-gated workspace');
const GATED = gated.id;
const GRANTED = 'questmaster:pro';

const ids = (surfaces: { id: string | null }[]) => surfaces.map(surface => surface.id);

/**
 * The clone/fork menus must offer exactly what the server keeps in place (`resolveCopySurface`), or a
 * checked "copy here" silently lands in the main list. Both read the same generated grant table.
 */
describe('useWorkspaceTargets with overlay copy grants', () => {
  beforeEach(() => {
    h.user = { currentUser: { id: 'user-1', tags: [] }, isAdmin: false };
    h.entitlements = [GRANTED];
    h.routes = [{ path: gated.routePrefix }];
    h.copyEntitlements = { [GATED]: [GRANTED] };
  });

  it('offers a grant holder a copy in place for a session already in the workspace', () => {
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: GATED }));

    expect(ids(result.current.copyTargets)).toEqual([GATED, null]);
    expect(ids(result.current.moveTargets)).toEqual([null]);
  });

  it('offers a grant holder no copy or move INTO the workspace from the main list', () => {
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: undefined }));

    expect(ids(result.current.copyTargets)).toEqual([null]);
    expect(result.current.moveTargets).toEqual([]);
  });

  it('offers no copy in place without a grant for the workspace', () => {
    h.copyEntitlements = {};
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: GATED }));

    expect(ids(result.current.copyTargets)).toEqual([null]);
  });

  it('offers no copy in place to a user without the granted key', () => {
    h.entitlements = ['base'];
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: GATED }));

    expect(ids(result.current.copyTargets)).toEqual([null]);
  });
});
