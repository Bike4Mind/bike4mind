// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoundPackSummary } from '@shared/mods';
import { resetSoundPacksForTests, resolveEventSound, selectSoundPack, soundPacksState } from './soundPacks';

const SOUND_KEY = 'b4m.orchestrator.sound';

async function load() {
  vi.resetModules();
  return import('./chime');
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the orchestrator sound setting', () => {
  it('defaults off and remembers a change', async () => {
    const chime = await load();
    expect(chime.orchestratorSoundOn()).toBe(false);
    chime.setOrchestratorSound(true);
    expect(chime.orchestratorSoundOn()).toBe(true);
    expect(window.localStorage.getItem(SOUND_KEY)).toBe('1');

    const reloaded = await load();
    expect(reloaded.orchestratorSoundOn()).toBe(true);
  });
});

const peaks: number[] = [];

describe('playChime', () => {
  function fakeAudio() {
    const started: number[] = [];
    peaks.length = 0;
    class FakeContext {
      currentTime = 0;
      destination = {};
      state = 'running';
      createOscillator() {
        return {
          type: '',
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: (at: number) => started.push(at),
          stop: vi.fn(),
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: (value: number) => peaks.push(value),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        };
      }
      resume = vi.fn(async () => undefined);
    }
    vi.stubGlobal('AudioContext', FakeContext);
    return started;
  }

  it('stays silent while the setting is off', async () => {
    const started = fakeAudio();
    const chime = await load();
    chime.playChime();
    expect(started).toEqual([]);
  });

  it('plays two short notes once the setting is on', async () => {
    const started = fakeAudio();
    const chime = await load();
    chime.setOrchestratorSound(true);
    chime.playChime();
    expect(started).toHaveLength(2);
    expect(started[1]).toBeGreaterThan(started[0]);
  });

  function fakeFiles() {
    const files: { url: string; volume: number; pause: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      'Audio',
      class {
        volume = 1;
        pause = vi.fn();
        play = vi.fn(async () => undefined);
        constructor(public url: string) {
          files.push(this as unknown as (typeof files)[number]);
        }
      }
    );
    return files;
  }

  it('cuts a playing sound when a newer one starts', async () => {
    fakeAudio();
    const files = fakeFiles();
    const chime = await load();
    chime.setOrchestratorSound(true);
    chime.playSoundEvent('finale', 'b4m-skin://nightglass/sounds/finale.ogg');
    expect(files[0].pause).not.toHaveBeenCalled();
    chime.playSoundEvent('finale');
    expect(files[0].pause).toHaveBeenCalledTimes(1);
    chime.playSoundEvent('finale');
    expect(files[0].pause).toHaveBeenCalledTimes(1);
  });

  it('plays a pack file at the master volume', async () => {
    fakeAudio();
    const files = fakeFiles();
    const chime = await load();
    const settings = await import('./soundSettings');
    chime.setOrchestratorSound(true);
    settings.setSoundVolume(0.25);
    chime.playSoundEvent('finale', 'b4m-skin://pack/sounds/done.ogg');
    expect(files[0].volume).toBe(0.25);
  });

  it('falls back to the built-in tones when the file cannot play', async () => {
    const started = fakeAudio();
    vi.stubGlobal(
      'Audio',
      class {
        volume = 1;
        pause = vi.fn();
        play = vi.fn(async () => Promise.reject(new Error('blocked')));
      }
    );
    const chime = await load();
    chime.setOrchestratorSound(true);
    chime.playSoundEvent('finale', 'b4m-skin://pack/sounds/finale.ogg');
    await vi.waitFor(() => expect(started).toHaveLength(2));
  });

  describe('the master switch, toggles and reduced motion', () => {
    it('plays nothing for any event while globally muted, even with every toggle on', async () => {
      const started = fakeAudio();
      const chime = await load();
      const settings = await import('./soundSettings');
      for (const event of ['agent-done', 'agent-error', 'approval-requested', 'finale'] as const) {
        settings.setSoundEventEnabled(event, true);
        chime.playSoundEvent(event);
      }
      chime.playChime();
      expect(started).toEqual([]);
    });

    it('honours each event toggle, with only the finale on by default', async () => {
      const started = fakeAudio();
      const chime = await load();
      const settings = await import('./soundSettings');
      chime.setOrchestratorSound(true);
      chime.playSoundEvent('agent-done');
      chime.playSoundEvent('agent-error');
      chime.playSoundEvent('approval-requested');
      expect(started).toEqual([]);
      settings.setSoundEventEnabled('agent-done', true);
      chime.playSoundEvent('agent-done');
      expect(started).toHaveLength(1);
      chime.playSoundEvent('agent-error');
      expect(started).toHaveLength(1);
      chime.playSoundEvent('finale');
      expect(started).toHaveLength(3);
      settings.setSoundEventEnabled('finale', false);
      chime.playSoundEvent('finale');
      expect(started).toHaveLength(3);
    });

    it('still plays under prefers-reduced-motion', async () => {
      const started = fakeAudio();
      vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({ matches: query.includes('reduce'), addEventListener: vi.fn() }))
      );
      const chime = await load();
      chime.setOrchestratorSound(true);
      chime.playSoundEvent('finale');
      chime.playChime();
      expect(started).toHaveLength(4);
    });
  });

  describe('priority', () => {
    afterEach(() => vi.useRealTimers());

    it('drops an event sound that arrives while the needs-you chime is sounding, then plays it after', async () => {
      vi.useFakeTimers();
      const started = fakeAudio();
      const chime = await load();
      chime.setOrchestratorSound(true);
      chime.playChime();
      expect(started).toHaveLength(2);
      chime.playSoundEvent('finale');
      expect(started).toHaveLength(2);
      vi.advanceTimersByTime(1000);
      chime.playSoundEvent('finale');
      expect(started).toHaveLength(4);
    });

    it('cuts a playing event sound, tones and files alike, when the needs-you chime starts', async () => {
      fakeAudio();
      const files = fakeFiles();
      const chime = await load();
      chime.setOrchestratorSound(true);
      chime.playSoundEvent('finale', 'b4m-skin://pack/sounds/finale.ogg');
      chime.playChime();
      expect(files[0].pause).toHaveBeenCalledTimes(1);
    });

    it('keeps the needs-you chime audible at volume 0 while event sounds follow the volume', async () => {
      fakeAudio();
      const chime = await load();
      const settings = await import('./soundSettings');
      chime.setOrchestratorSound(true);
      settings.setSoundVolume(0);
      chime.playChime();
      expect(peaks.every(peak => peak >= 0.08)).toBe(true);
      peaks.length = 0;
      chime.playSoundEvent('finale');
      expect(peaks.every(peak => peak <= 0.0001)).toBe(true);
    });

    it('plays an approval sound that arrives during the needs-you chime once the chime has ended', async () => {
      vi.useFakeTimers();
      const started = fakeAudio();
      const chime = await load();
      const settings = await import('./soundSettings');
      chime.setOrchestratorSound(true);
      settings.setSoundEventEnabled('approval-requested', true);
      chime.playChime();
      chime.playSoundEvent('approval-requested');
      expect(started).toHaveLength(2);
      vi.advanceTimersByTime(1000);
      expect(started).toHaveLength(4);
    });

    it('replays an approval sound the needs-you chime cut, after the chime', async () => {
      vi.useFakeTimers();
      fakeAudio();
      const files = fakeFiles();
      const chime = await load();
      const settings = await import('./soundSettings');
      chime.setOrchestratorSound(true);
      settings.setSoundEventEnabled('approval-requested', true);
      chime.playSoundEvent('approval-requested', 'b4m-skin://pack/sounds/approval.ogg');
      chime.playChime();
      expect(files[0].pause).toHaveBeenCalledTimes(1);
      expect(files).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(files).toHaveLength(2);
      expect(files[1].url).toBe('b4m-skin://pack/sounds/approval.ogg');
    });

    it('does not replay an approval sound that had already finished when the chime started', async () => {
      vi.useFakeTimers();
      const started = fakeAudio();
      const chime = await load();
      const settings = await import('./soundSettings');
      chime.setOrchestratorSound(true);
      settings.setSoundEventEnabled('approval-requested', true);
      chime.playSoundEvent('approval-requested');
      vi.advanceTimersByTime(5000);
      chime.playChime();
      vi.advanceTimersByTime(5000);
      expect(started).toHaveLength(4);
    });

    it('never uses a file for the needs-you chime', async () => {
      fakeAudio();
      const files = fakeFiles();
      const chime = await load();
      chime.setOrchestratorSound(true);
      chime.playChime();
      expect(files).toEqual([]);
    });
  });

  it('does nothing where Web Audio is missing', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const chime = await load();
    chime.setOrchestratorSound(true);
    expect(() => chime.playChime()).not.toThrow();
  });
});

