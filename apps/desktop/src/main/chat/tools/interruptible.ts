/**
 * How long a stopped call gets to wind itself down before the turn stops waiting for it, in ms.
 *
 * Long enough for a tool that honours the signal - a shell command taking its SIGTERM, an aborted
 * request - to settle with its own account of how far it got, which tells the model more than
 * "interrupted" does. Short enough that Stop and "send now" still read as immediate.
 */
export const STOP_GRACE_MS = 500;

export const INTERRUPTED_MESSAGE =
  'Interrupted: the turn was stopped while this was still running, so its result was not waited ' +
  'for. Whatever it was doing may have partly happened.';

export const STOPPED_BEFORE_CHANGE = 'The turn was stopped before this call changed anything.';

export type StoppableOutcome<T> =
  { kind: 'returned'; value: T } | { kind: 'threw'; error: unknown } | { kind: 'abandoned' };

/**
 * Wait for a tool call, but not past a stop.
 *
 * Once `signal` aborts, the call has `graceMs` to settle by itself; after that the wait ends as
 * 'abandoned' and the work is left to finish unobserved - its result, or its rejection, goes
 * nowhere. The one exception is a call that `holding()` says has started a write (see
 * ToolContext.beginWrite): that is waited for to the end, because leaving it would record a
 * change as interrupted that is in fact landing, and let the next turn read it half done.
 */
export function untilStopped<T>(
  work: Promise<T>,
  signal: AbortSignal,
  holding: () => boolean,
  graceMs = STOP_GRACE_MS
): Promise<StoppableOutcome<T>> {
  return new Promise(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: StoppableOutcome<T>) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      timer = setTimeout(() => {
        if (!holding()) finish({ kind: 'abandoned' });
      }, graceMs);
    };
    work.then(
      value => finish({ kind: 'returned', value }),
      error => finish({ kind: 'threw', error })
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
