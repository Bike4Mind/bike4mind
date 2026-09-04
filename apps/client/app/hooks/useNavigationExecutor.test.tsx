/**
 * The `navigate_view` suggestion buttons dispatch through this hook. The Opti branch is the
 * one with a trap: `/opti` reads its surface from `?mode=`, so a navigate that omits `search`
 * drops the param, the page falls back to its blank-state default, and the page-side consumer
 * discards the pending family instead of opening the console the user clicked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { NavigationIntent } from '@bike4mind/common';

// Hoisted: `optiRouteExists` is computed once when the hook module loads, so the route list has
// to exist before the import below - and the open-core case needs a fresh module to re-read it.
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setActiveTab: vi.fn(),
  setFileBrowserOpen: vi.fn(),
  premiumRoutes: [{ path: '/opti' }] as { path: string }[],
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/components/admin/useAdminModal', () => ({
  useAdminModal: (selector: (s: unknown) => unknown) => selector({ setActiveTab: mocks.setActiveTab }),
}));
vi.mock('@client/app/components/Files/Browser', () => ({
  useFileBrowser: (selector: (s: unknown) => unknown) => selector({ setOpen: mocks.setFileBrowserOpen }),
}));
// Gitignored codegen: absent in a fresh checkout, and its contents are what decides whether the
// Opti branch runs at all, so both shapes have to be drivable from the test.
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({
  get premiumRoutes() {
    return mocks.premiumRoutes;
  },
}));

import { useNavigationExecutor } from './useNavigationExecutor';
import { useOptiNavigation } from './useOptiNavigation';

const intent = (over: Partial<NavigationIntent>): NavigationIntent => ({
  viewId: 'opti.scheduling.gantt',
  label: 'Gantt Chart',
  description: '',
  navigationType: 'action',
  target: 'scheduling.gantt',
  reason: '',
  ...over,
});

const execute = (i: NavigationIntent) => renderHook(() => useNavigationExecutor()).result.current(i);

/** The search value `navigate` was called with, applied to the params already on the URL. */
const resolveSearch = (prev: Record<string, unknown>) => {
  const { search } = mocks.navigate.mock.calls[0][0] as { search?: unknown };
  return typeof search === 'function' ? (search as (p: Record<string, unknown>) => unknown)(prev) : search;
};

describe('useNavigationExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.premiumRoutes = [{ path: '/opti' }];
    useOptiNavigation.getState().clearPending();
  });

  describe('opti action intents', () => {
    it('asks for the console mode so the target survives the navigate', () => {
      execute(intent({}));

      expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/opti' }));
      // The click IS the mode decision: without it the page defaults to its blank state, which
      // consumes and drops the pending family (see QuantumPage's pendingFamily effect).
      expect(resolveSearch({ mode: 'new' })).toMatchObject({ mode: 'optimize' });
    });

    it("does not carry the previous route's params along", () => {
      execute(intent({}));

      // `session` is not one vocabulary across routes - /agent-executions uses it as a replay
      // key - and /opti would restore whatever id reached it. It reflects its own back in.
      expect(resolveSearch({ session: 'not-an-opti-session' })).toEqual({ mode: 'optimize' });
    });

    it('splits a composite target into family and sub-tab', () => {
      execute(intent({}));

      expect(useOptiNavigation.getState()).toMatchObject({ pendingFamily: 'scheduling', pendingSubTab: 'gantt' });
    });

    it('leaves the sub-tab unset for a bare family target', () => {
      execute(intent({ viewId: 'opti.routing', label: 'Routing', target: 'routing' }));

      expect(useOptiNavigation.getState()).toMatchObject({ pendingFamily: 'routing', pendingSubTab: null });
    });

    it('no-ops on an open-core build that has no /opti route', async () => {
      mocks.premiumRoutes = [];
      vi.resetModules();
      const [hook, store] = await Promise.all([import('./useNavigationExecutor'), import('./useOptiNavigation')]);

      renderHook(() => hook.useNavigationExecutor()).result.current(intent({}));

      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(store.useOptiNavigation.getState().pendingFamily).toBeNull();
    });

    it('opens the file browser without navigating', () => {
      execute(intent({ viewId: 'global.files', label: 'Files', target: 'file_browser' }));

      expect(mocks.setFileBrowserOpen).toHaveBeenCalledWith(true);
      expect(mocks.navigate).not.toHaveBeenCalled();
    });
  });

  it('routes a route intent to its target', () => {
    execute(intent({ viewId: 'admin.home', label: 'Admin', navigationType: 'route', target: '/admin' }));

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin' });
  });

  it('selects the admin tab before navigating for a tab intent', () => {
    execute(intent({ viewId: 'admin.users', label: 'Users', navigationType: 'tab', target: '3' }));

    expect(mocks.setActiveTab).toHaveBeenCalledWith(3);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin' });
  });
});
