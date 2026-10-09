import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from './ConfigStore';

async function writeGlobalConfig(configPath: string, preferences: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: '0.1.0',
      userId: 'test-user',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpServers: [],
      preferences: { temperature: 0.7, autoSave: true, theme: 'dark', exportFormat: 'markdown', ...preferences },
      // An incomplete `tools` makes load() reject the whole file and fall back
      // to defaults, which would make the "off by default" case pass vacuously.
      tools: { enabled: [], disabled: [], config: {} },
    }),
    'utf-8'
  );
}

describe('ConfigStore - postEditDiagnostics preference', () => {
  let configPath: string;

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-diagnostics-test-'));
    configPath = path.join(dir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
    delete process.env.B4M_NO_PROJECT_CONFIG;
  });

  it('is off when the global config does not set it', async () => {
    await writeGlobalConfig(configPath, {});

    const config = await new ConfigStore(configPath).get();

    expect(config.preferences.postEditDiagnostics).toBe(false);
  });

  it('survives a load when enabled in the global config', async () => {
    await writeGlobalConfig(configPath, { postEditDiagnostics: true });

    const config = await new ConfigStore(configPath).get();

    expect(config.preferences.postEditDiagnostics).toBe(true);
  });
});
