// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
