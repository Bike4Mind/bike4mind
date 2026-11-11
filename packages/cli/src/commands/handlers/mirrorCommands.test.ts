import { describe, expect, it, vi } from 'vitest';
import { runMirrorCommand } from './mirrorCommands.js';
import type { CommandContext } from '../types.js';
import type { MirrorStore } from '../../features/mirror/MirrorStore.js';

describe('/mirror', () => {
  const ctx = {
    configStore: {
      get: vi.fn(async () => ({ auth: { userId: 'u1' }, apiConfig: { customUrl: 'https://example.test' } })),
    },
  } as unknown as Pick<CommandContext, 'configStore'>;
  const store = {
    add: vi.fn(),
    list: vi.fn(async () => [{ name: 'local', directory: '/tmp/bundle', paused: false, accountId: 'u1', apiUrl: 'https://example.test' }]),
    pause: vi.fn(),
    revoke: vi.fn(),
  } as unknown as MirrorStore;

  it('configures a destination for the signed-in account', async () => {
    await runMirrorCommand(['add', 'local', '/tmp/bundle'], ctx, store);
    expect(store.add).toHaveBeenCalledWith({
      name: 'local',
      directory: '/tmp/bundle',
      accountId: 'u1',
      apiUrl: 'https://example.test',
    });
  });

  it('reports unknown lag and refuses an unsafe pull', async () => {
    expect(await runMirrorCommand(['status'], ctx, store)).toContain('lag: unknown');
    await expect(runMirrorCommand(['pull', 'local'], ctx, store)).rejects.toThrow('not available yet');
  });

  it('strips terminal control sequences from a configured path in status', async () => {
    const hostileStore = {
      list: vi.fn(async () => [{ name: 'local', directory: '/tmp/\u001b[2Jbundle', paused: false, accountId: 'u1' }]),
    } as unknown as MirrorStore;
    const output = await runMirrorCommand(['status'], ctx, hostileStore);
    expect(output).toContain('/tmp/bundle');
    expect(output).not.toContain('\u001b');
  });
});
