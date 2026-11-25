import { useCallback, useSyncExternalStore } from 'react';
import type { SoundPackEvent } from '@shared/mods';
import { DEFAULT_VOLUME, soundSettings } from './soundSettings';

/**
 * The orchestrator's optional sound: a short chime when an agent needs the user, and a sound for each
 * moment of a run (SoundPackEvent). Per-machine and opt-in, so localStorage with an OFF default, read
 * through a store the same way as worktreeDefault.ts (the Settings switch and the players read it
 * independently). That switch is the global mute: off, nothing plays. The volume and the per-event
 * toggles live in soundSettings.ts.
 */

const STORAGE_KEY = 'b4m.orchestrator.sound';
// Each sound is a few notes (Hz), NOTE_SECONDS long and NOTE_GAP apart; quiet enough to sit under speech.
const NEEDS_YOU_NOTES = [659.25, 880] as const;
const EVENT_NOTES: Record<SoundPackEvent, readonly number[]> = {
  // The finale keeps the two rising notes it always had.
  finale: [659.25, 880],
  'agent-done': [783.99],
  'agent-error': [440, 329.63],
  'approval-requested': [587.33, 587.33],
};
const NOTE_SECONDS = 0.35;
const NOTE_GAP = 0.12;
const PEAK_GAIN = 0.08;

let enabled = readStored();
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Storage blocked: off, the default.
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function orchestratorSoundOn(): boolean {
  return enabled;
}

export function setOrchestratorSound(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a settings click.
  }
  for (const listener of listeners) listener();
}

export function useOrchestratorSound(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, orchestratorSoundOn, orchestratorSoundOn);
  const toggle = useCallback(() => setOrchestratorSound(!orchestratorSoundOn()), []);
  return [value, toggle];
}

let context: AudioContext | null = null;
let playingFile: HTMLAudioElement | null = null;
let playingTones: OscillatorNode[] = [];
// While the needs-you chime is sounding nothing else may start: it is the one that must be heard.
let needsYouUntil = 0;
// The approval sound is the one event that always coincides with the needs-you chime (same transition),
// so rather than being dropped or cut it waits for the chime to end. `until` is null while a file plays.
const DEFERRED_GAP_MS = 80;
let playingApproval: { url?: string; until: number | null } | null = null;
let deferredApproval: ReturnType<typeof setTimeout> | null = null;

function stopPlaying(): void {
  playingApproval = null;
  playingFile?.pause();
  playingFile = null;
  for (const oscillator of playingTones) {
    try {
      oscillator.stop();
    } catch {
      // Already stopped.
    }
  }
  playingTones = [];
}

/**
 * The needs-you chime, if the master switch is on. Always the built-in tones (that sound is locked,
 * statePalette.ts), it cuts whatever is playing and cannot itself be cut by a later sound.
 */
export function playChime(): void {
  if (!enabled) return;
  const cut = playingApproval && (playingApproval.until === null || Date.now() < playingApproval.until);
  const cutUrl = playingApproval?.url;
  stopPlaying();
  needsYouUntil = Date.now() + noteSpanMs(NEEDS_YOU_NOTES);
  // Always at the base level: the master volume is for the event sounds, never for this one.
  playTones(NEEDS_YOU_NOTES, PEAK_GAIN);
  if (cut) deferApproval(cutUrl);
}

function deferApproval(soundUrl: string | undefined): void {
  if (deferredApproval) clearTimeout(deferredApproval);
  deferredApproval = setTimeout(
    () => {
      deferredApproval = null;
      playSoundEvent('approval-requested', soundUrl);
    },
    Math.max(0, needsYouUntil - Date.now()) + DEFERRED_GAP_MS
  );
}

/**
 * Plays one event's sound if the master switch and that event's toggle are on and no needs-you chime
 * is sounding. A sound still playing is cut first, so a long one never drowns out the next. `soundUrl`
 * is a pack's or skin's file (served by main over b4m-skin:); without one, or if it cannot play, the
 * event's built-in tones play. Reduced motion is not a reason to stay silent.
 */
export function playSoundEvent(event: SoundPackEvent, soundUrl?: string): void {
  if (!enabled) return;
  const { volume, toggles } = soundSettings();
  if (!toggles[event]) return;
  if (Date.now() < needsYouUntil) {
    if (event === 'approval-requested') deferApproval(soundUrl);
    return;
  }
  stopPlaying();
  if (soundUrl && typeof Audio === 'function') {
    const audio = new Audio(soundUrl);
    audio.volume = volume;
    playingFile = audio;
    if (event === 'approval-requested') {
      playingApproval = { url: soundUrl, until: null };
      audio.onended = () => {
        if (playingFile === audio) playingApproval = null;
      };
    }
    audio.play().catch(() => {
      // Only the sound that failed is replaced, never a newer one that has since started.
      if (playingFile === audio) playTones(EVENT_NOTES[event], eventPeak());
    });
    return;
  }
  if (event === 'approval-requested') {
    playingApproval = { url: soundUrl, until: Date.now() + noteSpanMs(EVENT_NOTES[event]) };
  }
  playTones(EVENT_NOTES[event], eventPeak());
}

const eventPeak = (): number => PEAK_GAIN * (soundSettings().volume / DEFAULT_VOLUME);

const noteSpanMs = (notes: readonly number[]): number => ((notes.length - 1) * NOTE_GAP + NOTE_SECONDS) * 1000;

function playTones(notes: readonly number[], peak: number): void {
  if (typeof AudioContext !== 'function') return;
  context ??= new AudioContext();
  const audio = context;
  // A context created before any user gesture starts suspended; resuming may be refused, which only costs this chime.
  if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
  notes.forEach((frequency, index) => {
    const start = audio.currentTime + index * NOTE_GAP;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(Math.max(peak, 0.0001), start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_SECONDS);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + NOTE_SECONDS);
    playingTones.push(oscillator);
  });
}
