import { open, type FileHandle } from 'node:fs/promises';
import { archFromModelInfo, positiveInt, tensorStatsFromTensors } from './arch';
import {
  GgufFormatError,
  LocalRuntimeError,
  RuntimeConnectionError,
  RuntimeHttpError,
  RuntimeProtocolError,
  type GgufFormatErrorReason,
} from './errors';
import { assertHeaderValues, connectionError, mapLimit, type HttpClient } from './http';
import type { FetchLike, ModelInspection } from './types';

export const DEFAULT_GGUF_TIMEOUT_MS = 60_000;
export const DEFAULT_GGUF_MAX_HEADER_BYTES = 128 * 1024 * 1024;
/** Longer arrays (tokenizer vocabularies, merges, scores) are kept as their length only, as Ollama does. */
export const DEFAULT_GGUF_MAX_ARRAY_LENGTH = 1024;

const GGUF_ID = 'gguf';
const GGUF_MAGIC = 0x46554747;
// The magic as a big-endian writer stores it ("FUGG").
const GGUF_MAGIC_SWAPPED = 0x47475546;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_KV_COUNT = 65_536;
const MAX_TENSOR_COUNT = 65_536;
const MAX_TENSOR_DIMS = 4;
const MAX_ARRAY_DEPTH = 4;
// Caps what nested or numerous small arrays can make the parser keep.
const MAX_KEPT_ELEMENTS = 1 << 20;
const FIRST_CHUNK_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const SHARD_CONCURRENCY = 4;
const INT64_MAX = 2n ** 63n - 1n;
// setTimeout's limit; a longer deadline means none.
const MAX_TIMER_MS = 2 ** 31 - 1;

const VALUE_TYPES = [
  'uint8',
  'int8',
  'uint16',
  'int16',
  'uint32',
  'int32',
  'float32',
  'bool',
  'string',
  'array',
  'uint64',
  'int64',
  'float64',
] as const;
export type GgufValueType = (typeof VALUE_TYPES)[number];
const STRING = 8;
const ARRAY = 9;
// Bytes per value; strings and arrays are length-prefixed instead.
const WIDTH: readonly number[] = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];

// ggml.h `ggml_type` ids named as `/api/show` prints them, removed ids included (Ollama's fs/gguf/tensor.go).
const GGML_TYPES: Partial<Record<number, string>> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  4: 'Q4_2',
  5: 'Q4_3',
  6: 'Q5_0',
  7: 'Q5_1',
  8: 'Q8_0',
  9: 'Q8_1',
  10: 'Q2_K',
  11: 'Q3_K',
  12: 'Q4_K',
  13: 'Q5_K',
  14: 'Q6_K',
  15: 'Q8_K',
  16: 'IQ2_XXS',
  17: 'IQ2_XS',
  18: 'IQ3_XXS',
  19: 'IQ1_S',
  20: 'IQ4_NL',
  21: 'IQ3_S',
  22: 'IQ2_S',
  23: 'IQ4_XS',
  24: 'I8',
  25: 'I16',
  26: 'I32',
  27: 'I64',
  28: 'F64',
  29: 'IQ1_M',
  30: 'BF16',
  31: 'Q4_0_4_4',
  32: 'Q4_0_4_8',
  33: 'Q4_0_8_8',
  34: 'TQ1_0',
  35: 'TQ2_0',
  36: 'IQ4_NL_4_4',
  37: 'IQ4_NL_4_8',
  38: 'IQ4_NL_8_8',
  39: 'MXFP4',
  40: 'NVFP4',
  41: 'Q1_0',
  42: 'Q2_0',
};

/** An array longer than `maxArrayLength`, skipped without being read into memory. */
export interface GgufOmittedArray {
  readonly omitted: true;
  readonly itemType: GgufValueType;
  readonly length: number;
}

/** 64-bit integers outside the safe range stay `bigint`. */
export type GgufValue = number | bigint | boolean | string | GgufValue[] | GgufOmittedArray;

/** Keyed like Ollama's `/api/show` `model_info`; has no prototype. */
export type GgufMetadata = Record<string, GgufValue>;

export interface GgufTensorInfo {
  name: string;
  /** e.g. `Q4_K`; `unknown` for an id `/api/show` has no name for. */
  type: string;
  typeId: number;
  /** Elements per dimension, innermost first, as `/api/show` lists them. */
  shape: number[];
  /** Byte offset within the data section. */
  offset: number;
}

