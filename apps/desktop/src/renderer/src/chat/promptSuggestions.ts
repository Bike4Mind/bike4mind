import { useCallback, useSyncExternalStore } from 'react';

/**
 * The switch for the composer's next-prompt hint, and the only thing that decides whether the
 * model call behind it is ever made.
 *
 * Per-machine UI state, so localStorage. It is
 * NOT stored per conversation and not sent to main: main generates a hint when it is asked for
 * one, so a renderer that never asks costs nothing, and there is no second copy of the setting
 * for the two to disagree about.
 *
 * Read from two places at once - the Customize row that toggles it and the composer that acts
 * on it - which is why it is a store with subscribers rather than a hook's own state. Two
 * `useState`s seeded from the same key would not notice each other changing it.
 */

const STORAGE_KEY = 'b4m.composer.promptSuggestions';

/** Defaults ON. The hint is the behaviour this was built to match; off is the opt-out. */
export function parseStoredPreference(raw: string | null): boolean {
  return raw !== '0';
}

/** One line for the Customize row, which is the only place the setting is described. */
export function promptSuggestionsSummary(enabled: boolean): string {
  return enabled ? 'On' : 'Off';
}

let enabled = readStored();
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return parseStoredPreference(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage blocked. The feature is on for this run, which is the default anyway.
    return true;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function promptSuggestionsEnabled(): boolean {
  return enabled;
}

export function setPromptSuggestionsEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a settings click.
  }
  for (const listener of listeners) listener();
}

/** The setting, and the toggle for it. Re-renders every reader when either one changes it. */
export function usePromptSuggestions(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, promptSuggestionsEnabled);
  const toggle = useCallback(() => setPromptSuggestionsEnabled(!promptSuggestionsEnabled()), []);
  return [value, toggle];
}
