import { useCliStore } from '../store/index.js';
import { logger } from '../utils/Logger.js';

/**
 * Runs `callback` once nothing holds the session (see `holdSession` in store/index.ts). Agent
 * turns, custom commands, background completion and compaction write the session back from a
 * snapshot taken at their start, so anything appended to it meanwhile would be clobbered.
 *
 * The callback runs synchronously as the last hold is released, before a queued turn can start
 * and take its own snapshot. It runs inside that release, so a throw is logged rather than
 * escaping into the releasing operation's `finally`.
 */
export function whenTurnIdle(callback: () => void): void {
  const runCallback = () => {
    try {
      callback();
    } catch (error) {
      logger.debug(`[whenTurnIdle] callback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (useCliStore.getState().sessionHolds === 0) {
    runCallback();
    return;
  }
  const unsubscribe = useCliStore.subscribe(state => {
    if (state.sessionHolds > 0) return;
    unsubscribe();
    runCallback();
  });
}