/** A metadata value's GGUF type as written; `itemType` is set for an array, even an empty one. */
export interface GgufKeyType {
  type: GgufValueType;
  itemType?: GgufValueType;
}

export interface GgufHeader {
  version: 2 | 3;
  metadata: GgufMetadata;
  /** Keyed as `metadata`, which loses the integer width and an empty array's item type; has no prototype. */
  types: Record<string, GgufKeyType>;
  tensors: GgufTensorInfo[];
  /** Bytes from the start of the file to the end of the tensor infos. */
  headerBytes: number;
}

export interface GgufByteSource {
  /** Names the source in errors; must not contain credentials. */
  readonly label: string;
  /** The bytes at `[offset, offset + length)`; fewer only at the end of the file. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** An `http(s)://` URL, a file path, or a caller-owned byte source (never closed here). */
export type GgufSource = string | GgufByteSource;

export interface ReadGgufOptions {
  /** For URL sources. */
  fetch?: FetchLike;
  /** `Authorization` value for URL sources, e.g. `Bearer hf_...` for a gated Hugging Face repo. Never sent cross-origin. */
  authorization?: string;
  signal?: AbortSignal;
  /** Deadline for the whole read (ms); `Infinity` for none. */
  timeoutMs?: number;
  maxHeaderBytes?: number;
  maxArrayLength?: number;
}

/** No `maxArrayLength`: arch reads whole per-layer arrays, so inspection keeps the default. */
export interface InspectGgufOptions extends Omit<ReadGgufOptions, 'maxArrayLength'> {
  /** The remaining shards of a split GGUF, in order. String sources named `*-00001-of-0000N.gguf` find their own. */
  shards?: readonly GgufSource[];
}

export type GgufInspection = Pick<ModelInspection, 'arch' | 'tensorStats'>;

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function quote(text: string): string {
  return JSON.stringify(text.length > 64 ? `${text.slice(0, 64)}...` : text);
}

/** Forward reader over a byte source that fetches in growing chunks and never holds more than one chunk. */
class ByteCursor {
  position = 0;
  private buffer = new Uint8Array(0);
  private view = new DataView(this.buffer.buffer);
  private bufferStart = 0;
  private chunk = FIRST_CHUNK_BYTES;

  constructor(
    private readonly source: GgufByteSource,
    private readonly signal: AbortSignal | undefined,
    readonly maxBytes: number
  ) {}

  get remaining(): number {
    return this.maxBytes - this.position;
  }

  fail(message: string, reason: GgufFormatErrorReason): GgufFormatError {
    return new GgufFormatError(`${this.source.label}: ${message}`, reason);
  }

  private overLimit(): GgufFormatError {
    return this.fail(`GGUF header is larger than the ${this.maxBytes}-byte limit`, 'limit');
  }

  async need(n: number): Promise<void> {
    if (n > this.remaining) throw this.overLimit();
    const at = this.position - this.bufferStart;
    if (at + n <= this.buffer.length) return;
    const kept = at < this.buffer.length ? this.buffer.subarray(at) : new Uint8Array(0);
    const from = this.position + kept.length;
    const length = Math.min(Math.max(n - kept.length, this.chunk), this.maxBytes - from);
    this.chunk = Math.min(this.chunk * 2, MAX_CHUNK_BYTES);
    this.signal?.throwIfAborted();
    const data = (await this.source.read(from, length, this.signal)).subarray(0, length);
    const buffer = new Uint8Array(kept.length + data.length);
    buffer.set(kept);
    buffer.set(data, kept.length);
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer);
    this.bufferStart = this.position;
    if (buffer.length < n)
      throw this.fail(`GGUF header is truncated at byte ${this.position + buffer.length}`, 'truncated');
  }

  /** Skipped bytes past the buffer are not fetched; `confirmEnd` or the next `need` proves they exist. */
  skip(n: number): void {
    if (n > this.remaining) throw this.overLimit();
    this.position += n;
  }

  async confirmEnd(): Promise<void> {
    if (this.position <= this.bufferStart + this.buffer.length) return;
    this.position--;
    await this.need(1);
    this.position++;
  }

