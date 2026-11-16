/**
 * The default model and its one-time move off the deprecated Sonnet 4.5 default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ChatModels } from '@bike4mind/common';
import { ConfigStore } from './ConfigStore';

async function makeTempConfigPath(): Promise<string> {
  const dir = path.join(tmpdir(), `b4m-defaultmodel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

async function writeConfig(
  configPath: string,
  fields: { version: string; defaultModel: string; maxTokens?: number }
): Promise<void> {
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: fields.version,
      userId: 'test-user',
      defaultModel: fields.defaultModel,
      mcpServers: [],
      preferences: {
        temperature: 0.7,
        autoSave: true,
        theme: 'dark',
        exportFormat: 'markdown',
        maxIterations: 10,
        ...(fields.maxTokens === undefined ? {} : { maxTokens: fields.maxTokens }),
      },
      // Required by CliConfigSchema - without it load() falls back to defaults and the
      // assertions below would pass vacuously.
      tools: { enabled: [], disabled: [], config: {} },
    }),
    'utf-8'
  );
}

describe('ConfigStore - default model', () => {
  let configPath: string;

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    configPath = await makeTempConfigPath();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true }).catch(() => {});
    delete process.env.B4M_NO_PROJECT_CONFIG;
  });

  it('defaults a fresh config to Sonnet 5.5', async () => {
    const config = await new ConfigStore(configPath).get();

    expect(config.defaultModel).toBe(ChatModels.CLAUDE_5_5_SONNET);
  });

  it('moves a saved Sonnet 4.5 default to Sonnet 5.5 and persists it', async () => {
    await writeConfig(configPath, { version: '0.2.0', defaultModel: ChatModels.CLAUDE_4_5_SONNET });

    const config = await new ConfigStore(configPath).get();

    expect(config.userId).toBe('test-user');
    expect(config.defaultModel).toBe(ChatModels.CLAUDE_5_5_SONNET);
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(onDisk.defaultModel).toBe(ChatModels.CLAUDE_5_5_SONNET);
  });

  it('keeps any other saved default model', async () => {
    await writeConfig(configPath, { version: '0.2.0', defaultModel: ChatModels.CLAUDE_4_5_HAIKU });

    const config = await new ConfigStore(configPath).get();

    expect(config.userId).toBe('test-user');
    expect(config.defaultModel).toBe(ChatModels.CLAUDE_4_5_HAIKU);
  });

  it('runs once, so Sonnet 4.5 chosen after the migration survives a reload', async () => {
    await writeConfig(configPath, { version: '0.2.0', defaultModel: ChatModels.CLAUDE_4_5_SONNET });
    await new ConfigStore(configPath).get();

    await new ConfigStore(configPath).update({ defaultModel: ChatModels.CLAUDE_4_5_SONNET });

    expect((await new ConfigStore(configPath).get()).defaultModel).toBe(ChatModels.CLAUDE_4_5_SONNET);
  });

  it('does not re-run the 0.2.0 output-budget cleanup on a 0.2.0 file', async () => {
    await writeConfig(configPath, {
      version: '0.2.0',
      defaultModel: ChatModels.CLAUDE_4_5_HAIKU,
      maxTokens: 4096,
    });

    const config = await new ConfigStore(configPath).get();

    expect(config.userId).toBe('test-user');
    expect(config.preferences.maxTokens).toBe(4096);
  });
});
