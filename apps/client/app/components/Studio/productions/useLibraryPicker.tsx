import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IFabFileDocument } from '@bike4mind/common';
import EmbeddedFileBrowser, { type EmbeddedFileBrowserHandle } from '@client/app/components/Files/EmbeddedFileBrowser';
import type { FileBrowserFilters } from '@client/app/components/Files/Browser/browserFilters';

export type LibraryPickRequest = {
  /** `locked` filters cannot be removed; `initial` only sets where the browser starts. */
  filter: { mode: 'locked' | 'initial'; type: NonNullable<FileBrowserFilters['type']> };
  onPicked: (files: IFabFileDocument[]) => void;
};

/**
 * One Library picker shared by a panel's slots (logo, product photos, a shot's takes). `pick` opens it for a slot;
 * the browser content mounts on open, so each request's filters apply afresh. Render `picker` once.
 */
export function useLibraryPicker(): { pick: (request: LibraryPickRequest) => void; picker: ReactNode } {
  const ref = useRef<EmbeddedFileBrowserHandle>(null);
  const [request, setRequest] = useState<LibraryPickRequest | null>(null);

  const pick = useCallback((next: LibraryPickRequest) => {
    setRequest(next);
    ref.current?.handleOpen();
  }, []);

  const filterType = request?.filter.type;
  const filterMode = request?.filter.mode;
  // Stable objects: the browser keys its queries on these.
  const lockedFilters = useMemo(
    () => (filterMode === 'locked' && filterType ? { type: filterType } : undefined),
    [filterMode, filterType]
  );
  const initialFilters = useMemo(
    () => (filterMode === 'initial' && filterType ? { type: filterType } : undefined),
    [filterMode, filterType]
  );

  const picker = (
    <EmbeddedFileBrowser
      ref={ref}
      lockedFilters={lockedFilters}
      initialFilters={initialFilters}
      addButtonLabelKey="file_browser.add_files_to_production"
      onAdd={files => request?.onPicked(files)}
    />
  );
  return { pick, picker };
}
