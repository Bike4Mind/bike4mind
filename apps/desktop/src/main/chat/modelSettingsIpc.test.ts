import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerModelSettingsIpc } from './modelSettingsIpc';
import { ModelSettingsStore } from './ModelSettingsStore';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const QWEN = 'local:ollama:qwen3.8:27b';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-model-settings-ipc-'));
  roots.push(directory);
  const store = new ModelSettingsStore(join(directory, 'model-settings.json'));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerModelSettingsIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    store
  );
  const get = (...args: unknown[]) => handlers.get(IPC_CHANNELS.chatGetModelSettings)?.({ sender: {} }, ...args);
  const set = (...args: unknown[]) => handlers.get(IPC_CHANNELS.chatSetModelSettings)?.({ sender: {} }, ...args);
  await store.set(QWEN, { generation: { temperature: 0.6 } });
  return { store, get, set };
}

describe('registerModelSettingsIpc', () => {
  it('reads and replaces a model, and clears it on an empty set', async () => {
    const { get, set } = await setup();
    expect(await get(QWEN)).toEqual({ generation: { temperature: 0.6 } });
    expect(await set(QWEN, { generation: { topK: 20 }, effort: 'high' })).toEqual({
      generation: { topK: 20 },
      effort: 'high',
    });
    expect(await get(QWEN)).toEqual({ generation: { topK: 20 }, effort: 'high' });
    expect(await set(QWEN, {})).toEqual({});
    expect(await get(QWEN)).toEqual({});
  });

  it.each([null, 'hot', { generation: { temperature: 50 } }, { effort: 'turbo' }, { generaton: {} }])(
    'leaves the stored defaults alone for %j',
    async settings => {
      const { store, set } = await setup();
      expect(await set(QWEN, settings)).toBeNull();
      expect(await store.get(QWEN)).toEqual({ generation: { temperature: 0.6 } });
    }
  );

  it('rejects the read when the file cannot be read, and when it is corrupt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-model-settings-ipc-'));
    roots.push(directory);
    const path = join(directory, 'model-settings.json');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const handle = (channel: string, listener: (...args: never[]) => unknown) =>
      void handlers.set(channel, listener as never);
    registerModelSettingsIpc({ handle }, new ModelSettingsStore(path));
    const get = () => handlers.get(IPC_CHANNELS.chatGetModelSettings)?.({ sender: {} }, QWEN);
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(get()).rejects.toThrow('denied');
    await writeFile(path, '[]', 'utf8');
    registerModelSettingsIpc({ handle }, new ModelSettingsStore(path));
    await expect(get()).rejects.toThrow('not a valid');
  });

  it.each([42, 'gpt-5', ''])('answers null for the model id %j', async id => {
    const { get, set } = await setup();
    expect(await get(id)).toBeNull();
    expect(await set(id, { generation: { topK: 20 } })).toBeNull();
  });
});
