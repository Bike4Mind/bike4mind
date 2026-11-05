import { promises as fsPromises } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hang, json, startFakeServer, type FakeServer, type Handler } from '@bike4mind/local-models/testing';
import { ConfigStore } from '../storage/ConfigStore.js';
import { ApiClient } from './ApiClient.js';
import { checkSavedSignIn, settleSignInRefresh, startupMode, type SavedSignIn } from './savedSignIn.js';

const HOUR = 3_600_000;
const stale = {
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
  userId: 'u1',
};

let dir: string;
let configPath: string;
let server: FakeServer | null = null;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-saved-sign-in-'));
  configPath = path.join(dir, 'config.json');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('B4M_NO_PROJECT_CONFIG', '1');
});

afterEach(async () => {
  await server?.close();
  server = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function savedStore(tokens: typeof stale | null = stale): Promise<ConfigStore> {
  const store = new ConfigStore(configPath);
  if (tokens) await store.setAuthTokens(tokens);
  return new ConfigStore(configPath);
}

async function refreshServer(handler: Handler): Promise<string> {
  server = await startFakeServer({ 'POST /api/oauth/refresh': handler });
  return server.baseUrl;
}

/** The startup check as the CLI runs it: the shared refresh path of an ApiClient on `baseUrl`. */
const check = (store: ConfigStore, baseUrl: string, timeoutMs?: number) =>
  checkSavedSignIn(store, rejected => new ApiClient(baseUrl, store).refreshSession(rejected), timeoutMs);

const onDisk = async () => (JSON.parse(await readFile(configPath, 'utf-8')) as { auth?: typeof stale }).auth ?? null;

/** Starts `other` (another process's write) just before the first rename of a new config file into place. */
function interleaveFirstConfigWrite(other: () => Promise<unknown>): { done: () => Promise<void> } {
  const realRename = fsPromises.rename.bind(fsPromises);
  let started: Promise<unknown> | null = null;
  vi.spyOn(fsPromises, 'rename').mockImplementation((async (...args: Parameters<typeof realRename>) => {
    if (!started && String(args[1]).endsWith('config.json')) {
      started = other();
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return realRename(...args);
  }) as typeof fsPromises.rename);
  return {
    done: async () => {
      await started;
      vi.mocked(fsPromises.rename).mockRestore();
    },
  };
}

describe('checkSavedSignIn', () => {
  it('is signed out with no saved sign-in, and asks nothing', async () => {
    const refresh = vi.fn();
    expect(await checkSavedSignIn(await savedStore(null), refresh)).toEqual({ status: 'signed-out' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('is signed in on an unexpired access token, and asks nothing', async () => {
    const tokens = { ...stale, expiresAt: new Date(Date.now() + HOUR).toISOString() };
    const refresh = vi.fn();
    expect(await checkSavedSignIn(await savedStore(tokens), refresh)).toEqual({ status: 'signed-in', tokens });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token and stays signed in on the new tokens', async () => {
    const baseUrl = await refreshServer(
      json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 1800, token_type: 'Bearer' })
    );

    const result = await check(await savedStore(), baseUrl);

    expect(result).toMatchObject({ status: 'signed-in', tokens: { accessToken: 'access-new' } });
    expect(await onDisk()).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new' });
  });

  it('ends the sign-in and clears it when the server rejects the refresh token', async () => {
    const baseUrl = await refreshServer(json({ error: 'invalid_grant' }, 400));

    expect(await check(await savedStore(), baseUrl)).toEqual({ status: 'expired' });
    expect(await onDisk()).toBeNull();
  });

  it('keeps a sign-in another b4m process refreshed while this one was rejected', async () => {
    const other = {
      ...stale,
      accessToken: 'access-other',
      refreshToken: 'refresh-other',
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    };
    const store = await savedStore();
    await store.getAuthTokens();
    const baseUrl = await refreshServer(async (request, response) => {
      await new ConfigStore(configPath).setAuthTokens(other);
      json({ error: 'invalid_grant' }, 400)(request, response);
    });

    expect(await check(store, baseUrl)).toEqual({ status: 'signed-in', tokens: other });
    expect(await onDisk()).toEqual(other);
  });

  it('keeps the tokens and says why when the refresh cannot complete', async () => {
    const baseUrl = await refreshServer(json({ error: 'unavailable' }, 503));

    const result = await check(await savedStore(), baseUrl);

    expect(result).toMatchObject({ status: 'unchecked', reason: expect.stringContaining('503') });
    expect(await onDisk()).toEqual(stale);
  });

  it('shares one refresh between the startup checks of one process', async () => {
    const fresh = { ...stale, accessToken: 'access-new', expiresAt: new Date(Date.now() + HOUR).toISOString() };
    const refresh = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return fresh;
    });
    const store = await savedStore();

    const results = await Promise.all([checkSavedSignIn(store, refresh), checkSavedSignIn(store, refresh)]);

    expect(results).toEqual([
      { status: 'signed-in', tokens: fresh },
      { status: 'signed-in', tokens: fresh },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('lets exit wait for a refresh that outlived the startup wait', async () => {
    let finished = false;
    const refresh = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      finished = true;
      return stale;
    });

    expect(await checkSavedSignIn(await savedStore(), refresh, 20)).toMatchObject({ status: 'unchecked' });
    expect(finished).toBe(false);
    const said: string[] = [];
    await settleSignInRefresh(5_000, line => said.push(line));
    expect(finished).toBe(true);
    expect(said).toEqual([expect.stringContaining('sign-in refresh')]);

    await settleSignInRefresh(5_000, line => said.push(line));
    expect(said).toHaveLength(1);
  });

  it('stops waiting at exit, after the bound, on a refresh that never settles', async () => {
    let settle!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<typeof stale>(resolve => {
          settle = () => resolve(stale);
        })
    );
    await checkSavedSignIn(await savedStore(), refresh, 20);
    const started = performance.now();

    await settleSignInRefresh(100, () => {});

    expect(performance.now() - started).toBeLessThan(1_000);
    settle();
    await settleSignInRefresh(1_000, () => {});
  });

  it('stops waiting on a refresh that never answers and keeps the tokens', async () => {
    const baseUrl = await refreshServer(hang);
    const started = performance.now();

    const result = await check(await savedStore(), baseUrl, 200);

    expect(result).toMatchObject({ status: 'unchecked', reason: expect.stringContaining('no answer') });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await onDisk()).toEqual(stale);
  });
});

describe('startupMode', () => {
  const statuses: [string, SavedSignIn][] = [
    ['signed-out', { status: 'signed-out' }],
    ['expired', { status: 'expired' }],
    ['unchecked', { status: 'unchecked', reason: 'timed out' }],
  ];

  it('stays on the sign-in when it is valid, whether or not local models answer', () => {
    const signedIn: SavedSignIn = { status: 'signed-in', tokens: stale };
    expect(startupMode(signedIn, true)).toBe('signed-in');
    expect(startupMode(signedIn, false)).toBe('signed-in');
  });

  it.each(statuses)('chats on local models when %s and one answers', (_label, signIn) => {
    expect(startupMode(signIn, true)).toBe('local');
  });

  it.each(statuses)('opens the sign-in flow when %s and none answers', (_label, signIn) => {
    expect(startupMode(signIn, false)).toBe('sign-in');
  });
});

describe('ConfigStore.reloadAuthTokens', () => {
  it('returns what another process saved since this store loaded, and serves it from then on', async () => {
    const store = await savedStore();
    await store.getAuthTokens();
    const other = { ...stale, accessToken: 'access-other' };
    await new ConfigStore(configPath).setAuthTokens(other);

    expect(await store.reloadAuthTokens()).toEqual(other);
    expect(await store.getAuthTokens()).toEqual(other);
  });

  it('returns null once another process signed out', async () => {
    const store = await savedStore();
    await store.getAuthTokens();
    await new ConfigStore(configPath).clearAuthTokens();

    expect(await store.reloadAuthTokens()).toBeNull();
  });

  it('rejects, naming the file, when the saved sign-in cannot be read', async () => {
    const store = await savedStore();
    await store.getAuthTokens();
    await writeFile(configPath, '{ not json');

    await expect(store.reloadAuthTokens()).rejects.toThrow(configPath);
  });

  it('never echoes the file contents when it is not JSON', async () => {
    const store = await savedStore();
    await store.getAuthTokens();
    await writeFile(configPath, '{"auth":{"accessToken":secret-token-123}}');

    const error = await store.reloadAuthTokens().catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(configPath);
    expect((error as Error).message).not.toContain('secret');
  });

  it("never hands this environment another environment's sign-in", async () => {
    const custom = { ...stale, accessToken: 'access-custom', refreshToken: 'refresh-custom' };
    const prod = { ...stale, accessToken: 'access-prod', refreshToken: 'refresh-prod' };
    const setup = new ConfigStore(configPath);
    await setup.setCustomApiUrl('https://self-hosted.example.com');
    await setup.setAuthTokens(custom);
    const store = new ConfigStore(configPath);
    await store.getAuthTokens();

    const other = new ConfigStore(configPath);
    await other.switchApiEnvironment('prod');
    await other.setAuthTokens(prod);

    expect(await store.reloadAuthTokens()).toEqual(custom);
    expect(await store.getAuthTokens()).toEqual(custom);

    const cleared = JSON.parse(await readFile(configPath, 'utf-8'));
    delete cleared.authByEnv;
    await writeFile(configPath, JSON.stringify(cleared));
    expect(await store.reloadAuthTokens()).toBeNull();
  });

  it('keeps a sign-in saved while the file was being re-read', async () => {
    const store = await savedStore();
    await store.getAuthTokens();
    const before = await readFile(configPath, 'utf-8');
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const realRead = fsPromises.readFile.bind(fsPromises);
    let held = false;
    vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      if (!held && String(args[0]) === configPath) {
        held = true;
        await gate;
        return before;
      }
      return realRead(...args);
    }) as typeof fsPromises.readFile);
    const fresh = { ...stale, accessToken: 'access-fresh', refreshToken: 'refresh-fresh' };

    const reloading = store.reloadAuthTokens();
    await vi.waitFor(() => expect(held).toBe(true));
    const saving = store.setAuthTokens(fresh);
    release();
    await Promise.all([reloading, saving]);
    vi.mocked(fsPromises.readFile).mockRestore();
    await store.save({});

    expect(await store.getAuthTokens()).toEqual(fresh);
    expect(await onDisk()).toEqual(fresh);
  });
});

