import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard: a first message sent with no active session must delegate to
 * the host route's `useSessionRouter.hostCreateSession` factory (which creates a
 * TREATED session, e.g. /opti's surface:'opti') and short-circuit, INSTEAD of
 * falling through to the generic send path (which would let the server auto-create
 * a generic `surface: null` session and orphan the notebook from the surface's
 * scoped nav).
 *
 * The load-bearing invariant is ORDERING: the delegation must run before the
 * generic send begins (`setSubmitting(true)` and the `/new` optimistic-create block).
 *
 * A source-level assertion is used (rather than a full `renderHook`) because
 * `useSendMessage` consumes ~15 context providers; a full render adds little
 * signal beyond locking this invariant.
 */
describe('useSendMessage — host-managed first-message creation (regression)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('delegates a no-session send to the host factory and short-circuits', () => {
    // The guard reads the host factory from useSessionRouter and awaits it with the prompt.
    expect(source).toContain('useSessionRouter.getState().hostCreateSession');
    expect(source).toMatch(/await hostCreateSession\(prompt\);\s*setSubmitting\(false\);\s*return;/);
  });

  it('runs the delegation only when there is no active session', () => {
    const guardIdx = source.indexOf('useSessionRouter.getState().hostCreateSession');
    const noSessionGuardIdx = source.lastIndexOf('if (!currentSession)', guardIdx);
    expect(noSessionGuardIdx).toBeGreaterThan(-1);
    expect(noSessionGuardIdx).toBeLessThan(guardIdx);
  });

  it('delegates BEFORE the generic send path begins (ordering invariant)', () => {
    const delegateIdx = source.indexOf('await hostCreateSession(prompt)');
    const newOptimisticIdx = source.indexOf("location.pathname === '/new'");

    expect(delegateIdx).toBeGreaterThan(-1);
    // Delegation short-circuits before the /new optimistic-create branch that would mint a generic session.
    expect(delegateIdx).toBeLessThan(newOptimisticIdx);
  });

  it('resets submitting state on the host-create early-return path', () => {
    // setSubmitting(true) is a re-entrancy lock at the top of handleSendClick.
    // The host-create path must call setSubmitting(false) before returning so the
    // UI is not left stuck in a submitting state.
    expect(source).toMatch(/await hostCreateSession\(prompt\);[\s\S]*?setSubmitting\(false\);[\s\S]*?return;/);
  });

  it('uses a ref-based mutex for the re-entrancy guard', () => {
    // React state updates are batched, so the guard must check a synchronous ref
    // rather than the closure-captured state value.
    expect(source).toContain('submittingRef.current');
  });
});
