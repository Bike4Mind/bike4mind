/**
 * Server-only product cutout (jimp). A matte model sees the source padded onto one of its output canvases and
 * returns a transparent PNG; only that PNG's alpha is kept. It is laid onto the ORIGINAL pixels, so every pixel the
 * cutout shows (a product label, its text) is the source's own, never a re-rendered copy. A dedicated entry, kept off
 * the barrel like imageResize, so importing @bike4mind/utils never drags jimp into a bundle.
 */
import { imageSize } from 'image-size';
import { MAX_IMAGE_PIXELS } from './imageResize';

/** The output canvases the matte model renders (gpt-image), as `WxH`. */
export const CUTOUT_CANVAS_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
export type CutoutCanvasSize = (typeof CUTOUT_CANVAS_SIZES)[number];

/** Source formats jimp decodes; a cutout of anything else is refused before it is charged. */
export const CUTOUT_SOURCE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);

// How far the matte's aspect may drift from the canvas it was asked for before its alpha no longer lines up.
const MATTE_ASPECT_TOLERANCE = 0.02;

type Dimensions = { width: number; height: number };
type Layout = { canvas: Dimensions; offsetX: number; offsetY: number };

/** The matte came back in a shape its alpha cannot be mapped from onto the source. */
export class CutoutMatteMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CutoutMatteMismatchError';
  }
}

/** The source cannot be decoded within budget (no readable header, or a decompression bomb). */
export class CutoutSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CutoutSourceError';
  }
}

const parseCanvas = (size: CutoutCanvasSize): Dimensions => {
  const [width, height] = size.split('x').map(Number);
  return { width, height };
};

/** Header-only read (no decode); null when the header is unreadable. */
export function readImageDimensions(bytes: Buffer): Dimensions | null {
  try {
    const { width, height } = imageSize(bytes);
    return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? { width, height }
      : null;
  } catch {
    return null;
  }
}

/** The canvas whose aspect is closest to the source's, so the least padding is added. */
export function cutoutCanvasSizeFor({ width, height }: Dimensions): CutoutCanvasSize {
  const distance = (size: CutoutCanvasSize) => {
    const canvas = parseCanvas(size);
    return Math.abs(Math.log(width / height) - Math.log(canvas.width / canvas.height));
  };
  return CUTOUT_CANVAS_SIZES.reduce((best, size) => (distance(size) < distance(best) ? size : best));
}

// The smallest box of the canvas's aspect that holds the source, with the source centred in it.
const layoutFor = (source: Dimensions, size: CutoutCanvasSize): Layout => {
  const target = parseCanvas(size);
  const aspect = target.width / target.height;
  const canvas =
    source.width / source.height > aspect
      ? { width: source.width, height: Math.round(source.width / aspect) }
      : { width: Math.round(source.height * aspect), height: source.height };
  return {
    canvas,
    offsetX: Math.floor((canvas.width - source.width) / 2),
    offsetY: Math.floor((canvas.height - source.height) / 2),
  };
};

const sourceDimensions = (bytes: Buffer): Dimensions => {
  const dimensions = readImageDimensions(bytes);
  if (!dimensions) throw new CutoutSourceError('The source image header could not be read');
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new CutoutSourceError(`The source image is over the ${MAX_IMAGE_PIXELS}-pixel processing limit`);
  }
  return dimensions;
};

const loadJimp = async () => (await import('jimp')).Jimp;

/** The source centred on a white canvas of `size`'s aspect, scaled to `size`: what the matte model is sent. */
export async function padForMatte(source: Buffer, size: CutoutCanvasSize): Promise<Buffer> {
  const layout = layoutFor(sourceDimensions(source), size);
  const Jimp = await loadJimp();
  const image = await Jimp.read(source);
  const canvas = new Jimp({ width: layout.canvas.width, height: layout.canvas.height, color: 0xffffffff });
  canvas.composite(image, layout.offsetX, layout.offsetY);
  const target = parseCanvas(size);
  canvas.resize({ w: target.width, h: target.height });
  return Buffer.from(await canvas.getBuffer('image/png'));
}

/**
 * The source's own pixels with the matte's alpha: a PNG the source's size. `matte` is the model's render of
 * padForMatte(source, size). Throws CutoutMatteMismatchError when the matte is not that canvas's shape.
 */
export async function applyCutoutMatte(source: Buffer, matte: Buffer, size: CutoutCanvasSize): Promise<Buffer> {
  const dimensions = sourceDimensions(source);
  const matteDimensions = readImageDimensions(matte);
  const target = parseCanvas(size);
  if (!matteDimensions) throw new CutoutMatteMismatchError('The matte image header could not be read');
  const drift = Math.abs(matteDimensions.width / matteDimensions.height / (target.width / target.height) - 1);
  if (drift > MATTE_ASPECT_TOLERANCE) {
    throw new CutoutMatteMismatchError(
      `The matte is ${matteDimensions.width}x${matteDimensions.height}, not the ${size} canvas it was asked for`
    );
  }
  const layout = layoutFor(dimensions, size);
  const Jimp = await loadJimp();
  const [image, alpha] = await Promise.all([Jimp.read(source), Jimp.read(matte)]);
  alpha
    .resize({ w: layout.canvas.width, h: layout.canvas.height })
    .crop({ x: layout.offsetX, y: layout.offsetY, w: dimensions.width, h: dimensions.height });
  const pixels = image.bitmap.data;
  const matteAlpha = alpha.bitmap.data;
  for (let index = 3; index < pixels.length; index += 4) {
    pixels[index] = Math.round((pixels[index] * matteAlpha[index]) / 255);
  }
  return Buffer.from(await image.getBuffer('image/png'));
}
