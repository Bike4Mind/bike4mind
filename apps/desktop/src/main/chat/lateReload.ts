export type LateReload = {
  /** A server's slow listing landed; reloads once for every notice inside the debounce window. */
  notify: () => void;
  /** Cancels a pending reload; later notices are ignored. */
  stop: () => void;
};

/** Gathers model servers whose slow listings finish close together into one chat model list reload. */
export function createLateReload(reload: () => void, delayMs: number): LateReload {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  return {
    notify: () => {
      if (timer || stopped) return;
      timer = setTimeout(() => {
        timer = undefined;
        reload();
      }, delayMs);
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
