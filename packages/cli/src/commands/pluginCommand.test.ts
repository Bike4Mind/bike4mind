/**
 * pluginCommand tests: spec validation shapes, the remove-name mapping rules,
 * list formatting, and the add/remove orchestration with npm mocked (the mock
 * mutates a temp plugins tree the way a real install would, so the
 * discover-after-install path is exercised for real; the true npm round-trip
 * lives in the e2e suite).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { promises as fs, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { validatePluginSpec, resolvePluginByName, formatPluginList, handleAdd, handleRemove } from './pluginCommand';
import { ConfigStore } from '../storage/ConfigStore';
import type { CliConfig } from '../storage/types';
import type { PluginDescriptor } from '../plugins/PluginStore';

const mockedExecFileSync = vi.mocked(execFileSync);

function makeValid(name: string, configKey = name): PluginDescriptor {
  return {
    valid: true,
    name,
    version: '1.0.0',
    description: `${name} description`,
    packageDir: `/plugins/node_modules/${name}`,
    entryAbsPath: `/plugins/node_modules/${name}/index.mjs`,
    configKey,
  };
}

describe('validatePluginSpec', () => {
  it.each([
    'b4m-plugin-foo',
    'b4m-plugin-foo@1.2.3',
    '@someone/b4m-plugin-bar',
    '@someone/b4m-plugin-bar@latest',
    'github:user/b4m-plugin-foo',
    'github:user/repo#v1.0.0',
    'user/repo',
    'file:/abs/path/to/plugin',
  ])('accepts %s', spec => {
    expect(validatePluginSpec(spec)).toBe(true);
  });

  it.each([
    '',
    '  ',
    'foo; rm -rf /',
    'foo && echo pwned',
    'foo|bar',
    'foo$(whoami)',
    'foo`id`',
    "foo'bar",
    'foo"bar',
    'foo bar',
    '../escape',
  ])('rejects %j', spec => {
    expect(validatePluginSpec(spec)).toBe(false);
  });
});

describe('resolvePluginByName', () => {
  const descriptors = [makeValid('@someone/b4m-plugin-foo', 'foo'), makeValid('b4m-plugin-bar')];

  it('matches an exact configKey', () => {
    expect(resolvePluginByName(descriptors, 'foo').plugin?.name).toBe('@someone/b4m-plugin-foo');
  });

  it('matches an exact package name', () => {
    expect(resolvePluginByName(descriptors, 'b4m-plugin-bar').plugin?.name).toBe('b4m-plugin-bar');
  });

  it('matches the short name with the b4m-plugin- prefix stripped', () => {
    expect(resolvePluginByName(descriptors, 'bar').plugin?.name).toBe('b4m-plugin-bar');
  });

  it('reports ambiguity instead of guessing', () => {
    const clash = [makeValid('@a/b4m-plugin-x', 'xa'), makeValid('@b/b4m-plugin-x', 'xb')];
    const result = resolvePluginByName(clash, 'x');
    expect(result.plugin).toBeUndefined();
    expect(result.candidates).toHaveLength(2);
  });

  it('returns nothing on no match', () => {
    expect(resolvePluginByName(descriptors, 'nope')).toEqual({});
  });
});

describe('formatPluginList', () => {
  it('renders the empty state with add examples', () => {
    const out = formatPluginList([], { features: {} } as unknown as CliConfig);
    expect(out).toContain('No plugins installed');
    expect(out).toContain('b4m plugin add');
  });

  it('renders enabled, disabled, and invalid rows', () => {
    const descriptors: PluginDescriptor[] = [
      makeValid('b4m-plugin-on', 'on'),
      makeValid('b4m-plugin-off', 'off'),
      { valid: false, name: 'b4m-plugin-broken', packageDir: '/x', reason: 'entry is required' },
    ];
    const out = formatPluginList(descriptors, { features: { on: true } } as unknown as CliConfig);
    expect(out).toContain('b4m-plugin-on@1.0.0 - ✅ Enabled');
    expect(out).toContain('b4m-plugin-off@1.0.0 - ⏸️ Disabled');
    expect(out).toContain('⚠️ entry is required');
  });
});

describe('add/remove orchestration', () => {
  let dir: string;
  let configPath: string;
  let configStore: ConfigStore;

  async function fakeInstalledPlugin(name: string, configKey: string): Promise<void> {
    const packageDir = path.join(dir, 'node_modules', name);
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        'b4m-plugin': { entry: './index.mjs', configKey },
      })
    );
  }

  beforeEach(async () => {
    process.env.B4M_NO_PROJECT_CONFIG = '1';
    dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-plugin-cmd-'));
    configPath = path.join(dir, 'config.json');
    configStore = new ConfigStore(configPath);
    mockedExecFileSync.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    delete process.env.B4M_NO_PROJECT_CONFIG;
    vi.restoreAllMocks();
  });

  it('add runs npm with the arg vector, seeds the root manifest, and enables the plugin', async () => {
    mockedExecFileSync.mockImplementation(() => {
      // Simulate npm materializing the package.
      const packageDir = path.join(dir, 'node_modules', 'b4m-plugin-foo');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'b4m-plugin-foo',
          version: '1.0.0',
          'b4m-plugin': { entry: './index.mjs', configKey: 'foo' },
        })
      );
      return Buffer.from('');
    });

    await handleAdd('b4m-plugin-foo', dir, configStore);

    const [binary, args] = mockedExecFileSync.mock.calls[0];
    expect(binary).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
    expect(args).toEqual(['install', '--prefix', dir, '--no-fund', '--no-audit', 'b4m-plugin-foo']);

    const rootManifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf-8'));
    expect(rootManifest).toMatchObject({ name: 'b4m-plugins', private: true });

    const config = await new ConfigStore(configPath).load();
    expect(config.features?.foo).toBe(true);
  });

  it('add rejects a bad spec before any npm call', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(handleAdd('foo; rm -rf /', dir, configStore)).rejects.toThrow('exit');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('add warns and does not enable when the installed package has no manifest', async () => {
    mockedExecFileSync.mockImplementation(() => {
      const packageDir = path.join(dir, 'node_modules', 'plain-dep');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'plain-dep', version: '1.0.0' }));
      return Buffer.from('');
    });

    await handleAdd('plain-dep', dir, configStore);
    const config = await new ConfigStore(configPath).load();
    expect(config.features?.['plain-dep']).toBeUndefined();
  });

  it('remove uninstalls via npm and writes the feature key to false', async () => {
    await fakeInstalledPlugin('b4m-plugin-foo', 'foo');
    const config = await configStore.load();
    await configStore.save({ ...config, features: { foo: true } });
    mockedExecFileSync.mockReturnValue(Buffer.from(''));

    await handleRemove('foo', dir, configStore);

    const [, args] = mockedExecFileSync.mock.calls[0];
    expect(args).toEqual(['uninstall', '--prefix', dir, 'b4m-plugin-foo']);

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.foo).toBe(false);
  });

  it('remove exits without npm when nothing matches', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(handleRemove('ghost', dir, configStore)).rejects.toThrow('exit');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
