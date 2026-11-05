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
    [{ effort: 3 }, 'has an invalid effort for'],
    ['high', 'has an entry for'],
  ])(
    'rejects only the model whose known value %j is of the wrong type, by file, model and field, and keeps its entry as written',
    async (entry, problem) => {
      const path = await fileIn();
      await writeFile(path, JSON.stringify({ models: { [GEMMA]: { effort: 'low' }, [QWEN]: entry } }), 'utf8');
      const warn = vi.fn();
      const store = new ModelSettingsStore(path, warn);
      const message = `The model settings file ${path} ${problem} "${QWEN}"${typeof entry === 'string' ? ' that is not a set of settings' : ''}. Fix it, or delete it`;
      await expect(store.get(QWEN)).rejects.toThrow(message);
      await expect(store.unsupported(QWEN)).rejects.toThrow(ModelSettingsFileError);
      await expect(store.set(QWEN, { effort: 'high' })).rejects.toThrow(message);
      expect(await store.get(GEMMA)).toEqual({ effort: 'low' });
      await store.set(GEMMA, { effort: 'high' });
      const reopened = new ModelSettingsStore(path);
      expect(await reopened.get(GEMMA)).toEqual({ effort: 'high' });
      expect(JSON.parse(await readFile(path, 'utf8')).models[QWEN]).toEqual(entry);
      await expect(reopened.get(QWEN)).rejects.toThrow(message);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(message));
    }
  );

  it.each([
    ['a known field', `{"${QWEN}": {"draftTokens": 1e999}}`, `has an invalid draftTokens for "${QWEN}"`],
    [
      'a generation field',
      `{"${QWEN}": {"generation": {"topK": -1e999}}}`,
      `has an invalid generation.topK for "${QWEN}"`,
    ],
  ])(
    'takes a number too large for JSON in %s for a broken value, which a save elsewhere cannot write as null',
    async (_, models, problem) => {
      const path = await fileIn();
      const content = `{"models": ${models}}`;
      await writeFile(path, content, 'utf8');
      const store = new ModelSettingsStore(path);
      await expect(store.get(QWEN)).rejects.toThrow(problem);
      await expect(store.set(GEMMA, { effort: 'high' })).rejects.toThrow(
        `has a number for "${QWEN}" too large to save back as written`
      );
      expect(await readFile(path, 'utf8')).toBe(content);
      const reopened = new ModelSettingsStore(path);
      expect(await reopened.get(GEMMA)).toEqual({});
      await expect(reopened.get(QWEN)).rejects.toThrow(problem);
    }
  );

  it('never saves an unknown field holding a number too large for JSON as null', async () => {
    const path = await fileIn();
    const content = `{"models": {"${QWEN}": {"effort": "low", "futureOnly": 1e999}}}`;
    await writeFile(path, content, 'utf8');
    const store = new ModelSettingsStore(path);
    expect(await store.get(QWEN)).toEqual({ effort: 'low' });
    await expect(store.set(QWEN, { effort: 'high' })).rejects.toThrow(ModelSettingsFileError);
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(await new ModelSettingsStore(path).get(QWEN)).toEqual({ effort: 'low' });
  });

  it('stamps what it wrote, so an edit landing right after its write is read before the next save', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await actual.rename(from, to);
      await writeFile(path, JSON.stringify({ models: { [QWEN]: { effort: 'high' }, [GEMMA]: { keepAlive: 300 } } }));
    });
    await store.set(QWEN, { effort: 'low' });
    await store.set(GEMMA, { keepAlive: 3600 });
    expect(JSON.parse(await readFile(path, 'utf8')).models).toEqual({
      [QWEN]: { effort: 'high' },
      [GEMMA]: { keepAlive: 3600 },
    });
  });

  it('quotes a model id in the error on one line and cuts a long one', async () => {
    const path = await fileIn();
    const id = `local:ollama:a\nb${'x'.repeat(300)}`;
    await writeFile(path, JSON.stringify({ models: { [id]: { effort: 3 } } }), 'utf8');
    const error = await new ModelSettingsStore(path).get(id).catch((reason: Error) => reason);
    expect((error as Error).message).toContain('has an invalid effort for "local:ollama:a\\nbxxx');
    expect((error as Error).message).toContain('xxx.... Fix it');
    expect((error as Error).message).not.toContain('\n');
  });

  it('keeps a value of the right type beyond this version, unused, through saves to it and to others', async () => {
    const path = await fileIn();
    await writeFile(
      path,
      JSON.stringify({ models: { [QWEN]: { effort: 'ultra', keepAlive: 3600, generation: { topK: 1.5 } } } }),
      'utf8'
    );
    const warn = vi.fn();
    const store = new ModelSettingsStore(path, warn);
    expect(await store.get(QWEN)).toEqual({ keepAlive: 3600 });
    expect(await store.unsupported(QWEN)).toEqual([
      { field: 'generation.topK', value: 1.5 },
      { field: 'effort', value: 'ultra' },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('holds effort "ultra" for'));
    await store.set(GEMMA, { effort: 'low' });
    await store.set(QWEN, { keepAlive: 300, generation: { temperature: 0.5 } });
    expect(JSON.parse(await readFile(path, 'utf8')).models[QWEN]).toEqual({
      generation: { topK: 1.5, temperature: 0.5 },
      effort: 'ultra',
      keepAlive: 300,
    });
    expect(await new ModelSettingsStore(path).unsupported(QWEN)).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reads the file again before a save when it changed by hand since it was read', async () => {
    const path = await fileIn();
    await writeFile(path, JSON.stringify({ models: { [QWEN]: { effort: 'low' } } }), 'utf8');
    const store = new ModelSettingsStore(path);
    expect(await store.get(QWEN)).toEqual({ effort: 'low' });
    await writeFile(
      path,
      JSON.stringify({ models: { [QWEN]: { effort: 'high' }, [GEMMA]: { keepAlive: 300 } } }),
      'utf8'
    );
    await store.set(GEMMA, { keepAlive: 3600 });
    expect(JSON.parse(await readFile(path, 'utf8')).models).toEqual({
      [QWEN]: { effort: 'high' },
      [GEMMA]: { keepAlive: 3600 },
    });
    const broken = '{"models": {';
    await writeFile(path, broken, 'utf8');
    await expect(store.set(QWEN, { effort: 'medium' })).rejects.toThrow(ModelSettingsFileError);
    expect(await readFile(path, 'utf8')).toBe(broken);
  });

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
