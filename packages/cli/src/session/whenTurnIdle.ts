import { useCliStore } from '../store/index.js';

/**
 * Runs `callback` once nothing holds the session (see `holdSession` in store/index.ts). Agent
 * turns, custom commands, compaction and handoff write the session back from a snapshot taken
 * at their start, so anything appended to it meanwhile would be clobbered or overwritten.
 *
 * The callback runs synchronously as the last hold is released, before a queued turn can start
 * and take its own snapshot.
 */
export function whenTurnIdle(callback: () => void): void {
  if (useCliStore.getState().sessionHolds === 0) {
    callback();
    return;
  }
  const unsubscribe = useCliStore.subscribe(state => {
    if (state.sessionHolds > 0) return;
    unsubscribe();
    callback();
  });
}
