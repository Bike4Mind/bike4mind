import type { GgufByteSource } from '../gguf';

/** GGUF value type ids (docs/gguf.md in ggml). */
export const T = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

/** A typed value: its type id and its encoding without the type tag. */
export interface Field {
  type: number;
  payload: Uint8Array;
}

export interface TensorSpec {
  name: string;
  shape: (number | bigint)[];
  type: number;
  offset?: number | bigint;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function le(width: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(width);
  write(new DataView(bytes.buffer));
  return bytes;
}

export const u32le = (value: number) => le(4, view => view.setUint32(0, value, true));
export const u64le = (value: number | bigint) => le(8, view => view.setBigUint64(0, BigInt(value), true));
export const stringBytes = (text: string | Uint8Array) => {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return concat(u64le(bytes.length), bytes);
};

export const u8 = (value: number): Field => ({ type: T.UINT8, payload: le(1, v => v.setUint8(0, value)) });
export const i8 = (value: number): Field => ({ type: T.INT8, payload: le(1, v => v.setInt8(0, value)) });
export const u16 = (value: number): Field => ({ type: T.UINT16, payload: le(2, v => v.setUint16(0, value, true)) });
export const i16 = (value: number): Field => ({ type: T.INT16, payload: le(2, v => v.setInt16(0, value, true)) });
export const u32 = (value: number): Field => ({ type: T.UINT32, payload: u32le(value) });
export const i32 = (value: number): Field => ({ type: T.INT32, payload: le(4, v => v.setInt32(0, value, true)) });
export const f32 = (value: number): Field => ({ type: T.FLOAT32, payload: le(4, v => v.setFloat32(0, value, true)) });
export const bool = (value: boolean | number): Field => ({
  type: T.BOOL,
  payload: le(1, v => v.setUint8(0, Number(value))),
});
export const str = (value: string | Uint8Array): Field => ({ type: T.STRING, payload: stringBytes(value) });
export const u64 = (value: number | bigint): Field => ({ type: T.UINT64, payload: u64le(value) });
export const i64 = (value: number | bigint): Field => ({
  type: T.INT64,
  payload: le(8, v => v.setBigInt64(0, BigInt(value), true)),
});
export const f64 = (value: number): Field => ({ type: T.FLOAT64, payload: le(8, v => v.setFloat64(0, value, true)) });

/** An array of `itemType`; `length` overrides the count written, for hostile headers. */
export function arr(itemType: number, items: Field[], length: number | bigint = items.length): Field {
  return { type: T.ARRAY, payload: concat(u32le(itemType), u64le(length), ...items.map(item => item.payload)) };
}

export function kvBytes(key: string, field: Field): Uint8Array {
  return concat(stringBytes(key), u32le(field.type), field.payload);
}

export function tensorBytes({ name, shape, type, offset = 0 }: TensorSpec): Uint8Array {
  return concat(stringBytes(name), u32le(shape.length), ...shape.map(u64le), u32le(type), u64le(offset));
}

export interface GgufSpec {
  version?: number;
  /** Raw first four bytes; `GGUF` by default. */
  magic?: string;
  kv?: [string, Field][];
  tensors?: TensorSpec[];
  kvCount?: number | bigint;
  tensorCount?: number | bigint;
}

/** A GGUF header with no tensor data after it. */
export function gguf({
  version = 3,
  magic = 'GGUF',
  kv = [],
  tensors = [],
  kvCount,
  tensorCount,
}: GgufSpec): Uint8Array {
  return concat(
    new TextEncoder().encode(magic),
    u32le(version),
    u64le(tensorCount ?? tensors.length),
    u64le(kvCount ?? kv.length),
    ...kv.map(([key, field]) => kvBytes(key, field)),
    ...tensors.map(tensorBytes)
  );
}

/** A header with tokenizer arrays ahead of `template`, as converted models have; no template key when null. */
export function ggufWithTemplate(template: string | null, architecture = 'qwen2', pooling?: Field): Uint8Array {
  return gguf({
    kv: [
      ['general.architecture', str(architecture)],
      ['general.alignment', u32(32)],
      ...(pooling ? [[`${architecture}.pooling_type`, pooling] as [string, Field]] : []),
      ['tokenizer.ggml.tokens', arr(T.STRING, [str('<s>'), str('hello'), str('world')])],
      ['tokenizer.ggml.scores', arr(T.FLOAT32, [f32(0), f32(0), f32(0)])],
      ...(template === null ? [] : [['tokenizer.chat_template', str(template)] as [string, Field]]),
    ],
  });
}

export interface MemorySource extends GgufByteSource {
  reads: { offset: number; length: number }[];
  closed: boolean;
}

/** Serves `bytes`, or `fill(offset)` past their end to model an endless file. */
export function memorySource(bytes: Uint8Array, fill?: (offset: number) => number): MemorySource {
  const source: MemorySource = {
    label: 'memory.gguf',
    reads: [],
    closed: false,
    async read(offset, length) {
      source.reads.push({ offset, length });
      if (!fill) return bytes.slice(offset, offset + length);
      return Uint8Array.from({ length }, (_, i) =>
        offset + i < bytes.length ? (bytes[offset + i] ?? 0) : fill(offset + i)
      );
    },
    async close() {
      source.closed = true;
    },
  };
  return source;
}

// ggml type ids for the names `/api/show` prints.
export const GGML_TYPE_IDS: Record<string, number> = { F32: 0, F16: 1, Q4_0: 2, Q8_0: 8, Q4_K: 12, Q5_0: 6, Q6_K: 14 };

/** Encodes a `model_info`-style map the way convert_hf_to_gguf.py types it. */
export function fieldFor(value: unknown): Field {
  if (typeof value === 'string') return str(value);
  if (typeof value === 'boolean') return bool(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return f32(value);
    return value < 0 ? i32(value) : u32(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(fieldFor);
    return arr(items[0]?.type ?? T.UINT32, items);
  }
  throw new Error(`cannot encode ${String(value)}`);
}
