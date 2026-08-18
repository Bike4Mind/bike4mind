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

  it('does not revert a concurrent edit to a key this caller never touched', async () => {
    // Session A loads with plugin-A on; it will later toggle nothing about A.
    const config = await store.load();
    await store.save({ ...config, features: { 'plugin-A': true } });

    const sessionA = new ConfigStore(configPath);
    const snapshot = await sessionA.load(); // {plugin-A: true}

    // Another process disables plugin-A and adds plugin-B on disk.
    const other = new ConfigStore(configPath);
    const oc = await other.load();
    await other.save({ ...oc, features: { 'plugin-A': false, 'plugin-B': true } });

    // Session A saves adding plugin-C, having never touched plugin-A/B.
    await sessionA.save({ ...snapshot, features: { ...snapshot.features, 'plugin-C': true } });

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.['plugin-A']).toBe(false); // the other process's edit survives
    expect(reloaded.features?.['plugin-B']).toBe(true); // and its new key survives
    expect(reloaded.features?.['plugin-C']).toBe(true); // session A's own change lands
  });

  it('drops a key the caller intentionally removed', async () => {
    const config = await store.load();
    await store.save({ ...config, features: { keep: true, drop: true } });

    const later = await store.load();
    const { drop: _drop, ...withoutDrop } = later.features ?? {};
    await store.save({ ...later, features: withoutDrop });

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.keep).toBe(true);
    expect(reloaded.features?.drop).toBeUndefined();
  });

  it('strips a non-boolean feature value on load instead of wiping the whole config', async () => {
    // A malformed feature value must not ZodError the whole parse (which would
    // discard config to defaults and let the next save wipe auth/mcpServers).
    const config = await store.load();
    await store.save({ ...config, features: { tavern: true } });
    // Corrupt the on-disk features with a non-boolean value, plus a real auth token.
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    onDisk.features = { tavern: true, bogus: 'not-a-boolean' };
    onDisk.auth = { accessToken: 'a', refreshToken: 'r', expiresAt: '2099-01-01T00:00:00Z', userId: 'u1' };
    await fs.writeFile(configPath, JSON.stringify(onDisk));

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.tavern).toBe(true); // valid key kept
    expect(reloaded.features?.bogus).toBeUndefined(); // bad value stripped, not fatal
    expect(reloaded.auth?.userId).toBe('u1'); // rest of the config survived
  });

  it('switchApiEnvironment does not write back a bogus disk feature value', async () => {
    const config = await store.load();
    await store.save({ ...config, features: { tavern: true } });
    // Corrupt the disk features with a non-boolean before the env switch.
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    onDisk.features = { tavern: true, bogus: 'nope' };
    await fs.writeFile(configPath, JSON.stringify(onDisk));

    const session = new ConfigStore(configPath);
    await session.load();
    await session.switchApiEnvironment({ customUrl: 'https://app.staging.bike4mind.com' });

    const written = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(written.features.tavern).toBe(true);
    expect('bogus' in written.features).toBe(false); // stripped, not written back
  });

  it('switchApiEnvironment preserves features written by another process', async () => {
    const config = await store.load();
    await store.save({ ...config, features: { tavern: true } });
    const session = new ConfigStore(configPath);
    await session.load(); // snapshot without the not-yet-added plugin

    // Another process adds + enables a plugin on disk.
    const other = new ConfigStore(configPath);
    const oc = await other.load();
    await other.save({ ...oc, features: { ...oc.features, 'b4m-plugin-x': true } });

    // The interactive session switches API env (no-arg save under the hood).
    await session.switchApiEnvironment({ customUrl: 'https://app.staging.bike4mind.com' });

    const reloaded = await new ConfigStore(configPath).load();
    expect(reloaded.features?.['b4m-plugin-x']).toBe(true); // not reverted by /set-api
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
