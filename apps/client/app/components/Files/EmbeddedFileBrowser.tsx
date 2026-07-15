import { IFabFileDocument } from '@bike4mind/common';
import { Modal, ModalClose, ModalDialog } from '@mui/joy';
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import FileBrowserContent from './Browser/Content';
import { FileBrowserConfig, FileBrowserInstanceProvider, FileBrowserInstanceValue } from './Browser/instanceContext';

export interface EmbeddedFileBrowserHandle {
  handleOpen: () => void;
}

export type EmbeddedFileBrowserProps = FileBrowserConfig;

/**
 * The shared file browser mounted inline as a picker (e.g. Projects, System Prompts).
 * Its selection/open/share state is local, so multiple instances on one screen never
 * collide (see instanceContext). The Data Lake wizard/manager modals are intentionally
 * NOT rendered here - they are store-driven singletons owned by the global Files/Browser
 * (mounted once in ProviderBundle) and remain reachable from the upload menu.
 */
const EmbeddedFileBrowser = forwardRef<EmbeddedFileBrowserHandle, EmbeddedFileBrowserProps>(
  ({ onAdd, onDelete, addedFileIds, addButtonLabelKey }, ref) => {
    const [open, setOpen] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [fileToShare, setFileToShare] = useState<IFabFileDocument | null>(null);

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
      []
    );

    const value = useMemo<FileBrowserInstanceValue>(
      () => ({
        open,
        setOpen,
        selectedIds,
        setSelectedIds,
        fileToShare,
        setFileToShare,
        config: { onAdd, onDelete, addedFileIds, addButtonLabelKey },
      }),
      [open, selectedIds, fileToShare, onAdd, onDelete, addedFileIds, addButtonLabelKey]
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
  }
);

EmbeddedFileBrowser.displayName = 'EmbeddedFileBrowser';

export default EmbeddedFileBrowser;
