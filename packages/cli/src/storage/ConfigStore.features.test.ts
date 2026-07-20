/**
 * Tests for the config `features` map: plugin keys surviving the zod parse
 * (catchall) and the save() deep-merge that protects a toggle written by
 * another process (b4m plugin add) from a running session's save.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from './ConfigStore';

async function makeTempConfigPath(): Promise<string> {
  const dir = path.join(tmpdir(), `b4m-features-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

describe('ConfigStore features map', () => {
  let configPath: string;
  let store: ConfigStore;

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    configPath = await makeTempConfigPath();
    store = new ConfigStore(configPath);
  });

  afterEach(async () => {
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
    delete process.env.B4M_NO_PROJECT_CONFIG;
  });

  it('keeps arbitrary plugin keys across a save/load round-trip', async () => {
    const config = await store.load();
    await store.save({ ...config, features: { tavern: true, 'b4m-plugin-foo': true } });

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.tavern).toBe(true);
    expect(reloaded.features?.['b4m-plugin-foo']).toBe(true);
  });

  it('preserves a false value for a plugin key (no truthy coercion)', async () => {
    const config = await store.load();
    await store.save({ ...config, features: { 'b4m-plugin-foo': false } });

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.['b4m-plugin-foo']).toBe(false);
  });

  it('deep-merges features on save so an on-disk key set by another process survives', async () => {
    // Session A loads its config before the plugin is added.
    const sessionConfig = await store.load();

    // Another process (b4m plugin add) enables a plugin on disk.
    const other = new ConfigStore(configPath);
    const otherConfig = await other.load();
    await other.save({ ...otherConfig, features: { ...otherConfig.features, added: true } });

    // Session A saves with its stale features object; the added key must survive.
    await store.save({ ...sessionConfig, features: { ...sessionConfig.features, tavern: true } });

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.added).toBe(true);
    expect(reloaded.features?.tavern).toBe(true);
  });

  it('lets an in-memory toggle win per-key over the disk value', async () => {
    const config = await store.load();
    await store.save({ ...config, features: { tavern: true } });

    const later = await store.load();
    await store.save({ ...later, features: { ...later.features, tavern: false } });

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.tavern).toBe(false);
  });
});
