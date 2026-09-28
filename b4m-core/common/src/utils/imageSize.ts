import { IMAGE_SIZE_CONSTRAINTS } from '../models';

/**
 * Parses a `WIDTHxHEIGHT` size preset (e.g. '1440x810') into discrete pixel dimensions.
 *
 * The image settings UI persists a `size` string, but the BFL Pro and local Stable-Diffusion
 * backends take `width`/`height` instead. Both the tool dispatch and the settings modal derive
 * dimensions through here so a size preset means the same thing on either side.
 *
 * Returns undefined for anything that is not two positive integers separated by 'x'.
 */
export function parseImageSize(size?: string | null): { width: number; height: number } | undefined {
  if (typeof size !== 'string') return undefined;
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  return { width, height };
}

/** BFL rejects a request outside this range outright, so a preset beyond it must not be forwarded. */
export const BFL_DIMENSION_BOUNDS = {
  min: IMAGE_SIZE_CONSTRAINTS.BFL.minWidth,
  max: IMAGE_SIZE_CONSTRAINTS.BFL.maxWidth,
} as const;

/**
 * Dimensions for a backend that sizes from discrete width/height. Explicit values win; otherwise
 * they come from the size preset.
 *
 * `bounds` discards a preset the provider would reject rather than forwarding it: a size chosen
 * for another provider survives a model switch (GPT Image 2 offers 3840x2160, BFL caps at 1440),
 * and sending it on would turn a wrong-size image into a failed generation. Both dimensions have
 * to fit, since using one and defaulting the other would distort the aspect ratio.
 */
export function resolveImageDimensions(
  { width, height, size }: { width?: number; height?: number; size?: string | null },
  bounds?: { min: number; max: number }
): { width?: number; height?: number } {
  const preset = parseImageSize(size);
  const usablePreset =
    preset && (!bounds || [preset.width, preset.height].every(v => v >= bounds.min && v <= bounds.max))
      ? preset
      : undefined;
  return { width: width ?? usablePreset?.width, height: height ?? usablePreset?.height };
}