describe('ConfigStore writes within one process', () => {
  const fresh = { ...stale, accessToken: 'access-fresh', refreshToken: 'refresh-fresh' };

  it('keeps a sign-in saved alongside a settings save', async () => {
    for (let run = 0; run < 10; run++) {
      const store = await savedStore();
      await store.getAuthTokens();

      await Promise.all([store.save({ defaultModel: `model-${run}` }), store.setAuthTokens(fresh)]);

      const file = JSON.parse(await readFile(configPath, 'utf-8')) as { auth?: unknown; defaultModel?: string };
      expect(file.auth).toEqual(fresh);
      expect(file.defaultModel).toBe(`model-${run}`);
      expect(await store.getAuthTokens()).toEqual(fresh);
    }
  });

  it('does not re-read the file while a sign-in is being written to it', async () => {
    const store = await savedStore();
    await store.getAuthTokens();
    const before = await readFile(configPath, 'utf-8');
    const realRename = fsPromises.rename.bind(fsPromises);
    const realRead = fsPromises.readFile.bind(fsPromises);
    let renaming = false;
    let releaseRename!: () => void;
    const renameGate = new Promise<void>(resolve => (releaseRename = resolve));
    let saved!: () => void;
    const savedGate = new Promise<void>(resolve => (saved = resolve));
    vi.spyOn(fsPromises, 'rename').mockImplementation((async (...args: Parameters<typeof realRename>) => {
      if (String(args[1]).endsWith('config.json')) {
        renaming = true;
        await renameGate;
      }
      return realRename(...args);
    }) as typeof fsPromises.rename);
    vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      // A read that starts before the rename lands sees the old file, however late it returns.
      if (renaming && String(args[0]) === configPath) {
        await savedGate;
        return before;
      }
      return realRead(...args);
    }) as typeof fsPromises.readFile);

    const saving = store.setAuthTokens(fresh);
    await vi.waitFor(() => expect(renaming).toBe(true));
    const reloading = store.reloadAuthTokens();
    await new Promise(resolve => setTimeout(resolve, 20));
    renaming = false;
    releaseRename();
    await saving;
    saved();
    await reloading;
    vi.restoreAllMocks();

    expect(await store.getAuthTokens()).toEqual(fresh);
  });
});

