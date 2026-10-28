import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { archFromModelInfo, tensorStatsFromTensors } from './arch';
import {
  GgufFormatError,
  LocalRuntimeError,
  RuntimeConnectionError,
  RuntimeHttpError,
  RuntimeProtocolError,
} from './errors';
import {
  ggufFileSource,
  ggufShardLocations,
  inspectGguf,
  readGgufMetadata,
  type GgufSource,
  type ReadGgufOptions,
} from './gguf';
import { delay, hang, json, startFakeServer, type FakeServer, type Handler } from './__test__/fakeServer';
import { ggufModels } from './__test__/ggufFixtures';
import {
  GGML_TYPE_IDS,
  T,
  arr,
  bool,
  concat,
  f32,
  f64,
  fieldFor,
  gguf,
  i16,
  i32,
  i64,
  i8,
  kvBytes,
  memorySource,
  str,
  u16,
  u32,
  u32le,
  u64,
  u64le,
  u8,
  type Field,
  type TensorSpec,
} from './__test__/ggufWriter';

const servers: FakeServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function serve(routes: Record<string, Handler>): Promise<FakeServer> {
  const server = await startFakeServer(routes);
  servers.push(server);
  return server;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gguf-test-'));
  tempDirs.push(dir);
  return dir;
}

const read = (bytes: Uint8Array, options?: ReadGgufOptions) => readGgufMetadata(memorySource(bytes), options);

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error
  );
}

async function formatError(promise: Promise<unknown>): Promise<GgufFormatError> {
  const error = await failure(promise);
  expect(error).toBeInstanceOf(GgufFormatError);
  return error as GgufFormatError;
}

/** A raw array field, for arrays too long to build item by item. */
const rawArray = (itemType: number, length: number, data: Uint8Array): Field => ({
  type: T.ARRAY,
  payload: concat(u32le(itemType), u64le(length), data),
});

const qwen3Kv: [string, Field][] = [
  ['general.architecture', str('qwen3moe')],
  ['qwen3moe.block_count', u32(4)],
  ['qwen3moe.context_length', u32(40960)],
  ['qwen3moe.embedding_length', u32(2048)],
  ['qwen3moe.attention.head_count', u32(32)],
  ['qwen3moe.attention.head_count_kv', u32(4)],
  ['qwen3moe.attention.key_length', u32(128)],
  ['qwen3moe.attention.value_length', u32(128)],
  ['qwen3moe.expert_count', u32(128)],
  ['qwen3moe.expert_used_count', u32(8)],
];

const F32 = 0;
const Q4_K = 12;
const Q6_K = 14;
const TYPE_NAMES: Record<number, string> = { [F32]: 'F32', [Q4_K]: 'Q4_K', [Q6_K]: 'Q6_K' };

function moeTensors(layers: number): TensorSpec[] {
  const tensors: TensorSpec[] = [
    { name: 'token_embd.weight', shape: [2048, 151936], type: Q4_K },
    { name: 'output_norm.weight', shape: [2048], type: F32 },
  ];
  for (let layer = 0; layer < layers; layer++) {
    tensors.push(
      { name: `blk.${layer}.attn_q.weight`, shape: [2048, 4096], type: Q4_K },
      { name: `blk.${layer}.ffn_gate_exps.weight`, shape: [2048, 768, 128], type: Q4_K },
      { name: `blk.${layer}.ffn_up_exps.weight`, shape: [2048, 768, 128], type: Q4_K },
      { name: `blk.${layer}.ffn_down_exps.weight`, shape: [768, 2048, 128], type: Q6_K }
    );
  }
  return tensors;
}

/** What `/api/show` would list for these tensors. */
const showTensors = (tensors: TensorSpec[]) =>
  tensors.map(tensor => ({ name: tensor.name, type: TYPE_NAMES[tensor.type] ?? '', shape: tensor.shape.map(Number) }));

// A leading byte-order mark must survive decoding: tokens can start with one.
const UNICODE = `${String.fromCodePoint(0xfeff)}qwen ${String.fromCodePoint(0xe9, 0x4e2d)}`;

