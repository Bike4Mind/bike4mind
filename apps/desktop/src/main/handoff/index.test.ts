import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth';

const h = vi.hoisted(() => ({
  handler: null as null | (() => Promise<void>),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  authListeners: [] as Array<(state: { status: string }) => void>,
}));
vi.mock('../auth', () => ({
  onAuthStateChanged: (listener: (state: { status: string }) => void) => {
    h.authListeners.push(listener);
    return () => {};
  },
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: () => Promise<void>) => {
      if (channel === 'handoff:open-server-sessions') h.handler = handler;
    },
  },
  shell: { openExternal: h.openExternal },
}));
import { purgeLegacyWebPartitions, registerSessionHandoff, webAppUrlFor } from './index';

const authFor = (state: unknown) => ({ getState: () => state }) as unknown as AuthService;
const signedInAt = (url: string) => ({ status: 'signed-in', environment: { url }, user: { id: 'user' } });

let userDataDir = '';

const open = async (state: unknown) => {
  registerSessionHandoff(authFor(state), userDataDir);
  if (!h.handler) throw new Error('Handoff IPC was not registered');
  await h.handler();
};

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'b4m-handoff-'));
  h.authListeners.length = 0;
  h.handler = null;
  h.openExternal.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

const seedPartition = (name: string) => {
  const dir = join(userDataDir, 'Partitions', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Cookies'), 'cookie');
  return dir;
};

describe('purgeLegacyWebPartitions', () => {
  it('removes the web-window partitions earlier builds left behind and keeps the rest', async () => {
    const legacy = seedPartition('server-conversations-0123abcd');
    const other = seedPartition('something-else');
    await purgeLegacyWebPartitions(userDataDir);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('does nothing when there is no Partitions directory', async () => {
    await expect(purgeLegacyWebPartitions(userDataDir)).resolves.toBeUndefined();
  });

  it('runs at startup and again on sign-out', async () => {
    const first = seedPartition('server-conversations-aaaa');
    registerSessionHandoff(authFor(signedInAt('https://app.example.test')), userDataDir);
    await vi.waitFor(() => expect(existsSync(first)).toBe(false));

    const second = seedPartition('server-conversations-bbbb');
    for (const listener of h.authListeners) listener({ status: 'signed-in' });
    expect(existsSync(second)).toBe(true);
    for (const listener of h.authListeners) listener({ status: 'signed-out' });
    await vi.waitFor(() => expect(existsSync(second)).toBe(false));
  });
});

describe('webAppUrlFor', () => {
  it.each([
    ['https://app.bike4mind.com', 'https://app.bike4mind.com/notebooks'],
    ['https://staging.example.test/', 'https://staging.example.test/notebooks'],
    ['https://pr-123.preview.example.test:8443', 'https://pr-123.preview.example.test:8443/notebooks'],
    ['http://localhost:3000', 'http://localhost:3000/notebooks'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000/notebooks'],
    ['http://[::1]:3000', 'http://[::1]:3000/notebooks'],
  ])('opens %s at %s', (environmentUrl, expected) => {
    expect(webAppUrlFor(environmentUrl)).toBe(expected);
  });

  it('keeps only the origin of the environment url', () => {
    expect(webAppUrlFor('https://user:secret@app.example.test/api/v1?x=1#y')).toBe(
      'https://app.example.test/notebooks'
    );
  });

  it.each([
    'http://app.example.test',
    'http://localhost.example.test',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://app.example.test',
    'not a url',
    '',
  ])('refuses %s', environmentUrl => {
    expect(webAppUrlFor(environmentUrl)).toBeNull();
  });
});

describe('registerSessionHandoff', () => {
  it('opens the web app for the signed-in environment in the default browser', async () => {
    await open(signedInAt('https://app.example.test'));
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith('https://app.example.test/notebooks');
  });

  it('follows the environment the user is signed in to at click time', async () => {
    let state = signedInAt('https://app.example.test');
    registerSessionHandoff({ getState: () => state } as unknown as AuthService, userDataDir);
    state = signedInAt('https://staging.example.test');
    await h.handler?.();
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith('https://staging.example.test/notebooks');
  });

  it('opens nothing when signed out', async () => {
    await open({ status: 'signed-out', environment: { url: 'https://app.example.test' } });
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('opens nothing for an environment url that fails validation', async () => {
    await open(signedInAt('http://app.example.test'));
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
