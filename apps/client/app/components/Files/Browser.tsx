import { Modal, ModalClose, ModalDialog } from '@mui/joy';
import { FC } from 'react';
import { create } from 'zustand';

import FileBrowserContent from './Browser/Content';
import DataLakeWizardModal from '../DataLakeWizard/DataLakeWizardModal';
import DataLakeManagerPanel from '../DataLakeWizard/DataLakeManagerPanel';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { IFabFileDocument } from '@bike4mind/common';

export const useFileBrowser = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
  fileToShare: IFabFileDocument | null;
  setFileToShare: (fileToShare: IFabFileDocument | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: (selectedIds: Set<string>) => void;
  /**
   * Selected file for instructions
   */
  selectedFileInstructions: IFabFileDocument | null;
  setSelectedFileInstructions: (selectedFileInstructions: IFabFileDocument | null) => void;
}>()(set => ({
  open: false,
  setOpen: (open: boolean) => set({ open }),
  fileToShare: null,
  setFileToShare: (fileToShare: IFabFileDocument | null) => set({ fileToShare }),
  selectedIds: new Set<string>(),
  setSelectedIds: (selectedIds: Set<string>) => set({ selectedIds }),
  selectedFileInstructions: null,
  setSelectedFileInstructions: (selectedFileInstructions: IFabFileDocument | null) => set({ selectedFileInstructions }),
}));

const FileBrowser: FC = () => {
  const { open, setOpen } = useFileBrowser();
  const isManagerOpen = useDataLakeWizardStore(s => s.isManagerOpen);
  const closeManager = useDataLakeWizardStore(s => s.closeManager);

  return (
    <>
      <Modal open={open} onClose={() => setOpen(false)}>
        <ModalDialog
          data-testid="file-browser-dialog"
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
          <ModalClose data-testid="file-browser-close-btn" sx={{ display: { xs: 'none', md: 'flex' } }} />
          {open ? <FileBrowserContent /> : null}
        </ModalDialog>
      </Modal>
      <DataLakeWizardModal />
      {/* Data Lakes management surface: one persistent two-pane layout (lakes/files nav on
          the left, lake details or file content on the right). Store-driven so it's
          reachable from the Upload Files menu and the in-chat tree's Manage button. */}
      <Modal open={isManagerOpen} onClose={closeManager}>
        <ModalDialog
          data-testid="data-lake-manager-modal"
          sx={{
            width: { xs: '100vw', md: '90vw' },
            maxWidth: '80rem',
            height: { xs: '100dvh', md: '85vh' },
            maxHeight: { xs: '100%', md: '85vh' },
            p: 0,
            border: 'none',
            overflow: 'hidden',
            borderRadius: { xs: 0, md: 'md' },
          }}
        >
          <ModalClose data-testid="data-lake-manager-close-btn" />
          {isManagerOpen ? <DataLakeManagerPanel /> : null}
        </ModalDialog>
      </Modal>
    </>
  );
};

export default FileBrowser;