describe('readGgufMetadata values', () => {
  it('decodes every scalar type, strings and arrays into model_info values', async () => {
    const header = await read(
      gguf({
        kv: [
          ['u8', u8(255)],
          ['i8', i8(-128)],
          ['u16', u16(65535)],
          ['i16', i16(-32768)],
          ['u32', u32(4294967295)],
          ['i32', i32(-2147483648)],
          ['f32', f32(1e-6)],
          ['f32.inf', f32(-Infinity)],
          ['bool.true', bool(true)],
          ['bool.false', bool(false)],
          ['bool.nonzero', bool(2)],
          ['string', str(UNICODE)],
          ['string.empty', str('')],
          ['u64.safe', u64(Number.MAX_SAFE_INTEGER)],
          ['u64.big', u64(2n ** 64n - 1n)],
          ['i64.negative', i64(-5)],
          ['i64.small', i64(-(2n ** 63n))],
          ['f64', f64(0.1)],
          ['array.u8', arr(T.UINT8, [u8(1), u8(2)])],
          ['array.i8', arr(T.INT8, [i8(-1)])],
          ['array.u16', arr(T.UINT16, [u16(7)])],
          ['array.i16', arr(T.INT16, [i16(-7)])],
          ['array.u32', arr(T.UINT32, [u32(0), u32(8), u32(0)])],
          ['array.i32', arr(T.INT32, [i32(-1), i32(1)])],
          ['array.f32', arr(T.FLOAT32, [f32(0.5), f32(1e-5)])],
          ['array.bool', arr(T.BOOL, [bool(true), bool(false)])],
          ['array.string', arr(T.STRING, [str('a'), str('')])],
          ['array.u64', arr(T.UINT64, [u64(1), u64(2n ** 60n)])],
          ['array.i64', arr(T.INT64, [i64(-2)])],
          ['array.f64', arr(T.FLOAT64, [f64(2.5)])],
          ['array.empty', arr(T.UINT32, [])],
          ['array.nested', arr(T.ARRAY, [arr(T.UINT32, [u32(1), u32(2)]), arr(T.STRING, [str('x')])])],
        ],
      })
    );
    expect(header.version).toBe(3);
    expect(header.tensors).toEqual([]);
    expect(Object.getPrototypeOf(header.metadata)).toBeNull();
    expect({ ...header.metadata }).toEqual({
      u8: 255,
      i8: -128,
      u16: 65535,
      i16: -32768,
      u32: 4294967295,
      i32: -2147483648,
      f32: 1e-6,
      'f32.inf': -Infinity,
      'bool.true': true,
      'bool.false': false,
      'bool.nonzero': true,
      string: UNICODE,
      'string.empty': '',
      'u64.safe': Number.MAX_SAFE_INTEGER,
      'u64.big': 2n ** 64n - 1n,
      'i64.negative': -5,
      'i64.small': -(2n ** 63n),
      f64: 0.1,
      'array.u8': [1, 2],
      'array.i8': [-1],
      'array.u16': [7],
      'array.i16': [-7],
      'array.u32': [0, 8, 0],
      'array.i32': [-1, 1],
      'array.f32': [0.5, 1e-5],
      'array.bool': [true, false],
      'array.string': ['a', ''],
      'array.u64': [1, 2n ** 60n],
      'array.i64': [-2],
      'array.f64': [2.5],
      'array.empty': [],
      'array.nested': [[1, 2], ['x']],
    });
  });

  it('keeps a __proto__ key as data', async () => {
    const header = await read(gguf({ kv: [['__proto__', str('x')]] }));
    expect(Object.getPrototypeOf(header.metadata)).toBeNull();
    expect(header.metadata['__proto__']).toBe('x');
  });

  it('records each value type, with the item type of every array however long or empty', async () => {
    const header = await read(
      gguf({
        kv: [
          ['narrow', u8(3)],
          ['wide', u32(3)],
          ['signed', i32(3)],
          ['text', str('x')],
          ['empty.nested', arr(T.ARRAY, [])],
          ['short.nested', arr(T.ARRAY, [arr(T.UINT8, [])])],
          ['long.strings', arr(T.STRING, [str('a'), str('b'), str('c')])],
        ],
      }),
      { maxArrayLength: 2 }
    );
    expect(Object.getPrototypeOf(header.types)).toBeNull();
    expect({ ...header.types }).toEqual({
      narrow: { type: 'uint8' },
      wide: { type: 'uint32' },
      signed: { type: 'int32' },
      text: { type: 'string' },
      'empty.nested': { type: 'array', itemType: 'array' },
      'short.nested': { type: 'array', itemType: 'array' },
      'long.strings': { type: 'array', itemType: 'string' },
    });
  });

  it('records long arrays by length only and keeps reading after them', async () => {
    const header = await read(
      gguf({
        kv: [
          ['long.u32', arr(T.UINT32, [u32(1), u32(2), u32(3)])],
          ['long.string', arr(T.STRING, [str('a'), str('bb'), str('ccc')])],
          [
            'long.nested',
            arr(T.ARRAY, [arr(T.STRING, [str('a')]), arr(T.UINT8, [u8(1), u8(2), u8(3)]), arr(T.BOOL, [])]),
          ],
          ['short', arr(T.UINT32, [u32(9), u32(8)])],
          ['nested.long.inner', arr(T.ARRAY, [arr(T.UINT16, [u16(1), u16(2), u16(3)])])],
          ['after', str('still read')],
        ],
        tensors: [{ name: 'blk.0.attn_q.weight', shape: [4, 4], type: 0 }],
      }),
      { maxArrayLength: 2 }
    );
    expect({ ...header.metadata }).toEqual({
      'long.u32': { omitted: true, itemType: 'uint32', length: 3 },
      'long.string': { omitted: true, itemType: 'string', length: 3 },
      'long.nested': { omitted: true, itemType: 'array', length: 3 },
      short: [9, 8],
      'nested.long.inner': [{ omitted: true, itemType: 'uint16', length: 3 }],
      after: 'still read',
    });
    expect(header.tensors.map(tensor => tensor.name)).toEqual(['blk.0.attn_q.weight']);
  });

  it('skips a long fixed-width array without reading its bytes', async () => {
    const scores = 8 * 1024 * 1024;
    const bytes = gguf({
      kv: [
        ['tokenizer.ggml.scores', rawArray(T.FLOAT32, scores / 4, new Uint8Array(scores))],
        ['general.architecture', str('llama')],
      ],
      tensors: [{ name: 'output.weight', shape: [8], type: 0 }],
    });
    const source = memorySource(bytes);
    const header = await readGgufMetadata(source);
    expect(header.metadata['general.architecture']).toBe('llama');
    expect(header.headerBytes).toBe(bytes.length);
    const fetched = source.reads.reduce((sum, entry) => sum + Math.min(entry.length, bytes.length - entry.offset), 0);
    expect(fetched).toBeLessThan(1024 * 1024);
  });

  it('keeps no more than its element budget across many short arrays', async () => {
    const short = arr(
      T.UINT8,
      Array.from({ length: 1000 }, () => u8(1))
    );
    const kv = Array.from({ length: 1100 }, (_, i): [string, Field] => [`a.${i}`, short]);
    const header = await read(gguf({ kv }));
    expect(header.metadata['a.0']).toHaveLength(1000);
    expect(header.metadata['a.1048']).toHaveLength(1000);
    expect(header.metadata['a.1049']).toEqual({ omitted: true, itemType: 'uint8', length: 1000 });
  });

  it('reads tensor infos with their ggml type names, shapes and offsets', async () => {
    const header = await read(
      gguf({
        tensors: [
          { name: 'token_embd.weight', shape: [896, 151936], type: 12, offset: 0 },
          { name: 'blk.0.ffn_up_exps.weight', shape: [2880, 2880, 32], type: 39, offset: 4096 },
          { name: 'scalar', shape: [], type: 0, offset: 2n ** 40n },
          { name: 'future', shape: [32], type: 43, offset: 64 },
        ],
      })
    );
    expect(header.tensors).toEqual([
      { name: 'token_embd.weight', type: 'Q4_K', typeId: 12, shape: [896, 151936], offset: 0 },
      { name: 'blk.0.ffn_up_exps.weight', type: 'MXFP4', typeId: 39, shape: [2880, 2880, 32], offset: 4096 },
      { name: 'scalar', type: 'F32', typeId: 0, shape: [], offset: 2 ** 40 },
      { name: 'future', type: 'unknown', typeId: 43, shape: [32], offset: 64 },
    ]);
  });

  it('names the ggml types ggml has removed as /api/show does', async () => {
    const names = Object.entries({
      4: 'Q4_2',
      5: 'Q4_3',
      31: 'Q4_0_4_4',
      32: 'Q4_0_4_8',
      33: 'Q4_0_8_8',
      36: 'IQ4_NL_4_4',
      37: 'IQ4_NL_4_8',
      38: 'IQ4_NL_8_8',
    });
    const header = await read(
      gguf({ tensors: names.map(([id]) => ({ name: `t${id}`, shape: [32], type: Number(id) })) })
    );
    expect(header.tensors.map(tensor => [String(tensor.typeId), tensor.type])).toEqual(names);
  });

  it('reads a float32 that needs nine significant digits as its shortest decimal', async () => {
    const value = Math.fround(10.0000105);
    for (let digits = 1; digits <= 8; digits++) expect(Math.fround(Number(value.toPrecision(digits)))).not.toBe(value);
    const header = await read(gguf({ kv: [['x', f32(value)]] }));
    expect(header.metadata.x).toBe(Number(value.toPrecision(9)));
  });

  it('reads v2 and v3 identically and reports the version', async () => {
    const spec = { kv: qwen3Kv, tensors: moeTensors(1) };
    const v2 = await read(gguf({ ...spec, version: 2 }));
    const v3 = await read(gguf({ ...spec, version: 3 }));
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    expect({ ...v2, version: 3 }).toEqual(v3);
  });
});

