import { describe, it, expect, beforeEach } from 'vitest';
import { useReplyChoices } from './useReplyChoices';

const turnA = { questId: 'quest-a' };
const turnB = { questId: 'quest-b' };

describe('useReplyChoices', () => {
  beforeEach(() => {
    useReplyChoices.setState({ newestBySession: {} });
  });

  it('tracks the newest turn per session, keyed so sessions cannot collide', () => {
    useReplyChoices.getState().setNewestTurn('session-1', turnA);
    useReplyChoices.getState().setNewestTurn('session-2', turnB);
    expect(useReplyChoices.getState().newestBySession).toEqual({
      'session-1': turnA,
      'session-2': turnB,
    });
  });

  it('a single instance mounting then unmounting clears its own session cleanly', () => {
    // Mirrors SessionMiddle's two effects: set on mount/update, clear on unmount.
    useReplyChoices.getState().setNewestTurn('session-1', turnA);
    useReplyChoices.getState().setNewestTurn('session-1', undefined); // cleanup on unmount
    expect(useReplyChoices.getState().newestBySession['session-1']).toBeUndefined();
  });

  it('REGRESSION: two instances for the same session - the survivor is wrongly cleared when the other unmounts', () => {
    // This pins down a known, currently-unreachable fragility (see the comment on SessionMiddle's
    // cleanup effect): the store itself has no concept of "which instance owns this session", so
    // if the single-SessionMiddle-per-session invariant SessionMiddle depends on is ever violated,
    // this is exactly what breaks - the surviving instance's buttons go dark on the other's unmount
    // until something else updates `newestTurn`. If a future fix adds reference counting or an
    // owner id to make this safe, update this test to assert the new, correct behavior instead.
    useReplyChoices.getState().setNewestTurn('session-1', turnA); // instance A mounts
    useReplyChoices.getState().setNewestTurn('session-1', turnB); // instance B mounts, same session
    useReplyChoices.getState().setNewestTurn('session-1', undefined); // instance B unmounts

    // Both instances are now gone according to the store, even though A is still mounted in this
    // hypothetical - a real second instance would see its buttons disabled with no event to revive them.
    expect(useReplyChoices.getState().newestBySession['session-1']).toBeUndefined();
  });

  it('does not emit a new state object for an unchanged turn', () => {
    useReplyChoices.getState().setNewestTurn('session-1', turnA);
    const before = useReplyChoices.getState().newestBySession;
    useReplyChoices.getState().setNewestTurn('session-1', { ...turnA });
    expect(useReplyChoices.getState().newestBySession).toBe(before);
  });
});
