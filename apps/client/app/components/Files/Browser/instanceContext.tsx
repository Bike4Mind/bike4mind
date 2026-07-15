import { IFabFileDocument } from '@bike4mind/common';
import { createContext, useContext } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useFileBrowser } from '../Browser';

/**
 * Per-instance surface the file browser reads instead of talking to the module-level
 * `useFileBrowser` store directly. This lets the browser be mounted either as the global
 * singleton (store-backed, one instance) or as multiple independent embedded pickers
 * (local-state-backed) whose selection/open state must not collide. Item.tsx and
 * ItemActions.tsx read selection/share through here too, so isolation holds however deep
 * the read is.
 */
export interface FileBrowserConfig {
  /** Primary bottom-bar action for the selected files. Undefined = add to the current session/workbench (global default). */
  onAdd?: (files: IFabFileDocument[]) => void;
  /** Delete for a batch of file ids. Undefined = delete the files globally (with confirm); embedded pickers override to e.g. remove-from-project. Takes an array so callers can batch (one request/toast for a bulk delete). */
  onDelete?: (fileIds: string[]) => void;
  /** Files already present in the caller's context; drives the "Added" indicator on each item. */
  addedFileIds?: Set<string>;
  /** i18n key for the add-button label; undefined uses the default notebook copy. */
  addButtonLabelKey?: string;
}

export interface FileBrowserInstanceValue {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  fileToShare: IFabFileDocument | null;
  setFileToShare: (file: IFabFileDocument | null) => void;
  config: FileBrowserConfig;
}

const EMPTY_CONFIG: FileBrowserConfig = {};

const FileBrowserInstanceContext = createContext<FileBrowserInstanceValue | null>(null);

export const FileBrowserInstanceProvider = FileBrowserInstanceContext.Provider;

/**
 * Reads the active file-browser instance. With no provider (the global singleton path and
 * unit tests) it falls back to the module-level `useFileBrowser` store, so behavior is
 * identical to before the context existed.
 */
export function useFileBrowserInstance(): FileBrowserInstanceValue {
  const ctx = useContext(FileBrowserInstanceContext);
  const [selectedIds, setSelectedIds, open, setOpen, fileToShare, setFileToShare] = useFileBrowser(
    useShallow(s => [s.selectedIds, s.setSelectedIds, s.open, s.setOpen, s.fileToShare, s.setFileToShare] as const)
  );
  if (ctx) return ctx;
  return { selectedIds, setSelectedIds, open, setOpen, fileToShare, setFileToShare, config: EMPTY_CONFIG };
}
