import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from './ConfigStore';

describe('ConfigStore modelServerCredentials', () => {
  let configPath: string;

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    const dir = path.join(tmpdir(), `b4m-server-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    configPath = path.join(dir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
    delete process.env.B4M_NO_PROJECT_CONFIG;
  });

  const disk = async () => JSON.parse(await fs.readFile(configPath, 'utf-8'));

  it('saves a credential keyed by server id with the file readable only by the owner', async () => {
    const store = new ConfigStore(configPath);
    await store.setModelServerCredential('abc123', 'secret-one');
    expect((await disk()).modelServerCredentials).toEqual({ abc123: { secret: 'secret-one' } });
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await store.load()).modelServerCredentials).toEqual({ abc123: { secret: 'secret-one' } });
  });

  it('clears one credential and keeps the others', async () => {
    const store = new ConfigStore(configPath);
    await store.setModelServerCredential('a', 'one');
    await store.setModelServerCredential('b', 'two');
    await store.clearModelServerCredential('a');
    expect((await disk()).modelServerCredentials).toEqual({ b: { secret: 'two' } });
  });

  it('keeps a login made in another process when a running session saves something else', async () => {
    const session = new ConfigStore(configPath);
    await session.load();
    const other = new ConfigStore(configPath);
    await other.setModelServerCredential('abc123', 'from-other-terminal');

    await session.update({ preferences: { theme: 'light' } as never });
    expect((await disk()).modelServerCredentials).toEqual({ abc123: { secret: 'from-other-terminal' } });

    await session.save();
    expect((await disk()).modelServerCredentials).toEqual({ abc123: { secret: 'from-other-terminal' } });
  });

  it('keeps auth another process wrote between load and a credential write', async () => {
    await new ConfigStore(configPath).setModelServerCredential('seed', 'seed-secret');
    const session = new ConfigStore(configPath);
    await session.load();
    const raw = await disk();
    const refreshed = {
      accessToken: 'refreshed-elsewhere',
      refreshToken: 'r',
      expiresAt: '2099-01-01T00:00:00.000Z',
      userId: 'u1',
    };
    await fs.writeFile(configPath, JSON.stringify({ ...raw, auth: refreshed }));

    await session.setModelServerCredential('abc123', 'secret-one');
    const after = await disk();
    expect(after.auth).toEqual(refreshed);
    expect(after.modelServerCredentials).toEqual({
      seed: { secret: 'seed-secret' },
      abc123: { secret: 'secret-one' },
    });
  });

  it('merges a login against credentials another process saved since load', async () => {
    const session = new ConfigStore(configPath);
    await session.load();
    const other = new ConfigStore(configPath);
    await other.setModelServerCredential('a', 'one');

    await session.setModelServerCredential('b', 'two');
    expect((await disk()).modelServerCredentials).toEqual({ a: { secret: 'one' }, b: { secret: 'two' } });
  });
});
