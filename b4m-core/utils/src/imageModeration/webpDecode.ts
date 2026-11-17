import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The codec's file name. A bundled Lambda has no node_modules, so a Lambda that moderates images ships this file
 * at its task root via `copyFiles` (the generation job subscription in infra/queues.ts); unbundled runtimes
 * resolve it from the package.
 */
export const WEBP_DECODER_WASM = 'webp_dec.wasm';

export type DecodedImage = { data: Uint8ClampedArray; width: number; height: number };

const wasmCandidates = (): string[] => {
  const candidates: string[] = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve(`@jsquash/webp/codec/dec/${WEBP_DECODER_WASM}`));
  } catch {
    // Bundled: nothing to resolve from, so only the task-root copy below can exist.
  }
  candidates.push(path.join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), WEBP_DECODER_WASM));
  return candidates;
};

const toArrayBuffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function readWasm(): Promise<ArrayBuffer> {
  const tried: string[] = [];
  for (const candidate of wasmCandidates()) {
    try {
      return toArrayBuffer(await readFile(candidate));
    } catch (err) {
      tried.push(`${candidate}: ${(err as Error).message}`);
    }
  }
  throw new Error(`WebP decoder wasm not found (${tried.join('; ')})`);
}

let ready: Promise<(buffer: ArrayBuffer) => Promise<DecodedImage>> | undefined;

// The codec's own loader fetches its wasm by file URL, which Node's fetch refuses, so the bytes are handed to it.
const decoder = () => {
  ready ??= (async () => {
    const [codec, wasmBinary] = await Promise.all([import('@jsquash/webp/decode.js'), readWasm()]);
    await codec.init({ wasmBinary });
    return codec.default;
  })().catch(err => {
    ready = undefined;
    throw err;
  });
  return ready;
};

/** Decodes a still WebP to RGBA. Throws on an animated or malformed file, or when the codec cannot load. */
export async function decodeWebp(bytes: Buffer): Promise<DecodedImage> {
  const decode = await decoder();
  const { data, width, height } = await decode(toArrayBuffer(bytes));
  return { data, width, height };
}
