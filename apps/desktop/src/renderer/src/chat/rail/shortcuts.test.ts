import { describe, expect, it } from 'vitest';
import {
  matchPlaceShortcut,
  matchSessionShortcut,
  matchSidebarToggle,
  placeShortcutLabel,
  sidebarShortcutLabel,
} from './shortcuts';

const chord = (code: string, modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>>) => ({
  code,
  key: code.replace(/^(Digit|Key)/, '').toLowerCase(),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe('on macOS', () => {
  const mac = true;

  it('picks places with Cmd+1..4', () => {
    expect(matchPlaceShortcut(chord('Digit1', { metaKey: true }), mac)).toBe('chat');
    expect(matchPlaceShortcut(chord('Digit2', { metaKey: true }), mac)).toBe('code');
    expect(matchPlaceShortcut(chord('Digit3', { metaKey: true }), mac)).toBe('studio');
    expect(matchPlaceShortcut(chord('Digit4', { metaKey: true }), mac)).toBe('agents');
    expect(matchPlaceShortcut(chord('Digit5', { metaKey: true }), mac)).toBe('library');
    expect(matchPlaceShortcut(chord('Digit6', { metaKey: true }), mac)).toBeNull();
  });

  it('opens the nth session with Ctrl+1..9, no longer with Cmd', () => {
    expect(matchSessionShortcut(chord('Digit1', { ctrlKey: true }), mac)).toBe(1);
    expect(matchSessionShortcut(chord('Digit9', { ctrlKey: true }), mac)).toBe(9);
    expect(matchSessionShortcut(chord('Digit1', { metaKey: true }), mac)).toBeNull();
    expect(matchPlaceShortcut(chord('Digit1', { ctrlKey: true }), mac)).toBeNull();
  });

  it('labels the place chord with the Command glyph', () => {
    expect(placeShortcutLabel(2, mac)).toBe('\u23182');
    expect(sidebarShortcutLabel(mac)).toBe('\u2318B');
  });
});

describe('on Windows and Linux', () => {
  const mac = false;

  it('picks places with Ctrl+1..3', () => {
    expect(matchPlaceShortcut(chord('Digit1', { ctrlKey: true }), mac)).toBe('chat');
    expect(matchPlaceShortcut(chord('Digit3', { ctrlKey: true }), mac)).toBe('studio');
    expect(matchPlaceShortcut(chord('Digit1', { metaKey: true }), mac)).toBeNull();
  });

  it('opens the nth session with Alt+1..9, since Ctrl is the place modifier', () => {
    expect(matchSessionShortcut(chord('Digit4', { altKey: true }), mac)).toBe(4);
    expect(matchSessionShortcut(chord('Digit4', { ctrlKey: true }), mac)).toBeNull();
  });

  it('labels the place chord with Ctrl', () => {
    expect(placeShortcutLabel(1, mac)).toBe('Ctrl+1');
    expect(sidebarShortcutLabel(mac)).toBe('Ctrl+B');
  });
});

describe('chords that are not ours', () => {
  it('ignores extra modifiers and Shift', () => {
    expect(matchPlaceShortcut(chord('Digit1', { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(matchPlaceShortcut(chord('Digit1', { metaKey: true, altKey: true }), true)).toBeNull();
    expect(matchSessionShortcut(chord('Digit1', { ctrlKey: true, metaKey: true }), true)).toBeNull();
  });

  it('reads the physical digit key, whatever the layout prints on it', () => {
    expect(matchPlaceShortcut({ ...chord('Digit2', { metaKey: true }), key: '\u00e9' }, true)).toBe('code');
  });

  it('toggles the sidebar on Mod+B only', () => {
    expect(matchSidebarToggle(chord('KeyB', { metaKey: true }))).toBe(true);
    expect(matchSidebarToggle(chord('KeyB', { ctrlKey: true }))).toBe(true);
    expect(matchSidebarToggle(chord('KeyB', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(matchSidebarToggle(chord('KeyB', {}))).toBe(false);
  });
});
