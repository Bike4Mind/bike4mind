/**
 * Runs a send with a guaranteed release of the submit mutex on failure.
 *
 * `submittingRef` is flipped synchronously at the top of the send body and is
 * only cleared on paths that body reaches, so ANY throw in between latches it
 * true for the lifetime of the mount - and because the re-entrancy guard is a
 * bare `return`, every later Enter, click and programmatic send then goes
 * silently nowhere until a reload. (Observed for real: React's "Maximum update
 * depth exceeded", raised by the `setSubmitting(true)` state write itself while
 * the composer's editor was in an update storm.)
 *
 * The ref is released before `setSubmitting`, because the state write is exactly
 * what can throw again here and the ref is what gates sending. A successful send
 * is untouched: no release, so `submitting` stays true for the duration of the
 * stream and the Stop affordance keeps rendering.
 */
export async function withSubmitMutex<T>(
  submittingRef: { current: boolean },
  setSubmitting: (value: boolean) => void,
  send: () => Promise<T>
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    submittingRef.current = false;
    try {
      setSubmitting(false);
    } catch {
      // Swallowed on purpose: if React is the thing failing, the ref release
      // above has already restored sending, and the original error is the one
      // worth propagating.
    }
    throw error;
  }
}
