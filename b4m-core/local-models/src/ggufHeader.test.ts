import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGgufChatTemplate, templateCapabilities } from './ggufHeader';
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

describe('readGgufChatTemplate', () => {
  it('reads the template past the tokenizer arrays', async () => {
    expect(await readGgufChatTemplate(await file(ggufWithTemplate(TOOLS_TEMPLATE)))).toBe(TOOLS_TEMPLATE);
  });

  it('is null for a header without a template and undefined for one it cannot read', async () => {
    expect(await readGgufChatTemplate(await file(ggufWithTemplate(null)))).toBeNull();
    const whole = ggufWithTemplate(TOOLS_TEMPLATE);
    expect(await readGgufChatTemplate(await file(whole.subarray(0, whole.length - 10)))).toBeUndefined();
    expect(await readGgufChatTemplate(await file(ggufBytes({}, 1)))).toBeUndefined();
    expect(await readGgufChatTemplate(await file(Buffer.from('PK\x03\x04 not gguf')))).toBeUndefined();
    expect(await readGgufChatTemplate(join(dir, 'absent.gguf'))).toBeUndefined();
  });

  it('reads the file again once it changes', async () => {
    const path = await file(ggufWithTemplate('first'));
    expect(await readGgufChatTemplate(path)).toBe('first');
    await writeFile(path, ggufWithTemplate('second, longer'));
    expect(await readGgufChatTemplate(path)).toBe('second, longer');
  });
});

describe('templateCapabilities', () => {
  it('reports tools when the template renders them, and when the template is unknown', () => {
    expect(templateCapabilities(TOOLS_TEMPLATE)).toEqual({ tools: true, thinking: true });
    expect(templateCapabilities('{{ messages }}')).toEqual({ tools: false, thinking: false });
    expect(templateCapabilities('{% if enable_thinking %}{% endif %}')).toEqual({ tools: false, thinking: true });
    expect(templateCapabilities(null)).toEqual({ tools: false, thinking: false });
    expect(templateCapabilities(undefined)).toEqual({ tools: true, thinking: false });
  });
});