describe('soundPacks', () => {
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
});

describe('soundSettings', () => {
  async function load() {
    vi.resetModules();
    return import('./soundSettings');
  }

  beforeEach(() => window.localStorage.clear());

  describe('sound settings', () => {
    it('defaults to the old finale volume with only the finale on', async () => {
      const { soundSettings, DEFAULT_VOLUME } = await load();
      expect(soundSettings().volume).toBe(DEFAULT_VOLUME);
      expect(soundSettings().toggles).toEqual({
        'agent-done': false,
        'agent-error': false,
        'approval-requested': false,
        finale: true,
      });
    });

    it('persists the volume and the toggles across a reload', async () => {
      const first = await load();
      first.setSoundVolume(0.3);
      first.setSoundEventEnabled('agent-error', true);
      first.setSoundEventEnabled('finale', false);
      const second = await load();
      expect(second.soundSettings().volume).toBe(0.3);
      expect(second.soundSettings().toggles).toMatchObject({ 'agent-error': true, finale: false, 'agent-done': false });
    });

    it('clamps the volume to 0..1', async () => {
      const settings = await load();
      settings.setSoundVolume(7);
      expect(settings.soundSettings().volume).toBe(1);
      settings.setSoundVolume(-2);
      expect(settings.soundSettings().volume).toBe(0);
    });

    it('ignores stored values it cannot read', async () => {
      window.localStorage.setItem('b4m.orchestrator.sound.volume', 'loud');
      window.localStorage.setItem('b4m.orchestrator.sound.events', '{"finale":"yes","bogus":true}');
      const { soundSettings, DEFAULT_VOLUME } = await load();
      expect(soundSettings().volume).toBe(DEFAULT_VOLUME);
      expect(soundSettings().toggles.finale).toBe(true);
      window.localStorage.setItem('b4m.orchestrator.sound.events', 'not json');
      expect((await load()).soundSettings().toggles.finale).toBe(true);
    });
  });
});
