import { IFabFileDocument } from '@bike4mind/common';
import { Box, Modal, ModalClose, ModalDialog } from '@mui/joy';
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import FileBrowserContent from './Browser/Content';
import { FileBrowserConfig, FileBrowserInstanceProvider, FileBrowserInstanceValue } from './Browser/instanceContext';

export interface EmbeddedFileBrowserHandle {
  handleOpen: () => void;
}

export type EmbeddedFileBrowserProps = FileBrowserConfig;

const noop = () => {};

/**
 * The per-instance state every embedded browser owns: selection and the share target stay local, so
 * several instances on one screen never collide (see instanceContext).
 */
function useInstanceValue(config: FileBrowserConfig, open: boolean, setOpen: (open: boolean) => void, closable = true) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [fileToShare, setFileToShare] = useState<IFabFileDocument | null>(null);
  const {
    onAdd,
    onDelete,
    addedFileIds,
    addButtonLabelKey,
    initialFilters,
    lockedFilters,
    enableStar,
    enableModelFilter,
    initialViewMode,
  } = config;

  const value = useMemo<FileBrowserInstanceValue>(
    () => ({
      open,
      setOpen,
      selectedIds,
      setSelectedIds,
      fileToShare,
      setFileToShare,
      config: {
        onAdd,
        onDelete,
        addedFileIds,
        addButtonLabelKey,
        initialFilters,
        lockedFilters,
        enableStar,
        enableModelFilter,
        initialViewMode,
      },
      closable,
    }),
    [
      open,
      setOpen,
      selectedIds,
      fileToShare,
      onAdd,
      onDelete,
      addedFileIds,
      addButtonLabelKey,
      initialFilters,
      lockedFilters,
      enableStar,
      enableModelFilter,
      initialViewMode,
      closable,
    ]
  );

  return { value, setSelectedIds, setFileToShare };
}

/**
 * The shared file browser mounted inline as a picker (e.g. Projects, System Prompts).
 * Its selection/open/share state is local, so multiple instances on one screen never
 * collide (see instanceContext). The Data Lake wizard/manager modals are intentionally
 * NOT rendered here - they are store-driven singletons owned by the global Files/Browser
 * (mounted once in ProviderBundle) and remain reachable from the upload menu.
 */
const EmbeddedFileBrowser = forwardRef<EmbeddedFileBrowserHandle, EmbeddedFileBrowserProps>((config, ref) => {
  const [open, setOpen] = useState(false);
  const { value, setSelectedIds, setFileToShare } = useInstanceValue(config, open, setOpen);

  // Reset selection/share on open so a dismissed-without-adding picker doesn't reopen
  // with stale pre-checked rows (which could drive an accidental re-add).
  useImperativeHandle(
    ref,
    () => ({
      handleOpen: () => {
        setSelectedIds(new Set());
        setFileToShare(null);
        setOpen(true);
      },
    }),
    [setSelectedIds, setFileToShare]
  );

  return (
    <FileBrowserInstanceProvider value={value}>
      <Modal open={open} onClose={() => setOpen(false)}>
        <ModalDialog
          data-testid="embedded-file-browser-dialog"
          sx={{
            width: { xs: '100vw', md: '90vw' },
            height: { xs: '100dvh', md: '90vh' },
            maxWidth: { xs: '100%', md: 'initial' },
            maxHeight: { xs: '100%', md: 'initial' },
            border: 'none',
            p: { xs: 0, md: 'initial' },
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: { xs: 0, md: 'md' },
            backgroundColor: theme => theme.palette.background.body,
          }}
        >
          <ModalClose data-testid="embedded-file-browser-close-btn" sx={{ display: { xs: 'none', md: 'flex' } }} />
          {open ? <FileBrowserContent /> : null}
        </ModalDialog>
      </Modal>
    </FileBrowserInstanceProvider>
  );
});

EmbeddedFileBrowser.displayName = 'EmbeddedFileBrowser';

export type InlineFileBrowserProps = FileBrowserConfig & {
  'data-testid'?: string;
};

/**
 * The same browser rendered in place, for a page that IS the file list (e.g. the Studio Library) rather than a
 * picker opened over one. Always open; it fills its parent, which must give it a height.
 */
export const InlineFileBrowser = ({
  'data-testid': testId = 'inline-file-browser',
  ...config
}: InlineFileBrowserProps) => {
  const { value } = useInstanceValue(config, true, noop, false);
  return (
    <FileBrowserInstanceProvider value={value}>
      <Box
        data-testid={testId}
        sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}
      >
        <FileBrowserContent />
      </Box>
    </FileBrowserInstanceProvider>
  );
};

export default EmbeddedFileBrowser;
