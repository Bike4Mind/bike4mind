/**
 * The mask the painter saves: opaque, white where the user painted (the area to change) and black elsewhere. The job
 * path redraws it in each provider's own convention (b4m-core/utils/src/imageProviders/editMask.ts).
 */
export function strokesToMaskPixels(strokes: Uint8ClampedArray): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(strokes.length);
  for (let index = 0; index < strokes.length; index += 4) {
    const value = strokes[index + 3] > 0 ? 255 : 0;
    mask[index] = value;
    mask[index + 1] = value;
    mask[index + 2] = value;
    mask[index + 3] = 255;
  }
  return mask;
}

/** Whether any pixel of the stroke layer was painted. */
export const hasPaintedPixels = (strokes: Uint8ClampedArray): boolean => {
  for (let index = 3; index < strokes.length; index += 4) if (strokes[index] > 0) return true;
  return false;
};