  private take(width: number): number {
    const at = this.position - this.bufferStart;
    this.position += width;
    return at;
  }

  peekU32 = () => this.view.getUint32(this.position - this.bufferStart, true);
  u8 = () => this.view.getUint8(this.take(1));
  i8 = () => this.view.getInt8(this.take(1));
  u16 = () => this.view.getUint16(this.take(2), true);
  i16 = () => this.view.getInt16(this.take(2), true);
  u32 = () => this.view.getUint32(this.take(4), true);
  i32 = () => this.view.getInt32(this.take(4), true);
  f32 = () => this.view.getFloat32(this.take(4), true);
  u64 = () => this.view.getBigUint64(this.take(8), true);
  i64 = () => this.view.getBigInt64(this.take(8), true);
  f64 = () => this.view.getFloat64(this.take(8), true);

  bytes(n: number): Uint8Array {
    const at = this.take(n);
    return this.buffer.subarray(at, at + n);
  }
}

/** The shortest decimal that rounds to the same float32, so 1e-6 reads as 1e-6 as it does in `/api/show`. */
function shortestFloat32(value: number): number {
  if (!Number.isFinite(value)) return value;
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return candidate;
  }
  return value;
}

function toNumber(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/** GGUF v2/v3 header layout: docs/gguf.md in ggml, checked as llama.cpp's gguf.cpp checks it. */
class HeaderReader {
  private keptElements = 0;

  constructor(
    private readonly cursor: ByteCursor,
    private readonly maxArrayLength: number
  ) {}

  async header(): Promise<GgufHeader> {
    const c = this.cursor;
    await c.need(8);
    const magic = c.u32();
    const version = c.u32();
    if (magic === GGUF_MAGIC_SWAPPED || (magic === GGUF_MAGIC && version !== 0 && (version & 0xffff) === 0)) {
      throw c.fail('GGUF file is big-endian; only little-endian files are supported', 'unsupported');
    }
    if (magic !== GGUF_MAGIC) throw c.fail('not a GGUF file', 'invalid');
    if (version === 1) throw c.fail('GGUF v1 is not supported', 'unsupported');
    if (version !== 2 && version !== 3) throw c.fail(`GGUF version ${version} is not supported`, 'unsupported');

    await c.need(16);
    const tensorCount = this.count(c.u64(), MAX_TENSOR_COUNT, 'tensors');
    const kvCount = this.count(c.u64(), MAX_KV_COUNT, 'metadata keys');

    const metadata: GgufMetadata = Object.create(null) as GgufMetadata;
    const types = Object.create(null) as Record<string, GgufKeyType>;
    for (let i = 0; i < kvCount; i++) {
      const key = await this.string();
      if (!key) throw c.fail(`metadata key ${i} is empty`, 'invalid');
      if (Object.hasOwn(metadata, key)) throw c.fail(`duplicate metadata key ${quote(key)}`, 'invalid');
      await c.need(4);
      const type = c.u32();
      if (type === ARRAY) await c.need(4);
      const itemType = type === ARRAY ? c.peekU32() : undefined;
      metadata[key] = await this.value(type, 0);
      types[key] =
        itemType === undefined
          ? { type: VALUE_TYPES[type] as GgufValueType }
          : { type: 'array', itemType: VALUE_TYPES[itemType] as GgufValueType };
    }

    const tensors: GgufTensorInfo[] = [];
    const names = new Set<string>();
    for (let i = 0; i < tensorCount; i++) tensors.push(await this.tensor(names));
    await c.confirmEnd();
    return { version, metadata, types, tensors, headerBytes: c.position };
  }

  private count(raw: bigint, max: number, what: string): number {
    if (raw > BigInt(max)) throw this.cursor.fail(`${raw} ${what} exceed the limit of ${max}`, 'limit');
    return Number(raw);
  }

  private stringLength(raw: bigint): number {
    if (raw > BigInt(MAX_STRING_BYTES)) {
      throw this.cursor.fail(`string of ${raw} bytes exceeds the ${MAX_STRING_BYTES}-byte limit`, 'limit');
    }
    return Number(raw);
  }

  private async string(): Promise<string> {
    const c = this.cursor;
    await c.need(8);
    const length = this.stringLength(c.u64());
    await c.need(length);
    return decoder.decode(c.bytes(length));
  }

  private async value(type: number, depth: number): Promise<GgufValue> {
    if (type === STRING) return this.string();
    if (type === ARRAY) return this.array(depth + 1);
    const width = WIDTH[type];
    if (!width) throw this.cursor.fail(`unknown GGUF value type ${type}`, 'invalid');
    await this.cursor.need(width);
    return this.scalar(type);
  }

  /** Reads a fixed-width value the caller has already made available. */
  private scalar(type: number): number | bigint | boolean {
    const c = this.cursor;
    switch (type) {
      case 0:
        return c.u8();
      case 1:
        return c.i8();
      case 2:
        return c.u16();
      case 3:
        return c.i16();
      case 4:
        return c.u32();
      case 5:
        return c.i32();
      case 6:
        return shortestFloat32(c.f32());
      case 7:
        return c.u8() !== 0;
      case 10:
        return toNumber(c.u64());
      case 11:
        return toNumber(c.i64());
      default:
        return c.f64();
    }
  }

  /** Checks an array header; a length whose smallest encoding overruns the byte limit fails before anything is read. */
  private arrayLength(itemType: number, raw: bigint, depth: number): number {
    const c = this.cursor;
    if (itemType >= VALUE_TYPES.length) throw c.fail(`unknown GGUF array item type ${itemType}`, 'invalid');
    if (itemType === ARRAY && depth >= MAX_ARRAY_DEPTH) {
      throw c.fail(`GGUF arrays nest deeper than ${MAX_ARRAY_DEPTH} levels`, 'limit');
    }
    const minBytes = WIDTH[itemType] || (itemType === STRING ? 8 : 12);
    if (raw * BigInt(minBytes) > BigInt(c.remaining)) {
      throw c.fail(`array of ${raw} entries overruns the ${c.maxBytes}-byte header limit`, 'limit');
    }
    return Number(raw);
  }

  private async array(depth: number): Promise<GgufValue[] | GgufOmittedArray> {
    const c = this.cursor;
    await c.need(12);
    const itemType = c.u32();
    const length = this.arrayLength(itemType, c.u64(), depth);
    if (length > this.maxArrayLength || this.keptElements + length > MAX_KEPT_ELEMENTS) {
      await this.skipItems(itemType, length, depth);
      return { omitted: true, itemType: VALUE_TYPES[itemType] as GgufValueType, length };
    }
    this.keptElements += length;
    const width = WIDTH[itemType];
    if (width) {
      await c.need(length * width);
      return Array.from({ length }, () => this.scalar(itemType));
    }
    const values: GgufValue[] = [];
    for (let i = 0; i < length; i++) values.push(await this.value(itemType, depth));
    return values;
  }

  private async skipItems(itemType: number, length: number, depth: number): Promise<void> {
    const c = this.cursor;
    const width = WIDTH[itemType];
    if (width) return c.skip(length * width);
    for (let i = 0; i < length; i++) {
      if (itemType === STRING) {
        await c.need(8);
        c.skip(this.stringLength(c.u64()));
      } else {
        await c.need(12);
        const nested = c.u32();
        await this.skipItems(nested, this.arrayLength(nested, c.u64(), depth + 1), depth + 1);
      }
    }
  }

  private safeInt(raw: bigint, what: string): number {
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw this.cursor.fail(`${what} ${raw} is out of range`, 'invalid');
    return Number(raw);
  }

  private async tensor(names: Set<string>): Promise<GgufTensorInfo> {
    const c = this.cursor;
    const name = await this.string();
    if (names.has(name)) throw c.fail(`duplicate tensor ${quote(name)}`, 'invalid');
    names.add(name);
    await c.need(4);
    const dims = c.u32();
    if (dims > MAX_TENSOR_DIMS) throw c.fail(`tensor ${quote(name)} has ${dims} dimensions`, 'invalid');
    await c.need(dims * 8 + 12);
    const shape = Array.from({ length: dims }, () => this.safeInt(c.u64(), `tensor ${quote(name)} dimension`));
    // As llama.cpp's gguf.cpp, which refuses to load such a file.
    if (shape.reduce((product, dim) => product * BigInt(dim), 1n) > INT64_MAX) {
      throw c.fail(`tensor ${quote(name)} has more elements than int64 can count`, 'invalid');
    }
    const typeId = c.u32();
    const offset = this.safeInt(c.u64(), `tensor ${quote(name)} offset`);
    return { name, type: GGML_TYPES[typeId] ?? 'unknown', typeId, shape, offset };
  }
}

/** Reads through a file handle in place; the file is never loaded whole. */
export function ggufFileSource(path: string): GgufByteSource {
  let handle: Promise<FileHandle> | undefined;
  return {
    label: path,
    async read(offset, length, signal) {
      signal?.throwIfAborted();
      handle ??= open(path, 'r');
      const file = await handle;
      const buffer = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await file.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    },
    async close() {
      const file = await handle?.catch(() => undefined);
      handle = undefined;
      await file?.close();
    },
  };
}

interface BodyStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** File offset of `chunk[0]`. */
  position: number;
  chunk: Uint8Array;
}

