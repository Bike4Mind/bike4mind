import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { styled } from '@mui/system';
import type { StudioCropRect } from '@bike4mind/common';
import { studioColor } from '../design/studioTokens';
import { CROP_CORNERS, moveCropRect, resizeCropRect, type CropCorner } from './cropEdits';

const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.1;
const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const Layer = styled('div')({ position: 'absolute', inset: 0, overflow: 'hidden', touchAction: 'none' });

const Box = styled('div')({
  position: 'absolute',
  cursor: 'move',
  outline: `2px solid ${studioColor('accent-bright')}`,
  // Dims everything outside the box; the layer's overflow clips the shadow to the frame.
  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
  '&:focus-visible': { outline: `3px solid ${studioColor('focus-ring')}` },
});

const HANDLE_PX = 14;
const HANDLE_POSITION: Record<CropCorner, { top?: number; bottom?: number; left?: number; right?: number }> = {
  nw: { top: -HANDLE_PX / 2, left: -HANDLE_PX / 2 },
  ne: { top: -HANDLE_PX / 2, right: -HANDLE_PX / 2 },
  sw: { bottom: -HANDLE_PX / 2, left: -HANDLE_PX / 2 },
  se: { bottom: -HANDLE_PX / 2, right: -HANDLE_PX / 2 },
};
const HANDLE_CURSOR: Record<CropCorner, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
};

const Handle = styled('div')({
  position: 'absolute',
  width: HANDLE_PX,
  height: HANDLE_PX,
  borderRadius: '50%',
  background: studioColor('accent-bright'),
  border: '2px solid white',
});

const cornerOf = (value: string | undefined): CropCorner | null =>
  CROP_CORNERS.find(corner => corner === value) ?? null;

type Drag = {
  corner: CropCorner | null;
  startX: number;
  startY: number;
  startRect: StudioCropRect;
  frameWidth: number;
  frameHeight: number;
};

type CropEditorProps = {
  /** The rect the output shows, normalized to the source; the layer this draws in has the source's shape. */
  rect: StudioCropRect;
  /** Normalized height per normalized width that keeps the output's shape; see resizeCropRect. */
  heightPerWidth: number;
  label: string;
  onChange: (rect: StudioCropRect) => void;
};

/** Drag the box to pan, a corner to zoom, or the arrow keys to nudge (Shift for larger steps). */
const CropEditor = ({ rect, heightPerWidth, label, onChange }: CropEditorProps) => {
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);

  // One handler for the box and its handles; a handle names its corner in data-corner.
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    const corner = cornerOf(event.currentTarget.dataset.corner);
    const frame = layerRef.current?.getBoundingClientRect();
    if (!frame || frame.width === 0 || frame.height === 0) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
      frameWidth: frame.width,
      frameHeight: frame.height,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / drag.frameWidth;
    const dy = (event.clientY - drag.startY) / drag.frameHeight;
    onChange(
      drag.corner
        ? resizeCropRect(drag.startRect, drag.corner, dx, dy, heightPerWidth)
        : moveCropRect(drag.startRect, dx, dy)
    );
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = ARROW_DELTAS[event.key];
    if (!delta) return;
    event.preventDefault();
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    onChange(moveCropRect(rect, delta[0] * step, delta[1] * step));
  };

  // Moves bubble here from whichever element captured the pointer.
  return (
    <Layer
      ref={layerRef}
      data-testid="production-crop-editor"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <Box
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(rect.x * 100)}
        aria-valuetext={`Left ${Math.round(rect.x * 100)}%, top ${Math.round(rect.y * 100)}%, width ${Math.round(rect.width * 100)}%`}
        data-testid="production-crop-box"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
        }}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
      >
        {CROP_CORNERS.map(corner => (
          <Handle
            key={corner}
            data-testid={`production-crop-handle-${corner}`}
            style={{ ...HANDLE_POSITION[corner], cursor: HANDLE_CURSOR[corner] }}
            data-corner={corner}
            onPointerDown={startDrag}
          />
        ))}
      </Box>
    </Layer>
  );
};

export default CropEditor;