describe('ConfigStore saves across processes', () => {
  const newer = { ...stale, accessToken: 'access-newer', refreshToken: 'refresh-newer' };

  it('keeps a sign-in another process saved when a signed-out process saves its settings', async () => {
    const signedOut = new ConfigStore(configPath);
    await signedOut.load();
    await new ConfigStore(configPath).setAuthTokens(newer);

    await signedOut.save({ defaultModel: 'local-model' });

    const file = JSON.parse(await readFile(configPath, 'utf-8')) as { auth?: unknown; defaultModel?: string };
    expect(file.auth).toEqual(newer);
    expect(file.defaultModel).toBe('local-model');
  });

  it('keeps the newer refresh token another process saved when this one saves with an older one', async () => {
    const store = await savedStore();
    expect(await store.getAuthTokens()).toEqual(stale);
    await new ConfigStore(configPath).setAuthTokens(newer);

    await store.trustTool('bash');

    expect(await onDisk()).toEqual(newer);
  });

  it('switches backend from the sign-in the file holds, not the one this process loaded', async () => {
    const store = new ConfigStore(configPath);
    await store.load();
    await new ConfigStore(configPath).setAuthTokens(newer);

    await store.switchApiEnvironment('dev');

    const file = JSON.parse(await readFile(configPath, 'utf-8')) as { auth?: unknown; authByEnv?: object };
    expect(file.auth).toBeUndefined();
    expect(Object.values(file.authByEnv ?? {})).toContainEqual(newer);
  });

  it('refuses to save a sign-in over a file that does not hold a JSON object, and leaves it as it was', async () => {
    for (const contents of ['[]', 'null', '"x"', '42']) {
      await rm(configPath, { force: true });
      const store = await savedStore();
      await store.getAuthTokens();
      await writeFile(configPath, contents);

      await expect(store.setAuthTokens(newer)).rejects.toThrow(configPath);
      expect(await readFile(configPath, 'utf-8')).toBe(contents);
    }
  });

  it('clears on a rejected refresh only while the file still holds the rejected token', async () => {
    const store = await savedStore();
    await store.getAuthTokens();
    await new ConfigStore(configPath).setAuthTokens(newer);

    expect(await store.clearAuthTokens(stale.refreshToken)).toBe(false);
    expect(await onDisk()).toEqual(newer);

    expect(await store.clearAuthTokens(newer.refreshToken)).toBe(true);
    expect(await onDisk()).toBeNull();
  });

  it('keeps a sign-in another process saves while this one is writing its settings', async () => {
    const mine = await savedStore();
    await mine.getAuthTokens();
    const theirs = new ConfigStore(configPath);
    await theirs.getAuthTokens();
    const theirSave = interleaveFirstConfigWrite(() => theirs.setAuthTokens(newer));

    await mine.save({ defaultModel: 'x' });
    await theirSave.done();

    expect(await onDisk()).toEqual(newer);
  });

  it('keeps a sign-in another process saves while this one is switching backend', async () => {
    const mine = await savedStore();
    await mine.getAuthTokens();
    const theirs = new ConfigStore(configPath);
    await theirs.getAuthTokens();
    const theirSave = interleaveFirstConfigWrite(() => theirs.setAuthTokens(newer));

    await mine.switchApiEnvironment('dev');
    await theirSave.done();

    const file = JSON.parse(await readFile(configPath, 'utf-8')) as { auth?: unknown; authByEnv?: object };
    expect(file.auth).toBeUndefined();
    expect(Object.values(file.authByEnv ?? {})).toEqual([newer]);
  });

  it('does not save a refreshed sign-in over a logout that landed after the refresh checked the file', async () => {
    const mine = await savedStore();
    await mine.getAuthTokens();
    const theirs = new ConfigStore(configPath);
    await theirs.getAuthTokens();
    const baseUrl = await refreshServer(
      json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 1800, token_type: 'Bearer' })
    );
    const reload = mine.reloadAuthTokens.bind(mine);
    let loggedOut = false;
    vi.spyOn(mine, 'reloadAuthTokens').mockImplementation(async () => {
      const read = await reload();
      // The read after the exchange answered is the refresh's last check; the logout lands right after it.
      if (!loggedOut && (server?.requests.length ?? 0) > 0) {
        loggedOut = true;
        await theirs.clearAuthTokens();
      }
      return read;
    });

    await expect(new ApiClient(baseUrl, mine).refreshSession(stale.accessToken)).rejects.toThrow();

    expect(loggedOut).toBe(true);
    expect(await onDisk()).toBeNull();
  });

  it('refuses to save settings over a file it could not read, keeping the sign-in on it', async () => {
    const mine = await savedStore();
    await mine.getAuthTokens();
    await new ConfigStore(configPath).setAuthTokens(newer);
    const realRead = fsPromises.readFile.bind(fsPromises);
    vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      if (String(args[0]) === configPath) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      return realRead(...args);
    }) as typeof fsPromises.readFile);

    await expect(mine.save({ defaultModel: 'x' })).rejects.toThrow(configPath);
    vi.mocked(fsPromises.readFile).mockRestore();

    expect(await onDisk()).toEqual(newer);
  });

  it('finishes a sign-in save before a model server credential reloads the config', async () => {
    const store = await savedStore();
    await store.getAuthTokens();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => (releaseSecond = resolve));
    const realRead = fsPromises.readFile.bind(fsPromises);
    let reads = 0;
    vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      // Holds the sign-in save's read, then whatever read of the file comes next, so the two can overlap.
      if (String(args[0]) === configPath && ++reads <= 2) await (reads === 1 ? gate : secondGate);
      return realRead(...args);
    }) as typeof fsPromises.readFile);

    const saving = store.setAuthTokens(newer);
    await vi.waitFor(() => expect(reads).toBe(1));
    const crediting = store.setModelServerCredential('gpu-box', 'secret-1');
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseSecond();
    await Promise.all([saving, crediting]);
    vi.mocked(fsPromises.readFile).mockRestore();

    const file = JSON.parse(await readFile(configPath, 'utf-8')) as {
      auth?: unknown;
      modelServerCredentials?: Record<string, { secret: string }>;
    };
    expect(file.auth).toEqual(newer);
    expect(file.modelServerCredentials?.['gpu-box']).toEqual({ secret: 'secret-1' });
  });

  it('names the file but never echoes its contents when it is not JSON at load', async () => {
    await writeFile(configPath, '{"auth":{"accessToken":secret-token-123}}');
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});

    const error = await new ConfigStore(configPath).load().catch((e: Error) => e);

    expect((error as Error).message).toContain(configPath);
    expect((error as Error).message).toContain('not valid JSON');
    expect((error as Error).message).not.toContain('secret');
    expect(JSON.stringify(printed.mock.calls.map(call => call.map(String)))).not.toContain('secret');
    printed.mockRestore();
  });
});

