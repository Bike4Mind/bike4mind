import { KnowledgeType, IFabFileDocument } from '@bike4mind/common';
import { useCreateFabFile } from '@client/app/hooks/data/fabFiles';
import { Box, Button, CircularProgress, Theme, Typography } from '@mui/joy';
import { SxProps } from '@mui/system';
import { FC, ReactNode, useRef, useState } from 'react';

interface KnowledgeDragDropInputProps {
  sx?: SxProps<Theme>;
  label?: ReactNode;
  onSuccess: (file: IFabFileDocument) => void;
}

const KnowledgeDragDropInput: FC<KnowledgeDragDropInputProps> = ({ onSuccess, label, sx }) => {
  const { mutate: createFabFile, isPending } = useCreateFabFile();
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      await handleFiles(Array.from(files));
    }
  };

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      const data = {
        type: KnowledgeType.FILE,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      };

      createFabFile([{ file, ...data }]);
    }
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <Box
      sx={
        sx ||
        (theme => ({
          border: '1px solid',
          borderColor: isDragging ? 'primary.main' : 'divider',
          borderRadius: '8px',
          p: { xs: '40px', sm: '140px' },
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'transparent',
          transition: 'all 0.3s',
          minHeight: '100px',
          mb: { xs: '0px', sm: '60px' },
        }))
      }
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <Typography level="body-md" sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: '16px' }}>
        {isPending ? (
          <CircularProgress />
        ) : isDragging ? (
          'Drop your files here'
        ) : (
          <>
            {label || 'Drag & Drop your files or'}{' '}
            <Button
              variant="plain"
              onClick={handleBrowseClick}
              sx={{
                p: 0,
                m: 0,
                fontWeight: 'inherit',
                fontSize: 'inherit',
                lineHeight: 'inherit',
                letterSpacing: 'inherit',
                textTransform: 'none',
                color: 'inherit',
                textDecoration: 'underline',
                '&:hover': {
                  bgcolor: 'transparent',
                },
                '&:focus': {
                  boxShadow: 'none',
                },
              }}
            >
              Browse
            </Button>
          </>
        )}
      </Typography>
      <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileSelect} multiple />
    </Box>
  );
};

export default KnowledgeDragDropInput;
