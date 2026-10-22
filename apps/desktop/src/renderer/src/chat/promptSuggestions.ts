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
export function promptSuggestionsSummary(enabled: boolean, model: string | null = null): string {
  if (!enabled) return 'Off';
  return model ? `On, ${model}` : 'On';
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
  // The third argument is the same reader: there is no server, and the value is a module
  // global rather than anything React renders around, so a string render sees what a live one
  // would. Without it React refuses to render this hook outside the browser at all.
  const value = useSyncExternalStore(subscribe, promptSuggestionsEnabled, promptSuggestionsEnabled);
  const toggle = useCallback(() => setPromptSuggestionsEnabled(!promptSuggestionsEnabled()), []);
  return [value, toggle];
}

/**
 * Which model writes the hint, by id, or null for automatic (main's pick of a small hosted
 * model). Same storage and the same reasons as the switch above; main validates the id against
 * the catalog on every call, so a stale one only means no hint.
 */
const MODEL_STORAGE_KEY = 'b4m.composer.promptSuggestionModel';

let model = readStoredModel();
const modelListeners = new Set<() => void>();

function readStoredModel(): string | null {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function subscribeModel(listener: () => void): () => void {
  modelListeners.add(listener);
  return () => modelListeners.delete(listener);
}

export function promptSuggestionModel(): string | null {
  return model;
}

export function setPromptSuggestionModel(next: string | null): void {
  if (next === model) return;
  model = next;
  try {
    if (next) window.localStorage.setItem(MODEL_STORAGE_KEY, next);
    else window.localStorage.removeItem(MODEL_STORAGE_KEY);
  } catch {
    // Kept for this run, as with the switch.
  }
  for (const listener of modelListeners) listener();
}

export function usePromptSuggestionModel(): [string | null, (next: string | null) => void] {
  const value = useSyncExternalStore(subscribeModel, promptSuggestionModel, promptSuggestionModel);
  return [value, setPromptSuggestionModel];
}