async function readBody(body: ReadableStream<Uint8Array> | null, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  if (!body) return out.subarray(0, 0);
  const reader = body.getReader();
  let filled = 0;
  try {
    while (filled < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, length - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, filled);
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

class HttpByteSource implements GgufByteSource {
  readonly label: string;
  private url: string;
  private readonly origin: string;
  private authorization: string | undefined;
  private stream: BodyStream | undefined;
  private readonly client: HttpClient;

  constructor(url: string, fetch: FetchLike, authorization: string | undefined) {
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new LocalRuntimeError('Invalid GGUF URL', GGUF_ID);
    }
    // The message must not echo the URL: it would leak the password.
    if (parsed.username || parsed.password) {
      throw new LocalRuntimeError('GGUF URL must not contain credentials; pass authorization instead', GGUF_ID);
    }
    // Signed redirect targets carry their credentials in the query, so labels drop it.
    this.label = `${parsed.origin}${parsed.pathname}`;
    this.url = parsed.href;
    this.origin = parsed.origin;
    if (authorization !== undefined) assertHeaderValues({ authorization }, GGUF_ID);
    this.authorization = authorization;
    this.client = { runtimeId: GGUF_ID, baseUrl: '', fetch };
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      if (this.stream) return await this.fromStream(this.stream, offset, length);
      const out = new Uint8Array(length);
      let filled = 0;
      // A server may answer a range with fewer bytes than asked; ask again for the rest until the file ends.
      while (filled < length) {
        const at = offset + filled;
        const response = await this.request(at, length - filled, signal);
        if (response.status === 206) {
          const { bytes, last } = await this.partial(response, at, length - filled);
          out.set(bytes, filled);
          filled += bytes.length;
          if (last) break;
          continue;
        }
        if (response.status === 200) {
          if (!response.body) throw new RuntimeProtocolError(`${GGUF_ID} ${this.label} returned no body`, GGUF_ID);
          // The server ignored Range: keep reading this one body forward and cancel it once the header is in.
          this.stream = { reader: response.body.getReader(), position: 0, chunk: new Uint8Array(0) };
          const rest = await this.fromStream(this.stream, at, length - filled);
          out.set(rest, filled);
          filled += rest.length;
          break;
        }
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 416) break;
        throw new RuntimeHttpError(
          `${GGUF_ID} ${this.label} returned HTTP ${response.status}`,
          GGUF_ID,
          response.status
        );
      }
      return out.subarray(0, filled);
    } catch (error) {
      throw connectionError(this.client, this.label, error, { signal });
    }
  }

  async close(): Promise<void> {
    await this.stream?.reader.cancel().catch(() => undefined);
    this.stream = undefined;
  }

  private async request(offset: number, length: number, signal: AbortSignal | undefined): Promise<Response> {
    // Fetch itself asks for `Accept-Encoding: identity` on a Range request, so the bytes line up.
    const headers: Record<string, string> = { range: `bytes=${offset}-${offset + length - 1}` };
    if (this.authorization) headers.authorization = this.authorization;
    const response = await this.client.fetch(this.url, { headers, signal, redirect: 'follow' });
    // Later ranges skip the redirect. A cross-origin target (a signed CDN URL) gets no credentials, as fetch does.
    if (response.redirected && URL.canParse(response.url)) {
      const target = new URL(response.url);
      this.url = target.href;
      if (target.origin !== this.origin) this.authorization = undefined;
    }
    return response;
  }

  /** `last` is true once the bytes reach the file size the server announced. */
  private async partial(
    response: Response,
    offset: number,
    length: number
  ): Promise<{ bytes: Uint8Array; last: boolean }> {
    const range = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '');
    const end = Number(range?.[2]);
    if (!range || Number(range[1]) !== offset || end < offset) {
      await response.body?.cancel().catch(() => undefined);
      throw new RuntimeProtocolError(`${GGUF_ID} ${this.label} answered with a different byte range`, GGUF_ID);
    }
    const expected = Math.min(length, end - offset + 1);
    const bytes = await readBody(response.body, expected);
    if (bytes.length < expected) {
      throw new RuntimeProtocolError(`${GGUF_ID} ${this.label} ended before the byte range it announced`, GGUF_ID);
    }
    return { bytes, last: range[3] !== '*' && end + 1 >= Number(range[3]) };
  }

  private async fromStream(stream: BodyStream, offset: number, length: number): Promise<Uint8Array> {
    if (offset < stream.position) {
      throw new RuntimeProtocolError(`${GGUF_ID} ${this.label} ignores Range, so it can only be read forward`, GGUF_ID);
    }
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (stream.chunk.length === 0) {
        const { done, value } = await stream.reader.read();
        if (done) break;
        stream.chunk = value;
        continue;
      }
      const want = offset + filled;
      const end = stream.position + stream.chunk.length;
      if (end <= want) {
        stream.position = end;
        stream.chunk = new Uint8Array(0);
        continue;
      }
      const from = want - stream.position;
      const take = Math.min(stream.chunk.length - from, length - filled);
      out.set(stream.chunk.subarray(from, from + take), filled);
      filled += take;
      stream.chunk = stream.chunk.subarray(from + take);
      stream.position = want + take;
    }
    return out.subarray(0, filled);
  }
}

