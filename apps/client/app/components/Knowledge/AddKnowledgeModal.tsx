import React, { useState, useRef } from 'react';
import { Modal, ModalDialog, ModalClose, Typography, Button, Box } from '@mui/joy';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import KnowledgeModal from '@client/app/components/Knowledge/KnowledgeModal';
import { IFabFileDocument, KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@client/app/utils/error';

interface AddKnowledgeModalProps {
  open: boolean;
  onClose: () => void;
}

const AddKnowledgeModal: React.FC<AddKnowledgeModalProps> = ({ open, onClose }) => {
  const [showKnowledgeModal] = useState(false);
  const [, setFabFile] = useState<IFabFileDocument | null>(null);
  const [, setCreatingKnowledge] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFiles(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
    }
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      await handleFiles(Array.from(files));
    }
  };

  const handleFiles = async (files: File[]) => {
    setCreatingKnowledge(true);
    for (const file of files) {
      try {
        const data = {
          type: KnowledgeType.FILE,
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
        };
        const newFabFile = await createFabFileOnServerWithUpload(data, file);
        queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
        setFabFile(newFabFile as IFabFileDocument);
        toast.success(`Uploaded: ${file.name}`);
      } catch (error) {
        console.error('Error uploading file %s:', file.name, error);
        toast.error(getErrorMessage(error));
        setCreatingKnowledge(false);
      }
    }
    setCreatingKnowledge(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        sx={theme => ({
          width: { xs: '90%', sm: '80%', md: '60%', lg: '50%' },
          minWidth: { xs: '90%', sm: '35rem' },
          maxWidth: '42rem',
          minHeight: 'auto',
          maxHeight: '80vh',
          overflow: 'auto',
          p: 3,
          bgcolor: theme.palette.background.body,
        })}
      >
        <ModalClose />
        <Typography level="h4" fontWeight="lg" mb={2}>
          Add Knowledge
        </Typography>

        <Box
          sx={theme => ({
            border: '1px solid',
            borderColor: isDragging ? 'primary.main' : 'divider',
            borderRadius: '8px',
            p: 3,
            mb: 2,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: isDragging ? 'action.hover' : theme.palette.background.panel,
            transition: 'all 0.3s',
            minHeight: '100px',
          })}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <Typography level="body-lg" sx={{ textAlign: 'center', mb: 2 }}>
            {isDragging ? 'Drop your files here' : <>Drag & Drop your files here</>}
          </Typography>
          <Button
            variant="outlined"
            startDecorator={<FileUploadIcon />}
            onClick={handleBrowseClick}
            sx={{
              minWidth: '200px',
              '@media (max-width: 600px)': {
                width: '100%',
              },
            }}
          >
            Browse Files
          </Button>
          <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileSelect} multiple />
        </Box>

        {showKnowledgeModal && <KnowledgeModal />}
      </ModalDialog>
    </Modal>
  );
};

export default AddKnowledgeModal;
