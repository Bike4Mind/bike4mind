import type { StudioCropRect, StudioOutputAspectRatio, StudioVideoClip } from './timeline';

/**
 * The framing rule from ./timeline, shared by the browser preview (TimelinePreview) and the ffmpeg render plan
 * (./ffmpeg/renderPlan) so preview and export frame a clip identically. Pure, so a desktop export can reuse it.
 */

export const STUDIO_FULL_FRAME_CROP: StudioCropRect = { x: 0, y: 0, width: 1, height: 1 };

export type StudioPixelSize = { width: number; height: number };

/** The rect a clip frames `aspectRatio` with, or undefined when it keeps the default centre crop. */
export const studioClipCropFor = (
  clip: Pick<StudioVideoClip, 'fit' | 'crop'>,
  aspectRatio: StudioOutputAspectRatio
): StudioCropRect | undefined => (clip.fit === 'cover' ? clip.crop?.[aspectRatio] : undefined);

/**
 * The region of the source, in source pixels, that fills an output of `output`'s shape: the largest region of that
 * shape inside `rect`, centred in it. The whole-frame rect gives the classic centre crop.
 */
export const studioCropRegion = (
  rect: StudioCropRect,
  source: StudioPixelSize,
  output: StudioPixelSize
): { x: number; y: number; width: number; height: number } => {
  const rectWidth = rect.width * source.width;
  const rectHeight = rect.height * source.height;
  const width = Math.min(rectWidth, (rectHeight * output.width) / output.height);
  const height = Math.min(rectHeight, (rectWidth * output.height) / output.width);
  return {
    x: rect.x * source.width + (rectWidth - width) / 2,
    y: rect.y * source.height + (rectHeight - height) / 2,
    width,
    height,
  };
};

/** `studioCropRegion` normalized back to 0..1 of the source: the rect the output actually shows. */
export const studioCropShownRect = (
  rect: StudioCropRect,
  source: StudioPixelSize,
  output: StudioPixelSize
): StudioCropRect => {
  const region = studioCropRegion(rect, source, output);
  return {
    x: region.x / source.width,
    y: region.y / source.height,
    width: region.width / source.width,
    height: region.height / source.height,
  };
};

const decimal = (value: number): string => String(Number(value.toFixed(6)));

/**
 * `studioCropRegion` as an ffmpeg `crop` filter. The source size is left to ffmpeg (`iw`/`ih`, after it applies a
 * video's rotation metadata, as a browser does), so the worker needs no probe. A source the two size differently
 * (non-square pixels; an image whose EXIF orientation only the browser applies) frames differently, as the centre
 * crop already did. Quoted, so the commas survive a filter graph.
 */
export const studioCropFfmpegFilter = (rect: StudioCropRect, output: StudioPixelSize): string => {
  const rectWidth = `${decimal(rect.width)}*iw`;
  const rectHeight = `${decimal(rect.height)}*ih`;
  const width = `min(${rectWidth},${rectHeight}*${output.width}/${output.height})`;
  const height = `min(${rectHeight},${rectWidth}*${output.height}/${output.width})`;
  const x = `${decimal(rect.x)}*iw+(${rectWidth}-ow)/2`;
  const y = `${decimal(rect.y)}*ih+(${rectHeight}-oh)/2`;
  return `crop=w='${width}':h='${height}':x='${x}':y='${y}'`;
};