/** Range requests through `fetch`, following redirects such as Hugging Face's `resolve` to its CDN. */
export function ggufHttpSource(
  url: string,
  options: Pick<ReadGgufOptions, 'fetch' | 'authorization'> = {}
): GgufByteSource {
  return new HttpByteSource(url, options.fetch ?? fetch, options.authorization);
}

const isUrl = (source: string) => /^https?:\/\//i.test(source);

function sourceLabel(source: GgufSource): string {
  if (typeof source !== 'string') return source.label;
  if (!isUrl(source)) return source;
  return URL.canParse(source) ? `${new URL(source).origin}${new URL(source).pathname}` : 'GGUF URL';
}

async function withDeadline<T>(
  label: string,
  options: ReadGgufOptions,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GGUF_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new LocalRuntimeError('GGUF timeoutMs must be a positive number of milliseconds or Infinity', GGUF_ID);
  }
  const timeout = timeoutMs <= MAX_TIMER_MS ? AbortSignal.timeout(timeoutMs) : undefined;
  const signals = [options.signal, timeout].filter(signal => signal !== undefined);
  const signal = signals.length === 1 && signals[0] ? signals[0] : AbortSignal.any(signals);
  try {
    return await task(signal);
  } catch (error) {
    if (timeout?.aborted && !options.signal?.aborted && !(error instanceof LocalRuntimeError)) {
      throw new RuntimeConnectionError(`${GGUF_ID} ${label} failed: timed out after ${timeoutMs}ms`, GGUF_ID, {
        cause: error,
      });
    }
    throw error;
  }
}