describe('readGgufMetadata rejects', () => {
  it.each([
    ['GGUF v1, whose counts are 32-bit', gguf({ version: 1 }), 'unsupported', /v1/],
    ['a big-endian file by its magic', gguf({ magic: 'FUGG', version: 3 }), 'unsupported', /big-endian/],
    [
      'a big-endian file by its version',
      concat(new TextEncoder().encode('GGUF'), new Uint8Array([0, 0, 0, 3]), u64le(0), u64le(0)),
      'unsupported',
      /big-endian/,
    ],
    ['an unknown version', gguf({ version: 4 }), 'unsupported', /version 4/],
    ['version 0', gguf({ version: 0 }), 'unsupported', /version 0/],
    ['a file that is not GGUF', gguf({ magic: 'GGML' }), 'invalid', /not a GGUF file/],
  ])('%s', async (_name, bytes, reason, message) => {
    const error = await formatError(read(bytes));
    expect(error).toMatchObject({ reason, runtimeId: 'gguf' });
    expect(error).toBeInstanceOf(LocalRuntimeError);
    expect(error.message).toMatch(message);
    expect(error.message).toMatch(/^memory\.gguf: /);
  });

  it('reports truncation at every byte boundary', async () => {
    const bytes = gguf({
      kv: [
        ['general.architecture', str('qwen3')],
        ['u8', u8(1)],
        ['u64', u64(2)],
        ['f64', f64(1.5)],
        ['skipped.fixed', arr(T.INT32, [i32(1), i32(2), i32(3)])],
        ['skipped.strings', arr(T.STRING, [str('a'), str('bc'), str('def')])],
        ['skipped.nested', arr(T.ARRAY, [arr(T.UINT8, [u8(1), u8(2), u8(3)]), arr(T.STRING, [str('x')])])],
        ['kept', arr(T.STRING, [str('k')])],
      ],
      tensors: [
        { name: 'a', shape: [2, 3], type: 0, offset: 0 },
        { name: 'b', shape: [4], type: 12, offset: 32 },
      ],
    });
    const options = { maxArrayLength: 2 };
    await expect(read(bytes, options)).resolves.toMatchObject({ headerBytes: bytes.length });
    for (let length = 0; length < bytes.length; length++) {
      const error = await formatError(read(bytes.subarray(0, length), options));
      expect(error.reason, `cut at ${length}`).toBe('truncated');
    }
  });

  it.each([
    ['a string length past 2^63', concat(gguf({ kvCount: 1 }), u64le(2n ** 63n)), 'limit'],
    ['a string over 16 MiB', concat(gguf({ kvCount: 1 }), u64le(16 * 1024 * 1024 + 1)), 'limit'],
    ['2^40 metadata keys', gguf({ kvCount: 2n ** 40n }), 'limit'],
    ['2^40 tensors', gguf({ tensorCount: 2n ** 40n }), 'limit'],
    ['a 2^60-entry byte array', gguf({ kv: [['a', arr(T.UINT8, [], 2n ** 60n)]] }), 'limit'],
    ['a 2^61-entry string array', gguf({ kv: [['a', arr(T.STRING, [], 2n ** 61n)]] }), 'limit'],
    ['a 2^62-entry array of arrays', gguf({ kv: [['a', arr(T.ARRAY, [], 2n ** 62n)]] }), 'limit'],
    [
      'arrays nested five deep',
      gguf({ kv: [['a', arr(T.ARRAY, [arr(T.ARRAY, [arr(T.ARRAY, [arr(T.ARRAY, [arr(T.UINT8, [])])])])])]] }),
      'limit',
    ],
    ['an unknown value type', gguf({ kv: [['a', { type: 13, payload: new Uint8Array(8) }]] }), 'invalid'],
    ['an unknown array item type', gguf({ kv: [['a', arr(13, [])]] }), 'invalid'],
    [
      'a duplicate key',
      gguf({
        kv: [
          ['a', u8(1)],
          ['a', u8(2)],
        ],
      }),
      'invalid',
    ],
    ['an empty key', gguf({ kv: [['', u8(1)]] }), 'invalid'],
    ['a five-dimensional tensor', gguf({ tensors: [{ name: 't', shape: [1, 1, 1, 1, 1], type: 0 }] }), 'invalid'],
    ['a tensor dimension past 2^53', gguf({ tensors: [{ name: 't', shape: [2n ** 60n], type: 0 }] }), 'invalid'],
    [
      'a tensor with more elements than int64 can count',
      gguf({ tensors: [{ name: 't', shape: [2n ** 31n, 2n ** 32n], type: 0 }] }),
      'invalid',
    ],
    [
      'a tensor offset past 2^53',
      gguf({ tensors: [{ name: 't', shape: [1], type: 0, offset: 2n ** 63n }] }),
      'invalid',
    ],
    [
      'a duplicate tensor',
      gguf({
        tensors: [
          { name: 't', shape: [1], type: 0 },
          { name: 't', shape: [1], type: 0 },
        ],
      }),
      'invalid',
    ],
  ])('%s', async (_name, bytes, reason) => {
    expect((await formatError(read(bytes))).reason).toBe(reason);
  });

  it('stops at maxHeaderBytes on an endless file', async () => {
    // A key followed by 1M empty strings in an omitted array, then the file never ends.
    const bytes = concat(gguf({ kvCount: 2 }), kvBytes('a', arr(T.STRING, [], 1_000_000)));
    const source = memorySource(bytes, () => 0);
    const error = await formatError(readGgufMetadata(source, { maxHeaderBytes: 1024 * 1024 }));
    expect(error.reason).toBe('limit');
    expect(source.reads.every(entry => entry.offset + entry.length <= 1024 * 1024)).toBe(true);
  });

  it('stops at maxHeaderBytes partway through skipping a string array', async () => {
    const strings = Array.from({ length: 60_000 }, () => str('12345678'));
    const source = memorySource(gguf({ kv: [['a', arr(T.STRING, strings)]] }));
    const error = await formatError(readGgufMetadata(source, { maxHeaderBytes: 512 * 1024 }));
    expect(error.reason).toBe('limit');
    expect(source.reads.length).toBeGreaterThan(1);
  });
});

