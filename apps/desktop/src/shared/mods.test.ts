import { describe, expect, it } from 'vitest';
import manifestFixture from './__fixtures__/skins/nightglass/mod.json';
import tokensFixture from './__fixtures__/skins/nightglass/tokens.json';
import { modManifestSchema, skinAssetUrl, skinTokensSchema } from './mods';

describe('modManifestSchema', () => {
  it('accepts the sample skin', () => {
    expect(modManifestSchema.safeParse(manifestFixture).success).toBe(true);
  });

  it.each([
    ['an unknown key', { script: 'run.js' }],
    ['an uppercase id', { id: 'Nightglass' }],
    ['an id with a path in it', { id: '../other' }],
    ['a one-character id', { id: 'n' }],
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
    expect(skinTokensSchema.safeParse({ sprites: { tavernBackdrop: path } }).success).toBe(false);
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
    expect(skinTokensSchema.safeParse({ sprites: { tavernBackdrop: path } }).success).toBe(false);
  });
});

describe('skinAssetUrl', () => {
  it('puts the skin id in the host', () => {
    expect(skinAssetUrl('nightglass', 'sprites/tank.png')).toBe('b4m-skin://nightglass/sprites/tank.png');
  });
});
