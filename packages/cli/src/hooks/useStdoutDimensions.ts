import { useSyncExternalStore } from 'react';
import { useStdout } from 'ink';

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

type Dimensions = [columns: number, rows: number];

interface DimensionsStore {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => Dimensions;
}

function readDimensions(stdout: NodeJS.WriteStream): Dimensions {
  return [stdout.columns || DEFAULT_COLUMNS, stdout.rows || DEFAULT_ROWS];
}

/**
 * One store per stream, so N hook consumers share a single `resize` listener.
 * Attaching one listener per consumer would blow past Node's default
 * maxListeners=10 on the shared `process.stdout` and print a
 * MaxListenersExceededWarning mid-frame (<Static> bulk-mounts every message on
 * the first render, so a resumed session with 10+ messages hits this).
 */
const storesByStream = new WeakMap<NodeJS.WriteStream, DimensionsStore>();

function getStore(stdout: NodeJS.WriteStream): DimensionsStore {
  const existing = storesByStream.get(stdout);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  let snapshot = readDimensions(stdout);

  const onResize = () => {
    const next = readDimensions(stdout);
    // Same dimensions must return the same array reference or
    // useSyncExternalStore re-renders every consumer for nothing.
    if (next[0] === snapshot[0] && next[1] === snapshot[1]) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const store: DimensionsStore = {
    subscribe(onStoreChange) {
      if (listeners.size === 0) {
        // Catch any resize that landed while nothing was subscribed; React
        // re-reads the snapshot right after subscribing and picks it up.
        snapshot = readDimensions(stdout);
        stdout.on('resize', onResize);
      }
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
        if (listeners.size === 0) stdout.off('resize', onResize);
      };
    },
    getSnapshot: () => snapshot,
  };

  storesByStream.set(stdout, store);
  return store;
}

const FALLBACK_DIMENSIONS: Dimensions = [DEFAULT_COLUMNS, DEFAULT_ROWS];
const fallbackStore: DimensionsStore = {
  subscribe: () => () => {},
  getSnapshot: () => FALLBACK_DIMENSIONS,
};

/**
 * Current terminal dimensions that re-render the component on resize.
 *
 * Ink's `useStdout()` exposes the stream but does NOT subscribe to `resize`,
 * so any layout computed from `stdout.columns` goes stale after a resize and
 * only refreshes when some unrelated state change forces a re-render. This
 * hook listens for the stdout `resize` event (SIGWINCH under the hood), shared
 * across all consumers of the same stream.
 *
 * @returns `[columns, rows]`, falling back to 80x24 when stdout is missing or
 * reports no dimensions (not a TTY).
 */
export function useStdoutDimensions(): Dimensions {
  const { stdout } = useStdout();
  const store = stdout ? getStore(stdout) : fallbackStore;
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
