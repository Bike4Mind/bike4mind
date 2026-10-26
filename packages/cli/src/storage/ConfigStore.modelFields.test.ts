/**
 * defaultModel and ollamaHost written by `b4m models` in another process must survive a save from a
 * session that loaded the config earlier.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from './ConfigStore';

describe('ConfigStore defaultModel and ollamaHost across processes', () => {
  let configPath: string;

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    const dir = path.join(tmpdir(), `b4m-model-fields-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    configPath = path.join(dir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
    delete process.env.B4M_NO_PROJECT_CONFIG;
  });

  const disk = async () => JSON.parse(await fs.readFile(configPath, 'utf-8'));

  async function sessionThenModels(patch: { defaultModel?: string; ollamaHost?: string }) {
    const session = new ConfigStore(configPath);
    await session.load();
    const models = new ConfigStore(configPath);
    await models.load();
    await models.update(patch);
    return session;
  }

  it('keeps values another process saved when the session saves something else', async () => {
    const session = await sessionThenModels({ defaultModel: 'qwen2.5:0.5b', ollamaHost: 'http://127.0.0.1:11630' });

    await session.update({ preferences: { theme: 'light' } as never });
    expect(await disk()).toMatchObject({ defaultModel: 'qwen2.5:0.5b', ollamaHost: 'http://127.0.0.1:11630' });

    await session.save();
    expect(await disk()).toMatchObject({ defaultModel: 'qwen2.5:0.5b', ollamaHost: 'http://127.0.0.1:11630' });
  });

  it("keeps the session's own change to either field", async () => {
    const session = await sessionThenModels({ defaultModel: 'qwen2.5:0.5b', ollamaHost: 'http://127.0.0.1:11630' });

    await session.update({ defaultModel: 'hosted-model', ollamaHost: 'http://gpu-box:11434' });
    expect(await disk()).toMatchObject({ defaultModel: 'hosted-model', ollamaHost: 'http://gpu-box:11434' });

    await session.update({ ollamaHost: undefined });
    expect(await disk()).not.toHaveProperty('ollamaHost');
  });

  it('keeps a host another process cleared', async () => {
    const first = new ConfigStore(configPath);
    await first.load();
    await first.update({ ollamaHost: 'http://127.0.0.1:11630' });

    const session = new ConfigStore(configPath);
    await session.load();
    await first.update({ ollamaHost: undefined });

    await session.update({ preferences: { theme: 'dark' } as never });
    expect(await disk()).not.toHaveProperty('ollamaHost');
  });
});
