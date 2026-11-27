import { z } from 'zod';

export const windowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type WindowBounds = z.infer<typeof windowBoundsSchema>;
export type WindowSize = Pick<WindowBounds, 'width' | 'height'>;

/**
 * Saved bounds, moved fully onto the display work area they overlap most. A window saved on an
 * unplugged display, or under a menu bar or dock that has since grown, would otherwise reopen
 * where its title bar cannot be reached. Null, when it overlaps no display, means "use the
 * default placement".
 */
export function fitBoundsToDisplays(
  saved: WindowBounds | null,
  workAreas: readonly WindowBounds[],
  minSize: WindowSize
): WindowBounds | null {
  if (!saved) return null;
  let best: WindowBounds | null = null;
  let bestOverlap = 0;
  for (const area of workAreas) {
    const overlapX = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const overlapY = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
    const overlap = overlapX > 0 && overlapY > 0 ? overlapX * overlapY : 0;
    if (overlap > bestOverlap) {
      best = area;
      bestOverlap = overlap;
    }
  }
  if (!best) return null;
  const width = clamp(saved.width, minSize.width, best.width);
  const height = clamp(saved.height, minSize.height, best.height);
  return {
    x: clamp(saved.x, best.x, best.x + best.width - width),
    y: clamp(saved.y, best.y, best.y + best.height - height),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
