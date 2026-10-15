import { useCliStore } from '../store/index.js';

/**
 * Runs `callback` once no agent turn is in flight. A turn writes the session from a snapshot it
 * took at its start (and a custom command finalizes "the last message"), so anything appended to
 * the session mid-turn is clobbered or overwritten.
 *
 * `isThinking` drops to false synchronously between an auto-compaction and the turn it precedes
 * (turnController.ts), so idleness is confirmed a macrotask later before `callback` runs.
 */
export function whenTurnIdle(callback: () => void): void {
  const runIfStillIdle = () => {
    if (useCliStore.getState().isThinking) {
      waitForIdle();
      return;
    }
    callback();
  };

  const waitForIdle = () => {
    const unsubscribe = useCliStore.subscribe(state => {
      if (state.isThinking) return;
      unsubscribe();
      setImmediate(runIfStillIdle);
    });
  };

  if (useCliStore.getState().isThinking) {
    waitForIdle();
  } else {
    callback();
  }
}
