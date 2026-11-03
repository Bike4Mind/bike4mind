import { useEffect, useState } from 'react';
import { IDLE_SIMULATOR_VIEW, type SimulatorViewState } from '@shared/simulator';

/** The live simulator view's state, pushed from main. `available` stays false off macOS. */
export function useSimulatorView(): SimulatorViewState {
  const [state, setState] = useState<SimulatorViewState>(IDLE_SIMULATOR_VIEW);
  useEffect(() => {
    let live = true;
    const unsubscribe = window.b4m.simulator.onState(next => setState(next));
    void window.b4m.simulator.getState().then(next => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return state;
}
