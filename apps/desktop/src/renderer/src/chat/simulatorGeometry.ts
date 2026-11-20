/** A drag shorter than this many CSS pixels is a tap, not a swipe. */
export const SWIPE_THRESHOLD_PX = 8;

export interface DrawnFrame {
  /** The image's on-screen box, from getBoundingClientRect. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The frame's own pixel size, which tells portrait from landscape after a rotation. */
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * A pointer position over the drawn frame, in device points. `screen` is portrait; when the frame
 * is landscape the device has been rotated and the two sides swap. Null outside the frame.
 */
export function toDevicePoints(
  clientX: number,
  clientY: number,
  frame: DrawnFrame,
  screen: { width: number; height: number }
): { x: number; y: number } | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  const relativeX = (clientX - frame.left) / frame.width;
  const relativeY = (clientY - frame.top) / frame.height;
  if (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1) return null;
  const landscape = frame.naturalWidth > frame.naturalHeight;
  const width = landscape ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const height = landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
  return { x: Math.round(relativeX * width * 10) / 10, y: Math.round(relativeY * height * 10) / 10 };
}
