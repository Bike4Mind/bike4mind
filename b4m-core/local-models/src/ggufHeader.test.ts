import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerCapabilities, readGgufHeader } from './ggufHeader';
import { ggufBytes, ggufWithTemplate } from './__test__/ggufBytes';

let dir: string;
let count = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gguf-header-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(bytes: Buffer): Promise<string> {
  const path = join(dir, `m-${++count}.gguf`);
  await writeFile(path, bytes);
  return path;
}

const TOOLS_TEMPLATE = '{%- if tools %}{{ tools | tojson }}{%- endif %}<think>{{ messages }}';

describe('readGgufHeader', () => {
  it('reads the architecture, pooling type and template past the tokenizer arrays', async () => {
    expect(await readGgufHeader(await file(ggufWithTemplate(TOOLS_TEMPLATE)))).toEqual({
      chatTemplate: TOOLS_TEMPLATE,
      architecture: 'qwen2',
      poolingType: null,
    });
    const embedder = ggufWithTemplate(null, 'qwen3', { type: 'u32', value: 3 });
    expect(await readGgufHeader(await file(embedder))).toEqual({
      chatTemplate: null,
      architecture: 'qwen3',
      poolingType: 3,
    });
    const unspecified = ggufWithTemplate(null, 'llama', { type: 'i32', value: -1 });
    expect((await readGgufHeader(await file(unspecified)))?.poolingType).toBe(-1);
  });

  it('is undefined for a header it cannot read', async () => {
    const whole = ggufWithTemplate(TOOLS_TEMPLATE);
    expect(await readGgufHeader(await file(whole.subarray(0, whole.length - 10)))).toBeUndefined();
    expect(await readGgufHeader(await file(ggufBytes({}, 1)))).toBeUndefined();
    expect(await readGgufHeader(await file(Buffer.from('PK\x03\x04 not gguf')))).toBeUndefined();
    expect(await readGgufHeader(join(dir, 'absent.gguf'))).toBeUndefined();
  });

  it('reads the file again once it changes', async () => {
    const path = await file(ggufWithTemplate('first'));
    expect((await readGgufHeader(path))?.chatTemplate).toBe('first');
    await writeFile(path, ggufWithTemplate('second, longer'));
    expect((await readGgufHeader(path))?.chatTemplate).toBe('second, longer');
  });
});

describe('headerCapabilities', () => {
  const chat = (chatTemplate: string | null, poolingType: number | null = null, architecture = 'qwen2') =>
    headerCapabilities({ chatTemplate, architecture, poolingType });

  it('reports a chat model with tools and thinking as its template shows them', () => {
    expect(chat(TOOLS_TEMPLATE)).toEqual({ tools: true, thinking: true, embeddings: false, completion: true });
    expect(chat('{{ messages }}')).toEqual({ tools: false, thinking: false, embeddings: false, completion: true });
    expect(chat('{% if enable_thinking %}{% endif %}')).toMatchObject({ tools: false, thinking: true });
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
