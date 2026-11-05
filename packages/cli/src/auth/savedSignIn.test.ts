import { promises as fsPromises } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hang, json, startFakeServer, type FakeServer, type Handler } from '@bike4mind/local-models/testing';
import { ConfigStore } from '../storage/ConfigStore.js';
import { ApiClient } from './ApiClient.js';
import { checkSavedSignIn } from './savedSignIn.js';

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

  it('stops waiting on a refresh that never answers and keeps the tokens', async () => {
    const baseUrl = await refreshServer(hang);
    const started = performance.now();

    const result = await check(await savedStore(), baseUrl, 200);

    expect(result).toMatchObject({ status: 'unchecked', reason: expect.stringContaining('no answer') });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await onDisk()).toEqual(stale);
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
    await setup.save({ apiConfig: { customUrl: 'https://self-hosted.example.com', endpointChosen: true } });
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
    await store.setAuthTokens(fresh);
    release();
    await reloading;
    vi.mocked(fsPromises.readFile).mockRestore();
    await store.save({});

    expect(await store.getAuthTokens()).toEqual(fresh);
    expect(await onDisk()).toEqual(fresh);
  });
});
