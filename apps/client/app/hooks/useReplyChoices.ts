import { create } from 'zustand';
import type { SuggestedChoices } from '@bike4mind/common';

/**
 * The newest turn of each open session and the choices it offered, published by SessionMiddle
 * (which holds the unfiltered quest list) for its siblings: the reply's button row, to know whether
 * its buttons are still live, and SessionBottom, to expand a typed bare key. Keyed by session so a
 * docked panel's session cannot overwrite the main one.
 */
export interface NewestTurn {
  questId: string;
  suggestedChoices?: SuggestedChoices;
}

interface ReplyChoicesState {
  newestBySession: Record<string, NewestTurn | undefined>;
  setNewestTurn: (sessionId: string, turn: NewestTurn | undefined) => void;
}

export const useReplyChoices = create<ReplyChoicesState>(set => ({
  newestBySession: {},
  setNewestTurn: (sessionId, turn) =>
    set(state => {
      const current = state.newestBySession[sessionId];
      if (current?.questId === turn?.questId && current?.suggestedChoices === turn?.suggestedChoices) return state;
      return { newestBySession: { ...state.newestBySession, [sessionId]: turn } };
    }),
}));
