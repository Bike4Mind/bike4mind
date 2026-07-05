import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendSessionMoves,
  getSessionMoves,
  resetSessionMoves,
  __resetAllSessionMovesForTests,
} from './chessSessionState';

const SESSION = 'test-session-1';
const OTHER_SESSION = 'test-session-2';

beforeEach(() => {
  __resetAllSessionMovesForTests();
});

describe('chessSessionState — in-memory round trip', () => {
  it('returns an empty list for a brand-new session', () => {
    expect(getSessionMoves(SESSION)).toEqual([]);
  });

  it('appends moves and reads them back in order', () => {
    appendSessionMoves(SESSION, ['e4']);
    appendSessionMoves(SESSION, ['e5']);
    appendSessionMoves(SESSION, ['Nf3', 'Nc6']);
    expect(getSessionMoves(SESSION)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('appending an empty array is a no-op', () => {
    appendSessionMoves(SESSION, ['e4']);
    appendSessionMoves(SESSION, []);
    expect(getSessionMoves(SESSION)).toEqual(['e4']);
  });

  it('reset wipes a session\u2019s history', () => {
    appendSessionMoves(SESSION, ['e4', 'e5']);
    resetSessionMoves(SESSION);
    expect(getSessionMoves(SESSION)).toEqual([]);
  });

  it('keeps sessions independent', () => {
    appendSessionMoves(SESSION, ['e4']);
    appendSessionMoves(OTHER_SESSION, ['d4']);
    expect(getSessionMoves(SESSION)).toEqual(['e4']);
    expect(getSessionMoves(OTHER_SESSION)).toEqual(['d4']);
  });
});

describe('chessSessionState — localStorage persistence', () => {
  it('writes through to localStorage on append', () => {
    appendSessionMoves(SESSION, ['e4', 'e5']);
    const raw = window.localStorage.getItem(`lumina5-chess-moves-${SESSION}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual(['e4', 'e5']);
  });

  it('removes the localStorage key on reset', () => {
    appendSessionMoves(SESSION, ['e4']);
    expect(window.localStorage.getItem(`lumina5-chess-moves-${SESSION}`)).not.toBeNull();
    resetSessionMoves(SESSION);
    expect(window.localStorage.getItem(`lumina5-chess-moves-${SESSION}`)).toBeNull();
  });

  it('hydrates from localStorage when the in-memory map is empty (simulating a reload)', () => {
    // Simulate a previous tab session: write directly to localStorage and
    // clear the in-memory state without touching storage.
    window.localStorage.setItem(
      `lumina5-chess-moves-${SESSION}`,
      JSON.stringify(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])
    );
    // Reach into the module's private hydration tracking by clearing it via
    // the test reset helper, then re-seed storage. The reset helper wipes
    // both storage and the hydration set, so we re-seed storage afterward.
    __resetAllSessionMovesForTests();
    window.localStorage.setItem(
      `lumina5-chess-moves-${SESSION}`,
      JSON.stringify(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])
    );
    expect(getSessionMoves(SESSION)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
  });

  it('ignores corrupt localStorage entries gracefully', () => {
    window.localStorage.setItem(`lumina5-chess-moves-${SESSION}`, '{"not":"an array"}');
    expect(getSessionMoves(SESSION)).toEqual([]);
  });

  it('ignores localStorage entries that are arrays but not strings', () => {
    window.localStorage.setItem(`lumina5-chess-moves-${SESSION}`, '[1, 2, 3]');
    expect(getSessionMoves(SESSION)).toEqual([]);
  });

  it('caps move history at the safety limit', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `m${i}`);
    appendSessionMoves(SESSION, huge);
    const stored = getSessionMoves(SESSION);
    expect(stored.length).toBe(400);
    // Should keep the LATEST moves, not the earliest
    expect(stored[stored.length - 1]).toBe('m499');
    expect(stored[0]).toBe('m100');
  });
});
