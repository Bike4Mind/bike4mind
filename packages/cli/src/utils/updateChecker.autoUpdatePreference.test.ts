import { promises as fsPromises } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../storage/ConfigStore.js';
import { setAutoUpdatePreference } from './updateChecker.js';

const signIn = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  userId: 'u',
};

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-auto-update-'));
  configPath = path.join(dir, 'config.json');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('B4M_NO_PROJECT_CONFIG', '1');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('setAutoUpdatePreference on a real config file', () => {
  it('sets autoUpdate and keeps the rest of the config, sign-in included', async () => {
    const setup = new ConfigStore(configPath);
    await setup.save({ preferences: { theme: 'light' } });
    await setup.setAuthTokens(signIn);

    await setAutoUpdatePreference(false, configPath);

    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toMatchObject({
      auth: signIn,
      preferences: { theme: 'light', autoUpdate: false },
    });
  });

  it('leaves a config it could not read untouched', async () => {
    const contents = JSON.stringify({ auth: signIn, preferences: { theme: 'light' } });
    await writeFile(configPath, contents, { mode: 0o600 });
    const realRead = fsPromises.readFile.bind(fsPromises);
    vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      if (String(args[0]) === configPath) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      return realRead(...args);
    }) as typeof fsPromises.readFile);

    await setAutoUpdatePreference(true, configPath);
    vi.mocked(fsPromises.readFile).mockRestore();

    expect(await readFile(configPath, 'utf-8')).toBe(contents);
  });
});
