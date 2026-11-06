import Box from '@mui/joy/Box';
import type { SxProps } from '@mui/joy/styles/types';
import { useCallback, useEffect, useState, type ReactNode, type Ref } from 'react';
import { ResizeHandle } from '../ResizeHandle';
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MIN_WIDTH,
  clampDockWidth,
  dockMaxWidth,
  readDockWidth,
  writeDockWidth,
} from './orchestratorPrefs';

/** 'chat' fills the row; 'docked' sits beside the agent stage; 'hidden' is docked but out of sight. */
export type ThreadDockMode = 'chat' | 'docked' | 'hidden';

/**
 * The dock's width: the remembered preference, clamped to half of the current window. A drag moves
 * `width` on every frame and persists only on commit (release, key press or reset).
 */
export function useDockWidth() {
  const [preferred, setPreferred] = useState(readDockWidth);
  const [max, setMax] = useState(() => dockMaxWidth(window.innerWidth));
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const measure = () => setMax(dockMaxWidth(window.innerWidth));
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const clamp = useCallback((next: number) => clampDockWidth(next, max), [max]);
  const commit = useCallback((next: number) => {
    setPreferred(next);
    writeDockWidth(next);
  }, []);

  return {
    width: clamp(preferred),
    min: Math.min(DOCK_MIN_WIDTH, max),
    max,
    clamp,
    dragging,
    setDragging,
    setWidth: setPreferred,
    commit,
  };
}

/**
 * The box the conversation thread lives in, in every mode, so entering or leaving orchestrate, or
 * toggling the dock, never remounts the thread. Owning the dock width here keeps a drag's re-renders
 * to this box: `children` is the same element on every frame, so React skips the thread beneath it.
 */
export function ThreadDock({
  mode,
  hostRef,
  children,
}: {
  mode: ThreadDockMode;
  hostRef: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const dock = useDockWidth();

  // A hidden dock stays laid out (visibility, not display), so the thread keeps its scroll offset.
  const sx: SxProps =
    mode === 'chat'
      ? { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
      : {
          width: dock.width,
          flexShrink: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          ...(mode === 'hidden'
            ? { position: 'absolute', top: 0, right: 0, bottom: 0, visibility: 'hidden' }
            : { position: 'relative', borderLeft: '1px solid', borderColor: 'divider' }),
        };

  return (
    <Box
      ref={hostRef}
      data-testid={mode === 'docked' ? 'orchestrator-dock' : mode === 'hidden' ? 'orchestrator-dock-hidden' : undefined}
      sx={sx}
    >
      {mode === 'docked' && (
        <ResizeHandle
          edge="left"
          label="Resize the conversation"
          testId="orchestrator-dock-resize-handle"
          width={dock.width}
          min={dock.min}
          max={dock.max}
          defaultWidth={DOCK_DEFAULT_WIDTH}
          clamp={dock.clamp}
          dragging={dock.dragging}
          onWidth={dock.setWidth}
          onCommit={dock.commit}
          onDraggingChange={dock.setDragging}
          sx={{ left: -3 }}
        />
      )}
      {children}
    </Box>
  );
}
