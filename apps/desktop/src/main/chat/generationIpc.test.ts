import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerGenerationIpc } from './generationIpc';
import { SessionStore } from './SessionStore';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-generation-ipc-'));
  roots.push(directory);
  const store = new SessionStore(directory, 'test-model');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerGenerationIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    { setSessionGeneration: (id, generation) => store.setGeneration(id, generation) }
  );
  const set = (...args: unknown[]) => handlers.get(IPC_CHANNELS.chatSetSessionGeneration)?.({ sender: {} }, ...args);
  const session = await store.create();
  await store.setGeneration(session.id, { temperature: 0.4, topK: 40 });
  return { store, set, id: session.id };
}

describe('registerGenerationIpc', () => {
  it('stores a valid set and clears on an empty one', async () => {
    const { store, set, id } = await setup();
    expect(await set(id, { topP: 0.9 })).toMatchObject({ id, generation: { topP: 0.9 } });
    await set(id, {});
    expect((await store.get(id))?.generation).toBeUndefined();
  });

  it.each([null, 'hot', { temperature: 50 }, { topK: 1e9 }, { temperature: 0.2, topP: '0.9' }, { temperatur: 0.5 }])(
    'leaves the stored overrides alone for %j',
    async generation => {
      const { store, set, id } = await setup();
      expect(await set(id, generation)).toBeNull();
      expect((await store.get(id))?.generation).toEqual({ temperature: 0.4, topK: 40 });
    }
  );

  it('answers null for a session id that is not a string', async () => {
    const { set } = await setup();
    expect(await set(42, { topP: 0.9 })).toBeNull();
  });
});
