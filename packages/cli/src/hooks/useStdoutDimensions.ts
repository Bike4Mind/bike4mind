import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * Current terminal dimensions that re-render the component on resize.
 *
 * Ink's `useStdout()` exposes the stream but does NOT subscribe to `resize`,
 * so any layout computed from `stdout.columns` goes stale after a resize and
 * only refreshes when some unrelated state change forces a re-render. This
 * hook listens for the stdout `resize` event (SIGWINCH under the hood) and
 * stores the dimensions in state, so consumers repaint at the new width.
 *
 * @returns `[columns, rows]`, falling back to 80x24 when stdout is not a TTY.
 */
export function useStdoutDimensions(): [columns: number, rows: number] {
  const { stdout } = useStdout();

  const [dimensions, setDimensions] = useState<[number, number]>([
    stdout?.columns ?? DEFAULT_COLUMNS,
    stdout?.rows ?? DEFAULT_ROWS,
  ]);

  useEffect(() => {
    if (!stdout) return;

    const onResize = () => {
      setDimensions([stdout.columns ?? DEFAULT_COLUMNS, stdout.rows ?? DEFAULT_ROWS]);
    };

    // Sync once on mount in case the terminal was resized between the initial
    // useState and this effect running.
    onResize();

    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return dimensions;
}
