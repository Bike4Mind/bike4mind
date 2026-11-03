import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoadedModelState } from '@shared/models';
import { LOADED_POLL_MS } from './contextStatus';

/**
 * Whether `modelId` is loaded on its Ollama server: read when `active` turns on, then every
 * LOADED_POLL_MS while the window is visible and the last read succeeded. `refresh` asks once
 * now, for a tooltip that just opened, and restarts the interval if that read succeeds.
 *
 * A failed read (`unknown`) stops the interval until the next hover or visibility return: a read
 * of a saved server that is down re-marks its health, which reloads the model catalog. A runtime
 * that answers `unsupported` is not asked again. Nothing from before a turn is kept past it.
 */
export function useLoadedModelState(
  modelId: string | null,
  active: boolean
): { state: LoadedModelState | null; refresh: () => void } {
  const [result, setResult] = useState<{ modelId: string; state: LoadedModelState } | null>(null);
  const ask = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!modelId || !active) return;
    const id = modelId;
    let disposed = false;
    let unsupported = false;
    let latest = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer === null) timer = setInterval(read, LOADED_POLL_MS);
    };
    function read() {
      if (unsupported || document.visibilityState === 'hidden') return;
      const request = ++latest;
      window.b4m.models.getLoadedState(id).then(
        state => {
          if (disposed || request !== latest) return;
          setResult({ modelId: id, state });
          if (state.kind === 'unsupported') unsupported = true;
          if (state.kind === 'unsupported' || state.kind === 'unknown') stop();
          else if (document.visibilityState !== 'hidden') start();
        },
        () => undefined
      );
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else read();
    };
    read();
    document.addEventListener('visibilitychange', onVisibility);
    ask.current = read;
    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      ask.current = () => undefined;
      setResult(null);
    };
  }, [modelId, active]);

  const refresh = useCallback(() => ask.current(), []);
  return { state: result && result.modelId === modelId ? result.state : null, refresh };
}
