/**
 * Seam test for the whole plugin pipeline short of npm: a realistic installed
 * tree under <pluginsDir>/node_modules goes through PluginStore.discover()
 * and its actual output feeds buildFeatureRegistry - proving the descriptor
 * contract the two modules share, not two fixtures that happen to agree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { PluginStore } from '../plugins/PluginStore';
import { buildFeatureRegistry } from './buildFeatureRegistry';
import type { CliConfig } from '../storage/types';
import type { Logger } from '../utils/Logger';

const quietLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

let dir: string;

async function installFakePlugin(name: string, entryRelPath: string, entrySource: string): Promise<void> {
  const packageDir = path.join(dir, 'node_modules', name);
  const entryPath = path.join(packageDir, entryRelPath);
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      description: `${name} plugin`,
      'b4m-plugin': { entry: `./${entryRelPath}`, configKey: name },
    })
  );
  await fs.writeFile(entryPath, entrySource);
}

describe('plugin system integration (discover -> build registry)', () => {
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-plugin-system-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('discovers an installed package and loads it into a working registry', async () => {
    await installFakePlugin(
      'b4m-plugin-greeter',
      'dist/index.mjs',
      `export default (ctx) => ({
        name: 'greeter',
        description: 'greets',
        getTools: () => [{ toolFn: async () => 'hello', toolSchema: { name: 'greet', description: 'say hello', parameters: { type: 'object', properties: {} } } }],
        getSystemPromptSection: () => 'You can greet.',
        getCommands: () => [{ name: 'greet', description: 'greet', execute: () => {} }],
      });`
    );

    const store = new PluginStore({ pluginsDir: dir });
    const descriptors = await store.discover();
    expect(store.getValid(descriptors)).toHaveLength(1);

    const config = { features: { 'b4m-plugin-greeter': true } } as unknown as CliConfig;
    const { registry, loaded, skipped } = await buildFeatureRegistry({
      builtins: [],
      descriptors,
      config,
      logger: quietLogger,
    });

    expect(loaded).toEqual(['b4m-plugin-greeter']);
    expect(skipped).toEqual([]);
    expect(registry.getAllToolNames()).toEqual(['greet']);
    expect(registry.getSystemPromptSections()).toContain('You can greet.');
    expect(registry.executeCommand('greet', [])).toBe(true);
  });

  it('keeps a broken installed package from affecting a healthy one', async () => {
    await installFakePlugin('b4m-plugin-broken', 'index.mjs', `throw new Error('bad install');`);
    await installFakePlugin(
      'b4m-plugin-healthy',
      'index.mjs',
      `export default () => ({
        name: 'healthy',
        description: '',
        getTools: () => [],
        getSystemPromptSection: () => '',
      });`
    );

    const store = new PluginStore({ pluginsDir: dir });
    const descriptors = await store.discover();
    const config = {
      features: { 'b4m-plugin-broken': true, 'b4m-plugin-healthy': true },
    } as unknown as CliConfig;

    const { loaded, skipped } = await buildFeatureRegistry({
      builtins: [],
      descriptors,
      config,
      logger: quietLogger,
    });
    expect(loaded).toEqual(['b4m-plugin-healthy']);
    expect(skipped.map(s => s.name)).toEqual(['b4m-plugin-broken']);
  });
});
