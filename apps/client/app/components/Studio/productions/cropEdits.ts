import { STUDIO_CROP_MIN_EDGE, type StudioCropRect } from '@bike4mind/common';

/**
 * Pure edits for the preview's crop box. Rects are normalized to the source frame (see StudioCropRectSchema), and a
 * resize keeps the box at the output's shape, so the stored rect is exactly what the export frames.
 */

export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';
export const CROP_CORNERS: readonly CropCorner[] = ['nw', 'ne', 'sw', 'se'];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Slides the rect by a normalized delta, stopping at the frame edges. */
export const moveCropRect = (rect: StudioCropRect, dx: number, dy: number): StudioCropRect => ({
  ...rect,
  x: clamp(rect.x + dx, 0, 1 - rect.width),
  y: clamp(rect.y + dy, 0, 1 - rect.height),
});

/**
 * Drags `corner` by a normalized delta with the opposite corner pinned. `heightPerWidth` converts a normalized width
 * to the normalized height that keeps the output's shape: (source width / source height) / (output width / height).
 * Whichever axis moved further drives the size, so a mostly vertical drag still resizes a tall box.
 */
export const resizeCropRect = (
  rect: StudioCropRect,
  corner: CropCorner,
  dx: number,
  dy: number,
  heightPerWidth: number
): StudioCropRect => {
  const growsRight = corner === 'ne' || corner === 'se';
  const growsDown = corner === 'sw' || corner === 'se';
  const anchorX = growsRight ? rect.x : rect.x + rect.width;
  const anchorY = growsDown ? rect.y : rect.y + rect.height;
  const widthFromX = rect.width + (growsRight ? dx : -dx);
  const widthFromY = (rect.height + (growsDown ? dy : -dy)) / heightPerWidth;
  const proposed = Math.abs(widthFromX - rect.width) >= Math.abs(widthFromY - rect.width) ? widthFromX : widthFromY;

  const roomX = growsRight ? 1 - anchorX : anchorX;
  const roomY = growsDown ? 1 - anchorY : anchorY;
  const maxWidth = Math.min(roomX, roomY / heightPerWidth);
  const minWidth = Math.max(STUDIO_CROP_MIN_EDGE, STUDIO_CROP_MIN_EDGE / heightPerWidth);
  // A box already pinned below the minimum by the frame edge cannot grow; leave it as it is.
  if (maxWidth < minWidth) return rect;
  const width = clamp(proposed, minWidth, maxWidth);
  const height = width * heightPerWidth;
  return {
    x: growsRight ? anchorX : anchorX - width,
    y: growsDown ? anchorY : anchorY - height,
    width,
    height,
  };
};
