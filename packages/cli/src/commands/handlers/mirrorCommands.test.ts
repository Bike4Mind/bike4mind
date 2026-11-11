import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMirrorCommand } from './mirrorCommands.js';
import type { CommandContext } from '../types.js';
import type { MirrorStore } from '../../features/mirror/MirrorStore.js';

type Config = { auth?: { userId?: string }; apiConfig?: { customUrl?: string } };

const destination = {
  name: 'local',
  directory: '/tmp/bundle',
  paused: false,
  accountId: 'u1',
  apiUrl: 'https://example.test',
};

function makeCtx(config: Config): Pick<CommandContext, 'configStore'> {
  return { configStore: { get: vi.fn(async () => config) } } as unknown as Pick<CommandContext, 'configStore'>;
}

function makeStore(destinations: Array<Record<string, unknown>>): MirrorStore {
  return {
    add: vi.fn(),
    list: vi.fn(async () => destinations),
    pause: vi.fn(),
    revoke: vi.fn(),
  } as unknown as MirrorStore;
}

describe('/mirror', () => {
  let ctx: Pick<CommandContext, 'configStore'>;
  let store: MirrorStore;

  beforeEach(() => {
    ctx = makeCtx({ auth: { userId: 'u1' }, apiConfig: { customUrl: 'https://example.test' } });
    store = makeStore([{ ...destination }]);
  });

  it('configures a destination for the signed-in account', async () => {
    await runMirrorCommand(['add', 'local', '/tmp/bundle'], ctx, store);
    expect(store.add).toHaveBeenCalledWith({
      name: 'local',
      directory: '/tmp/bundle',
      accountId: 'u1',
      apiUrl: 'https://example.test',
    });
  });

  it('rejects add when signed out', async () => {
    ctx = makeCtx({ apiConfig: { customUrl: 'https://example.test' } });
    await expect(runMirrorCommand(['add', 'local', '/tmp/bundle'], ctx, store)).rejects.toThrow('Sign in');
    expect(store.add).not.toHaveBeenCalled();
  });

  it('rejects add when no endpoint is configured', async () => {
    ctx = makeCtx({ auth: { userId: 'u1' } });
    await expect(runMirrorCommand(['add', 'local', '/tmp/bundle'], ctx, store)).rejects.toThrow('Sign in');
    expect(store.add).not.toHaveBeenCalled();
  });

  it('reports unknown lag and the owning account, and refuses a pull', async () => {
    const output = await runMirrorCommand(['status'], ctx, store);
    expect(output).toContain('lag: unknown');
    expect(output).toContain('account u1');
    await expect(runMirrorCommand(['pull', 'local'], ctx, store)).rejects.toThrow('not available yet');
  });

  it('reports not found for an unknown pull destination', async () => {
    await expect(runMirrorCommand(['pull', 'other'], ctx, store)).rejects.toThrow('not found');
  });

  it('refuses to pull a paused destination', async () => {
    store = makeStore([{ ...destination, paused: true }]);
    await expect(runMirrorCommand(['pull', 'local'], ctx, store)).rejects.toThrow('paused');
  });

  it('refuses to pull a destination owned by a different account', async () => {
    store = makeStore([{ ...destination, accountId: 'u2' }]);
    await expect(runMirrorCommand(['pull', 'local'], ctx, store)).rejects.toThrow('different account');
  });

  it('rejects invalid destination names before touching the store', async () => {
    await expect(runMirrorCommand(['pause', 'my.dest'], ctx, store)).rejects.toThrow('Destination name must');
    await expect(runMirrorCommand(['pull', 'my.dest'], ctx, store)).rejects.toThrow('Destination name must');
    expect(store.pause).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });

  it('resumes by unpausing the destination', async () => {
    await runMirrorCommand(['resume', 'local'], ctx, store);
    expect(store.pause).toHaveBeenCalledWith('local', false);
  });

  it('falls back to usage for missing or unknown actions', async () => {
    expect(await runMirrorCommand([], ctx, store)).toContain('Usage: /mirror');
    expect(await runMirrorCommand(['bogus'], ctx, store)).toContain('Usage: /mirror');
  });

  it('strips terminal control sequences from a configured path in status', async () => {
    store = makeStore([{ ...destination, directory: '/tmp/\u001b[2Jbundle' }]);
    const output = await runMirrorCommand(['status'], ctx, store);
    expect(output).toContain('/tmp/bundle');
    expect(output).not.toContain('\u001b');
  });
});
