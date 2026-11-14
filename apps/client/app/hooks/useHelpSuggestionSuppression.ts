import { create } from 'zustand';

type HelpSuggestionSuppression = {
  activeTokens: ReadonlySet<string>;
  acquire(token: string): void;
  release(token: string): void;
};

/** Transient holders hide suggestions while staged forms need the bottom of the page. */
export const useHelpSuggestionSuppression = create<HelpSuggestionSuppression>(set => ({
  activeTokens: new Set<string>(),
  acquire: token =>
    set(state => {
      if (state.activeTokens.has(token)) return state;
      return { activeTokens: new Set([...state.activeTokens, token]) };
    }),
  release: token =>
    set(state => {
      if (!state.activeTokens.has(token)) return state;
      const activeTokens = new Set(state.activeTokens);
      activeTokens.delete(token);
      return { activeTokens };
    }),
}));
