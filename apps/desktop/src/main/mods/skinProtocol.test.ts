import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSkin, type LoadedSkin } from './skinFolder';
import { serveSkinAsset } from './skinProtocol';
import { PNG_BYTES, installSampleSkin } from './testSkins';

vi.mock('electron', () => ({ protocol: {} }));

let modsRoot: string;
let folder: string;
let skins: Map<string, LoadedSkin>;

beforeEach(async () => {
  modsRoot = await mkdtemp(join(tmpdir(), 'skin-protocol-'));
  folder = await installSampleSkin(modsRoot);
  const result = await loadSkin(modsRoot, 'nightglass');
  if (result === 'not-a-skin' || !result.ok) throw new Error(JSON.stringify(result));
  skins = new Map([['nightglass', result.skin]]);
});

afterEach(async () => {
  await rm(modsRoot, { recursive: true, force: true });
});

describe('serveSkinAsset', () => {
  it('serves a referenced sprite with its type, nosniff and no caching', async () => {
    const response = await serveSkinAsset(skins, 'b4m-skin://nightglass/sprites/tank.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  it('serves a referenced sound as audio', async () => {
    const response = await serveSkinAsset(skins, 'b4m-skin://nightglass/sounds/finale.ogg');
    expect(response.headers.get('content-type')).toBe('audio/ogg');
  });

  it.each([
    ['the manifest', 'b4m-skin://nightglass/mod.json'],
    ['the tokens', 'b4m-skin://nightglass/tokens.json'],
    ['an unknown skin', 'b4m-skin://other/sprites/tank.png'],
    ['an unreferenced file', 'b4m-skin://nightglass/sprites/unused.png'],
    ['a dot-dot path', 'b4m-skin://nightglass/sprites/../mod.json'],
    ['an encoded dot-dot path', 'b4m-skin://nightglass/sprites/%2e%2e/mod.json'],
    ['an encoded separator', 'b4m-skin://nightglass/sprites%2ftank.png'],
    ['a query string', 'b4m-skin://nightglass/sprites/tank.png?x=1'],
    ['another scheme', 'file:///etc/hosts'],
    ['garbage', 'not a url'],
  ])('answers 404 for %s', async (_label, url) => {
    if (url.includes('unused')) await writeFile(join(folder, 'sprites/unused.png'), PNG_BYTES);
    expect((await serveSkinAsset(skins, url)).status).toBe(404);
  });

  it('refuses a file replaced on disk by something that is no longer its type', async () => {
    await writeFile(join(folder, 'sprites/tank.png'), '<html></html>');
    expect((await serveSkinAsset(skins, 'b4m-skin://nightglass/sprites/tank.png')).status).toBe(404);
  });

  it('refuses a file grown past its cap since the scan', async () => {
    await writeFile(join(folder, 'sprites/tank.png'), Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024)]));
    expect((await serveSkinAsset(skins, 'b4m-skin://nightglass/sprites/tank.png')).status).toBe(404);
  });
});
