import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Typography from '@mui/joy/Typography';
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
 * Whether an Escape that reached the window is the dock's to take. A menu, listbox, dialog or open select owns
 * its own Escape, and the peek drawer claims one first by preventing its default (OrchestratorStage).
 */
export function escapeClosesDock(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return false;
  if (document.querySelector('[aria-modal="true"]')) return false;
  const target = event.target instanceof Element ? event.target : null;
  // aria-expanded covers a select whose focus stays on its trigger while its listbox is open.
  return !target?.closest('[role="menu"], [role="listbox"], [role="dialog"], [aria-expanded="true"]');
}

/**
 * The box the conversation thread lives in, in every mode, so entering or leaving orchestrate, or
 * toggling the dock, never remounts the thread. Owning the dock width here keeps a drag's re-renders
 * to this box: `children` is the same element on every frame, so React skips the thread beneath it.
 */
export function ThreadDock({
  mode,
  hostRef,
  onClose,
  children,
}: {
  mode: ThreadDockMode;
  hostRef: Ref<HTMLDivElement>;
  /** Hides a docked thread: the dock's own close button and Escape, beside the stage header's toggle. */
  onClose?(): void;
  children: ReactNode;
}) {
  const dock = useDockWidth();
  // The header stays mounted while hidden too, so reopening never shifts the thread under the reader.
  const hasHeader = mode !== 'chat' && onClose !== undefined;

  useEffect(() => {
    if (mode !== 'docked' || !onClose) return;
    const close = onClose;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!escapeClosesDock(event)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, onClose]);

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
      {hasHeader && (
        <Box
          data-testid="orchestrator-dock-header"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            pl: 2,
            pr: 1,
            py: 0.5,
            borderBottom: '1px solid',
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          <Typography level="title-sm" sx={{ flex: 1, minWidth: 0 }}>
            Conversation
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Hide the conversation"
            title="Hide the conversation (Esc)"
            data-testid="orchestrator-dock-close-btn"
            onClick={onClose}
          >
            {'\u00D7'}
          </IconButton>
        </Box>
      )}
      {children}
    </Box>
  );
}
