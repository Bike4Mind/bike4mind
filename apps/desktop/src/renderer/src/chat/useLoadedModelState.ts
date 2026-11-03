import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoadedModelState } from '@shared/models';
import { LOADED_POLL_MS } from './contextStatus';

/**
 * Whether `modelId` is loaded on its Ollama server, read on mount and every LOADED_POLL_MS while
 * `active` and the window is visible. A runtime that answers `unsupported` is not asked again.
 * `refresh` asks once now, for a tooltip that just opened.
 */
export function useLoadedModelState(
  modelId: string | null,
  active: boolean
): { state: LoadedModelState | null; refresh: () => void } {
  const [result, setResult] = useState<{ modelId: string; state: LoadedModelState } | null>(null);
  const ask = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!modelId || !active) return;
    let disposed = false;
    let unsupported = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const read = () => {
      if (unsupported || document.visibilityState === 'hidden') return;
      window.b4m.models.getLoadedState(modelId).then(
        state => {
          if (disposed) return;
          setResult({ modelId, state });
          if (state.kind === 'unsupported') {
            unsupported = true;
            stop();
          }
        },
        () => undefined
      );
    };
    const start = () => {
      if (timer === null && !unsupported) timer = setInterval(read, LOADED_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else {
        read();
        start();
      }
    };
    read();
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    ask.current = read;
    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      ask.current = () => undefined;
    };
  }, [modelId, active]);

  const refresh = useCallback(() => ask.current(), []);
  return { state: result && result.modelId === modelId ? result.state : null, refresh };
}
