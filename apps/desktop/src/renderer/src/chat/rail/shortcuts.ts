import { useEffect, useRef } from 'react';
import { isMac } from '../platform';
import { PLACES, type Place } from './places';

/**
 * The rail's keyboard map. The platform's primary modifier plus a place's digit picks it (Cmd on macOS,
 * Ctrl elsewhere). Opening the nth session moved off that chord to Ctrl+1-9 on macOS, and to
 * Alt+1-9 elsewhere, where Ctrl is already the place modifier.
 *
 * `event.code` rather than `event.key` throughout: on several non-US layouts the digit row only
 * produces a digit with a modifier already applied, and `key` is then a symbol.
 */
type Chord = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> &
  Partial<Pick<KeyboardEvent, 'key'>>;

const digitOf = (code: string) => {
  const match = /^Digit([1-9])$/.exec(code);
  return match ? Number(match[1]) : null;
};

/** Exactly one of the three modifiers, and no Shift. */
function only(event: Chord, modifier: 'metaKey' | 'ctrlKey' | 'altKey'): boolean {
  if (event.shiftKey) return false;
  return (['metaKey', 'ctrlKey', 'altKey'] as const).every(key => event[key] === (key === modifier));
}

export function placeShortcutLabel(digit: number, mac = isMac): string {
  return mac ? `\u2318${digit}` : `Ctrl+${digit}`;
}

export function sidebarShortcutLabel(mac = isMac): string {
  return mac ? '\u2318B' : 'Ctrl+B';
}

export function matchPlaceShortcut(event: Chord, mac = isMac): Place | null {
  if (!only(event, mac ? 'metaKey' : 'ctrlKey')) return null;
  const digit = digitOf(event.code);
  return PLACES.find(entry => entry.digit === digit)?.place ?? null;
}

/** The 1-based row the session chord asks for, or null. */
export function matchSessionShortcut(event: Chord, mac = isMac): number | null {
  if (!only(event, mac ? 'ctrlKey' : 'altKey')) return null;
  return digitOf(event.code);
}

/** Mod+B. Either Cmd or Ctrl, as it always was, so muscle memory from other editors carries over. */
export function matchSidebarToggle(event: Chord & Pick<KeyboardEvent, 'key'>): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  return event.key === 'b' || event.key === 'B';
}

/**
 * Binds the place and sidebar chords on the window, so they work while the composer has focus.
 * Bound once; the latest callbacks are read through a ref.
 */
export function usePlaceShortcuts(handlers: { onPlace: (place: Place) => void; onToggleSidebar: () => void }) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const place = matchPlaceShortcut(event);
      if (place) {
        event.preventDefault();
        latest.current.onPlace(place);
        return;
      }
      if (matchSidebarToggle(event)) {
        event.preventDefault();
        latest.current.onToggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
