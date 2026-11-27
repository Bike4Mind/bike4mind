import { describe, expect, it } from 'vitest';
import manifestFixture from './__fixtures__/skins/nightglass/mod.json';
import tokensFixture from './__fixtures__/skins/nightglass/tokens.json';
import packFixture from './__fixtures__/sound-packs/chimes/mod.json';
import {
  SOUND_PACK_EVENTS,
  mapSceneSkinAssets,
  modManifestSchema,
  sceneSkinAssetPaths,
  skinAssetUrl,
  skinTokensSchema,
  skinTokensSchemaFor,
  skinTokensV1Schema,
} from './mods';

describe('modManifestSchema', () => {
  it('accepts the sample skin', () => {
    expect(modManifestSchema.safeParse(manifestFixture).success).toBe(true);
  });

  it.each([
    ['an unknown key', { script: 'run.js' }],
    ['an uppercase id', { id: 'Nightglass' }],
    ['an id with a path in it', { id: '../other' }],
    ['a one-character id', { id: 'n' }],
    ['an all-digit id', { id: '42' }],
    ['a longer all-digit id', { id: '1234' }],
    ['a hex-looking id', { id: '0x1f' }],
    ['a non-semver version', { version: 'v1' }],
    ['an unknown kind', { kind: 'theme' }],
    ['a fractional contract', { contract: 1.5 }],
    ['a name over 60 characters', { name: 'x'.repeat(61) }],
    ['a skin with an entry document', { entry: 'index.html' }],
    ['a skin asking for permissions', { permissions: ['read:snippets'] }],
    ['manifest version 2', { manifest: 2 }],
  ])('rejects %s', (_label, patch) => {
    expect(modManifestSchema.safeParse({ ...manifestFixture, ...patch }).success).toBe(false);
  });

  it.each(['nightglass', 'a1', '2d-skin'])('accepts the id %s', id => {
    expect(modManifestSchema.safeParse({ ...manifestFixture, id }).success).toBe(true);
  });

  it('lets a view carry an entry document', () => {
    expect(modManifestSchema.safeParse({ ...manifestFixture, kind: 'view', entry: 'index.html' }).success).toBe(true);
  });
});

describe('skinTokensSchema', () => {
  it('accepts the sample skin and an empty one', () => {
    expect(skinTokensSchema.safeParse(tokensFixture).success).toBe(true);
    expect(skinTokensSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ['an unknown top-level key', { css: 'body{}' }],
    ['an unknown state', { states: { sleeping: '#000000' } }],
    ['an unknown surface', { surfaces: { stage: '#000000', html: '#000000' } }],
    ['a free-form font family', { type: { family: 'Comic Sans; } body { display:none' } }],
  ])('rejects %s', (_label, tokens) => {
    expect(skinTokensSchema.safeParse(tokens).success).toBe(false);
  });

  it.each(['red', '#fff', '#12345g', '#1234567', 'url(x)', 'var(--x)', 'rgb(0,0,0)', ' #123456'])(
    'rejects the colour %j',
    color => {
      expect(skinTokensSchema.safeParse({ states: { working: color } }).success).toBe(false);
      expect(skinTokensSchema.safeParse({ surfaces: { stage: color } }).success).toBe(false);
    }
  );

  it.each([
    'sprites/a.svg',
    'sprites/a.gif',
    'sprites/a.html',
    'sprites/a.js',
    'sprites/a.css',
    'sprites/a.png.js',
    'sounds/a.mp3',
  ])('rejects the sprite path %j for a disallowed type or folder', path => {
    expect(skinTokensSchema.safeParse({ scenes: { tavern: { backdrop: path } } }).success).toBe(false);
    expect(skinTokensV1Schema.safeParse({ sprites: { tavernBackdrop: path } }).success).toBe(false);
  });

  it.each(['sounds/a.wav', 'sounds/a.html', 'sprites/a.ogg'])('rejects the sound path %j', path => {
    expect(skinTokensSchema.safeParse({ sounds: { finale: path } }).success).toBe(false);
  });

  it.each([
    '../sprites/a.png',
    'sprites/../../a.png',
    'sprites/../a.png',
    '/etc/a.png',
    'C:\\a.png',
    'sprites\\..\\a.png',
    'sprites/sub/a.png',
    'sprites/.hidden.png',
    'file:///etc/a.png',
    'https://example.com/a.png',
  ])('rejects the path %j that could leave the skin folder', path => {
    expect(skinTokensSchema.safeParse({ scenes: { tavern: { backdrop: path } } }).success).toBe(false);
    expect(
      skinTokensSchema.safeParse({ scenes: { office: { cast: { host: { sprites: { idle: path } } } } } }).success
    ).toBe(false);
    expect(skinTokensV1Schema.safeParse({ sprites: { tavernBackdrop: path } }).success).toBe(false);
  });

  it.each([
    ['the contract 1 sprites key', { sprites: { tavernBackdrop: 'sprites/a.png' } }],
    ['a scene id that is not a kebab name', { scenes: { Tavern: {} } }],
    ['an unknown key in a scene block', { scenes: { tavern: { script: 'a.js' } } }],
    ['an unknown map key', { scenes: { tavern: { map: { states: {} } } } }],
    ['a slot off the scene', { scenes: { tavern: { map: { zones: { bar: { slots: [{ x: 101, y: 4 }] } } } } } }],
    ['an empty slot list', { scenes: { tavern: { map: { zones: { bar: { slots: [] } } } } } }],
    ['a reply with no side', { scenes: { tavern: { map: { reply: { top: 3 } } } } }],
    ['an empty sheet list', { scenes: { tavern: { cast: { sheets: [] } } } }],
    ['sprites too small to see', { scenes: { tavern: { cast: { spriteHeight: 0.01 } } } }],
    ['an unknown host pose', { scenes: { tavern: { cast: { host: { sprites: { dancing: 'sprites/a.png' } } } } } }],
    ['an empty copy line', { scenes: { tavern: { copy: { hostName: '' } } } }],
    ['copy that tries to change the needs-you look', { scenes: { tavern: { copy: { needsYou: 'x' } } } }],
    [
      'more than 16 scenes',
      { scenes: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`scene-${index}`, {}])) },
    ],
  ])('rejects %s', (_label, tokens) => {
    expect(skinTokensSchema.safeParse(tokens).success).toBe(false);
  });

  it('accepts a block for a scene this app does not have yet', () => {
    expect(skinTokensSchema.safeParse({ scenes: { lighthouse: { backdrop: 'sprites/lighthouse.png' } } }).success).toBe(
      true
    );
  });
});

