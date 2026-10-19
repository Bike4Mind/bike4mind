import { MAX_IMAGE_PIXELS } from '../imageResize';
import { UnsupportedImageFormatError } from './index';

/** More frames than this and an animated image is not moderated frame by frame: it is blocked. */
export const MAX_MODERATED_FRAMES = 60;

type Rect = { x: number; y: number; width: number; height: number };

interface OmgGifReader {
  width: number;
  height: number;
  numFrames(): number;
  frameInfo(i: number): Rect & { disposal: number };
  decodeAndBlitFrameRGBA(i: number, pixels: Uint8Array): void;
}

const unsupported = (message: string) => new UnsupportedImageFormatError(`Animated image: ${message}`);

// Every frame is composited onto a full canvas, so the decoded total is frames x canvas pixels.
const assertBudget = (frames: number, width: number, height: number) => {
  if (frames > MAX_MODERATED_FRAMES) throw unsupported(`${frames} frames, over the ${MAX_MODERATED_FRAMES} cap`);
  if (frames * width * height > MAX_IMAGE_PIXELS) {
    throw unsupported(`${frames} frames of ${width}x${height} exceed the ${MAX_IMAGE_PIXELS}-pixel decode budget`);
  }
};

const assertInCanvas = (frame: Rect, width: number, height: number) => {
  if (frame.x + frame.width > width || frame.y + frame.height > height) throw unsupported('frame outside the canvas');
};

const clearRect = (canvas: Uint8Array, canvasWidth: number, r: Rect) => {
  for (let row = r.y; row < r.y + r.height; row++) {
    canvas.fill(0, (row * canvasWidth + r.x) * 4, (row * canvasWidth + r.x + r.width) * 4);
  }
};

const encodeCanvas = async (canvas: Uint8Array, width: number, height: number): Promise<Buffer> => {
  // Dynamic import for the same bundler reason as RekognitionImageModerationService's jimp use.
  const { Jimp } = await import('jimp');
  // Unpooled copy: jimp's fromBitmap re-reads a Buffer's whole backing ArrayBuffer from offset 0,
  // so a pooled Buffer.from() slice would encode whatever sits at the start of the pool.
  const data = Buffer.alloc(canvas.length);
  data.set(canvas);
  return Buffer.from(await Jimp.fromBitmap({ data, width, height }).getBuffer('image/jpeg'));
};

/**
 * The images a viewer actually shows for an animated GIF, APNG or animated WebP, one per frame, or
 * null for a still image (moderated as-is). GIF and APNG frames are composited the way a browser
 * draws them (offsets, transparency, disposal, blending), so content split across partial frames
 * is moderated as it is displayed. Animated WebP cannot be decoded here, so it is only accepted when
 * every frame is a full-canvas frame that replaces the last (each frame then is what is shown).
 * Anything over MAX_MODERATED_FRAMES, over the pixel budget or malformed throws
 * UnsupportedImageFormatError, which moderation treats as blocked.
 */
export async function extractAnimationFrames(bytes: Buffer): Promise<Buffer[] | null> {
  try {
    return await splitAnimation(bytes);
  } catch (err) {
    // A parser bounds error on malformed input is a terminal verdict, not a transient one to retry.
    if (err instanceof UnsupportedImageFormatError) throw err;
    if (err instanceof RangeError && /allocation failed/i.test(err.message)) throw err;
    throw unsupported(`malformed image: ${(err as Error).message}`);
  }
}

async function splitAnimation(bytes: Buffer): Promise<Buffer[] | null> {
  const magic = bytes.subarray(0, 6).toString('latin1');
  if (magic === 'GIF87a' || magic === 'GIF89a') return gifFrames(bytes);
  // The chunk-name probes keep still PNG/WebP files off the parsers entirely.
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return bytes.includes('acTL', 8, 'latin1') ? apngFrames(bytes) : null;
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return bytes.includes('ANMF', 12, 'latin1') ? webpFrames(bytes) : null;
  }
  return null;
}

async function gifFrames(bytes: Buffer): Promise<Buffer[] | null> {
  // @ts-expect-error omggif ships no type declarations; OmgGifReader below types the part used.
  const mod = await import('omggif');
  const GifReader = (mod.GifReader ?? mod.default.GifReader) as new (buf: Uint8Array) => OmgGifReader;
  let reader: OmgGifReader;
  try {
    reader = new GifReader(bytes);
  } catch (err) {
    throw unsupported(`undecodable GIF: ${(err as Error).message}`);
  }
  const count = reader.numFrames();
  if (count <= 1) return null;
  const { width, height } = reader;
  assertBudget(count, width, height);

  const canvas = new Uint8Array(width * height * 4);
  const out: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const info = reader.frameInfo(i);
    assertInCanvas(info, width, height);
    const previous = info.disposal === 3 ? canvas.slice() : null;
    try {
      reader.decodeAndBlitFrameRGBA(i, canvas); // transparent pixels leave the canvas as it was
    } catch (err) {
      throw unsupported(`undecodable GIF frame ${i}: ${(err as Error).message}`);
    }
    out.push(await encodeCanvas(canvas, width, height));
    if (info.disposal === 2) clearRect(canvas, width, info);
    else if (previous) canvas.set(previous);
  }
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

type ApngFrame = Rect & { dispose: number; blend: number; data: Buffer[] };

