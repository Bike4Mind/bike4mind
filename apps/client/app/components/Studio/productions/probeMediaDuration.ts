const PROBE_TIMEOUT_MS = 10_000;

/**
 * A media file's length in ms, read from its metadata in a detached element (FabFiles do not store a duration).
 * Resolves undefined when the browser cannot read it in time; the caller falls back to a default clip length.
 */
export const probeMediaDurationMs = (url: string): Promise<number | undefined> =>
  new Promise(resolve => {
    const element = document.createElement('video');
    const finish = (durationMs: number | undefined) => {
      clearTimeout(timer);
      element.removeAttribute('src');
      element.load();
      resolve(durationMs);
    };
    const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);
    element.preload = 'metadata';
    element.onloadedmetadata = () =>
      finish(
        Number.isFinite(element.duration) && element.duration > 0 ? Math.round(element.duration * 1000) : undefined
      );
    element.onerror = () => finish(undefined);
    element.src = url;
  });
