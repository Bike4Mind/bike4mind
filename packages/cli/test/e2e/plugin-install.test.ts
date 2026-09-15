/**
 * Real-npm round trip for the plugin system: b4m plugin add (actual
 * `npm install --prefix` of the file: fixture) -> discovery -> registry load
 * -> remove. This is the only suite that validates npm's on-disk install
 * layout, which mocks structurally cannot.
 *
 * Unlike the rest of this harness it spawns npm; the file: spec plus
 * --no-audit keeps it off the network. Requires npm on PATH (true wherever
 * this repo builds).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { handleAdd, handleRemove } from '../../src/commands/pluginCommand';
import { PluginStore } from '../../src/plugins/PluginStore';
import { buildFeatureRegistry } from '../../src/features/buildFeatureRegistry';
import { ConfigStore } from '../../src/storage/ConfigStore';
import type { Logger } from '../../src/utils/Logger';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/b4m-plugin-example');

const quietLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

describe('plugin install round trip (real npm)', () => {
  let dir: string;
  let configStore: ConfigStore;

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-plugin-e2e-'));
    configStore = new ConfigStore(path.join(dir, 'config.json'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    delete process.env.B4M_NO_PROJECT_CONFIG;
  });

  it('installs, discovers, loads, and removes the fixture plugin', { timeout: 120_000 }, async () => {
    const pluginsDir = path.join(dir, 'plugins');

    // add: real npm install of the fixture
    await handleAdd(`file:${FIXTURE_DIR}`, pluginsDir, configStore);

    const store = new PluginStore({ pluginsDir });
    let descriptors = await store.discover();
    const valid = store.getValid(descriptors);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ name: 'b4m-plugin-example', configKey: 'example' });

    // add auto-enabled the feature key
    let config = await configStore.load();
    expect(config.features?.example).toBe(true);

    // the loader can import and register it
    const { registry, loaded, skipped } = await buildFeatureRegistry({
      builtins: [],
      descriptors,
      config,
      logger: quietLogger,
    });
    expect(skipped).toEqual([]);
    expect(loaded).toEqual(['b4m-plugin-example']);
    expect(registry.getAllToolNames()).toEqual(['example_hello']);
    expect(registry.executeCommand('example', [])).toBe(true);

    // remove: real npm uninstall + feature key set to false
    await handleRemove('example', pluginsDir, configStore);
    descriptors = await store.discover();
    expect(store.getValid(descriptors)).toHaveLength(0);
    config = await new ConfigStore(path.join(dir, 'config.json')).load();
    expect(config.features?.example).toBe(false);
  });
});
