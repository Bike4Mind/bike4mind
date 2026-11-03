import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSettingsStore } from './ModelSettingsStore';

const QWEN = 'local:ollama:qwen3.8:27b';
const GEMMA = 'local:ollama:gemma4:12b-it-qat';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fileIn(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-model-settings-'));
  roots.push(directory);
  return join(directory, 'model-settings.json');
}

describe('ModelSettingsStore', () => {
  it('holds nothing before the file exists, and warns about nothing', async () => {
    const warn = vi.fn();
    expect(await new ModelSettingsStore(await fileIn(), warn).get(QWEN)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes defaults by model id that a fresh store reads back', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    await store.set(QWEN, { generation: { temperature: 0.6, topK: 20 } });
    await store.set(GEMMA, { effort: 'high' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      models: { [QWEN]: { generation: { temperature: 0.6, topK: 20 } }, [GEMMA]: { effort: 'high' } },
    });
    const reopened = new ModelSettingsStore(path);
    expect(await reopened.get(QWEN)).toEqual({ generation: { temperature: 0.6, topK: 20 } });
    expect(await reopened.get(GEMMA)).toEqual({ effort: 'high' });
  });

  it('removes a model whose set is empty', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    await store.set(QWEN, { generation: { temperature: 0.6 } });
    await store.set(QWEN, {});
    expect(await store.get(QWEN)).toEqual({});
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ models: {} });
  });

  it('runs concurrent writes one at a time, so neither is lost', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    await Promise.all([store.set(QWEN, { effort: 'low' }), store.set(GEMMA, { generation: { topP: 0.9 } })]);
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).models).sort()).toEqual([GEMMA, QWEN].sort());
  });

  it('reads a corrupt file as no defaults, warns, and replaces it on the next save', async () => {
    const path = await fileIn();
    await writeFile(path, '{"models": {"local:ollama:qwen', 'utf8');
    const warn = vi.fn();
    const store = new ModelSettingsStore(path, warn);
    expect(await store.get(QWEN)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
    await store.set(GEMMA, { effort: 'medium' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ models: { [GEMMA]: { effort: 'medium' } } });
  });

  it('drops what a hand-edited file holds that is not valid', async () => {
    const path = await fileIn();
    await writeFile(
      path,
      JSON.stringify({ models: { [QWEN]: { generation: { temperature: 7, topK: 20 }, effort: 'wild' }, x: {} } }),
      'utf8'
    );
    expect(await new ModelSettingsStore(path).get(QWEN)).toEqual({ generation: { topK: 20 } });
  });
});
