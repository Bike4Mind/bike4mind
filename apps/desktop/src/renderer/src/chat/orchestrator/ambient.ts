import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the Tavern waits with no pointer, key or wheel input before its chrome settles out (ms). */
export const AMBIENT_IDLE_MS = 45_000;

/**
 * Marks something open that the user is in the middle of (the peek drawer, the order slip), so the
 * chrome never settles out from under it.
 */
export const AMBIENT_HOLD_ATTR = 'data-ambient-hold';
/** Marks a card the user may use while the chrome is settled: pointer input over it does not wake the rest. */
export const AMBIENT_QUIET_ATTR = 'data-ambient-quiet';

// Must match the Composer's textarea testid (Composer.tsx): a draft there holds the chrome even unfocused.
const COMPOSER_INPUT = '[data-testid="chat-composer-input"]';
// Popup triggers only: an expanded tree row (the session sidebar) says aria-expanded too, and stays so.
const OPEN_POPUP = [
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[aria-haspopup][aria-expanded="true"]',
  '[role="combobox"][aria-expanded="true"]',
  `[${AMBIENT_HOLD_ATTR}]`,
].join(', ');

function hasText(element: Element): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value.trim() !== '';
  return element instanceof HTMLElement && element.isContentEditable && (element.textContent ?? '').trim() !== '';
}

/**
 * Whether anything on screen says the user is mid-task: an unsent draft in the composer, text in
 * the focused field, or an open menu, dialog, drawer or slip. An empty focused composer does not
 * hold, or a watcher who sent a message and walked away would never get the quiet scene.
 */
export function ambientHeld(doc: Document): boolean {
  const active = doc.activeElement;
  if (active && active !== doc.body && hasText(active)) return true;
  if (doc.querySelector(OPEN_POPUP)) return true;
  const composer = doc.querySelector(COMPOSER_INPUT);
  return composer !== null && hasText(composer);
}

/** A field that takes typing, where a keystroke belongs to the field rather than to an order. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches('input, textarea, select');
}

/** A key that types a character, so a keystroke in the quiet tavern can become the first letter of an order. */
export function isPrintableKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>) {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing;
}

const WAKE_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;

interface AmbientSettleOptions {
  enabled: boolean;
  /** Asked when the idle timer runs out; true keeps the chrome up and restarts the wait. */
  held(): boolean;
  /** A key pressed while settled, heard before anything else; the chrome wakes either way. */
  onSettledKey?(event: KeyboardEvent): void;
  idleMs?: number;
}

/**
 * Settles after `idleMs` with no input and wakes on any pointer move, press, key or wheel, except
 * pointer input inside an AMBIENT_QUIET_ATTR card. Disabling it wakes at once. Focus held when it
 * settled is given back on waking.
 */
export function useAmbientSettle({ enabled, held, onSettledKey, idleMs = AMBIENT_IDLE_MS }: AmbientSettleOptions) {
  const [settled, setSettled] = useState(false);
  const latest = useRef({ held, onSettledKey, settled });
  latest.current = { held, onSettledKey, settled };
  const rearm = useRef<() => void>(() => undefined);
  // Settling hides the focused control (the composer, often); waking gives focus back to it.
  const focusBeforeSettle = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSettled(false);
      return;
    }
    let timer: number | undefined;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (latest.current.held()) {
          arm();
          return;
        }
        const active = document.activeElement;
        focusBeforeSettle.current = active instanceof HTMLElement && active !== document.body ? active : null;
        setSettled(true);
      }, idleMs);
    };
    const onInput = (event: Event) => {
      const quiet = event.target instanceof Element && event.target.closest(`[${AMBIENT_QUIET_ATTR}]`) !== null;
      if (quiet && event.type !== 'keydown') return;
      if (latest.current.settled && event instanceof KeyboardEvent) latest.current.onSettledKey?.(event);
      setSettled(false);
      arm();
    };
    rearm.current = arm;
    arm();
    for (const type of WAKE_EVENTS)
      window.addEventListener(type, onInput, { capture: true, passive: type !== 'keydown' });
    return () => {
      window.clearTimeout(timer);
      rearm.current = () => undefined;
      for (const type of WAKE_EVENTS) window.removeEventListener(type, onInput, { capture: true });
    };
  }, [enabled, idleMs]);

  useEffect(() => {
    if (settled) return;
    const previous = focusBeforeSettle.current;
    focusBeforeSettle.current = null;
    // Only into a void: a key that opened something while settled has put focus there already.
    const nowhere = document.activeElement === null || document.activeElement === document.body;
    if (previous?.isConnected && nowhere) previous.focus({ preventScroll: true });
  }, [settled]);

  const wake = useCallback(() => {
    setSettled(false);
    rearm.current();
  }, []);

  return { settled: enabled && settled, wake };
}