describe('concurrent refreshes across b4m processes', () => {
  const lockPath = () => path.join(dir, 'auth-refresh.lock');

  it('end signed in on the one rotation when two processes refresh the same expired sign-in', async () => {
    await savedStore();
    let exchanges = 0;
    const baseUrl = await refreshServer(async (request, response) => {
      exchanges++;
      if (exchanges > 1) return json({ error: 'invalid_grant' }, 400)(request, response);
      await new Promise(resolve => setTimeout(resolve, 150));
      json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 1800, token_type: 'Bearer' })(
        request,
        response
      );
    });
    const first = new ConfigStore(configPath);
    const second = new ConfigStore(configPath);
    await first.getAuthTokens();
    await second.getAuthTokens();

    const results = await Promise.all([
      new ApiClient(baseUrl, first).refreshSession(stale.accessToken),
      new ApiClient(baseUrl, second).refreshSession(stale.accessToken),
    ]);

    expect(results.map(tokens => tokens.refreshToken)).toEqual(['refresh-new', 'refresh-new']);
    expect(exchanges).toBe(1);
    expect(await onDisk()).toMatchObject({ refreshToken: 'refresh-new' });
  });

  it('breaks a lock left behind longer than the stale limit', async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now() - 31_000, nonce: 'gone' }));

    expect(await new ConfigStore(configPath).withRefreshLock(async () => 'ran', 1_000)).toBe('ran');
    await expect(readFile(lockPath())).rejects.toThrow();
  });

  it('gives up after the wait bound, without running the work, while another process holds the lock', async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now(), nonce: 'other' }));
    const work = vi.fn(async () => 'ran');

    await expect(new ConfigStore(configPath).withRefreshLock(work, 300)).rejects.toThrow('still refreshing');
    expect(work).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(lockPath(), 'utf-8'))).toMatchObject({ nonce: 'other' });
  });

  it('breaks at once a fresh lock whose holder on this host has exited', async () => {
    const goneProcess = 2_147_483_646;
    await writeFile(
      lockPath(),
      JSON.stringify({ pid: goneProcess, hostname: os.hostname(), at: Date.now(), nonce: 'gone' })
    );

    expect(await new ConfigStore(configPath).withRefreshLock(async () => 'ran', 300)).toBe('ran');
  });

  it('stands down when another waiter took the lock it broke', async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now() - 31_000, nonce: 'gone' }));
    const work = vi.fn(async () => 'ran');

    const locking = new ConfigStore(configPath).withRefreshLock(work, 800);
    await vi.waitFor(
      async () => {
        const lock = JSON.parse(await readFile(lockPath(), 'utf-8')) as { nonce: string };
        expect(lock.nonce).not.toBe('gone');
      },
      { interval: 5 }
    );
    await writeFile(
      lockPath(),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: Date.now(), nonce: 'other' })
    );

    await expect(locking).rejects.toThrow('still refreshing');
    expect(work).not.toHaveBeenCalled();
  });

  it('stands down when a lock it just made is replaced before it confirmed it', async () => {
    const work = vi.fn(async () => 'ran');
    const realOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, 'open').mockImplementation((async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === lockPath()) {
        // Another process removes the new lock as stale and makes its own, as a racing breaker would.
        setTimeout(() => {
          void writeFile(
            lockPath(),
            JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: Date.now(), nonce: 'other' })
          );
        }, 20);
      }
      return handle;
    }) as typeof fsPromises.open);

    await expect(new ConfigStore(configPath).withRefreshLock(work, 400)).rejects.toThrow('still refreshing');
    expect(work).not.toHaveBeenCalled();
  });

  it('leaves in place a lock another process made while this one held it', async () => {
    const replaced = JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: Date.now(), nonce: 'other' });

    await new ConfigStore(configPath).withRefreshLock(async () => {
      await writeFile(lockPath(), replaced);
    }, 1_000);

    expect(await readFile(lockPath(), 'utf-8')).toBe(replaced);
  });

  it('keeps the lock it broke when re-reading it briefly fails', async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now() - 31_000, nonce: 'gone' }));
    const realRead = fsPromises.readFile.bind(fsPromises);
    let failed = false;
    vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      const text = await realRead(...args);
      if (!failed && String(args[0]) === lockPath() && !String(text).includes('"gone"')) {
        failed = true;
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      return text;
    }) as typeof fsPromises.readFile);

    try {
      expect(await new ConfigStore(configPath).withRefreshLock(async () => 'ran', 1_000)).toBe('ran');
      expect(failed).toBe(true);
    } finally {
      vi.mocked(fsPromises.readFile).mockRestore();
    }
  });

  it('on Windows, waits out a lock still being deleted instead of failing', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const realOpen = fsPromises.open.bind(fsPromises);
    const open = vi
      .spyOn(fsPromises, 'open')
      .mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))
      .mockImplementation(realOpen as typeof fsPromises.open);
    try {
      expect(await new ConfigStore(configPath).withRefreshLock(async () => 'ran', 1_000)).toBe('ran');
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('ConfigStore sign-in writes', () => {
  const prod = { ...stale, accessToken: 'access-prod-1', refreshToken: 'refresh-prod-1' };
  const dev = { ...stale, accessToken: 'access-dev', refreshToken: 'refresh-dev' };

  /** This process on the default backend; another one has since switched to dev and signed in there. */
  async function afterAnotherProcessSwitched(): Promise<{ mine: ConfigStore; theirs: ConfigStore }> {
    const mine = await savedStore();
    await mine.getAuthTokens();
    const theirs = new ConfigStore(configPath);
    await theirs.switchApiEnvironment('dev');
    await theirs.setAuthTokens(dev);
    return { mine, theirs };
  }

  it("saves only this backend's sign-in, keeping another process's backend and sign-in", async () => {
    const { mine, theirs } = await afterAnotherProcessSwitched();

    await mine.setAuthTokens(prod);

    const file = JSON.parse(await readFile(configPath, 'utf-8')) as { auth: unknown; authByEnv: object };
    expect(file.auth).toEqual(dev);
    expect(Object.values(file.authByEnv)).toContainEqual(prod);
    expect(await theirs.reloadAuthTokens()).toEqual(dev);
    expect(await mine.reloadAuthTokens()).toEqual(prod);
  });

  it("clears only this backend's sign-in", async () => {
    const { mine, theirs } = await afterAnotherProcessSwitched();

    await mine.clearAuthTokens();

    expect(await theirs.reloadAuthTokens()).toEqual(dev);
    expect(await mine.reloadAuthTokens()).toBeNull();
    expect(await mine.getAuthTokens()).toBeNull();
  });
});
