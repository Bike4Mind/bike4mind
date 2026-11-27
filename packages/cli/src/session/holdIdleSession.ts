import { useCliStore } from '../store/index.js';

export type IdleSessionClaim = {
  assertHeld: () => void;
  release: () => void;
};

/** Claim synchronously before awaiting; pass this claim through nested parts of the same operation. */
export function holdIdleSession(): IdleSessionClaim | undefined {
  const store = useCliStore.getState();
  if (store.peerTurnActive || store.turnInFlight || store.sessionHolds > 0 || store.isThinking) return undefined;
  const releaseHold = store.holdSession();
  let held = true;
  return {
    assertHeld: () => {
      if (!held) throw new Error('The session operation no longer owns its hold');
    },
    release: () => {
      if (!held) return;
      held = false;
      releaseHold();
    },
  };
}