async function apngFrames(bytes: Buffer): Promise<Buffer[] | null> {
  let ihdr: Buffer | undefined;
  const palette: Buffer[] = []; // PLTE/tRNS, needed to decode each rebuilt frame
  let animated = false;
  let defaultIsFrame = false;
  let seenIdat = false;
  const frames: ApngFrame[] = [];

  for (let p = 8; p + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(p);
    const type = bytes.subarray(p + 4, p + 8).toString('latin1');
    const data = bytes.subarray(p + 8, p + 8 + length);
    if (data.length !== length) throw unsupported('truncated PNG chunk');
    p += 12 + length;

    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE' || type === 'tRNS') palette.push(pngChunk(type, data));
    else if (type === 'acTL') animated = true;
    else if (type === 'fcTL') {
      if (data.length < 26) throw unsupported('short fcTL chunk');
      if (!seenIdat) defaultIsFrame = true;
      frames.push({
        width: data.readUInt32BE(4),
        height: data.readUInt32BE(8),
        x: data.readUInt32BE(12),
        y: data.readUInt32BE(16),
        dispose: data[24],
        blend: data[25],
        data: [],
      });
    } else if (type === 'IDAT') {
      seenIdat = true;
      if (defaultIsFrame) frames.at(-1)?.data.push(data);
    } else if (type === 'fdAT')
      frames.at(-1)?.data.push(data.subarray(4)); // minus the sequence number
    else if (type === 'IEND') break;
  }

  // The default image is shown by viewers without APNG support; when it is not frame 0 it is
  // moderated as its own still image (the original bytes decode to it).
  const extra = defaultIsFrame ? [] : [bytes];
  if (!animated || !ihdr || frames.length + extra.length <= 1) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assertBudget(frames.length + extra.length, width, height);

  const { Jimp } = await import('jimp');
  const canvas = new Uint8Array(width * height * 4);
  const out: Buffer[] = [];
  for (const [i, frame] of frames.entries()) {
    assertInCanvas(frame, width, height);
    const header = Buffer.from(ihdr);
    header.writeUInt32BE(frame.width, 0);
    header.writeUInt32BE(frame.height, 4);
    const png = Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', header),
      ...palette,
      pngChunk('IDAT', Buffer.concat(frame.data)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    let pixels: Buffer;
    try {
      pixels = (await Jimp.read(png)).bitmap.data;
    } catch (err) {
      throw unsupported(`undecodable APNG frame ${i}: ${(err as Error).message}`);
    }

    // APNG_DISPOSE_OP_PREVIOUS on the first frame is treated as BACKGROUND (spec).
    const previous = frame.dispose === 2 && i > 0 ? canvas.slice() : null;
    for (let row = 0; row < frame.height; row++) {
      for (let col = 0; col < frame.width; col++) {
        const s = (row * frame.width + col) * 4;
        const d = ((frame.y + row) * width + frame.x + col) * 4;
        const a = pixels[s + 3] / 255;
        if (frame.blend === 0 || a === 1) {
          canvas.set(pixels.subarray(s, s + 4), d); // APNG_BLEND_OP_SOURCE replaces, alpha included
        } else if (a > 0) {
          const da = canvas[d + 3] / 255;
          const oa = a + da * (1 - a);
          for (let c = 0; c < 3; c++) {
            canvas[d + c] = Math.round((pixels[s + c] * a + canvas[d + c] * da * (1 - a)) / oa);
          }
          canvas[d + 3] = Math.round(oa * 255);
        }
      }
    }
    out.push(await encodeCanvas(canvas, width, height));
    if (frame.dispose === 1 || (frame.dispose === 2 && i === 0)) clearRect(canvas, width, frame);
    else if (previous) canvas.set(previous);
  }
  return [...extra, ...out];
}

const u24 = (b: Buffer, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

function webpFrames(bytes: Buffer): Buffer[] | null {
  let canvas: { width: number; height: number } | undefined;
  const frames: Buffer[] = [];
  for (let p = 12; p + 8 <= bytes.length;) {
    const type = bytes.subarray(p, p + 4).toString('latin1');
    const size = bytes.readUInt32LE(p + 4);
    const data = bytes.subarray(p + 8, p + 8 + size);
    if (data.length !== size) throw unsupported('truncated WebP chunk');
    p += 8 + size + (size & 1);

    if (type === 'VP8X' && size >= 10) canvas = { width: 1 + u24(data, 4), height: 1 + u24(data, 7) };
    else if (type === 'ANMF') {
      if (size < 16 || !canvas) throw unsupported('malformed ANMF chunk');
      const frame = { x: 2 * u24(data, 0), y: 2 * u24(data, 3), width: 1 + u24(data, 6), height: 1 + u24(data, 9) };
      const replaces = (data[15] & 0x02) !== 0; // blending bit set: do not blend
      if (frame.x || frame.y || frame.width !== canvas.width || frame.height !== canvas.height || !replaces) {
        throw unsupported('animated WebP with partial or blended frames cannot be composited for moderation');
      }
      frames.push(data.subarray(16));
    }
  }
  if (frames.length === 0 || !canvas) return null;
  assertBudget(frames.length, canvas.width, canvas.height);

  return frames.map(frame => {
    // A still extended-format WebP: VP8X (alpha flag when the frame carries ALPH) + the frame's chunks.
    const vp8x = Buffer.alloc(18);
    vp8x.write('VP8X', 0, 'latin1');
    vp8x.writeUInt32LE(10, 4);
    vp8x[8] = frame.subarray(0, 4).toString('latin1') === 'ALPH' ? 0x10 : 0;
    vp8x.writeUIntLE(canvas.width - 1, 12, 3);
    vp8x.writeUIntLE(canvas.height - 1, 15, 3);
    const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x, frame]);
    const header = Buffer.alloc(8);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  });
}
