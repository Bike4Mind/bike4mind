import { useCallback, useSyncExternalStore } from 'react';

/**
 * The orchestrator's optional sound: a short chime when an agent needs the user and when a run
 * finishes. Per-machine and opt-in, so localStorage with an OFF default, read through a store the
 * same way as worktreeDefault.ts (the Settings switch and the players read it independently).
 */

const STORAGE_KEY = 'b4m.orchestrator.sound';
// Two rising notes (Hz), each NOTE_SECONDS long and NOTE_GAP apart; quiet enough to sit under speech.
const NOTES = [659.25, 880] as const;
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

/** Plays the chime if the setting is on. Synthesised, so the app ships no audio file. */
export function playChime(): void {
  if (!enabled || typeof AudioContext !== 'function') return;
  context ??= new AudioContext();
  const audio = context;
  // A context created before any user gesture starts suspended; resuming may be refused, which only costs this chime.
  if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
  NOTES.forEach((frequency, index) => {
    const start = audio.currentTime + index * NOTE_GAP;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_SECONDS);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + NOTE_SECONDS);
  });
}
