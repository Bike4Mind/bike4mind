/**
 * buildFeatureRegistry tests: built-ins first, config gating (a disabled
 * plugin's code must never even be imported), per-plugin failure isolation,
 * collision handling, and the end-to-end enable -> dispose -> re-enable arc
 * that mirrors what the /config hot-reload site does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { buildFeatureRegistry } from './buildFeatureRegistry';
import type { ICliFeatureModule } from './ICliFeatureModule';
import type { PluginDescriptor, ValidPluginDescriptor } from '../plugins/PluginStore';
import type { CliConfig } from '../storage/types';
import type { Logger } from '../utils/Logger';

let dir: string;

const quietLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

function makeConfig(features: Record<string, boolean>): CliConfig {
  return { features } as unknown as CliConfig;
}

function makeBuiltin(name: string): ICliFeatureModule {
  return {
    name,
    description: `built-in ${name}`,
    getTools: () => [],
    getSystemPromptSection: () => '',
  };
}

async function writePluginEntry(filename: string, content: string): Promise<ValidPluginDescriptor> {
  const entryAbsPath = path.join(dir, filename);
  await fs.writeFile(entryAbsPath, content);
  const name = filename.replace(/\.(mjs|cjs)$/, '');
  return {
    valid: true,
    name,
    version: '1.0.0',
    description: '',
    packageDir: dir,
    entryAbsPath,
    configKey: name,
  };
}

function factorySource(moduleName: string, toolName: string): string {
  return `export default () => ({
    name: '${moduleName}',
    description: '',
    getTools: () => [{ toolFn: () => 'ok', toolSchema: { name: '${toolName}', description: '', parameters: {} } }],
    getSystemPromptSection: () => '${moduleName} prompt',
    getCommands: () => [{ name: '${moduleName}-cmd', description: '', execute: () => {} }],
  });`;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-build-registry-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('buildFeatureRegistry', () => {
  it('registers built-ins even with no plugins', async () => {
    const { registry, loaded, skipped } = await buildFeatureRegistry({
      builtins: [makeBuiltin('tavern')],
      descriptors: [],
      config: makeConfig({ tavern: true }),
      logger: quietLogger,
    });
    expect(registry.getModuleNames()).toEqual(['tavern']);
    expect(loaded).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('loads an enabled valid plugin and reports it', async () => {
    const descriptor = await writePluginEntry('good-one.mjs', factorySource('good-one', 'good_tool'));
    const { registry, loaded } = await buildFeatureRegistry({
      builtins: [],
      descriptors: [descriptor],
      config: makeConfig({ 'good-one': true }),
      logger: quietLogger,
    });
    expect(loaded).toEqual(['good-one']);
    expect(registry.getAllToolNames()).toEqual(['good_tool']);
    expect(registry.getSystemPromptSections()).toContain('good-one prompt');
    expect(registry.getAllCommands().map(c => c.name)).toEqual(['good-one-cmd']);
  });

  it('never imports a disabled plugin', async () => {
    const sentinel = path.join(dir, 'disabled-side-effect.txt');
    const descriptor = await writePluginEntry(
      'disabled-one.mjs',
      `import { writeFileSync } from 'fs';
       writeFileSync('${sentinel}', 'imported');
       export default () => ({ name: 'disabled-one', description: '', getTools: () => [], getSystemPromptSection: () => '' });`
    );
    const { registry, loaded, skipped } = await buildFeatureRegistry({
      builtins: [],
      descriptors: [descriptor],
      config: makeConfig({}),
      logger: quietLogger,
    });
    expect(loaded).toEqual([]);
    expect(skipped).toEqual([]);
    expect(registry.hasModules).toBe(false);
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it('records an invalid descriptor as skipped', async () => {
    const invalid: PluginDescriptor = {
      valid: false,
      name: 'broken',
      packageDir: dir,
      reason: 'no entry',
    };
    const { skipped } = await buildFeatureRegistry({
      builtins: [],
      descriptors: [invalid],
      config: makeConfig({ broken: true }),
      logger: quietLogger,
    });
    expect(skipped).toEqual([{ name: 'broken', reason: 'no entry' }]);
  });

  it('isolates one failing plugin from the others', async () => {
    const bad = await writePluginEntry('bad-import.mjs', `throw new Error('boom');`);
    const good = await writePluginEntry('still-good.mjs', factorySource('still-good', 'still_good_tool'));
    const { registry, loaded, skipped } = await buildFeatureRegistry({
      builtins: [],
      descriptors: [bad, good],
      config: makeConfig({ 'bad-import': true, 'still-good': true }),
      logger: quietLogger,
    });
    expect(loaded).toEqual(['still-good']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].name).toBe('bad-import');
    expect(registry.getAllToolNames()).toEqual(['still_good_tool']);
  });

  it('skips a plugin whose module name collides with a built-in (no throw)', async () => {
    const impostor = await writePluginEntry('impostor.mjs', factorySource('tavern', 'impostor_tool'));
    const { registry, loaded, skipped } = await buildFeatureRegistry({
      builtins: [makeBuiltin('tavern')],
      descriptors: [impostor],
      config: makeConfig({ tavern: true, impostor: true }),
      logger: quietLogger,
    });
    expect(loaded).toEqual([]);
    expect(skipped[0].reason).toContain('already registered');
    expect(registry.getModuleNames()).toEqual(['tavern']);
  });

  it('skips a plugin with a malformed tool before it can poison the registry', async () => {
    const descriptor = await writePluginEntry(
      'bad-tool.mjs',
      `export default () => ({
        name: 'bad-tool',
        description: '',
        getTools: () => [{ toolSchema: {} }],
        getSystemPromptSection: () => '',
      });`
    );
    const { registry, skipped } = await buildFeatureRegistry({
      builtins: [],
      descriptors: [descriptor],
      config: makeConfig({ 'bad-tool': true }),
      logger: quietLogger,
    });
    expect(skipped[0].reason).toContain('malformed');
    expect(registry.hasModules).toBe(false);
    // The consumer path that used to crash on a malformed tool:
    expect(() => registry.getAllToolNames()).not.toThrow();
  });

  it('supports the enable -> dispose -> re-enable hot-reload arc', async () => {
    const sentinel = path.join(dir, 'dispose-sentinel.txt');
    const descriptor = await writePluginEntry(
      'reloadable.mjs',
      `import { writeFileSync } from 'fs';
       export default () => ({
         name: 'reloadable',
         description: '',
         getTools: () => [{ toolFn: () => 'ok', toolSchema: { name: 'reloadable_tool', description: '', parameters: {} } }],
         getSystemPromptSection: () => '',
         dispose: () => writeFileSync('${sentinel}', 'disposed'),
       });`
    );

    const first = await buildFeatureRegistry({
      builtins: [],
      descriptors: [descriptor],
      config: makeConfig({ reloadable: true }),
      logger: quietLogger,
    });
    expect(first.registry.getAllToolNames()).toEqual(['reloadable_tool']);

    // Hot-reload with the plugin disabled: old registry disposed, new one empty.
    first.registry.disposeAll();
    expect(await fs.readFile(sentinel, 'utf-8')).toBe('disposed');
    const second = await buildFeatureRegistry({
      builtins: [],
      descriptors: [descriptor],
      config: makeConfig({ reloadable: false }),
      logger: quietLogger,
    });
    expect(second.registry.hasModules).toBe(false);

    // Re-enable: factory runs again and the tools come back.
    const third = await buildFeatureRegistry({
      builtins: [],
      descriptors: [descriptor],
      config: makeConfig({ reloadable: true }),
      logger: quietLogger,
    });
    expect(third.registry.getAllToolNames()).toEqual(['reloadable_tool']);
  });
});
