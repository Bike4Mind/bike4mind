import { describe, it, expect, beforeEach } from 'vitest';
import { useOptiNavigation } from './useOptiNavigation';

// pendingUserInitiated is the seam the /opti consumer reads to tell a clicked
// navigate_view button apart from every other dispatch. Defaulting it to true
// anywhere would let a replay yank the user off a view that owns its own layout,
// which is the bug this flag exists to prevent.
describe('useOptiNavigation', () => {
  beforeEach(() => {
    useOptiNavigation.getState().clearPending();
  });

  it('defaults a request to not user-initiated', () => {
    useOptiNavigation.getState().requestFamily('scheduling', 'problem');
    const { pendingFamily, pendingSubTab, pendingUserInitiated } = useOptiNavigation.getState();
    expect(pendingFamily).toBe('scheduling');
    expect(pendingSubTab).toBe('problem');
    expect(pendingUserInitiated).toBe(false);
  });

  it('marks a request user-initiated only when asked to', () => {
    useOptiNavigation.getState().requestFamily('scheduling', 'problem', { userInitiated: true });
    expect(useOptiNavigation.getState().pendingUserInitiated).toBe(true);
  });

  it('resets provenance along with the request', () => {
    useOptiNavigation.getState().requestFamily('routing', undefined, { userInitiated: true });
    useOptiNavigation.getState().clearPending();
    const { pendingFamily, pendingSubTab, pendingUserInitiated } = useOptiNavigation.getState();
    expect(pendingFamily).toBeNull();
    expect(pendingSubTab).toBeNull();
    expect(pendingUserInitiated).toBe(false);
  });
});
