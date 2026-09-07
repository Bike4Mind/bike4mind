/**
 * surfaceTokens - the injection seam that keeps the Data Lake surface (the in-chat
 * `DataLakeExplorer`, on the main app and the premium hosts alike) brand-agnostic.
 *
 * The copy - labels, empty states, drop prompts - lives here with NEUTRAL defaults. A branded
 * surface wraps the explorer in `DataLakeSurfaceProvider` and overrides only what it needs, so no
 * product-specific string ever has to be edited into the shared components. Anything added to the
 * shared components that reads as product flavor belongs in this file as a token instead.
 *
 * Hues, icons and taxonomy labels used to live here too, for the standalone /data-lakes page's
 * article reader and tree. That page was retired in #1943 and nothing read those sections
 * afterwards, so they are gone rather than kept as a vocabulary with no speakers. Hues themselves
 * still live in `surfaceChrome`/`deckChrome`, which the premium deck surfaces do read.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DATA_LAKE, DATA_LAKES } from '@client/app/components/datalake/dataLakeBranding';

export interface DataLakeSurfaceCopy {
  /** Title over the browse tree. */
  rootLabel: string;
  dropTitle: string;
  dropHint: string;
  /** Resting hint advertising drag-to-ingest before any drag has started. */
  dropRestingHint: string;
  /** Tail of the "N files <hint>" toast confirming a drop. */
  dropAcceptedHint: string;
  /**
   * TRUE zero-lake state only: the caller has no accessible lakes at all. Never shown merely
   * because the current browse scope holds no files - that conflated "you have no lakes" with
   * "there is nothing here", telling a user with lakes to create their first one (#1645).
   */
  zeroTitle: string;
  zeroHint: string;
  /**
   * Lake selected, but it holds no files yet. The hint must promise NO action: this copy is chosen
   * surface-wide with no knowledge of the selected lake, and the lake may be one the viewer cannot
   * write to at all (a built-in/registry lake, or someone else's public lake), where neither
   * "add files" nor "connect a folder" is offered. The Add-files button beside it appears only when
   * the viewer can manage the lake, and that button - not this sentence - is the call to action.
   */
  lakeEmptyTitle: string;
  lakeEmptyHint: string;
  /**
   * Lakes exist but NONE of them hold a file, so the all-lakes view has no tree at all. Distinct
   * from the lake-scoped copy above: there is no one lake to point the user at.
   */
  allLakesEmptyTitle: string;
  allLakesEmptyHint: string;
  /**
   * The lake list could not be READ. Distinct from `zero*` on purpose: a failed read must never
   * borrow the zero-state's meaning, or a transient error invites a user who already has lakes to
   * create a duplicate.
   */
  lakesErrorTitle: string;
  lakesErrorHint: string;
  createLabel: string;
  /** Lake-picker row that clears the lake scope and browses every reachable lake at once. */
  allLakesLabel: string;
  /** Label for the shared manage-knowledge affordance (`ManageKnowledgeButton`). */
  manageLabel: string;
}

export interface DataLakeSurfaceTokens {
  copy: DataLakeSurfaceCopy;
}

export interface DataLakeSurfaceOverrides {
  copy?: Partial<DataLakeSurfaceCopy>;
}

export const DEFAULT_DATA_LAKE_SURFACE_TOKENS: DataLakeSurfaceTokens = {
  copy: {
    rootLabel: DATA_LAKES,
    dropTitle: `Drop to add to a ${DATA_LAKE.toLowerCase()}`,
    dropHint: "Files or folders - you'll pick the destination next",
    dropRestingHint: 'Drag files here to add',
    dropAcceptedHint: `ready to add to a ${DATA_LAKE.toLowerCase()}`,
    zeroTitle: 'Nothing here yet',
    zeroHint: `Create your first ${DATA_LAKE.toLowerCase()} to turn your files into searchable knowledge.`,
    lakeEmptyTitle: 'This lake has no files yet',
    lakeEmptyHint: 'Nothing has been added to this lake yet.',
    allLakesEmptyTitle: 'No files yet',
    allLakesEmptyHint: `Pick a ${DATA_LAKE.toLowerCase()} from the picker above and add files to make them searchable.`,
    lakesErrorTitle: `Couldn't load your ${DATA_LAKES.toLowerCase()}`,
    lakesErrorHint: 'Something went wrong reading the list. Retry - nothing has been lost.',
    createLabel: `Create ${DATA_LAKE.toLowerCase()}`,
    allLakesLabel: `All ${DATA_LAKES.toLowerCase()}`,
    manageLabel: 'Manage lakes',
  },
};

const DataLakeSurfaceContext = createContext<DataLakeSurfaceTokens>(DEFAULT_DATA_LAKE_SURFACE_TOKENS);

/**
 * Overrides are merged one level deep (per section), so a caller can replace a
 * single string without restating the rest of the section.
 */
export function DataLakeSurfaceProvider({
  tokens,
  children,
}: {
  tokens: DataLakeSurfaceOverrides;
  children: ReactNode;
}) {
  const merged = useMemo<DataLakeSurfaceTokens>(
    () => ({ copy: { ...DEFAULT_DATA_LAKE_SURFACE_TOKENS.copy, ...tokens.copy } }),
    [tokens]
  );
  return <DataLakeSurfaceContext.Provider value={merged}>{children}</DataLakeSurfaceContext.Provider>;
}

/** Tokens for the current surface; the neutral defaults when no provider is mounted. */
export const useDataLakeSurface = () => useContext(DataLakeSurfaceContext);
