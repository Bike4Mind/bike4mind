import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSettingsFileError, ModelSettingsStore } from './ModelSettingsStore';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), readFile: vi.fn(actual.readFile) };
});

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

  it('keeps a model whose set holds only load settings', async () => {
    const path = await fileIn();
    await new ModelSettingsStore(path).set(QWEN, { draftTokens: 0, keepAlive: -1 });
    expect(await new ModelSettingsStore(path).get(QWEN)).toEqual({ draftTokens: 0, keepAlive: -1 });
  });

  it('runs concurrent writes one at a time, so neither is lost', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    await Promise.all([store.set(QWEN, { effort: 'low' }), store.set(GEMMA, { generation: { topP: 0.9 } })]);
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).models).sort()).toEqual([GEMMA, QWEN].sort());
  });

  it.each([
    ['{"models": {"local:ollama:qwen', 'is not valid JSON'],
    ['[]', 'does not hold model settings'],
    ['{}', 'does not hold model settings'],
    ['{"model": {}}', 'does not hold model settings'],
    ['"text"', 'does not hold model settings'],
  ])('rejects a corrupt or wrong-shape file %s by name, and never writes over it', async (content, problem) => {
    const path = await fileIn();
    await writeFile(path, content, 'utf8');
    const warn = vi.fn();
    const store = new ModelSettingsStore(path, warn);
    const error = await store.get(QWEN).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ModelSettingsFileError);
    expect((error as ModelSettingsFileError).filePath).toBe(path);
    expect((error as Error).message).toBe(
      `The model settings file ${path} ${problem}. Fix it, or delete it to clear the saved settings of every model.`
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path));
    await expect(store.set(GEMMA, { effort: 'medium' })).rejects.toThrow(ModelSettingsFileError);
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(await readdir(dirname(path))).toEqual(['model-settings.json']);
  });

  it('reads a corrupt file again once it is fixed by hand', async () => {
    const path = await fileIn();
    await writeFile(path, '{"models": {', 'utf8');
    const store = new ModelSettingsStore(path);
    await expect(store.get(QWEN)).rejects.toThrow(ModelSettingsFileError);
    await writeFile(path, JSON.stringify({ models: { [QWEN]: { effort: 'low' } } }), 'utf8');
    expect(await store.get(QWEN)).toEqual({ effort: 'low' });
  });

  it('lets a retry succeed after a corrupt file is deleted by hand', async () => {
    const path = await fileIn();
    await writeFile(path, '[]', 'utf8');
    const store = new ModelSettingsStore(path);
    await expect(store.get(QWEN)).rejects.toThrow(ModelSettingsFileError);
    await rm(path);
    expect(await store.get(QWEN)).toEqual({});
    await store.set(GEMMA, { effort: 'high' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ models: { [GEMMA]: { effort: 'high' } } });
  });

  it('rejects a read on a read error, and reads a good file', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    expect(await store.get(QWEN)).toEqual({});
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(new ModelSettingsStore(path).get(QWEN)).rejects.toThrow('denied');
    await writeFile(path, JSON.stringify({ models: { [QWEN]: { effort: 'low' } } }), 'utf8');
    expect(await new ModelSettingsStore(path).get(QWEN)).toEqual({ effort: 'low' });
  });

  it('does not cache a failed read as empty: warns, rejects get and set, and retries', async () => {
    const path = await fileIn();
    await mkdir(path);
    const warn = vi.fn();
    const store = new ModelSettingsStore(path, warn);
    await expect(store.get(QWEN)).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read'));
    await expect(store.set(GEMMA, { effort: 'high' })).rejects.toThrow();
    expect((await readdir(path)).length).toBe(0);
    await rm(path, { recursive: true });
    await writeFile(path, JSON.stringify({ models: { [QWEN]: { effort: 'low' } } }), 'utf8');
    expect(await store.get(QWEN)).toEqual({ effort: 'low' });
    await store.set(GEMMA, { effort: 'high' });
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).models).sort()).toEqual([GEMMA, QWEN].sort());
  });

  it('removes its temporary file when the write fails, and keeps the old defaults', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    await store.set(QWEN, { effort: 'low' });
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk full'));
    await expect(store.set(GEMMA, { effort: 'high' })).rejects.toThrow('disk full');
    expect(await readdir(dirname(path))).toEqual(['model-settings.json']);
    expect(await store.get(GEMMA)).toEqual({});
    expect(await store.get(QWEN)).toEqual({ effort: 'low' });
  });

  it.each([
    [{ generation: { temperature: '0.6', topK: 20 } }, 'has an invalid generation.temperature for'],
    [{ effort: 'wild' }, 'has an invalid effort for'],
    ['high', 'has an entry for'],
  ])(
    'rejects a hand-edited known value %j by file, model and field, and never writes over it',
    async (entry, problem) => {
      const path = await fileIn();
      const content = JSON.stringify({ models: { [GEMMA]: { effort: 'low' }, [QWEN]: entry } });
      await writeFile(path, content, 'utf8');
      const store = new ModelSettingsStore(path);
      await expect(store.get(GEMMA)).rejects.toThrow(
        `The model settings file ${path} ${problem} ${QWEN}${typeof entry === 'string' ? ' that is not a set of settings' : ''}. Fix it, or delete it`
      );
      await expect(store.set(GEMMA, { effort: 'high' })).rejects.toThrow(ModelSettingsFileError);
      expect(await readFile(path, 'utf8')).toBe(content);
    }
  );

  it('keeps fields and entries it does not know when it rewrites the file for another model', async () => {
    const path = await fileIn();
    const qwen = { generation: { temperature: 0.6, minP2: 0.1 }, effort: 'high', speculation: { kind: 'eagle', n: 3 } };
    const others = { 'claude-sonnet': { pinned: true }, 'gpt-5': [1, 'two'] };
    await writeFile(path, JSON.stringify({ version: 2, models: { [QWEN]: qwen, ...others } }), 'utf8');
    const store = new ModelSettingsStore(path);
    expect(await store.get(QWEN)).toEqual({ generation: { temperature: 0.6 }, effort: 'high' });
    await store.set(GEMMA, { effort: 'medium' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 2,
      models: { [QWEN]: qwen, ...others, [GEMMA]: { effort: 'medium' } },
    });
    await store.set(QWEN, { keepAlive: -1 });
    expect(JSON.parse(await readFile(path, 'utf8')).models[QWEN]).toEqual({
      generation: { minP2: 0.1 },
      speculation: { kind: 'eagle', n: 3 },
      keepAlive: -1,
    });
    expect(await new ModelSettingsStore(path).get(QWEN)).toEqual({ keepAlive: -1 });
  });

  it('logs a failure that persists once, and a different one again', async () => {
    const path = await fileIn();
    await writeFile(path, '[]', 'utf8');
    const warn = vi.fn();
    const store = new ModelSettingsStore(path, warn);
    await expect(store.get(QWEN)).rejects.toThrow(ModelSettingsFileError);
    await expect(store.get(GEMMA)).rejects.toThrow(ModelSettingsFileError);
    expect(warn).toHaveBeenCalledOnce();
    await writeFile(path, '{', 'utf8');
    await expect(store.get(QWEN)).rejects.toThrow('is not valid JSON');
    expect(warn).toHaveBeenCalledTimes(2);
    await rm(path);
    expect(await store.get(QWEN)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
