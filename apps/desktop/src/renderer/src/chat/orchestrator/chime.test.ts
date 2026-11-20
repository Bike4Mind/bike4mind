// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('playChime', () => {
  function fakeAudio() {
    const started: number[] = [];
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
          gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
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
