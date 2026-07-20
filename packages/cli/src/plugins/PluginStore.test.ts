/**
 * Tests for PluginStore discovery: enumeration of ~/.bike4mind/plugins-style
 * trees, b4m-plugin manifest validation, containment of entry paths, and the
 * first-wins dedup rules. Fixtures are real temp-dir packages; no npm runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { PluginStore, getDefaultPluginsDir } from './PluginStore';

interface MakePkgOptions {
  manifest?: Record<string, unknown>;
  pkgExtra?: Record<string, unknown>;
  entryFile?: string;
  rawJson?: string;
  root?: string;
}

let dir: string;

async function makePkg(name: string, options: MakePkgOptions = {}): Promise<string> {
  const root = options.root ?? 'node_modules';
  const packageDir = path.join(dir, root, name);
  await fs.mkdir(packageDir, { recursive: true });

  const json =
    options.rawJson ??
    JSON.stringify({
      name,
      version: '1.2.3',
      description: `${name} description`,
      ...(options.manifest !== undefined ? { 'b4m-plugin': options.manifest } : {}),
      ...(options.pkgExtra ?? {}),
    });
  await fs.writeFile(path.join(packageDir, 'package.json'), json);

  if (options.entryFile) {
    const entryPath = path.join(packageDir, options.entryFile);
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(entryPath, 'export default () => ({});');
  }
  return packageDir;
}

describe('PluginStore.discover', () => {
  let store: PluginStore;

  beforeEach(async () => {
    dir = path.join(tmpdir(), `b4m-plugin-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    store = new PluginStore({ pluginsDir: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('defaults the plugins dir under the user home', () => {
    expect(getDefaultPluginsDir()).toMatch(/\.bike4mind[/\\]plugins$/);
  });

  it('returns empty when the plugins dir is missing', async () => {
    const missing = new PluginStore({ pluginsDir: path.join(dir, 'nope') });
    expect(await missing.discover()).toEqual([]);
  });

  it('returns empty when node_modules is empty', async () => {
    expect(await store.discover()).toEqual([]);
  });

  it('discovers a valid plugin with all descriptor fields', async () => {
    const packageDir = await makePkg('b4m-plugin-foo', {
      manifest: { entry: './dist/index.js', configKey: 'foo' },
      entryFile: 'dist/index.js',
    });

    const [descriptor] = await store.discover();
    expect(descriptor).toEqual({
      valid: true,
      name: 'b4m-plugin-foo',
      version: '1.2.3',
      description: 'b4m-plugin-foo description',
      packageDir,
      entryAbsPath: path.join(packageDir, 'dist', 'index.js'),
      configKey: 'foo',
    });
  });

  it('skips packages without a b4m-plugin field', async () => {
    await makePkg('lodash');
    await makePkg('b4m-plugin-foo', { manifest: { entry: './index.js' } });

    const descriptors = await store.discover();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].name).toBe('b4m-plugin-foo');
  });

  it('marks a package invalid on malformed package.json', async () => {
    await makePkg('broken', { rawJson: '{ not json' });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(false);
    expect(descriptor.name).toBe('broken');
    expect((descriptor as { reason: string }).reason).toContain('not valid JSON');
  });

  it('marks a package invalid when package.json cannot be read', async () => {
    // A directory named package.json triggers a non-ENOENT read error.
    const packageDir = path.join(dir, 'node_modules', 'weird');
    await fs.mkdir(path.join(packageDir, 'package.json'), { recursive: true });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(false);
    expect((descriptor as { reason: string }).reason).toContain('unreadable');
  });

  it('marks a plugin invalid when entry is missing from the manifest', async () => {
    await makePkg('b4m-plugin-foo', { manifest: { configKey: 'foo' } });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(false);
    expect((descriptor as { reason: string }).reason).toContain('entry');
  });

  it('rejects an entry that escapes the package directory', async () => {
    await makePkg('b4m-plugin-evil', { manifest: { entry: '../../../etc/passwd' } });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(false);
    expect((descriptor as { reason: string }).reason).toContain('inside the package');
  });

  it('rejects absolute entry paths', async () => {
    await makePkg('b4m-plugin-abs', { manifest: { entry: '/tmp/elsewhere.js' } });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(false);
    expect((descriptor as { reason: string }).reason).toContain('inside the package');
  });

  it.each(['.', './'])('rejects an entry that resolves to the package directory itself (%s)', async entry => {
    await makePkg('b4m-plugin-dir', { manifest: { entry } });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(false);
    expect((descriptor as { reason: string }).reason).toContain('inside the package');
  });

  it('rejects a plugin claiming a reserved built-in configKey', async () => {
    await makePkg('b4m-plugin-sneaky', { manifest: { entry: './index.js', configKey: 'tavern' } });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(false);
    expect((descriptor as { reason: string }).reason).toContain('reserved');
  });

  it('keeps the scoped package name on an invalid descriptor (so remove targets the right package)', async () => {
    // Invalid manifest (missing entry) for a scoped package: the descriptor
    // name must stay @scope/... not the unscoped basename.
    await makePkg('@someone/b4m-plugin-bar', { manifest: { configKey: 'bar' } });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(false);
    expect(descriptor.name).toBe('@someone/b4m-plugin-bar');
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', '__defineGetter__', '__lookupSetter__'])(
    'rejects a plugin whose configKey names a prototype member (%s)',
    async configKey => {
      await makePkg('b4m-plugin-proto', { manifest: { entry: './index.js', configKey } });
      const [descriptor] = await store.discover();
      expect(descriptor.valid).toBe(false);
      expect((descriptor as { reason: string }).reason).toContain('not allowed');
    }
  );

  it('keeps the first plugin and invalidates a duplicate configKey', async () => {
    await makePkg('b4m-plugin-a', { manifest: { entry: './index.js', configKey: 'same' } });
    await makePkg('b4m-plugin-b', { manifest: { entry: './index.js', configKey: 'same' } });

    const descriptors = await store.discover();
    const a = descriptors.find(d => d.name === 'b4m-plugin-a');
    const b = descriptors.find(d => d.name === 'b4m-plugin-b');
    expect(a?.valid).toBe(true);
    expect(b?.valid).toBe(false);
    expect((b as { reason: string }).reason).toContain('b4m-plugin-a');
  });

  it('discovers scoped plugin packages', async () => {
    await makePkg('@someone/b4m-plugin-bar', {
      manifest: { entry: './index.js', configKey: 'bar' },
    });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(true);
    expect(descriptor.name).toBe('@someone/b4m-plugin-bar');
  });

  it('defaults configKey to the package name when the manifest omits it', async () => {
    await makePkg('@someone/b4m-plugin-bar', { manifest: { entry: './index.js' } });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(true);
    expect((descriptor as { configKey: string }).configKey).toBe('@someone/b4m-plugin-bar');
  });

  it('does not require the entry file to exist on disk', async () => {
    // Existence is the loader's concern; discovery only validates containment.
    await makePkg('b4m-plugin-foo', { manifest: { entry: './dist/missing.js' } });

    const [descriptor] = await store.discover();
    expect(descriptor.valid).toBe(true);
  });

  it('discovers plugins from lib/node_modules as well', async () => {
    await makePkg('b4m-plugin-foo', {
      manifest: { entry: './index.js' },
      root: path.join('lib', 'node_modules'),
    });

    const descriptors = await store.discover();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].valid).toBe(true);
  });

  it('dedupes a package present in both roots (first root wins)', async () => {
    const primary = await makePkg('b4m-plugin-foo', { manifest: { entry: './index.js' } });
    await makePkg('b4m-plugin-foo', {
      manifest: { entry: './other.js' },
      root: path.join('lib', 'node_modules'),
    });

    const descriptors = await store.discover();
    expect(descriptors).toHaveLength(1);
    expect((descriptors[0] as { packageDir: string }).packageDir).toBe(primary);
  });

  it('filters with getValid and getInvalid', async () => {
    await makePkg('b4m-plugin-good', { manifest: { entry: './index.js' } });
    await makePkg('b4m-plugin-bad', { manifest: {} });

    const descriptors = await store.discover();
    expect(store.getValid(descriptors)).toHaveLength(1);
    expect(store.getInvalid(descriptors)).toHaveLength(1);
  });
});
