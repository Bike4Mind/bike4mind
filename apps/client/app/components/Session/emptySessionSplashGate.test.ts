import { describe, expect, it } from 'vitest';
import { shouldShowEmptySessionSplash } from './emptySessionSplashGate';

const base = { hasSplash: true, questCount: 0, isFetching: false, hasActiveQuest: false };

describe('shouldShowEmptySessionSplash', () => {
  it('shows the splash for a loaded, empty session with nothing in flight', () => {
    expect(shouldShowEmptySessionSplash(base)).toBe(true);
  });

  it('hides when no splash content was provided (default rendering)', () => {
    expect(shouldShowEmptySessionSplash({ ...base, hasSplash: false })).toBe(false);
  });

  it('hides while quests are still fetching (no flash on sessions with history)', () => {
    expect(shouldShowEmptySessionSplash({ ...base, isFetching: true })).toBe(false);
  });

  it('hides once the session has messages', () => {
    expect(shouldShowEmptySessionSplash({ ...base, questCount: 3 })).toBe(false);
  });

  it('hides while a first message is streaming or optimistically pending', () => {
    expect(shouldShowEmptySessionSplash({ ...base, hasActiveQuest: true })).toBe(false);
  });
});
