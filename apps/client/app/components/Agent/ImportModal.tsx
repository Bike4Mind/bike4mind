import React from 'react';
import { Modal, ModalDialog, ModalClose, Typography, FormControl, FormLabel, Textarea, Button, Box } from '@mui/joy';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  importJsonText: string;
  onImportTextChange: (value: string) => void;
  importError: string | null;
  isProcessing: boolean;
  onProcess: () => void;
}

const ImportModal: React.FC<ImportModalProps> = ({
  isOpen,
  onClose,
  importJsonText,
  onImportTextChange,
  importError,
  isProcessing,
  onProcess,
}) => {
  return (
    <Modal open={isOpen} onClose={onClose}>
      <ModalDialog
        sx={{
          maxWidth: '600px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ModalClose onClick={onClose} />
        <Typography level="h4" mb={2}>
          Import Agent Template
        </Typography>

        <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 2 }}>
          Paste your agent JSON data below. This will populate the form fields with the imported configuration.
        </Typography>

        <FormControl sx={{ flexGrow: 1, mb: 2 }}>
          <FormLabel>JSON Data</FormLabel>
          <Textarea
            minRows={12}
            maxRows={20}
            value={importJsonText}
            onChange={e => {
              onImportTextChange(e.target.value);
            }}
            placeholder="Paste your agent JSON data here..."
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              flexGrow: 1,
            }}
          />
        </FormControl>

        {importError && (
          <Box
            sx={{
              p: 1.5,
              borderRadius: 1,
              bgcolor: 'danger.softBg',
              color: 'danger.softColor',
              border: '1px solid',
              borderColor: 'danger.softBorder',
              mb: 2,
            }}
          >
            <Typography level="body-sm" fontWeight="bold">
              Import Error:
            </Typography>
            <Typography level="body-xs">{importError}</Typography>
          </Box>
        )}

        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button variant="outlined" color="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="solid"
            color="primary"
            loading={isProcessing}
            disabled={!importJsonText.trim() || isProcessing}
            onClick={onProcess}
          >
            {isProcessing ? 'Processing...' : 'Import Template'}
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default ImportModal;
