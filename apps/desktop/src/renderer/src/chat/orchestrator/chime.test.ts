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

  it('does nothing where Web Audio is missing', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const chime = await load();
    chime.setOrchestratorSound(true);
    expect(() => chime.playChime()).not.toThrow();
  });
});
