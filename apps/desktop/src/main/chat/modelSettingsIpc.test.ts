import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { modelSettingsChanged, registerModelSettingsIpc } from './modelSettingsIpc';
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

  it('rejects the read when the file cannot be read, and names a corrupt one with how to fix it', async () => {
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
    await expect(get()).rejects.toThrow(
      `The model settings file ${path} does not hold model settings. Fix it, or delete it`
    );
    expect(await readFile(path, 'utf8')).toBe('[]');
  });

  it('lists the values a model holds that this version keeps but does not use', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-model-settings-ipc-'));
    roots.push(directory);
    const path = join(directory, 'model-settings.json');
    await writeFile(path, JSON.stringify({ models: { [QWEN]: { effort: 'ultra' } } }), 'utf8');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const handle = (channel: string, listener: (...args: never[]) => unknown) =>
      void handlers.set(channel, listener as never);
    registerModelSettingsIpc({ handle }, new ModelSettingsStore(path));
    const unsupported = (id: unknown) =>
      handlers.get(IPC_CHANNELS.chatGetUnsupportedModelSettings)?.({ sender: {} }, id);
    expect(await unsupported(QWEN)).toEqual([{ field: 'effort', value: 'ultra' }]);
    expect(await unsupported('gpt-5')).toBeNull();
  });

  it.each([42, 'gpt-5', ''])('answers null for the model id %j', async id => {
    const { get, set } = await setup();
    expect(await get(id)).toBeNull();
    expect(await set(id, { generation: { topK: 20 } })).toBeNull();
  });
});

describe('registerModelSettingsIpc load options', () => {
  async function withHooks() {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-model-settings-ipc-'));
    roots.push(directory);
    const store = new ModelSettingsStore(join(directory, 'model-settings.json'));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const offer = vi.fn(async () => ({ keepAlive: true as const }));
    const changed = vi.fn();
    registerModelSettingsIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      store,
      { offer, changed }
    );
    const call =
      (channel: string) =>
      (...args: unknown[]) =>
        handlers.get(channel)?.({ sender: {} }, ...args);
    return {
      offer,
      changed,
      set: call(IPC_CHANNELS.chatSetModelSettings),
      getOffer: call(IPC_CHANNELS.chatGetModelLoadOffer),
    };
  }

  it('tells main a model changed after a save, and not after a rejected one', async () => {
    const { set, changed } = await withHooks();
    expect(await set(QWEN, { draftTokens: 2, keepAlive: 3600 })).toEqual({ draftTokens: 2, keepAlive: 3600 });
    expect(changed).toHaveBeenCalledExactlyOnceWith(QWEN, true);
    expect(await set(QWEN, { draftTokens: 40 })).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('marks a save resized only when the context or draft tokens change', async () => {
    const { set, changed } = await withHooks();
    await set(QWEN, { context: { mode: 'auto' }, draftTokens: 2 });
    expect(changed).toHaveBeenLastCalledWith(QWEN, true);
    await set(QWEN, { context: { mode: 'auto' }, draftTokens: 2, keepAlive: 3600, generation: { temperature: 0.2 } });
    expect(changed).toHaveBeenLastCalledWith(QWEN, false);
    await set(QWEN, { context: { mode: 'auto', maxTokens: 32768 }, draftTokens: 2, keepAlive: 3600 });
    expect(changed).toHaveBeenLastCalledWith(QWEN, true);
    await set(QWEN, { context: { mode: 'auto', maxTokens: 32768 }, keepAlive: 3600 });
    expect(changed).toHaveBeenLastCalledWith(QWEN, true);
  });

  it('passes a valid draft count to the offer and drops an invalid one', async () => {
    const { getOffer, offer } = await withHooks();
    expect(await getOffer(QWEN, 3)).toEqual({ keepAlive: true });
    expect(offer).toHaveBeenLastCalledWith(QWEN, 3);
    await getOffer(QWEN, 99);
    expect(offer).toHaveBeenLastCalledWith(QWEN, undefined);
    expect(await getOffer('gpt-5', 3)).toBeNull();
    expect(offer).toHaveBeenCalledTimes(2);
  });
});

describe('modelSettingsChanged', () => {
  it('forgets the sized context only when resized, and always refreshes the model list and tells the renderer', () => {
    const calls: string[] = [];
    const changed = modelSettingsChanged({
      forgetContext: modelId => calls.push(`forget ${modelId}`),
      refreshModels: () => calls.push('refresh'),
      announce: () => calls.push('announce'),
    });
    changed(QWEN, true);
    expect(calls).toEqual([`forget ${QWEN}`, 'refresh', 'announce']);
    calls.length = 0;
    changed(QWEN, false);
    expect(calls).toEqual(['refresh', 'announce']);
  });
});