async function readSource(source: GgufSource, options: ReadGgufOptions, signal: AbortSignal): Promise<GgufHeader> {
  const owned = typeof source === 'string';
  const bytes = !owned ? source : isUrl(source) ? ggufHttpSource(source, options) : ggufFileSource(source);
  try {
    const cursor = new ByteCursor(bytes, signal, options.maxHeaderBytes ?? DEFAULT_GGUF_MAX_HEADER_BYTES);
    return await new HeaderReader(cursor, options.maxArrayLength ?? DEFAULT_GGUF_MAX_ARRAY_LENGTH).header();
  } finally {
    if (owned) await bytes.close().catch(() => undefined);
  }
}

/**
 * Reads one GGUF file's metadata and tensor infos, fetching only the header. Rejects with `GgufFormatError` for a
 * bad header, `RuntimeHttpError`/`RuntimeConnectionError` for URL failures, and the abort reason when `signal` aborts.
 */
export async function readGgufMetadata(source: GgufSource, options: ReadGgufOptions = {}): Promise<GgufHeader> {
  return withDeadline(sourceLabel(source), options, signal => readSource(source, options, signal));
}

const SHARD_SUFFIX = /-(\d{5})-of-(\d{5})\.gguf$/;

/** Every shard's location given the first, by llama.cpp's `<prefix>-%05d-of-%05d.gguf` naming; null if it does not fit. */
export function ggufShardLocations(first: string, count: number): string[] | null {
  const url = isUrl(first) && URL.canParse(first) ? new URL(first) : undefined;
  const path = url ? url.pathname : first;
  const match = SHARD_SUFFIX.exec(path);
  if (!match || Number(match[1]) !== 1 || Number(match[2]) !== count) return null;
  const prefix = path.slice(0, match.index);
  const total = String(count).padStart(5, '0');
  return Array.from({ length: count }, (_, i) => {
    const name = `${prefix}-${String(i + 1).padStart(5, '0')}-of-${total}.gguf`;
    if (!url) return name;
    const shard = new URL(url);
    shard.pathname = name;
    return shard.href;
  });
}

