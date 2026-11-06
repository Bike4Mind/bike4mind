import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelSavePatch } from '../utils/performModelSwitch.js';
import { ConfigStore } from './ConfigStore.js';

const signIn = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  userId: 'u',
};

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-invalid-config-'));
  configPath = path.join(dir, 'config.json');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('B4M_NO_PROJECT_CONFIG', '1');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const readJson = async () => JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;

describe('saving over a config this build cannot validate', () => {
  it('keeps a partial config and adds only the model a /model save chose', async () => {
    await writeFile(configPath, JSON.stringify({ auth: signIn }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    const config = await store.load();

    await store.save(modelSavePatch({ id: 'llama3.2' }, config, null));

    expect(await readJson()).toEqual({ auth: signIn, defaultModel: 'llama3.2' });
  });

  it('keeps an invalid value and unknown keys exactly, and adds the trusted tool to the saved list', async () => {
    const preferences = { theme: 'sepia', temperature: 0.4, autoSave: true, exportFormat: 'markdown' };
    const newerSetting = { level: 3, modes: ['a', 'b'] };
    await writeFile(
      configPath,
      JSON.stringify({ userId: 'user-1', defaultModel: 'm', preferences, trustedTools: ['web_search'], newerSetting }),
      { mode: 0o600 }
    );

    await new ConfigStore(configPath).trustTool('file_read');

    const file = await readJson();
    expect(JSON.stringify(file.preferences)).toBe(JSON.stringify(preferences));
    expect(JSON.stringify(file.newerSetting)).toBe(JSON.stringify(newerSetting));
    expect(file).toEqual({
      userId: 'user-1',
      defaultModel: 'm',
      preferences,
      trustedTools: ['web_search', 'file_read'],
      newerSetting,
    });
  });

  it('refuses a save over a file that does not hold a JSON object, and leaves it unchanged', async () => {
    await writeFile(configPath, '["not", "a", "config"]', { mode: 0o600 });

    await expect(new ConfigStore(configPath).save({ defaultModel: 'x' })).rejects.toThrow(
      `${configPath} failed validation`
    );
    expect(await readFile(configPath, 'utf-8')).toBe('["not", "a", "config"]');
  });
});
