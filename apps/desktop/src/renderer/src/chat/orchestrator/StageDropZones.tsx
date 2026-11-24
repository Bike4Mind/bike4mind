import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { carriesSession, draggedSessionId } from '../sessionDrag';
import type { OrchestratorLayout } from './orchestratorLayout';
import { EDGE_ZONE_FRACTION, allowedDropZones, applySessionDrop, dropZoneAt, type StageDropZone } from './stageDrop';

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A session drag over the stage: the zone under the cursor, and for `center` the pane it would re-pin. */
interface Hover {
  zone: StageDropZone | undefined;
  paneIndex: number;
  paneRect: Rect | undefined;
}

const ZONE_LABEL: Record<StageDropZone, string> = { right: 'Open beside', bottom: 'Open below', center: 'Show here' };

const EDGE_PERCENT = `${EDGE_ZONE_FRACTION * 100}%`;

const ZONE_RECT: Record<Exclude<StageDropZone, 'center'>, Record<string, number | string>> = {
  right: { top: 0, right: 0, bottom: 0, width: EDGE_PERCENT },
  bottom: { left: 0, right: 0, bottom: 0, height: EDGE_PERCENT },
};

interface StageDropZonesProps {
  layout: OrchestratorLayout;
  onLayoutChange(layout: OrchestratorLayout): void;
  /** The stage's own session: dropping it is ignored, as it already fills every unpinned pane. */
  activeId: string | undefined;
  /** Whether an id is a listed session; anything else dropped is ignored. */
  isListed(sessionId: string): boolean;
  children: ReactNode;
}

/**
 * Takes a session dragged onto the stage (a sidebar row or a Mission Control tile) and opens it as a pinned
 * pane, drawing the zones the layout allows (stageDrop.ts) while the drag is over it.
 */
export function StageDropZones({ layout, onLayoutChange, activeId, isListed, children }: StageDropZonesProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const track = (event: DragEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box || !carriesSession([...event.dataTransfer.types])) return;
    const zone = dropZoneAt(layout, {
      x: box.width > 0 ? (event.clientX - box.left) / box.width : 0,
      y: box.height > 0 ? (event.clientY - box.top) / box.height : 0,
    });
    const pane = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane-index]') : null;
    const paneIndex = Number(pane?.dataset.paneIndex ?? layout.panes.length - 1);
    const paneBox = pane?.getBoundingClientRect();
    const paneRect = paneBox && {
      left: paneBox.left - box.left,
      top: paneBox.top - box.top,
      width: paneBox.width,
      height: paneBox.height,
    };
    if (zone) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
    setHover(current =>
      current && current.zone === zone && current.paneIndex === paneIndex && sameRect(current.paneRect, paneRect)
        ? current
        : { zone, paneIndex, paneRect }
    );
  };

  const leave = (event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && container.current?.contains(event.relatedTarget)) return;
    setHover(null);
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    const target = hover;
    setHover(null);
    if (!target?.zone) return;
    event.preventDefault();
    const sessionId = draggedSessionId(event.dataTransfer);
    if (!sessionId || sessionId === activeId || !isListed(sessionId)) return;
    onLayoutChange(applySessionDrop(layout, target.zone, sessionId, target.paneIndex));
  };

  return (
    <Box
      ref={container}
      onDragEnter={track}
      onDragOver={track}
      onDragLeave={leave}
      onDrop={drop}
      data-testid="orchestrator-stage-drop-target"
      sx={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      {children}
      {hover && <ZoneOverlay layout={layout} hover={hover} />}
    </Box>
  );
}

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function ZoneOverlay({ layout, hover }: { layout: OrchestratorLayout; hover: Hover }) {
  const zones = allowedDropZones(layout);
  return (
    <Box
      aria-hidden="true"
      data-testid="orchestrator-stage-drop-zones"
      sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 10 }}
    >
      {zones.map(zone => {
        const active = hover.zone === zone;
        const rect = zone === 'center' ? centerRect(hover) : ZONE_RECT[zone];
        if (zone === 'center' && !active) return null;
        return (
          <Box
            key={zone}
            data-testid={`orchestrator-stage-drop-zone-${zone}`}
            data-active={active ? 'true' : undefined}
            sx={{
              position: 'absolute',
              ...rect,
              m: zone === 'center' ? 0 : 0.75,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 'md',
              border: '2px dashed',
              borderColor: active ? 'primary.outlinedColor' : 'primary.outlinedBorder',
              bgcolor: active ? 'primary.softBg' : 'transparent',
              opacity: active ? 0.95 : 0.6,
              transition: 'background-color 120ms, opacity 120ms',
            }}
          >
            <Typography level="title-sm" color="primary">
              {ZONE_LABEL[zone]}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

function centerRect({ paneRect }: Hover): Record<string, number> {
  if (!paneRect) return { top: 0, left: 0, right: 0, bottom: 0 };
  return { left: paneRect.left, top: paneRect.top, width: paneRect.width, height: paneRect.height };
}
