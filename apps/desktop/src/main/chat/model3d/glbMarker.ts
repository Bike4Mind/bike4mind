import { open } from 'node:fs/promises';

/**
 * The marker that tells a GLB the model pane wrote apart from one the user made (by hand, or
 * exported from Blender). ModelLiveView stamps it into every sibling GLB it writes and replaces an
 * existing sibling only when the marker is there. The marker is self-asserted: it guards against
 * accidents, not against a file crafted to carry it.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const MARKER_KEY = 'bike4mindModel';
// The pane's JSON chunk is a few KB, tens of KB for thousands of parts; a bigger one is not ours.
const MAX_MARKER_JSON_BYTES = 16 * 1024 * 1024;

type GlbParts = { json: Record<string, unknown>; rest: Uint8Array };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON chunk and every byte after it (the BIN chunk, if any); null when this is not a GLB. */
function splitGlb(bytes: Uint8Array): GlbParts | null {
  if (bytes.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) return null;
  const jsonLength = view.getUint32(HEADER_BYTES, true);
  if (view.getUint32(HEADER_BYTES + 4, true) !== CHUNK_JSON) return null;
  const jsonStart = HEADER_BYTES + CHUNK_HEADER_BYTES;
  const jsonEnd = jsonStart + jsonLength;
  if (jsonEnd > bytes.byteLength) return null;
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(jsonStart, jsonEnd)));
    return isRecord(json) ? { json, rest: bytes.subarray(jsonEnd) } : null;
  } catch {
    return null;
  }
}

export function isModelPaneGlb(bytes: Uint8Array): boolean {
  const parts = splitGlb(bytes);
  if (!parts || !isRecord(parts.json.asset) || !isRecord(parts.json.asset.extras)) return false;
  return parts.json.asset.extras[MARKER_KEY] === true;
}

/** Whether the file at `path` carries the marker, reading only its header and JSON chunk. */
export async function isModelPaneGlbFile(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const head = new Uint8Array(HEADER_BYTES + CHUNK_HEADER_BYTES);
    const { bytesRead } = await file.read(head, 0, head.byteLength, 0);
    if (bytesRead < head.byteLength) return false;
    const jsonLength = new DataView(head.buffer).getUint32(HEADER_BYTES, true);
    if (jsonLength > MAX_MARKER_JSON_BYTES) return false;
    const prefix = new Uint8Array(head.byteLength + jsonLength);
    const read = await file.read(prefix, 0, prefix.byteLength, 0);
    return read.bytesRead === prefix.byteLength && isModelPaneGlb(prefix);
  } finally {
    await file.close();
  }
}

/** The same GLB with the marker in `asset.extras`; throws when the bytes are not a GLB. */
export function stampModelPaneGlb(bytes: Uint8Array): Uint8Array {
  const parts = splitGlb(bytes);
  if (!parts) throw new Error('The model pane produced bytes that are not a GLB.');
  const asset = isRecord(parts.json.asset) ? parts.json.asset : { version: '2.0' };
  const extras = isRecord(asset.extras) ? asset.extras : {};
  const json = { ...parts.json, asset: { ...asset, extras: { ...extras, [MARKER_KEY]: true } } };
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  // glTF pads the JSON chunk to 4 bytes with spaces.
  const paddedLength = Math.ceil(encoded.byteLength / 4) * 4;
  const total = HEADER_BYTES + CHUNK_HEADER_BYTES + paddedLength + parts.rest.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(HEADER_BYTES, paddedLength, true);
  view.setUint32(HEADER_BYTES + 4, CHUNK_JSON, true);
  out.set(encoded, HEADER_BYTES + CHUNK_HEADER_BYTES);
  out.fill(
    0x20,
    HEADER_BYTES + CHUNK_HEADER_BYTES + encoded.byteLength,
    HEADER_BYTES + CHUNK_HEADER_BYTES + paddedLength
  );
  out.set(parts.rest, HEADER_BYTES + CHUNK_HEADER_BYTES + paddedLength);
  return out;
}
