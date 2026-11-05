import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSettingsStore } from './ModelSettingsStore';

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

  it('runs concurrent writes one at a time, so neither is lost', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    await Promise.all([store.set(QWEN, { effort: 'low' }), store.set(GEMMA, { generation: { topP: 0.9 } })]);
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).models).sort()).toEqual([GEMMA, QWEN].sort());
  });

  it.each(['{"models": {"local:ollama:qwen', '[]', '{}', '{"model": {}}', '"text"'])(
    'moves a corrupt or wrong-shape file %s aside on first read, reads empty, and set writes a fresh file',
    async content => {
      const path = await fileIn();
      await writeFile(path, content, 'utf8');
      const warn = vi.fn();
      const store = new ModelSettingsStore(path, warn);
      expect(await store.getStrict(QWEN)).toEqual({});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
      expect(await readFile(`${path}.corrupt`, 'utf8')).toBe(content);
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await store.set(GEMMA, { effort: 'medium' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ models: { [GEMMA]: { effort: 'medium' } } });
      expect(await readFile(`${path}.corrupt`, 'utf8')).toBe(content);
    }
  );

  it('tolerates the file vanishing before it can be moved aside', async () => {
    const path = await fileIn();
    await writeFile(path, '[]', 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await new ModelSettingsStore(path).getStrict(QWEN)).toEqual({});
  });

  it('answers a chat turn with no defaults when the file cannot be moved aside, leaving it in place', async () => {
    const path = await fileIn();
    await writeFile(path, '[]', 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    expect(await new ModelSettingsStore(path).get(QWEN)).toEqual({});
    expect(await readFile(path, 'utf8')).toBe('[]');
  });

  it('does not cache a failed move, rejects the strict read and set, and retries', async () => {
    const path = await fileIn();
    await writeFile(path, '[]', 'utf8');
    const store = new ModelSettingsStore(path);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    await expect(store.getStrict(QWEN)).rejects.toThrow('busy');
    expect(await readFile(path, 'utf8')).toBe('[]');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    await expect(store.set(GEMMA, { effort: 'high' })).rejects.toThrow('busy');
    expect(await readFile(path, 'utf8')).toBe('[]');
    await store.set(GEMMA, { effort: 'high' });
    expect(await readFile(`${path}.corrupt`, 'utf8')).toBe('[]');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ models: { [GEMMA]: { effort: 'high' } } });
  });

  it('lets a retry succeed after the file is deleted by hand following a failed read', async () => {
    const path = await fileIn();
    await writeFile(path, '[]', 'utf8');
    const store = new ModelSettingsStore(path);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    await expect(store.getStrict(QWEN)).rejects.toThrow('busy');
    await rm(path);
    expect(await store.getStrict(QWEN)).toEqual({});
    await store.set(GEMMA, { effort: 'high' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ models: { [GEMMA]: { effort: 'high' } } });
  });

  it('rejects a strict read only on a read error, and reads a good file', async () => {
    const path = await fileIn();
    const store = new ModelSettingsStore(path);
    expect(await store.getStrict(QWEN)).toEqual({});
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(new ModelSettingsStore(path).getStrict(QWEN)).rejects.toThrow('denied');
    await writeFile(path, JSON.stringify({ models: { [QWEN]: { effort: 'low' } } }), 'utf8');
    expect(await new ModelSettingsStore(path).getStrict(QWEN)).toEqual({ effort: 'low' });
  });

  it('does not cache a failed read as empty: warns, answers none, rejects set, and retries', async () => {
    const path = await fileIn();
    await mkdir(path);
    const warn = vi.fn();
    const store = new ModelSettingsStore(path, warn);
    expect(await store.get(QWEN)).toEqual({});
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
