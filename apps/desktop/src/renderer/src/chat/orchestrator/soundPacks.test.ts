// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { SoundPackSummary } from '@shared/mods';
import { resetSoundPacksForTests, resolveEventSound, selectSoundPack, soundPacksState } from './soundPacks';

const pack = (id: string, sounds: Extract<SoundPackSummary, { status: 'ok' }>['sounds']): SoundPackSummary => ({
  status: 'ok',
  id,
  name: id,
  version: '1.0.0',
  sounds,
});

describe('resolveEventSound', () => {
  const packSounds = { finale: 'b4m-skin://pack/sounds/finale.ogg', 'agent-done': 'b4m-skin://pack/sounds/done.ogg' };

  it('prefers the pack over the skin for finale', () => {
    expect(resolveEventSound('finale', { packSounds, skinFinale: 'b4m-skin://skin/sounds/finale.ogg' })).toBe(
      packSounds.finale
    );
  });

  it('falls back to the skin finale when the pack sets none, and to nothing without either', () => {
    const skinFinale = 'b4m-skin://skin/sounds/finale.ogg';
    expect(resolveEventSound('finale', { packSounds: { 'agent-done': packSounds['agent-done'] }, skinFinale })).toBe(
      skinFinale
    );
    expect(resolveEventSound('finale', { skinFinale })).toBe(skinFinale);
    expect(resolveEventSound('finale', {})).toBeUndefined();
  });

  it('never takes the other events from a skin', () => {
    expect(resolveEventSound('agent-done', { skinFinale: 'b4m-skin://skin/sounds/finale.ogg' })).toBeUndefined();
    expect(resolveEventSound('agent-done', { packSounds })).toBe(packSounds['agent-done']);
    expect(resolveEventSound('agent-error', { packSounds })).toBeUndefined();
  });
});

describe('the active sound pack', () => {
  beforeEach(() => window.localStorage.clear());

  it('is one at a time, and picking another replaces it', () => {
    resetSoundPacksForTests([pack('one', {}), pack('two', {})], null);
    selectSoundPack('one');
    expect(soundPacksState().active?.id).toBe('one');
    selectSoundPack('two');
    expect(soundPacksState().active?.id).toBe('two');
    selectSoundPack(null);
    expect(soundPacksState().active).toBeNull();
  });

  it('keeps a broken or missing pick inactive but remembered', () => {
    resetSoundPacksForTests([{ status: 'broken', id: 'bad', error: 'nope' }], 'bad');
    expect(soundPacksState().active).toBeNull();
    expect(soundPacksState().selectedId).toBe('bad');
    resetSoundPacksForTests([], 'gone');
    expect(soundPacksState().active).toBeNull();
  });
});
