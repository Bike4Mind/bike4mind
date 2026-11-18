import type { IFabFileDocument } from '@bike4mind/common';
import { FC } from 'react';
import type { FileBrowserFilters } from '../Browser/browserFilters';
import { InlineFileBrowser } from '../EmbeddedFileBrowser';

export type StudioLibraryProps = {
  /** Where the user's own filters start, e.g. one media type or generated files only. */
  initialFilters?: FileBrowserFilters;
  /** The bottom-bar action for the selected files; undefined adds them to the current notebook. */
  onAdd?: (files: IFabFileDocument[]) => void;
};

/**
 * The Studio Library: the file browser's default scope inline (own files, generated and uploaded, plus shared and
 * data-lake files, every type; see server/files/searchFilesForRequest.ts), with a Generated toggle, type, model and
 * starred filters and a star on each tile. No source lock, so uploads list as in the production picker
 * (Studio/productions/ProductionEditor.tsx), which adds a per-track type lock.
 */
export const StudioLibrary: FC<StudioLibraryProps> = ({ initialFilters, onAdd }) => (
  <InlineFileBrowser
    data-testid="studio-library"
    initialFilters={initialFilters}
    initialViewMode="grid"
    enableStar
    enableModelFilter
    onAdd={onAdd}
  />
);

export default StudioLibrary;
