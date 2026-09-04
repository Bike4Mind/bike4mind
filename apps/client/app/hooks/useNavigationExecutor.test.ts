import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNavigationExecutor } from './useNavigationExecutor';
import { useOptiNavigation } from './useOptiNavigation';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@client/app/components/admin/useAdminModal', () => ({
  useAdminModal: (selector: (s: unknown) => unknown) => selector({ setActiveTab: vi.fn() }),
}));

vi.mock('@client/app/components/Files/Browser', () => ({
  useFileBrowser: (selector: (s: unknown) => unknown) => selector({ setOpen: vi.fn() }),
}));

// The executor no-ops on Opti intents unless an /opti route is present, and the
// open-core route table is empty - so the overlay's route has to be stood in for.
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({
  premiumRoutes: [{ path: '/opti' }],
}));

const optiIntent = (target: string) =>
  ({ navigationType: 'action', target }) as Parameters<ReturnType<typeof useNavigationExecutor>>[0];

describe('useNavigationExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOptiNavigation.getState().clearPending();
  });

  it('marks an Opti click as user-initiated so the surface does not drop it as a replay', () => {
    const { result } = renderHook(() => useNavigationExecutor());
    result.current(optiIntent('scheduling.solvers'));

    const { pendingFamily, pendingSubTab, pendingUserInitiated } = useOptiNavigation.getState();
    expect(pendingFamily).toBe('scheduling');
    expect(pendingSubTab).toBe('solvers');
    expect(pendingUserInitiated).toBe(true);
  });

  // router-core hands a plain `search` object through untouched, so naming mode as a
  // literal would drop every other param on the way to /opti - losing `article`
  // outright, since nothing downstream puts it back.
  it('merges mode into the existing search params instead of replacing them', () => {
    const { result } = renderHook(() => useNavigationExecutor());
    result.current(optiIntent('scheduling'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const { to, search } = mockNavigate.mock.calls[0][0];
    expect(to).toBe('/opti');
    expect(typeof search).toBe('function');
    expect(search({ mode: 'canvas', session: 'abc', article: 'xyz' })).toEqual({
      mode: 'optimize',
      session: 'abc',
      article: 'xyz',
    });
  });
});
