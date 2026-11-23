import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { SpawnLocationPreference } from './SpawnLocationPreference';
import { registerSpawnLocationIpc } from './spawnLocationIpc';

async function setup() {
  const file = join(await mkdtemp(join(tmpdir(), 'b4m-spawn-location-ipc-')), 'spawn-location.json');
  const broadcast = vi.fn();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSpawnLocationIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    { preference: new SpawnLocationPreference(file), broadcast }
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args);
  return { file, broadcast, call };
}

describe('registerSpawnLocationIpc', () => {
  it('answers the default before anything is saved', async () => {
    const { call } = await setup();
    expect(await call(IPC_CHANNELS.chatGetSpawnLocation)).toBe('worktree');
  });

  it('saves a location and tells every window', async () => {
    const { file, broadcast, call } = await setup();
    expect(await call(IPC_CHANNELS.chatSetSpawnLocation, 'local')).toBe('local');
    expect(broadcast).toHaveBeenCalledWith('local');
    expect(await call(IPC_CHANNELS.chatGetSpawnLocation)).toBe('local');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ location: 'local' });
  });

  it.each([null, 'here', 42, { location: 'ask' }])(
    'reads garbage from the renderer as the default: %j',
    async input => {
      const { broadcast, call } = await setup();
      expect(await call(IPC_CHANNELS.chatSetSpawnLocation, input)).toBe('worktree');
      expect(broadcast).toHaveBeenCalledWith('worktree');
    }
  );
});
