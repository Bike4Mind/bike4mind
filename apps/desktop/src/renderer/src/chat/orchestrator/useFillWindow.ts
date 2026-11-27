import { useCallback, useEffect, useState } from 'react';
import { isEditable } from './ambient';
import { inSceneDialogue } from './scene/dialogue';

const OVERLAY = '[role="dialog"], [role="menu"], [role="listbox"]';

export type FillWindowKeyAction = 'enter' | 'exit';

/**
 * What a key does to Fill window: F switches it, Escape leaves it. Null for a key that belongs to
 * something else: a field being typed in, an open menu or dialog, the Tavern dialogue box (whose
 * keys answer requests, and whose Escape minimizes it), or a handler that already claimed it. A held
 * key's auto-repeat is ignored, so holding F does not flicker the layout.
 */
export function fillWindowKeyAction(event: KeyboardEvent, on: boolean): FillWindowKeyAction | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
    return null;
  if (isEditable(event.target) || inSceneDialogue(event.target)) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(OVERLAY)) return null;
  if (event.key === 'f' || event.key === 'F') return on ? 'exit' : 'enter';
  if (event.key === 'Escape' && on) return 'exit';
  return null;
}

export interface FillWindow {
  on: boolean;
  setOn(on: boolean): void;
}

/**
 * The Agent view's Fill window state: memory only, so a restart always opens the normal layout. It
 * turns off whenever the Agent view is not `available`, so it never comes back on by itself.
 */
export function useFillWindow(available: boolean): FillWindow {
  const [requested, setRequested] = useState(false);
  const on = requested && available;

  useEffect(() => {
    if (!available) setRequested(false);
  }, [available]);

  useEffect(() => {
    if (!available) return;
    // Bubble phase on window, so the dialogue box and a drawer's Escape (OrchestratorStage) are heard
    // first and can claim the key.
    const onKeyDown = (event: KeyboardEvent) => {
      const action = fillWindowKeyAction(event, on);
      if (!action) return;
      event.preventDefault();
      setRequested(action === 'enter');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [available, on]);

  const setOn = useCallback((next: boolean) => setRequested(next), []);
  return { on, setOn };
}