/** Answers Range requests from `bytes`, as Hugging Face's CDN does, with at most `cap` bytes per response. */
function rangeHandler(bytes: Uint8Array, cap = Infinity): Handler {
  return (request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ''));
    if (!match) {
      response.writeHead(200, { 'content-length': bytes.length });
      response.end(Buffer.from(bytes));
      return;
    }
    const start = Number(match[1]);
    if (start >= bytes.length) {
      response.writeHead(416, { 'content-range': `bytes */${bytes.length}` });
      response.end();
      return;
    }
    const end = Math.min(Number(match[2]), bytes.length - 1, start + cap - 1);
    response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}` });
    response.end(Buffer.from(bytes.subarray(start, end + 1)));
  };
}

const servedBytes = (server: FakeServer, size: number) =>
  server.requests.reduce((sum, request) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ''));
    return sum + (match ? Math.max(0, Math.min(Number(match[2]), size - 1) - Number(match[1]) + 1) : 0);
  }, 0);

/** Several range requests deep: an omitted 1 MB string array, then an 8 MB float array the reader jumps over. */
function largeHeader(): Uint8Array {
  const tokens = Array.from({ length: 4000 }, (_, i) => str(`token-${i}`.padEnd(256, '.')));
  return gguf({
    kv: [
      ...qwen3Kv,
      ['tokenizer.ggml.tokens', arr(T.STRING, tokens)],
      ['tokenizer.ggml.scores', rawArray(T.FLOAT32, 2 * 1024 * 1024, new Uint8Array(8 * 1024 * 1024))],
    ],
    tensors: moeTensors(4),
  });
}

describe('readGgufMetadata over HTTP', () => {
  it('reads with growing Range requests, skipping what it does not need', async () => {
    const bytes = largeHeader();
    const server = await serve({ 'GET /model.gguf': rangeHandler(bytes) });
    const header = await readGgufMetadata(`${server.baseUrl}/model.gguf`, { authorization: 'Bearer hf_secret' });
    expect(header).toEqual(await read(bytes));
    expect(server.requests.length).toBeGreaterThan(2);
    expect(server.requests.every(request => request.headers.authorization === 'Bearer hf_secret')).toBe(true);
    expect(server.requests.every(request => request.headers['accept-encoding'] === 'identity')).toBe(true);
    expect(servedBytes(server, bytes.length)).toBeLessThan(bytes.length - 6 * 1024 * 1024);
  });

  it('reads a server that ignores Range from one response and cancels the rest of it', async () => {
    const bytes = largeHeader();
    const total = bytes.length + 256 * 1024 * 1024;
    let written = 0;
    const server = await serve({
      'GET /model.gguf': (_request, response: ServerResponse) =>
        new Promise<void>(resolve => {
          response.writeHead(200, { 'content-length': total });
          let closed = false;
          response.on('close', () => {
            closed = true;
            resolve();
          });
          const pump = () => {
            while (!closed && written < total) {
              const piece =
                written < bytes.length
                  ? Buffer.from(bytes.subarray(written, written + 65536))
                  : Buffer.alloc(Math.min(65536, total - written));
              written += piece.length;
              if (!response.write(piece)) return void response.once('drain', pump);
            }
            if (written >= total) response.end();
          };
          pump();
        }),
    });
    const header = await readGgufMetadata(`${server.baseUrl}/model.gguf`);
    expect(header).toEqual(await read(bytes));
    expect(server.requests).toHaveLength(1);
    await delay(100);
    expect(written).toBeLessThan(bytes.length + 64 * 1024 * 1024);
  });

  it('follows a same-origin redirect once and keeps the Authorization header', async () => {
    const bytes = gguf({ kv: qwen3Kv, tensors: moeTensors(2) });
    const server = await serve({
      'GET /resolve/main/model.gguf': (_request, response) => {
        response.writeHead(302, { location: '/cache/model.gguf' });
        response.end();
      },
      'GET /cache/model.gguf': rangeHandler(bytes),
    });
    const header = await readGgufMetadata(`${server.baseUrl}/resolve/main/model.gguf`, { authorization: 'Bearer t' });
    expect(header).toEqual(await read(bytes));
    expect(server.requests.every(request => request.headers.authorization === 'Bearer t')).toBe(true);
  });

  it('never sends the Authorization header to a cross-origin redirect target', async () => {
    const bytes = largeHeader();
    const cdn = await serve({ 'GET /blob?signature=s3cr3t': rangeHandler(bytes) });
    const hub = await serve({
      'GET /org/repo/resolve/main/model.gguf': (_request, response) => {
        response.writeHead(302, { location: `${cdn.baseUrl}/blob?signature=s3cr3t` });
        response.end();
      },
    });
    const header = await readGgufMetadata(`${hub.baseUrl}/org/repo/resolve/main/model.gguf`, {
      authorization: 'Bearer hf_secret',
    });
    expect(header).toEqual(await read(bytes));
    expect(hub.requests).toHaveLength(1);
    expect(hub.requests[0]?.headers.authorization).toBe('Bearer hf_secret');
    expect(cdn.requests.length).toBeGreaterThan(1);
    expect(cdn.requests.some(request => request.headers.authorization !== undefined)).toBe(false);
  });

  it('rejects a gated file with RuntimeHttpError and keeps the token out of the message', async () => {
    const server = await serve({
      'GET /gated.gguf?download=true': json({ error: 'Access to model is restricted' }, 401),
    });
    const error = await failure(
      readGgufMetadata(`${server.baseUrl}/gated.gguf?download=true`, { authorization: 'Bearer hf_secret' })
    );
    expect(error).toBeInstanceOf(RuntimeHttpError);
    expect(error).toMatchObject({ status: 401, runtimeId: 'gguf' });
    expect((error as Error).message).toBe(`gguf ${server.baseUrl}/gated.gguf returned HTTP 401`);
  });

  it('rejects a mismatched Content-Range with RuntimeProtocolError', async () => {
    const server = await serve({
      'GET /model.gguf': (_request, response) => {
        response.writeHead(206, { 'content-range': 'bytes 100-199/1000' });
        response.end(Buffer.alloc(100));
      },
    });
    expect(await failure(readGgufMetadata(`${server.baseUrl}/model.gguf`))).toBeInstanceOf(RuntimeProtocolError);
  });

  it('reports a truncated remote file as truncated', async () => {
    const bytes = gguf({ kv: qwen3Kv, tensors: moeTensors(2) });
    const server = await serve({ 'GET /model.gguf': rangeHandler(bytes.subarray(0, bytes.length - 3)) });
    expect((await formatError(readGgufMetadata(`${server.baseUrl}/model.gguf`))).reason).toBe('truncated');
  });

  it('rejects with the abort reason when the caller aborts', async () => {
    const server = await serve({ 'GET /model.gguf': hang });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const error = await failure(readGgufMetadata(`${server.baseUrl}/model.gguf`, { signal: controller.signal }));
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('rejects with RuntimeConnectionError when the deadline passes', async () => {
    const server = await serve({ 'GET /model.gguf': hang });
    const error = await failure(readGgufMetadata(`${server.baseUrl}/model.gguf`, { timeoutMs: 100 }));
    expect(error).toBeInstanceOf(RuntimeConnectionError);
    expect((error as Error).message).toBe(`gguf ${server.baseUrl}/model.gguf failed: timed out after 100ms`);
  });

  it('rejects a URL with credentials without echoing it', async () => {
    const error = await failure(readGgufMetadata('https://user:hunter2@example.com/model.gguf'));
    expect(error).toBeInstanceOf(LocalRuntimeError);
    expect((error as Error).message).not.toContain('hunter2');
  });

  // fetch rejects CR, LF and NUL with an error quoting the whole header value, and anything past U+00FF.
  it.each([10, 13, 0, 0x2028])(
    'rejects an Authorization value fetch refuses without echoing it (char %i)',
    async code => {
      const server = await serve({ 'GET /model.gguf': rangeHandler(gguf({})) });
      const authorization = `Bearer hf_SECRET${String.fromCharCode(code)}tail`;
      for (const call of [readGgufMetadata, inspectGguf]) {
        const error = await failure(call(`${server.baseUrl}/model.gguf`, { authorization }));
        expect(error).toBeInstanceOf(LocalRuntimeError);
        expect(error).not.toBeInstanceOf(RuntimeConnectionError);
        expect((error as Error).message).toBe('gguf authorization header contains a character HTTP does not allow');
        expect((error as Error).cause).toBeUndefined();
        expect(inspect(error, { depth: 10 })).not.toContain('hf_SECRET');
      }
      expect(server.requests).toEqual([]);
    }
  );

  it('asks again for the rest when a server answers a range with fewer bytes', async () => {
    const template = 'x'.repeat(300 * 1024);
    const bytes = gguf({ kv: [...qwen3Kv, ['tokenizer.chat_template', str(template)]], tensors: moeTensors(1) });
    const server = await serve({ 'GET /model.gguf': rangeHandler(bytes, 128 * 1024) });
    const header = await readGgufMetadata(`${server.baseUrl}/model.gguf`);
    expect(header).toEqual(await read(bytes));
    expect(header.metadata['tokenizer.chat_template']).toBe(template);

    const cut = await serve({ 'GET /model.gguf': rangeHandler(bytes.subarray(0, bytes.length - 3), 128 * 1024) });
    expect((await formatError(readGgufMetadata(`${cut.baseUrl}/model.gguf`))).reason).toBe('truncated');
  });

  it('rejects a Content-Range that ends before it starts with RuntimeProtocolError', async () => {
    const bytes = gguf({ kv: [...qwen3Kv, ['tokenizer.chat_template', str('y'.repeat(400 * 1024))]] });
    const server = await serve({
      'GET /model.gguf': (request, response) => {
        const start = Number(/^bytes=(\d+)-/.exec(String(request.headers.range))?.[1]);
        if (start === 0) return rangeHandler(bytes)(request, response);
        response.writeHead(206, { 'content-range': `bytes ${start}-${start - 10}/${bytes.length}` });
        response.end(Buffer.alloc(16));
      },
    });
    expect(await failure(readGgufMetadata(`${server.baseUrl}/model.gguf`))).toBeInstanceOf(RuntimeProtocolError);
  });

  it('treats Infinity and timeouts past the timer limit as no deadline', async () => {
    const bytes = gguf({ kv: qwen3Kv });
    const server = await serve({
      'GET /model.gguf': async (request, response) => {
        await delay(50);
        rangeHandler(bytes)(request, response);
      },
    });
    for (const timeoutMs of [2 ** 31, Infinity]) {
      expect(await readGgufMetadata(`${server.baseUrl}/model.gguf`, { timeoutMs })).toEqual(await read(bytes));
    }
  });

  it.each([0, -1, NaN])('rejects timeoutMs %s before making a request', async timeoutMs => {
    const server = await serve({ 'GET /model.gguf': rangeHandler(gguf({})) });
    expect(await failure(readGgufMetadata(`${server.baseUrl}/model.gguf`, { timeoutMs }))).toBeInstanceOf(
      LocalRuntimeError
    );
    expect(server.requests).toEqual([]);
  });
});

describe('readGgufMetadata from a file', () => {
  it('reads a file path through a file handle', async () => {
    const bytes = largeHeader();
    const path = join(await tempDir(), 'model.gguf');
    await writeFile(path, bytes);
    expect(await readGgufMetadata(path)).toEqual(await read(bytes));
  });

  it('rejects a missing file with the fs error', async () => {
    const error = await failure(readGgufMetadata(join(await tempDir(), 'missing.gguf')));
    expect(error).toMatchObject({ code: 'ENOENT' });
  });

  it('honours an already aborted signal', async () => {
    const path = join(await tempDir(), 'model.gguf');
    await writeFile(path, gguf({}));
    const error = await failure(readGgufMetadata(path, { signal: AbortSignal.abort() }));
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('leaves a caller-owned source open and closes its own', async () => {
    const source = memorySource(gguf({}));
    await readGgufMetadata(source);
    expect(source.closed).toBe(false);
    const file = ggufFileSource(join(await tempDir(), 'missing.gguf'));
    await expect(file.read(0, 8)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(file.close()).resolves.toBeUndefined();
  });
});

describe('inspectGguf', () => {
  it.each(Object.keys(ggufModels) as (keyof typeof ggufModels)[])(
    'derives the same arch as model_info for the real %s header',
    async model => {
      const fixture: {
        modelInfo: Record<string, unknown>;
        tensors?: readonly { name: string; type: string; shape: readonly number[] }[];
      } = ggufModels[model];
      const tensors = (fixture.tensors ?? []).map(tensor => ({
        name: tensor.name,
        type: GGML_TYPE_IDS[tensor.type] ?? -1,
        shape: [...tensor.shape],
      }));
      const bytes = gguf({
        kv: Object.entries(fixture.modelInfo).map(([key, value]) => [key, fieldFor(value)]),
        tensors,
      });
      expect(await inspectGguf(memorySource(bytes))).toEqual({
        arch: archFromModelInfo(fixture.modelInfo, fixture.tensors),
        tensorStats: tensorStatsFromTensors(fixture.tensors),
      });
    }
  );

  it('splits MoE weights into expert and other bytes', async () => {
    const tensors = moeTensors(4);
    const result = await inspectGguf(memorySource(gguf({ kv: qwen3Kv, tensors })));
    expect(result.arch?.moe).toEqual({ experts: 128, used: 8, moeLayers: 4 });
    // ggml block sizes: Q4_K packs 256 values in 144 bytes, Q6_K in 210.
    const q4k = (elements: number) => (elements / 256) * 144;
    const q6k = (elements: number) => (elements / 256) * 210;
    expect(result.tensorStats).toEqual({
      expertBytesPerLayer: 2 * q4k(2048 * 768 * 128) + q6k(768 * 2048 * 128),
      nonExpertBytes: q4k(2048 * 151936) + 2048 * 4 + 4 * q4k(2048 * 4096),
    });
  });

  function splitShards(tensors: TensorSpec[], kv: [string, Field][]): Uint8Array[] {
    const parts = [tensors.slice(0, 3), tensors.slice(3, 10), tensors.slice(10)];
    return parts.map((part, i) =>
      gguf({
        kv: [
          ...(i === 0 ? kv : []),
          ['split.no', u16(i)],
          ['split.count', u16(parts.length)],
          ['split.tensors.count', i32(tensors.length)],
        ],
        tensors: part,
      })
    );
  }

  it('reads every shard of a split GGUF named the llama.cpp way', async () => {
    const tensors = moeTensors(4);
    const dir = await tempDir();
    const shards = splitShards(tensors, qwen3Kv);
    const paths = shards.map((_, i) => join(dir, `Model-Q4_K_M-0000${i + 1}-of-00003.gguf`));
    await Promise.all(shards.map((bytes, i) => writeFile(paths[i] ?? '', bytes)));
    const whole = await inspectGguf(memorySource(gguf({ kv: qwen3Kv, tensors })));
    expect(await inspectGguf(paths[0] ?? '')).toEqual(whole);
    expect(whole.tensorStats).toEqual(tensorStatsFromTensors(showTensors(tensors)));
    // The first shard alone holds one layer's experts, which would skew the per-layer average.
    const firstOnly = (await readGgufMetadata(paths[0] ?? '')).tensors;
    expect(tensorStatsFromTensors(firstOnly)).not.toEqual(whole.tensorStats);
  });

  it('reads split shards from caller sources and over HTTP', async () => {
    const tensors = moeTensors(4);
    const shards = splitShards(tensors, qwen3Kv);
    const whole = await inspectGguf(memorySource(gguf({ kv: qwen3Kv, tensors })));
    const [first, ...rest] = shards.map(bytes => memorySource(bytes));
    expect(await inspectGguf(first as GgufSource, { shards: rest })).toEqual(whole);

    const routes = Object.fromEntries(
      shards.map((bytes, i) => [`GET /repo/resolve/main/Q4_K_M/M-0000${i + 1}-of-00003.gguf`, rangeHandler(bytes)])
    );
    const server = await serve(routes);
    expect(await inspectGguf(`${server.baseUrl}/repo/resolve/main/Q4_K_M/M-00001-of-00003.gguf`)).toEqual(whole);
    expect(server.requests).toHaveLength(3);
  });

  it('stops reading the other shards once one fails', async () => {
    const count = 8;
    let delivered = 0;
    const name = (i: number) => `/m-${String(i + 1).padStart(5, '0')}-of-${String(count).padStart(5, '0')}.gguf`;
    const routes = Object.fromEntries(
      Array.from({ length: count }, (_, i): [string, Handler] => {
        const bytes = gguf({
          kv: [
            ...(i === 0 ? qwen3Kv : []),
            ['split.no', u16(i)],
            ['split.count', u16(count)],
            ['split.tensors.count', i32(count)],
          ],
          tensors: [{ name: `t${i}`, shape: [4], type: F32 }],
        });
        if (i === 0) return [`GET ${name(i)}`, rangeHandler(bytes)];
        if (i === 1) return [`GET ${name(i)}`, json({}, 404)];
        return [
          `GET ${name(i)}`,
          async (request, response) => {
            await delay(300);
            if (response.destroyed) return;
            delivered++;
            rangeHandler(bytes)(request, response);
          },
        ];
      })
    );
    const server = await serve(routes);
    const fetched: string[] = [];
    const countingFetch: typeof fetch = (input, init) => {
      fetched.push(String(input));
      return fetch(input, init);
    };
    const error = await failure(inspectGguf(`${server.baseUrl}${name(0)}`, { fetch: countingFetch }));
    expect(error).toBeInstanceOf(RuntimeHttpError);
    const atRejection = fetched.length;
    await delay(500);
    // The first shard, then one window of SHARD_CONCURRENCY reads, the slow ones aborted mid-flight.
    expect(fetched).toHaveLength(atRejection);
    expect(fetched.map(url => new URL(url).pathname)).toEqual([0, 1, 2, 3, 4].map(name));
    expect(delivered).toBe(0);
  });

  it('ignores maxArrayLength, which would hide the per-layer arrays arch reads', async () => {
    const kv: [string, Field][] = [
      ...qwen3Kv.filter(([key]) => key !== 'qwen3moe.attention.head_count_kv'),
      ['qwen3moe.attention.head_count_kv', arr(T.UINT32, [u32(4), u32(4), u32(4), u32(4)])],
    ];
    const bytes = gguf({ kv, tensors: moeTensors(4) });
    const options = { maxArrayLength: 1, timeoutMs: 10_000 };
    const result = await inspectGguf(memorySource(bytes), options);
    expect(result.arch).not.toBeNull();
    expect(result).toEqual(await inspectGguf(memorySource(bytes)));
    expect((await read(bytes, options)).metadata['qwen3moe.attention.head_count_kv']).toMatchObject({ omitted: true });
  });

  it('refuses a split GGUF whose other shards it cannot find or that do not match', async () => {
    const [first, second, third] = splitShards(moeTensors(4), qwen3Kv).map((bytes): GgufSource => memorySource(bytes));
    if (!first || !second || !third) throw new Error('expected three shards');
    expect((await formatError(inspectGguf(first))).reason).toBe('unsupported');
    expect((await formatError(inspectGguf(first, { shards: [second] }))).reason).toBe('invalid');
    expect((await formatError(inspectGguf(first, { shards: [third, second] }))).reason).toBe('invalid');
    expect((await formatError(inspectGguf(second, { shards: [first, third] }))).reason).toBe('invalid');
  });
});

describe('ggufShardLocations', () => {
  it('names every shard from the first, for URLs and paths', () => {
    expect(
      ggufShardLocations('https://huggingface.co/o/r/resolve/main/Q4_K_M/M-Q4_K_M-00001-of-00003.gguf', 3)
    ).toEqual([
      'https://huggingface.co/o/r/resolve/main/Q4_K_M/M-Q4_K_M-00001-of-00003.gguf',
      'https://huggingface.co/o/r/resolve/main/Q4_K_M/M-Q4_K_M-00002-of-00003.gguf',
      'https://huggingface.co/o/r/resolve/main/Q4_K_M/M-Q4_K_M-00003-of-00003.gguf',
    ]);
    expect(ggufShardLocations('/models/m-00001-of-00002.gguf', 2)).toEqual([
      '/models/m-00001-of-00002.gguf',
      '/models/m-00002-of-00002.gguf',
    ]);
  });

  it('returns null when the name is not the first of that many shards', () => {
    expect(ggufShardLocations('/models/m.gguf', 2)).toBeNull();
    expect(ggufShardLocations('/models/m-00002-of-00002.gguf', 2)).toBeNull();
    expect(ggufShardLocations('/models/m-00001-of-00003.gguf', 2)).toBeNull();
  });
});
