import Box from '@mui/joy/Box';
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { MIN_PANE_FRACTION, resizePanes, type OrchestratorLayout, type OrchestratorPane } from './orchestratorLayout';
import { ORCHESTRATOR_VIEW_INFO } from './ViewSwitcher';

/** One arrow-key press on a resize handle, as a fraction of the stage. */
export const RESIZE_KEY_STEP = 0.05;

const PANE_SELECTOR = '[data-orchestrator-pane]';

interface StageLayoutProps {
  layout: OrchestratorLayout;
  onLayoutChange(layout: OrchestratorLayout): void;
  /** Draws one pane: its view, of the active session or of the session the pane is pinned to. */
  renderPane(pane: OrchestratorPane, index: number): ReactNode;
}

/**
 * Lays the stage's panes out in a row or a column with a resize handle between each pair. A single pane is
 * drawn bare, exactly as the stage drew one view before layouts. F6 and Shift+F6 move focus between panes.
 */
export function StageLayout({ layout, onLayoutChange, renderPane }: StageLayoutProps) {
  const container = useRef<HTMLDivElement | null>(null);
  // A drag redraws from this and is remembered once, on release, rather than on every pointer move.
  const [dragged, setDragged] = useState<OrchestratorLayout | null>(null);
  const shown = dragged ?? layout;
  const cancelDrag = useRef<(() => void) | null>(null);
  // A layout set from elsewhere mid-drag (a reset, a session switch) wins: the drag is dropped, not saved over it.
  useEffect(() => () => cancelDrag.current?.(), [layout]);

  if (shown.panes.length === 1) return <>{renderPane(shown.panes[0], 0)}</>;

  const row = shown.split === 'row';

  const startDrag = (handle: number, event: ReactPointerEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    const extent = box ? (row ? box.width : box.height) : 0;
    if (event.button !== 0 || extent <= 0) return;
    event.preventDefault();
    const start = row ? event.clientX : event.clientY;
    const from = layout;
    let latest = layout;
    const onMove = (move: PointerEvent) => {
      latest = resizePanes(from, handle, ((row ? move.clientX : move.clientY) - start) / extent);
      setDragged(latest);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      cancelDrag.current = null;
      setDragged(null);
    };
    const onUp = () => {
      stop();
      if (latest !== from) onLayoutChange(latest);
    };
    cancelDrag.current = stop;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const resizeByKey = (handle: number, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const shrink = row ? 'ArrowLeft' : 'ArrowUp';
    const grow = row ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== shrink && event.key !== grow) return;
    event.preventDefault();
    onLayoutChange(resizePanes(layout, handle, event.key === grow ? RESIZE_KEY_STEP : -RESIZE_KEY_STEP));
  };

  const movePaneFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey) return;
    const panes = [...(container.current?.querySelectorAll<HTMLElement>(PANE_SELECTOR) ?? [])];
    const current = panes.findIndex(pane => event.target instanceof Node && pane.contains(event.target));
    if (current === -1) return;
    event.preventDefault();
    const step = event.shiftKey ? -1 : 1;
    panes[(current + step + panes.length) % panes.length].focus();
  };

  return (
    <Box
      ref={container}
      data-testid="orchestrator-layout"
      data-split={shown.split}
      onKeyDown={movePaneFocus}
      sx={{ display: 'flex', flexDirection: row ? 'row' : 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      {shown.panes.map((pane, index) => {
        const label = ORCHESTRATOR_VIEW_INFO[pane.view].label;
        return (
          // By position: a pane keeps its place (and its view's state) while its neighbour changes view.
          <Fragment key={index}>
            {index > 0 && (
              <Box
                role="separator"
                tabIndex={0}
                aria-orientation={row ? 'vertical' : 'horizontal'}
                aria-label={`Resize pane ${index} and pane ${index + 1}`}
                aria-valuemin={Math.round(MIN_PANE_FRACTION * 100)}
                aria-valuemax={Math.round((shown.panes[index - 1].size + pane.size - MIN_PANE_FRACTION) * 100)}
                aria-valuenow={Math.round(shown.panes[index - 1].size * 100)}
                data-testid={`orchestrator-pane-handle-${index - 1}`}
                onPointerDown={event => startDrag(index - 1, event)}
                onKeyDown={event => resizeByKey(index - 1, event)}
                sx={{
                  flex: '0 0 auto',
                  [row ? 'width' : 'height']: 6,
                  cursor: row ? 'col-resize' : 'row-resize',
                  bgcolor: 'divider',
                  touchAction: 'none',
                  transition: 'background-color 120ms',
                  '&:hover, &:focus-visible': { bgcolor: 'primary.outlinedBorder', outline: 'none' },
                }}
              />
            )}
            <Box
              role="region"
              aria-label={`Pane ${index + 1}: ${label}`}
              tabIndex={-1}
              data-orchestrator-pane=""
              data-pane-index={index}
              data-testid={`orchestrator-pane-${index}`}
              data-view={pane.view}
              sx={{
                flex: `${pane.size} 1 0px`,
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 0,
                overflow: 'auto',
                '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: -2 },
              }}
            >
              {renderPane(pane, index)}
            </Box>
          </Fragment>
        );
      })}
    </Box>
  );
}
