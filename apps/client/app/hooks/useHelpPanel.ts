import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * History entry for navigation within the help panel
 */
interface HelpHistoryEntry {
  slug: string;
  anchor?: string;
}

/**
 * Zustand store for Help Panel state management
 */
interface HelpPanelState {
  // Open state
  open: boolean;

  // Current navigation
  currentSlug: string;
  currentAnchor?: string;

  // File path of the currently displayed article (e.g. "features/opti/index.md").
  // Kept alongside currentSlug so relative links can resolve against the file path
  // rather than the slug (index pages drop the "/index" segment from their slug).
  currentFilePath?: string;

  // Navigation history for back/forward
  history: HelpHistoryEntry[];
  historyIndex: number;

  // Persisted settings
  panelWidth: number; // Width in pixels
  chatHeight: number; // Height of help chat in pixels
}

interface HelpPanelActions {
  // Core actions
  setOpen: (open: boolean) => void;

  // Navigation actions
  navigateTo: (slug: string, anchor?: string) => void;
  setCurrentFilePath: (filePath: string | undefined) => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;

  // Panel settings
  setPanelWidth: (width: number) => void;
  setChatHeight: (height: number) => void;

  // Utility actions
  close: () => void;
  openToSlug: (slug: string, anchor?: string) => void;
}

type HelpPanelStore = HelpPanelState & HelpPanelActions;

const DEFAULT_PANEL_WIDTH = 480; // pixels
const DEFAULT_CHAT_HEIGHT = 450; // pixels
const DEFAULT_SLUG = 'index'; // Home page
const MAX_HISTORY_SIZE = 50; // Prevent unbounded memory growth

export const useHelpPanel = create<HelpPanelStore>()(
  persist(
    (set, get) => ({
      // Initial state
      open: false,
      currentSlug: DEFAULT_SLUG,
      currentAnchor: undefined,
      currentFilePath: undefined,
      history: [{ slug: DEFAULT_SLUG }],
      historyIndex: 0,
      panelWidth: DEFAULT_PANEL_WIDTH,
      chatHeight: DEFAULT_CHAT_HEIGHT,

      // Actions
      setOpen: open => set({ open }),

      setCurrentFilePath: filePath => set({ currentFilePath: filePath }),

      navigateTo: (slug, anchor) => {
        const state = get();
        const newEntry: HelpHistoryEntry = { slug, anchor };

        // If we're not at the end of history, truncate forward history
        let newHistory = state.history.slice(0, state.historyIndex + 1);
        newHistory.push(newEntry);

        // Prevent unbounded history growth - trim oldest entries
        let newIndex = newHistory.length - 1;
        if (newHistory.length > MAX_HISTORY_SIZE) {
          const excess = newHistory.length - MAX_HISTORY_SIZE;
          newHistory = newHistory.slice(excess);
          newIndex = newHistory.length - 1;
        }

        set({
          currentSlug: slug,
          currentAnchor: anchor,
          history: newHistory,
          historyIndex: newIndex,
        });
      },

      goBack: () => {
        const state = get();
        if (state.historyIndex > 0) {
          const newIndex = state.historyIndex - 1;
          const entry = state.history[newIndex];
          set({
            historyIndex: newIndex,
            currentSlug: entry.slug,
            currentAnchor: entry.anchor,
          });
        }
      },

      goForward: () => {
        const state = get();
        if (state.historyIndex < state.history.length - 1) {
          const newIndex = state.historyIndex + 1;
          const entry = state.history[newIndex];
          set({
            historyIndex: newIndex,
            currentSlug: entry.slug,
            currentAnchor: entry.anchor,
          });
        }
      },

      canGoBack: () => {
        return get().historyIndex > 0;
      },

      canGoForward: () => {
        const state = get();
        return state.historyIndex < state.history.length - 1;
      },

      setPanelWidth: width => set({ panelWidth: width }),
      setChatHeight: height => set({ chatHeight: height }),

      close: () => set({ open: false }),

      openToSlug: (slug, anchor) => {
        const state = get();

        // If panel is already open and we're navigating, use navigateTo
        if (state.open) {
          get().navigateTo(slug, anchor);
        } else {
          // Opening fresh - reset history to start at this slug
          set({
            open: true,
            currentSlug: slug,
            currentAnchor: anchor,
            history: [{ slug, anchor }],
            historyIndex: 0,
          });
        }
      },
    }),
    {
      name: 'help-panel',
      // Only persist panel settings, not navigation state
      partialize: state => ({
        panelWidth: state.panelWidth,
        chatHeight: state.chatHeight,
      }),
    }
  )
);

// Export convenience functions for external use
export const openHelpPanel = (slug?: string, anchor?: string) => {
  const store = useHelpPanel.getState();
  if (slug) {
    store.openToSlug(slug, anchor);
  } else {
    store.setOpen(true);
  }
};

export const closeHelpPanel = () => {
  useHelpPanel.getState().close();
};

export const navigateHelp = (slug: string, anchor?: string) => {
  useHelpPanel.getState().navigateTo(slug, anchor);
};

export default useHelpPanel;
