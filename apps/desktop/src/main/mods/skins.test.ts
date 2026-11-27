import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSkin, loadSkins, loadSoundPack, loadSoundPacks, type SkinLoadResult, type LoadedSkin } from './skinFolder';
import { OGG_BYTES, PNG_BYTES, SAMPLE_SKIN_SPRITES, installSamplePack, installSampleSkin } from './testSkins';
import { serveSkinAsset } from './skinProtocol';

vi.mock('electron', () => ({ protocol: {} }));

describe('skin folders', () => {
  let modsRoot: string;
  let outside: string;

  const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));

  function expectRejected(result: SkinLoadResult | 'not-a-skin', reason: RegExp): void {
    expect(result).not.toBe('not-a-skin');
    if (result === 'not-a-skin' || result.ok) throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
    expect(result.error).toMatch(reason);
  }

  beforeEach(async () => {
    modsRoot = await mkdtemp(join(tmpdir(), 'skin-mods-'));
    outside = await mkdtemp(join(tmpdir(), 'skin-outside-'));
  });

  afterEach(async () => {
    await rm(modsRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('loadSkin', () => {
    it('loads the sample skin with only its referenced files as assets', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeFile(join(folder, 'sprites/unused.png'), PNG_BYTES);
      await writeFile(join(folder, '.DS_Store'), 'finder metadata');

      const result = await loadSkin(modsRoot, 'nightglass');

      if (result === 'not-a-skin' || !result.ok) throw new Error(JSON.stringify(result));
      expect(result.skin.manifest.name).toBe('Nightglass');
      expect(result.skin.tokens.states?.working).toBe('#3cc8ff');
      expect([...result.skin.assets.keys()].sort()).toEqual(['sounds/finale.ogg', ...SAMPLE_SKIN_SPRITES].sort());
      expect(SAMPLE_SKIN_SPRITES).toEqual(
        expect.arrayContaining([
          'sprites/tavern.png',
          'sprites/office.png',
          'sprites/tank.png',
          'sprites/office-night-work.png',
        ])
      );
      expect(result.skin.assets.get('sprites/tank.png')).toMatchObject({ type: 'png', size: PNG_BYTES.length });
    });

    it('skips a folder that holds another kind of mod, whatever files it has', async () => {
      const folder = join(modsRoot, 'some-view');
      await mkdir(folder);
      await writeJson(join(folder, 'mod.json'), { manifest: 1, id: 'some-view', kind: 'view' });
      await writeFile(join(folder, 'index.html'), '<script></script>');
      expect(await loadSkin(modsRoot, 'some-view')).toBe('not-a-skin');
    });

    it.each(['index.html', 'theme.css', 'run.js', 'icon.svg', 'sprites/clip.gif', 'sounds/beep.wav', 'notes.txt'])(
      'rejects a skin containing %s',
      async file => {
        const folder = await installSampleSkin(modsRoot);
        await writeFile(join(folder, file), 'x');
        const result = await loadSkin(modsRoot, 'nightglass');
        expectRejected(result, /file type is not allowed/);
        expect(result).toMatchObject({ name: 'Nightglass' });
      }
    );

    it.each([
      ['sprites/tank.png', 2 * 1024 * 1024 + 1, /over the 2 MB limit/],
      ['sounds/finale.ogg', 1024 * 1024 + 1, /over the 1 MB limit/],
      ['tokens.json', 64 * 1024 + 1, /over the 64 KB limit/],
    ])('rejects %s over its size cap', async (file, size, reason) => {
      const folder = await installSampleSkin(modsRoot);
      await writeFile(join(folder, file), Buffer.alloc(size));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), reason);
    });

    it('rejects folders nested deeper than three levels', async () => {
      const folder = await installSampleSkin(modsRoot);
      await mkdir(join(folder, 'a/b/c/d'), { recursive: true });
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /nested too deep/);
    });

    it('rejects a skin with more than 200 files', async () => {
      const folder = await installSampleSkin(modsRoot);
      await mkdir(join(folder, 'extra'));
      await Promise.all(Array.from({ length: 201 }, (_, i) => writeFile(join(folder, `extra/f${i}.png`), 'x')));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /more than 200 files/);
    });

    it('rejects a skin over 20 MB in total even when every file is under its cap', async () => {
      const folder = await installSampleSkin(modsRoot);
      await mkdir(join(folder, 'extra'));
      const full = Buffer.alloc(2 * 1024 * 1024);
      await Promise.all(Array.from({ length: 11 }, (_, i) => writeFile(join(folder, `extra/big${i}.png`), full)));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /in total/);
    });

    it('rejects a sprite symlinked to a file outside the skin folder', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeFile(join(outside, 'secret.png'), PNG_BYTES);
      await rm(join(folder, 'sprites/tank.png'));
      await symlink(join(outside, 'secret.png'), join(folder, 'sprites/tank.png'));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /sprites\/tank\.png is a symbolic link/);
    });

    it('rejects a sprites folder that is a symlink out of the skin', async () => {
      const folder = await installSampleSkin(modsRoot);
      await rm(join(folder, 'sprites'), { recursive: true });
      await symlink(outside, join(folder, 'sprites'));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /sprites is a symbolic link/);
    });

    it('rejects a skin folder that is itself a symlink', async () => {
      await installSampleSkin(outside, 'nightglass');
      await symlink(join(outside, 'nightglass'), join(modsRoot, 'nightglass'));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /skin folder is a symbolic link/);
    });

    it('lists a symlinked mod folder once, as a broken skin, and not as a broken sound pack', async () => {
      await installSampleSkin(outside, 'nightglass');
      await symlink(join(outside, 'nightglass'), join(modsRoot, 'nightglass'));
      expect(await loadSoundPack(modsRoot, 'nightglass')).toBe('not-a-sound-pack');
      expect(await loadSoundPacks(modsRoot)).toEqual([]);
      expect((await loadSkins(modsRoot)).map(result => (result.ok ? result.skin.manifest.id : result.id))).toEqual([
        'nightglass',
      ]);
    });

    it('rejects a mod.json that is a symlink', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeJson(join(outside, 'mod.json'), { manifest: 1 });
      await rm(join(folder, 'mod.json'));
      await symlink(join(outside, 'mod.json'), join(folder, 'mod.json'));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /mod\.json is a symbolic link/);
    });

    it('rejects a token path that leaves the skin folder', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeJson(join(folder, 'tokens.json'), { scenes: { tavern: { backdrop: '../other/sprites/a.png' } } });
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /tokens\.json: scenes\.tavern\.backdrop/);
    });

    it('rejects a missing sheet sprite in any scene block', async () => {
      const folder = await installSampleSkin(modsRoot);
      await rm(join(folder, 'sprites/office-night-call.png'));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /sprites\/office-night-call\.png is missing/);
    });

    it('rejects a host sprite symlinked out of the skin', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeFile(join(outside, 'secret.png'), PNG_BYTES);
      await rm(join(folder, 'sprites/tavern-host-idle.png'));
      await symlink(join(outside, 'secret.png'), join(folder, 'sprites/tavern-host-idle.png'));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /sprites\/tavern-host-idle\.png is a symbolic link/);
    });

    it('loads a contract 1 skin with its backdrops moved into their scenes', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeJson(join(folder, 'mod.json'), {
        manifest: 1,
        id: 'nightglass',
        name: 'Nightglass',
        version: '1.0.0',
        kind: 'skin',
        contract: 1,
      });
      await writeJson(join(folder, 'tokens.json'), {
        states: { working: '#3cc8ff' },
        sprites: { tavernBackdrop: 'sprites/tavern.png', aquariumBackdrop: 'sprites/tank.png' },
      });

      const result = await loadSkin(modsRoot, 'nightglass');

      if (result === 'not-a-skin' || !result.ok) throw new Error(JSON.stringify(result));
      expect(result.skin.tokens.scenes).toEqual({
        tavern: { backdrop: 'sprites/tavern.png' },
        aquarium: { backdrop: 'sprites/tank.png' },
      });
      expect([...result.skin.assets.keys()].sort()).toEqual(['sprites/tank.png', 'sprites/tavern.png']);
    });

    it('ignores the needs-you sound, so a missing file for it does not reject the skin', async () => {
      const folder = await installSampleSkin(modsRoot);
      await rm(join(folder, 'sounds/alarm.ogg'));

      const result = await loadSkin(modsRoot, 'nightglass');

      if (result === 'not-a-skin' || !result.ok) throw new Error(JSON.stringify(result));
      expect(result.skin.assets.has('sounds/alarm.ogg')).toBe(false);
    });

    it('rejects a referenced file that is missing', async () => {
      const folder = await installSampleSkin(modsRoot);
      await rm(join(folder, 'sprites/tank.png'));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /sprites\/tank\.png is missing/);
    });

    it('rejects a file whose bytes do not match its extension', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeFile(join(folder, 'sprites/tank.png'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /sprites\/tank\.png is not a valid \.png file/);
    });

    it('rejects unknown keys in tokens.json and names them', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeJson(join(folder, 'tokens.json'), { states: { working: '#000000' }, stylesheet: 'a.css' });
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /tokens\.json: .*stylesheet/);
    });

    it('rejects a bad colour', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeJson(join(folder, 'tokens.json'), { states: { working: 'red' } });
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /states\.working: must be a #rrggbb colour/);
    });

    it('rejects malformed JSON', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeFile(join(folder, 'tokens.json'), '{ "states": ');
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /tokens\.json is not valid JSON/);
    });

    it('rejects a manifest whose id does not match its folder, and keeps the name for the picker', async () => {
      await installSampleSkin(modsRoot, 'renamed');
      const result = await loadSkin(modsRoot, 'renamed');
      expectRejected(result, /does not match the folder name/);
      expect(result).toMatchObject({ name: 'Nightglass' });
    });

    it('rejects a skin written for another contract', async () => {
      const folder = await installSampleSkin(modsRoot);
      await writeJson(join(folder, 'mod.json'), {
        manifest: 1,
        id: 'nightglass',
        name: 'Nightglass',
        version: '3.0.0',
        kind: 'skin',
        contract: 3,
      });
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /skin contract 3; this app reads contract 1 or 2/);
    });

    it('rejects a folder without mod.json or tokens.json', async () => {
      await mkdir(join(modsRoot, 'empty'));
      expectRejected(await loadSkin(modsRoot, 'empty'), /mod\.json is missing/);
      const folder = await installSampleSkin(modsRoot);
      await rm(join(folder, 'tokens.json'));
      expectRejected(await loadSkin(modsRoot, 'nightglass'), /tokens\.json is missing/);
    });

    it('rejects a folder name that is not a mod id', async () => {
      await mkdir(join(modsRoot, 'Bad Name'));
      expectRejected(await loadSkin(modsRoot, 'Bad Name'), /not a valid mod id/);
    });
  });

  describe('loadSkins', () => {
    it('lists valid and broken skins by id and ignores loose files and dot-folders', async () => {
      await installSampleSkin(modsRoot);
      await mkdir(join(modsRoot, 'broken-one'));
      await mkdir(join(modsRoot, '.trash'));
      await writeFile(join(modsRoot, 'readme.txt'), 'x');

      const results = await loadSkins(modsRoot);

      expect(results.map(result => [result.ok ? result.skin.manifest.id : result.id, result.ok])).toEqual([
        ['broken-one', false],
        ['nightglass', true],
      ]);
    });

    it('is empty when the mods folder does not exist yet', async () => {
      expect(await loadSkins(join(modsRoot, 'missing'))).toEqual([]);
    });
  });

  describe('sound packs', () => {
    const manifestOf = (folder: string) => join(folder, 'mod.json');

    it('loads the sample pack with only its referenced files as assets', async () => {
      const folder = await installSamplePack(modsRoot);
      await writeFile(join(folder, 'sounds/unused.ogg'), OGG_BYTES);

      const result = await loadSoundPack(modsRoot, 'chimes');

      if (result === 'not-a-sound-pack' || !result.ok) throw new Error(JSON.stringify(result));
      expect(result.pack.manifest.name).toBe('Chimes');
      expect([...result.pack.assets.keys()].sort()).toEqual([
        'sounds/approval.ogg',
        'sounds/done.ogg',
        'sounds/error.ogg',
        'sounds/finale.ogg',
      ]);
      expect(result.pack.assets.get('sounds/done.ogg')).toMatchObject({ type: 'ogg', size: OGG_BYTES.length });
    });

    it('is skipped by the skin loader, and skins and broken folders are skipped by the pack loader', async () => {
      await installSamplePack(modsRoot);
      await installSampleSkin(modsRoot);
      await mkdir(join(modsRoot, 'no-manifest'));
      const brokenJson = join(modsRoot, 'bad-json');
      await mkdir(brokenJson);
      await writeFile(manifestOf(brokenJson), '{ nope');

      expect((await loadSkins(modsRoot)).map(result => (result.ok ? result.skin.manifest.id : result.id))).toEqual([
        'bad-json',
        'nightglass',
        'no-manifest',
      ]);
      expect((await loadSoundPacks(modsRoot)).map(result => (result.ok ? result.pack.manifest.id : result.id))).toEqual(
        ['chimes']
      );
      expect(await loadSkin(modsRoot, 'chimes')).toBe('not-a-skin');
      expect(await loadSoundPack(modsRoot, 'nightglass')).toBe('not-a-sound-pack');
    });

    it('rejects a pack that sets a needs-you sound', async () => {
      const folder = await installSamplePack(modsRoot);
      await writeJson(manifestOf(folder), {
        manifest: 1,
        id: 'chimes',
        name: 'Chimes',
        version: '1.0.0',
        kind: 'sounds',
        contract: 1,
        sounds: { 'needs-you': 'sounds/done.ogg' },
      });
      const result = await loadSoundPack(modsRoot, 'chimes');
      expect(result).toMatchObject({ ok: false, id: 'chimes', error: expect.stringContaining('needs-you') });
    });

    it.each([
      [
        'a missing sound file',
        async (folder: string) => rm(join(folder, 'sounds/done.ogg')),
        /sounds\/done.ogg is missing/,
      ],
      [
        'a file that is not audio',
        async (folder: string) => writeFile(join(folder, 'sounds/done.ogg'), PNG_BYTES),
        /not a valid \.ogg file/,
      ],
      [
        'a sound over the size cap',
        async (folder: string) => writeFile(join(folder, 'sounds/done.ogg'), Buffer.alloc(1024 * 1024 + 1)),
        /over the 1 MB limit/,
      ],
      [
        'a document in the folder',
        async (folder: string) => writeFile(join(folder, 'index.html'), '<script></script>'),
        /file type is not allowed/,
      ],
      [
        'a symbolic link',
        async (folder: string) => symlink(outside, join(folder, 'sounds/link.ogg')),
        /is a symbolic link/,
      ],
    ])('rejects %s', async (_label, break_, reason) => {
      const folder = await installSamplePack(modsRoot);
      await break_(folder);
      const result = await loadSoundPack(modsRoot, 'chimes');
      if (result === 'not-a-sound-pack' || result.ok)
        throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
      expect(result.error).toMatch(reason);
    });

    it('rejects another contract and a manifest id that does not match the folder', async () => {
      const folder = await installSamplePack(modsRoot);
      const manifest = { manifest: 1, id: 'chimes', name: 'Chimes', version: '1.0.0', kind: 'sounds', sounds: {} };
      await writeJson(manifestOf(folder), { ...manifest, contract: 2 });
      expect(await loadSoundPack(modsRoot, 'chimes')).toMatchObject({
        ok: false,
        error: expect.stringContaining('contract 2'),
      });
      await writeJson(manifestOf(folder), { ...manifest, contract: 1, id: 'other-pack' });
      expect(await loadSoundPack(modsRoot, 'chimes')).toMatchObject({
        ok: false,
        error: expect.stringContaining('does not match'),
      });
    });
  });
});

describe('skin protocol', () => {
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

    it('serves a cast sheet sprite from a scene block', async () => {
      const response = await serveSkinAsset(skins, 'b4m-skin://nightglass/sprites/office-night-work.png');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
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
      ['the locked needs-you sound', 'b4m-skin://nightglass/sounds/alarm.ogg'],
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

    it.skipIf(process.platform === 'win32')('refuses a served file swapped for a link after the scan', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'skin-outside-'));
      try {
        await writeFile(join(outside, 'tank.png'), PNG_BYTES);
        await rm(join(folder, 'sprites/tank.png'));
        await symlink(join(outside, 'tank.png'), join(folder, 'sprites/tank.png'));
        expect((await serveSkinAsset(skins, 'b4m-skin://nightglass/sprites/tank.png')).status).toBe(404);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('refuses a sprites folder swapped for a link after the scan', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'skin-outside-'));
      try {
        await writeFile(join(outside, 'tank.png'), PNG_BYTES);
        await rm(join(folder, 'sprites'), { recursive: true });
        await symlink(outside, join(folder, 'sprites'));
        expect((await serveSkinAsset(skins, 'b4m-skin://nightglass/sprites/tank.png')).status).toBe(404);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
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
});
