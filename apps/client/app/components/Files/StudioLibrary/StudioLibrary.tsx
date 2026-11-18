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
 * The Studio Library: the user's files, generated and uploaded, inline, with source, type, model and starred
 * filters and a star on each tile. No source lock, so it lists the same files the production picker
 * (Studio/productions/ProductionEditor.tsx) offers, uploads included.
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
