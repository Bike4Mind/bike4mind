import { parseImageSize, usesDiscreteImageDimensions } from '@bike4mind/common';

/**
 * Store patch for picking an Image Size preset.
 *
 * Flux Pro sizes its request from discrete `width`/`height` (see `BFLImageService.generate`), so a
 * preset has to move those too. Otherwise the dropdown and the Width/Height inputs persist
 * contradictory values and the inputs silently win at dispatch, pinning every Pro generation to
 * whatever width/height were last set.
 *
 * For every other model the dimensions are cleared rather than left alone, so a pair set for Flux
 * Pro cannot survive a detour through another model and reassert itself on the next Pro request.
 */
export const imageSizeUpdate = <S extends string>(
  model: string | undefined | null,
  size: S
): { size: S; width?: number; height?: number } => {
  const dimensions = usesDiscreteImageDimensions(model) ? parseImageSize(size) : undefined;
  return { size, width: dimensions?.width, height: dimensions?.height };
};