/** Tensor infos of every shard: a split GGUF keeps metadata in the first file but spreads tensors over all of them. */
async function allTensors(
  header: GgufHeader,
  source: GgufSource,
  options: InspectGgufOptions,
  signal: AbortSignal
): Promise<GgufTensorInfo[]> {
  const { metadata } = header;
  const count = positiveInt(metadata['split.count']) ?? 1;
  if (count === 1) return header.tensors;
  const fail = (message: string, reason: GgufFormatErrorReason) =>
    new GgufFormatError(`${sourceLabel(source)}: ${message}`, reason);
  const no = metadata['split.no'];
  if (no !== 0) throw fail(`is shard ${typeof no === 'number' ? no + 1 : '?'} of ${count}, not the first`, 'invalid');
  const others =
    options.shards ?? (typeof source === 'string' ? ggufShardLocations(source, count)?.slice(1) : undefined);
  if (!others) throw fail(`is the first of ${count} shards; pass the others as shards`, 'unsupported');
  if (others.length !== count - 1)
    throw fail(`is split into ${count} shards but ${others.length + 1} were given`, 'invalid');

  // mapLimit keeps going after a rejection, so the first failure aborts the reads in flight and the ones not started.
  const failed = new AbortController();
  const shardSignal = AbortSignal.any([signal, failed.signal]);
  const shards = await mapLimit(others, SHARD_CONCURRENCY, async shard => {
    shardSignal.throwIfAborted();
    try {
      return await readSource(shard, options, shardSignal);
    } catch (error) {
      failed.abort();
      throw error;
    }
  });
  const tensors = [...header.tensors];
  const names = new Set(tensors.map(tensor => tensor.name));
  shards.forEach((shard, i) => {
    if (shard.metadata['split.no'] !== i + 1 || shard.metadata['split.count'] !== count) {
      throw fail(`shard ${i + 2} is not part ${i + 2} of the same ${count}-shard split`, 'invalid');
    }
    for (const tensor of shard.tensors) {
      if (names.has(tensor.name)) throw fail(`tensor ${quote(tensor.name)} appears in two shards`, 'invalid');
      names.add(tensor.name);
      tensors.push(tensor);
    }
  });
  const expected = metadata['split.tensors.count'];
  if (typeof expected === 'number' && expected !== tensors.length) {
    throw fail(`declares ${expected} tensors across its shards but they hold ${tensors.length}`, 'invalid');
  }
  return tensors;
}

/**
 * `ModelArch` and `TensorStats` from a GGUF header, as `OllamaRuntime.inspect` derives them from `/api/show`.
 * A split GGUF reads every shard's tensor infos, so MoE expert sizes cover the whole model.
 */
export async function inspectGguf(source: GgufSource, options: InspectGgufOptions = {}): Promise<GgufInspection> {
  const readOptions = { ...options, maxArrayLength: undefined };
  return withDeadline(sourceLabel(source), readOptions, async signal => {
    const header = await readSource(source, readOptions, signal);
    const tensors = await allTensors(header, source, readOptions, signal);
    return { arch: archFromModelInfo(header.metadata, tensors), tensorStats: tensorStatsFromTensors(tensors) };
  });
}
