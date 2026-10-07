/**
 * `preferences.showThoughts` set by editing the config file must survive load.
 * The preferences schema is a plain z.object, which strips keys it does not
 * declare, so an undeclared preference only ever worked through the in-app
 * /config toggle and was silently dropped from the file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from './ConfigStore';

async function makeTempConfigPath(): Promise<string> {
  const dir = path.join(tmpdir(), `b4m-showthoughts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

async function writeConfig(configPath: string, preferences: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: '0.1.0',
      userId: 'test-user',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpServers: [],
      preferences: {
        temperature: 0.7,
        autoSave: true,
        theme: 'dark',
        exportFormat: 'markdown',
        maxIterations: 10,
        ...preferences,
      },
      tools: { enabled: [], disabled: [], config: {} },
    }),
    'utf-8'
  );
}

describe('ConfigStore - showThoughts preference', () => {
  let configPath: string;

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    configPath = await makeTempConfigPath();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true }).catch(() => {});
    delete process.env.B4M_NO_PROJECT_CONFIG;
  });

  it('keeps showThoughts: false written directly to the config file', async () => {
    await writeConfig(configPath, { showThoughts: false });

    const config = await new ConfigStore(configPath).get();

    // A rejected file falls back to defaults; this proves it was really loaded.
    expect(config.userId).toBe('test-user');
    expect(config.preferences.showThoughts).toBe(false);
  });

  it('leaves showThoughts unset when the file omits it, so the UI default applies', async () => {
    await writeConfig(configPath, {});

    const config = await new ConfigStore(configPath).get();

    expect(config.userId).toBe('test-user');
    expect(config.preferences.showThoughts).toBeUndefined();
  });
});
