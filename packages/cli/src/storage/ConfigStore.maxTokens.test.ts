/**
 * The output-budget preference and its legacy-value migration.
 *
 * `preferences.maxTokens` used to be required, defaulting to 4096. Because the CLI forwards
 * it verbatim, every install was silently telling the server "cap me at 4096 total" - which
 * starves models that spend reasoning tokens inside the output budget and truncates the
 * visible answer. Absent is now the default, and the legacy value is cleared on load so
 * machines that merely ran an older CLI are not stuck with it forever.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from './ConfigStore';

const LEGACY_PINNED_MAX_TOKENS = 4096;

async function makeTempConfigPath(): Promise<string> {
  const dir = path.join(tmpdir(), `b4m-maxtokens-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

/** Write a config file shaped like one an older CLI would have persisted. */
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
      // Required by CliConfigSchema - an incomplete `tools` makes load() reject the WHOLE
      // file and fall back to defaults, which would make every assertion below pass
      // vacuously.
      tools: { enabled: [], disabled: [], config: {} },
    }),
    'utf-8'
  );
}

describe('ConfigStore - output budget preference', () => {
  let configPath: string;

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    configPath = await makeTempConfigPath();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true }).catch(() => {});
    delete process.env.B4M_NO_PROJECT_CONFIG;
  });

  it('leaves maxTokens unset on a fresh config so the server sizes it', async () => {
    const store = new ConfigStore(configPath);
    const config = await store.get();

    expect(config.preferences.maxTokens).toBeUndefined();
  });

  it('clears the legacy pinned 4096 from an existing config', async () => {
    await writeConfig(configPath, { maxTokens: LEGACY_PINNED_MAX_TOKENS });
    const store = new ConfigStore(configPath);

    const config = await store.get();

    // Proves the file was really loaded: a rejected config falls back to defaults, under
    // which maxTokens is ALSO undefined and this test would pass having tested nothing.
    expect(config.userId).toBe('test-user');
    // The whole point: an install that never chose 4096 stops being capped by it.
    expect(config.preferences.maxTokens).toBeUndefined();
  });

  it('preserves a budget the user actually chose', async () => {
    await writeConfig(configPath, { maxTokens: 32000 });
    const store = new ConfigStore(configPath);

    const config = await store.get();

    expect(config.userId).toBe('test-user');
    expect(config.preferences.maxTokens).toBe(32000);
  });

  it('accepts an explicitly unset budget without substituting a default', async () => {
    await writeConfig(configPath, {});
    const store = new ConfigStore(configPath);

    const config = await store.get();

    expect(config.userId).toBe('test-user');
    expect(config.preferences.maxTokens).toBeUndefined();
    // Neighbouring preferences must survive the migration untouched.
    expect(config.preferences.temperature).toBe(0.7);
  });

  // The migration rewrites the file, so it is a one-time cleanup rather than a standing
  // rule that 4096 is unrepresentable - otherwise a user who deliberately picks the value
  // the /config select still offers would silently lose it on every restart.
  it('runs once, so a 4096 chosen after the migration survives a reload', async () => {
    await writeConfig(configPath, { maxTokens: LEGACY_PINNED_MAX_TOKENS });
    expect((await new ConfigStore(configPath).get()).preferences.maxTokens).toBeUndefined();

    // The legacy value is gone from disk, not just from the in-memory copy.
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(onDisk.preferences.maxTokens).toBeUndefined();
    expect(onDisk.userId).toBe('test-user');

    const chooser = new ConfigStore(configPath);
    await chooser.update({
      preferences: { ...(await chooser.get()).preferences, maxTokens: LEGACY_PINNED_MAX_TOKENS },
    });

    const reloaded = new ConfigStore(configPath);
    expect((await reloaded.get()).preferences.maxTokens).toBe(LEGACY_PINNED_MAX_TOKENS);
  });

  it('round-trips an explicit budget through a save', async () => {
    const store = new ConfigStore(configPath);
    await store.update({ preferences: { ...(await store.get()).preferences, maxTokens: 8192 } });

    const reloaded = new ConfigStore(configPath);
    expect((await reloaded.get()).preferences.maxTokens).toBe(8192);
  });
});
