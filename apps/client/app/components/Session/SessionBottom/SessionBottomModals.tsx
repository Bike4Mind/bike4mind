import { Modal, ModalClose, ModalDialog, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { AdminModalPreview } from '../../AdminToolModals/AdminModalPreview';
import { ModalListPopup } from '../../AdminToolModals/ModalListPopup';
import GenericModal from '../../modals/GenericModal';
import { FormatSelectionDialog } from '@client/app/components/Session/FormatSelectionDialog';
import ContentPreviewModal from '@client/app/components/ProfileModal/ContentPreviewModal';
import FilesSection from '@client/app/components/Session/AISettings/FilesSection';

interface SessionBottomModalsProps {
  // Admin preview
  adminPreviewData: any;
  showAdminPreview: boolean;
  setShowAdminPreview: (open: boolean) => void;
  setAdminPreviewData: (data: any) => void;

  // Modal list popup
  modalListPopupOpen: boolean;
  setModalListPopupOpen: (open: boolean) => void;
  modalListData: { modals: any[]; message?: string };

  // Triggered modal
  triggeredModal: any;
  triggeredModalOpen: boolean;
  setTriggeredModalOpen: (open: boolean) => void;

  // Format selection dialog
  formatDialogOpen: boolean;
  setFormatDialogOpen: (open: boolean) => void;
  pasteContentForFormat: string;
  pasteSmartFileName: string;

  // Content preview
  transformedContent: { title: string; content: string; summary?: string; suggestedTags?: string[] } | null;
  shouldShowPreview: boolean;
  clearPreview: () => void;

  // Mobile session files
  sessionFilesOpen: boolean;
  setSessionFilesOpen: (open: boolean) => void;
  model: string;
}

export function SessionBottomModals({
  adminPreviewData,
  showAdminPreview,
  setShowAdminPreview,
  setAdminPreviewData,
  modalListPopupOpen,
  setModalListPopupOpen,
  modalListData,
  triggeredModal,
  triggeredModalOpen,
  setTriggeredModalOpen,
  formatDialogOpen,
  setFormatDialogOpen,
  pasteContentForFormat,
  pasteSmartFileName,
  transformedContent,
  shouldShowPreview,
  clearPreview,
  sessionFilesOpen,
  setSessionFilesOpen,
  model,
}: SessionBottomModalsProps) {
  return (
    <>
      {/* Admin Tools Preview */}
      {adminPreviewData && (
        <AdminModalPreview
          isOpen={showAdminPreview}
          modalData={adminPreviewData}
          onConfirm={async editedData => {
            try {
              await api.post('/api/modals', editedData);
              toast.success('Modal created successfully!');
              setShowAdminPreview(false);
              setAdminPreviewData(null);
            } catch (error) {
              console.error('Error creating modal:', error);
              toast.error('Failed to create modal');
            }
          }}
          onClose={() => {
            setShowAdminPreview(false);
            setAdminPreviewData(null);
          }}
        />
      )}

      {/* Modal List Popup */}
      <ModalListPopup
        open={modalListPopupOpen}
        onClose={() => setModalListPopupOpen(false)}
        modals={modalListData.modals}
        message={modalListData.message}
      />

      {/* Triggered Modal Display */}
      {triggeredModal && (
        <GenericModal
          {...triggeredModal}
          isOpen={triggeredModalOpen}
          onClose={() => setTriggeredModalOpen(false)}
          onAgree={() => setTriggeredModalOpen(false)}
          isPreview={false}
        />
      )}

      {/* Format Selection Dialog */}
      <FormatSelectionDialog
        open={formatDialogOpen}
        onClose={() => setFormatDialogOpen(false)}
        onConfirm={() => {
          setFormatDialogOpen(false);
        }}
        content={pasteContentForFormat}
        defaultFileName={pasteSmartFileName}
      />

      {/* Content Publishing Studio - Preview Modal */}
      {transformedContent && (
        <ContentPreviewModal
          open={shouldShowPreview}
          onClose={clearPreview}
          initialTitle={transformedContent.title}
          initialContent={transformedContent.content}
          initialSummary={transformedContent.summary}
          initialTags={transformedContent.suggestedTags}
        />
      )}

      {/* Mobile Session Files Modal */}
      <Modal open={sessionFilesOpen} onClose={() => setSessionFilesOpen(false)}>
        <ModalDialog
          sx={{
            width: '100%',
            maxWidth: '500px',
            maxHeight: '80vh',
            overflow: 'auto',
          }}
        >
          <ModalClose />
          <Typography level="title-lg" sx={{ mb: 1 }}>
            Session Files
          </Typography>
          <FilesSection model={model} />
        </ModalDialog>
      </Modal>
    </>
  );
}
