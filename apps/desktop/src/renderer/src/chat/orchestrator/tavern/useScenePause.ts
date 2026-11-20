import { useEffect, useState } from 'react';

/** How long (ms) the window may sit unfocused before the room stops animating. */
export const UNFOCUSED_PAUSE_MS = 3 * 60 * 1000;

/** Why the room is holding still: its window is hidden, or has been out of focus a while. */
export type ScenePause = 'hidden' | 'unfocused' | undefined;

export interface ScenePauseOptions {
  /** How long (ms) unfocused before pausing; 0 pauses as soon as focus leaves. */
  unfocusedAfterMs?: number;
  /** Keep animating while unfocused (never while hidden): the mini Tavern, while someone needs you. */
  awake?: boolean;
}

/**
 * Drives the scene's `data-paused` attribute, which pauses every infinite animation under it
 * (embers, flicker, bob, drift) while nobody is looking, so an idle window stops burning frames.
 */
export function useScenePause(options: number | ScenePauseOptions = UNFOCUSED_PAUSE_MS): ScenePause {
  const { unfocusedAfterMs = UNFOCUSED_PAUSE_MS, awake = false } =
    typeof options === 'number' ? { unfocusedAfterMs: options } : options;
  const [hidden, setHidden] = useState(() => document.hidden);
  const [unfocused, setUnfocused] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const onVisibility = () => setHidden(document.hidden);
    const onBlur = () => {
      clearTimer();
      timer = window.setTimeout(() => setUnfocused(true), unfocusedAfterMs);
    };
    const onFocus = () => {
      clearTimer();
      setUnfocused(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    if (!document.hasFocus()) onBlur();
    return () => {
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [unfocusedAfterMs]);

  if (hidden) return 'hidden';
  return unfocused && !awake ? 'unfocused' : undefined;
}
