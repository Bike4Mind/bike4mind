import { createContext, useContext, useEffect, useRef } from 'react';
import type { FindMatch } from './threadFind';

/**
 * The match the find bar is on, for the parts of the thread that hide text until opened: the
 * window over older rounds, the section folded above a boundary, collapsed relay and automatic
 * turns, tool rows, and clipped output. Each one that holds the target opens itself.
 *
 * `seq` changes on every move, so stepping back to a match the reader has since folded away
 * opens it again. Nothing closes on its own when the bar moves on or shuts, as in a browser.
 */
export interface FindTarget extends FindMatch {
  seq: number;
}

export const ThreadFindContext = createContext<FindTarget | null>(null);

/**
 * Calls `reveal` once per move whose target `holds` says is inside this component, including
 * when the component mounts already holding it (a tool row's detail mounts after its row opens).
 * `holds` may be a fresh closure each render; only the target's `seq` re-runs the check.
 */
export function useRevealFindTarget(holds: (target: FindTarget) => boolean, reveal: (target: FindTarget) => void) {
  const target = useContext(ThreadFindContext);
  const latest = useRef({ holds, reveal });
  latest.current = { holds, reveal };
  const seq = target?.seq ?? 0;

  useEffect(() => {
    if (target && latest.current.holds(target)) latest.current.reveal(target);
    // Keyed on seq alone: the target object is replaced exactly when seq changes.
  }, [seq]);
}
