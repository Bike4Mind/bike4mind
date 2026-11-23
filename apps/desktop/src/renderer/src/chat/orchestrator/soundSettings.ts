import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { SOUND_PACK_EVENTS, type SoundPackEvent } from '@shared/mods';

/**
 * The sound mix: one master volume and an on/off per event, kept per machine in localStorage like the
 * master switch in chime.ts (which is the global mute: off silences everything). Reduced motion is
 * deliberately not consulted anywhere: it asks for less movement, not for silence.
 */

const VOLUME_KEY = 'b4m.orchestrator.sound.volume';
const EVENTS_KEY = 'b4m.orchestrator.sound.events';

/** What the finale sound has always played at, so an untouched volume changes nothing. */
export const DEFAULT_VOLUME = 0.6;

/** The finale was the only sound before packs, so it stays on; the new moments are opt-in. */
export const DEFAULT_EVENT_TOGGLES: Readonly<Record<SoundPackEvent, boolean>> = {
  'agent-done': false,
  'agent-error': false,
  'approval-requested': false,
  finale: true,
};

export const SOUND_EVENT_LABEL: Record<SoundPackEvent, string> = {
  'agent-done': 'An agent finishes',
  'agent-error': 'An agent fails',
  'approval-requested': 'An approval is requested',
  finale: 'The run finishes',
};

const storedToggles = z.partialRecord(z.enum(SOUND_PACK_EVENTS), z.boolean());

export interface SoundSettings {
  /** 0 to 1. */
  volume: number;
  toggles: Readonly<Record<SoundPackEvent, boolean>>;
}

const clampVolume = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;

function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a settings click.
  }
}

function readSettings(): SoundSettings {
  const rawVolume = readItem(VOLUME_KEY);
  const volume = rawVolume === null || rawVolume.trim() === '' ? DEFAULT_VOLUME : clampVolume(Number(rawVolume));
  let overrides: z.infer<typeof storedToggles> = {};
  try {
    const raw = readItem(EVENTS_KEY);
    const parsed = raw === null ? undefined : storedToggles.safeParse(JSON.parse(raw));
    if (parsed?.success) overrides = parsed.data;
  } catch {
    // Unreadable JSON: the defaults.
  }
  return { volume, toggles: { ...DEFAULT_EVENT_TOGGLES, ...overrides } };
}

let settings = readSettings();
const listeners = new Set<() => void>();

function publish(next: SoundSettings): void {
  settings = next;
  for (const listener of listeners) listener();
}

export const soundSettings = (): SoundSettings => settings;

export function setSoundVolume(volume: number): void {
  const next = clampVolume(volume);
  if (next === settings.volume) return;
  writeItem(VOLUME_KEY, String(next));
  publish({ ...settings, volume: next });
}

export function setSoundEventEnabled(event: SoundPackEvent, enabled: boolean): void {
  if (settings.toggles[event] === enabled) return;
  const toggles = { ...settings.toggles, [event]: enabled };
  writeItem(EVENTS_KEY, JSON.stringify(toggles));
  publish({ ...settings, toggles });
}

export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    soundSettings,
    soundSettings
  );
}
