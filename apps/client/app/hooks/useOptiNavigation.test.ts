import { describe, it, expect, beforeEach } from 'vitest';
import { useOptiNavigation } from './useOptiNavigation';

// pendingUserInitiated is the seam the /opti consumer reads to tell a clicked
// navigate_view button apart from every other dispatch. Defaulting it to true
// anywhere would let a replay yank the user off a view that owns its own layout,
// which is the bug this flag exists to prevent.
describe('useOptiNavigation', () => {
  beforeEach(() => {
    useOptiNavigation.getState().clearPending();
    useOptiNavigation.getState().setHostHandlesFamilyInPlace(false);
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

  // Read off the initial state, not the live one: the suite's own reset would
  // mask a default that shipped as true, which would route every click into a
  // surface that is not mounted.
  it('claims nothing in place until a host registers', () => {
    expect(useOptiNavigation.getInitialState().hostHandlesFamilyInPlace).toBe(false);
  });

  // The claim is a registration by whichever surface is mounted, not part of a
  // request - clearing it with the request would drop the claim on the first
  // dispatch and send the next one off to the standalone view.
  it('keeps a host claim across a consumed request', () => {
    useOptiNavigation.getState().setHostHandlesFamilyInPlace(true);
    useOptiNavigation.getState().requestFamily('assignment', undefined, { userInitiated: true });
    useOptiNavigation.getState().clearPending();
    expect(useOptiNavigation.getState().hostHandlesFamilyInPlace).toBe(true);
  });

  it('drops the claim when the host unregisters', () => {
    useOptiNavigation.getState().setHostHandlesFamilyInPlace(true);
    useOptiNavigation.getState().setHostHandlesFamilyInPlace(false);
    expect(useOptiNavigation.getState().hostHandlesFamilyInPlace).toBe(false);
  });
});
