import { createContext, useContext } from 'react';

/** One richest-branch shortcut surfaced by a host idle pane (e.g. quick-dive chips). */
export interface DataLakeQuickDive {
  /** Full tag path to navigate to, e.g. ['books', 'business']. */
  path: string[];
  /** Leaf segment for the label (host humanizes it). */
  segment: string;
  /** Article count on the branch. */
  count: number;
}

/**
 * Lets a host-supplied pane rendered in DataLakeExplorer's `chatSlot` drive the Explorer's tree
 * (and read its richest branches) without prop-drilling through the chat. DataLakeExplorer
 * provides it around the chatSlot; consumers get a no-op/empty shape outside a provider. Kept
 * generic (no surface-specific content) so any Explorer host can opt in.
 */
export interface DataLakeNav {
  /** Navigate the tree to a tag path (same effect as clicking through the breadcrumb). */
  navigate: (path: string[]) => void;
  /** Richest second-level branches across the tree, already sorted + capped by the Explorer. */
  quickDives: DataLakeQuickDive[];
}

const DataLakeNavContext = createContext<DataLakeNav | null>(null);

export const DataLakeNavProvider = DataLakeNavContext.Provider;

/** Nav handle for a pane inside DataLakeExplorer's chatSlot; null when rendered standalone. */
export function useDataLakeNav(): DataLakeNav | null {
  return useContext(DataLakeNavContext);
}
