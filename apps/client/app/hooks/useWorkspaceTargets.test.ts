import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  user: { currentUser: { id: 'user-1', tags: [] as string[] }, isAdmin: false } as Record<string, unknown>,
  entitlements: [] as string[],
  routes: [{ path: '/opti' }] as { path: string }[],
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

import { useWorkspaceTargets } from './useWorkspaceTargets';

const ids = (surfaces: { id: string | null }[]) => surfaces.map(surface => surface.id);

describe('useWorkspaceTargets', () => {
  beforeEach(() => {
    h.user = { currentUser: { id: 'user-1', tags: [] }, isAdmin: false };
    h.entitlements = ['optihashi:pro'];
    h.routes = [{ path: '/opti' }];
  });

  it('offers an entitled owner every workspace to copy into and the others to move to', () => {
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: undefined }));

    expect(result.current.current?.id).toBeNull();
    expect(ids(result.current.copyTargets)).toEqual([null, 'opti']);
    expect(ids(result.current.moveTargets)).toEqual(['opti']);
  });

  it('puts the current workspace first for an opti session', () => {
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: 'opti' }));

    expect(ids(result.current.copyTargets)).toEqual(['opti', null]);
    expect(ids(result.current.moveTargets)).toEqual([null]);
  });

  it('offers no move to a user who does not own the session', () => {
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'someone-else', surface: undefined }));

    expect(ids(result.current.copyTargets)).toEqual([null, 'opti']);
    expect(result.current.moveTargets).toEqual([]);
  });

  it('hides a workspace the user is not entitled to', () => {
    h.entitlements = ['base'];
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: undefined }));

    expect(ids(result.current.copyTargets)).toEqual([null]);
    expect(result.current.moveTargets).toEqual([]);
  });

  it('hides a workspace whose route this build does not ship', () => {
    h.routes = [];
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: undefined }));

    expect(ids(result.current.copyTargets)).toEqual([null]);
  });

  // Private surfaces are unknown to this repo: never a target, and their sessions cannot leave.
  it('offers nothing for a session in an unregistered surface', () => {
    const { result } = renderHook(() => useWorkspaceTargets({ userId: 'user-1', surface: 'some-private-surface' }));

    expect(result.current.current).toBeUndefined();
    expect(result.current.copyTargets).toEqual([]);
    expect(result.current.moveTargets).toEqual([]);
  });
});
