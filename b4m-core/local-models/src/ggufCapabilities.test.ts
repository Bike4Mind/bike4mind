import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerCapabilities, readCapabilityInfo } from './ggufCapabilities';
import { f32, gguf, ggufWithTemplate, i32, i64, str, u32, u64, u8 } from './__test__/ggufWriter';

let dir: string;
let count = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gguf-capabilities-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(bytes: Uint8Array): Promise<string> {
  const path = join(dir, `m-${++count}.gguf`);
  await writeFile(path, bytes);
  return path;
}

const TOOLS_TEMPLATE = '{%- if tools %}{{ tools | tojson }}{%- endif %}<think>{{ messages }}';

describe('readCapabilityInfo', () => {
  it('reads the architecture, pooling type and template past the tokenizer arrays', async () => {
    expect(await readCapabilityInfo(await file(ggufWithTemplate(TOOLS_TEMPLATE)))).toEqual({
      chatTemplate: TOOLS_TEMPLATE,
      architecture: 'qwen2',
      poolingType: null,
    });
    const embedder = ggufWithTemplate(null, 'qwen3', u32(3));
    expect(await readCapabilityInfo(await file(embedder))).toEqual({
      chatTemplate: null,
      architecture: 'qwen3',
      poolingType: 3,
    });
    const unspecified = ggufWithTemplate(null, 'llama', i32(-1));
    expect((await readCapabilityInfo(await file(unspecified)))?.poolingType).toBe(-1);
  });

  it('takes a pooling type only as a 32-bit integer written before the template', async () => {
    for (const pooling of [u8(3), u64(3), i64(3), f32(3)]) {
      expect((await readCapabilityInfo(await file(ggufWithTemplate(null, 'qwen3', pooling))))?.poolingType).toBeNull();
    }
    const late = gguf({
      kv: [
        ['general.architecture', str('qwen3')],
        ['tokenizer.chat_template', str('{{ messages }}')],
        ['qwen3.pooling_type', u32(3)],
      ],
    });
    expect(await readCapabilityInfo(await file(late))).toEqual({
      chatTemplate: '{{ messages }}',
      architecture: 'qwen3',
      poolingType: null,
    });
  });

  it('is undefined for a header it cannot read', async () => {
    const whole = ggufWithTemplate(TOOLS_TEMPLATE);
    expect(await readCapabilityInfo(await file(whole.subarray(0, whole.length - 10)))).toBeUndefined();
    expect(await readCapabilityInfo(await file(gguf({ version: 1 })))).toBeUndefined();
    expect(await readCapabilityInfo(await file(Buffer.from('PK\x03\x04 not gguf')))).toBeUndefined();
    expect(await readCapabilityInfo(join(dir, 'absent.gguf'))).toBeUndefined();
  });

  it('gives up on arrays of arrays at once, as llama.cpp does', async () => {
    const u32le = (value: number) => Buffer.from(new Uint32Array([value]).buffer);
    const u64le = (value: number) => Buffer.from(new BigUint64Array([BigInt(value)]).buffer);
    const head = Buffer.concat([Buffer.from('GGUF'), u32le(3), u64le(0), u64le(1), u64le(3), Buffer.from('a.b')]);
    const depth = 200_000;
    const nested = Buffer.concat([
      head,
      u32le(9),
      Buffer.concat(Array(depth).fill(Buffer.concat([u32le(9), u64le(1)]))),
    ]);
    const wide = Buffer.concat([
      head,
      u32le(9),
      u32le(9),
      u64le(depth),
      ...Array(depth).fill(Buffer.concat([u32le(4), u64le(0)])),
    ]);
    const short = Buffer.concat([head, u32le(9), u32le(9), u64le(1), u32le(4), u64le(0)]);
    const empty = Buffer.concat([head, u32le(9), u32le(9), u64le(0)]);
    const started = Date.now();
    expect(await readCapabilityInfo(await file(nested))).toBeUndefined();
    expect(await readCapabilityInfo(await file(wide))).toBeUndefined();
    expect(await readCapabilityInfo(await file(short))).toBeUndefined();
    expect(await readCapabilityInfo(await file(empty))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reads the file again once it changes', async () => {
    const path = await file(ggufWithTemplate('first'));
    expect((await readCapabilityInfo(path))?.chatTemplate).toBe('first');
    await writeFile(path, ggufWithTemplate('second, longer'));
    expect((await readCapabilityInfo(path))?.chatTemplate).toBe('second, longer');
  });
});

describe('headerCapabilities', () => {
  const chat = (chatTemplate: string | null, poolingType: number | null = null, architecture = 'qwen2') =>
    headerCapabilities({ chatTemplate, architecture, poolingType });

  it('reports a chat model with tools and thinking as its template shows them', () => {
    expect(chat(TOOLS_TEMPLATE)).toEqual({ tools: true, thinking: true, embeddings: false, completion: true });
    expect(chat('{{ messages }}')).toEqual({ tools: false, thinking: false, embeddings: false, completion: true });
    expect(chat('{% if enable_thinking %}{% endif %}')).toMatchObject({ tools: false, thinking: true });
    expect(chat('{{ reasoning_effort }}<|start|>assistant<|channel|>analysis<|message|>')).toMatchObject({
      thinking: true,
    });
    expect(chat('[THINK]{{ thought }}[/THINK]')).toMatchObject({ thinking: true });
    expect(chat(null)).toEqual({ tools: false, thinking: false, embeddings: false, completion: true });
    expect(chat(null, 0)).toMatchObject({ completion: true, embeddings: false });
    expect(chat(null, -1)).toMatchObject({ completion: true, embeddings: false });
  });

  it('reports a model with pooling or an encoder-only architecture as embeddings without completion', () => {
    const embeddings = { tools: false, thinking: false, embeddings: true, completion: false };
    expect(chat(TOOLS_TEMPLATE, 3)).toEqual(embeddings);
    expect(chat(null, 4)).toEqual(embeddings);
    expect(chat(null, null, 'nomic-bert')).toEqual(embeddings);
  });

  it('reports nothing for a vision projector', () => {
    expect(chat(null, null, 'clip')).toEqual({ tools: false, thinking: false, embeddings: false, completion: false });
  });

  it('reports a chat model with tools when the header is unreadable', () => {
    expect(headerCapabilities(undefined)).toEqual({
      tools: true,
      thinking: false,
      embeddings: false,
      completion: true,
    });
  });
});