describe('skinTokensSchemaFor', () => {
  it("moves a contract 1 skin's backdrops into their scenes", () => {
    const tokens = skinTokensSchemaFor(1).parse({
      states: { working: '#3cc8ff' },
      sprites: { tavernBackdrop: 'sprites/tavern.png', aquariumBackdrop: 'sprites/tank.png' },
    });
    expect(tokens).toEqual({
      states: { working: '#3cc8ff' },
      scenes: { tavern: { backdrop: 'sprites/tavern.png' }, aquarium: { backdrop: 'sprites/tank.png' } },
    });
  });

  it('leaves a contract 1 skin with no backdrops without a scenes block', () => {
    expect(skinTokensSchemaFor(1).parse({ type: { family: 'mono' } })).toEqual({ type: { family: 'mono' } });
  });

  it('refuses contract 2 scene data in a contract 1 skin, and contract 1 sprites in a contract 2 one', () => {
    expect(skinTokensSchemaFor(1).safeParse({ scenes: {} }).success).toBe(false);
    expect(skinTokensSchemaFor(2).safeParse({ sprites: {} }).success).toBe(false);
  });
});

describe('scene skin assets', () => {
  const block = skinTokensSchema.parse(tokensFixture).scenes?.office ?? {};

  it('lists the backdrop, every sheet sprite and every host sprite', () => {
    expect(sceneSkinAssetPaths(block)).toEqual([
      'sprites/office.png',
      'sprites/office-night-work.png',
      'sprites/office-night-call.png',
      'sprites/office-night-rest.png',
      'sprites/office-night-idle.png',
    ]);
  });

  it('maps every image path and leaves positions and copy alone', () => {
    const mapped = mapSceneSkinAssets(block, path => `x://${path}`);
    expect(sceneSkinAssetPaths(mapped).every(path => path.startsWith('x://sprites/'))).toBe(true);
    expect(mapped.map).toEqual(block.map);
    expect(mapped.copy).toEqual(block.copy);
  });
});

describe('skinAssetUrl', () => {
  it('puts the skin id in the host', () => {
    expect(skinAssetUrl('nightglass', 'sprites/tank.png')).toBe('b4m-skin://nightglass/sprites/tank.png');
  });
});

describe('a sounds manifest', () => {
  it('accepts the sample pack and narrows on kind', () => {
    const parsed = modManifestSchema.safeParse(packFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'sounds') {
      expect(Object.keys(parsed.data.sounds).sort()).toEqual([...SOUND_PACK_EVENTS].sort());
    } else {
      throw new Error('expected a sounds manifest');
    }
  });

  it('may set any subset of the events, or none', () => {
    expect(modManifestSchema.safeParse({ ...packFixture, sounds: { finale: 'sounds/f.mp3' } }).success).toBe(true);
    expect(modManifestSchema.safeParse({ ...packFixture, sounds: {} }).success).toBe(true);
  });

  it.each([
    ['a needs-you sound', { 'needs-you': 'sounds/alarm.ogg' }],
    ['an unknown event', { 'agent-started': 'sounds/start.ogg' }],
    ['a path outside sounds/', { finale: '../finale.ogg' }],
    ['a nested path', { finale: 'sounds/deep/finale.ogg' }],
    ['a file type that is not audio', { finale: 'sounds/finale.wav' }],
    ['an absolute path', { finale: '/etc/passwd.ogg' }],
  ])('rejects %s', (_label, sounds) => {
    expect(modManifestSchema.safeParse({ ...packFixture, sounds }).success).toBe(false);
  });

  it('rejects the needs-you entry alongside valid ones, so it is never applied', () => {
    const result = modManifestSchema.safeParse({
      ...packFixture,
      sounds: { ...packFixture.sounds, 'needs-you': 'sounds/alarm.ogg' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a pack with no sounds map, with an entry or with permissions', () => {
    const { sounds: _sounds, ...withoutSounds } = packFixture;
    expect(modManifestSchema.safeParse(withoutSounds).success).toBe(false);
    expect(modManifestSchema.safeParse({ ...packFixture, entry: 'index.html' }).success).toBe(false);
    expect(modManifestSchema.safeParse({ ...packFixture, permissions: ['x'] }).success).toBe(false);
  });

  it('rejects a sounds map on a skin', () => {
    expect(modManifestSchema.safeParse({ ...manifestFixture, sounds: packFixture.sounds }).success).toBe(false);
  });
});
