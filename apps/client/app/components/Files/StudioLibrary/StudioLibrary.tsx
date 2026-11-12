import type { IFabFileDocument } from '@bike4mind/common';
import { FC } from 'react';
import type { FileBrowserFilters } from '../Browser/browserFilters';
import { InlineFileBrowser } from '../EmbeddedFileBrowser';

// Module-level so the instance config keeps one identity across renders.
const STUDIO_LIBRARY_LOCKED_FILTERS: FileBrowserFilters = { source: 'generated' };

export type StudioLibraryProps = {
  /** Where the user's own filters start, e.g. one media type. The source is always generated. */
  initialFilters?: Omit<FileBrowserFilters, 'source'>;
  /** The bottom-bar action for the selected files; undefined adds them to the current notebook. */
  onAdd?: (files: IFabFileDocument[]) => void;
};

/**
 * The Studio Library: every generated file, inline, with type, model and starred filters and a star on each
 * tile. Locked to generated media, so the user can narrow it but never widen it to uploads.
 */
export const StudioLibrary: FC<StudioLibraryProps> = ({ initialFilters, onAdd }) => (
  <InlineFileBrowser
    data-testid="studio-library"
    lockedFilters={STUDIO_LIBRARY_LOCKED_FILTERS}
    initialFilters={initialFilters}
    initialViewMode="grid"
    enableStar
    enableModelFilter
    onAdd={onAdd}
  />
);

export default StudioLibrary;
