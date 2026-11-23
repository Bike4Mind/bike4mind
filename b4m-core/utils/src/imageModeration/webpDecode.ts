import { WEBP_DECODER_WASM_HEX } from './webpDecoderWasm.generated';

export type DecodedImage = { data: Uint8ClampedArray; width: number; height: number };

type WebpModule = { decode(data: Uint8Array): DecodedImage | null };

export const isWebp = (bytes: Buffer) =>
  bytes.length >= 12 &&
  bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
  bytes.subarray(8, 12).toString('latin1') === 'WEBP';

/**
 * The decoder itself could not start. Moderation rethrows this deployment failure instead of classifying the
 * image as unsupported; callers retain their existing failure and retry behavior.
 */
export class WebpDecoderUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`WebP decoder unavailable: ${(cause as Error)?.message ?? String(cause)}`, { cause });
    this.name = 'WebpDecoderUnavailableError';
  }
}

let ready: Promise<WebpModule> | undefined;

// The wasm is embedded (webpDecoderWasm.generated.ts) so no bundle needs a sibling asset. The factory is driven
// directly rather than through the package's decode.js, whose cached module promise never recovers from a failed
// load; locateFile keeps the factory from resolving a wasm URL it would never fetch.
const loadModule = (): Promise<WebpModule> => {
  ready ??= (async () => {
    const { default: factory } = await import('@jsquash/webp/codec/dec/webp_dec.js');
    const wasmBinary = Buffer.from(WEBP_DECODER_WASM_HEX, 'hex');
    return (await factory({ noInitialRun: true, wasmBinary, locateFile: (file: string) => file })) as WebpModule;
  })().catch(err => {
    ready = undefined;
    throw new WebpDecoderUnavailableError(err);
  });
  return ready;
};

/**
 * Decodes a still WebP to RGBA. Throws WebpDecoderUnavailableError when the decoder cannot start, and a plain
 * Error for an animated or malformed file.
 */
export async function decodeWebp(bytes: Buffer): Promise<DecodedImage> {
  if (!isWebp(bytes)) throw new Error('not a WebP file');
  const webp = await loadModule();
  const decoded = webp.decode(bytes);
  if (!decoded) throw new Error('WebP could not be decoded (animated or malformed)');
  const { data, width, height } = decoded;
  return { data, width, height };
}
