import React from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  Input,
  Button,
  Box,
  Card,
  AspectRatio,
  CircularProgress,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import ImageIcon from '@mui/icons-material/Image';
import { IFabFileDocument } from '@bike4mind/common';

interface ImageBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageSearch: string;
  onImageSearchChange: (value: string) => void;
  isLoadingImages: boolean;
  imageFiles: IFabFileDocument[];
  selectedImage: IFabFileDocument | null;
  onSelectImage: (file: IFabFileDocument) => void;
  onApplyImage: (file: IFabFileDocument) => void;
  onSearch: () => void;
}

const ImageBrowserModal: React.FC<ImageBrowserModalProps> = ({
  isOpen,
  onClose,
  imageSearch,
  onImageSearchChange,
  isLoadingImages,
  imageFiles,
  selectedImage,
  onSelectImage,
  onApplyImage,
  onSearch,
}) => {
  return (
    <Modal open={isOpen} onClose={onClose}>
      <ModalDialog
        sx={{
          maxWidth: '80%',
          maxHeight: '80vh',
          width: '700px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ModalClose onClick={onClose} />
        <Typography level="h4" mb={2}>
          Select Portrait Image
        </Typography>

        <Box sx={{ mb: 2, display: 'flex', gap: 1 }}>
          <Input
            startDecorator={<SearchIcon />}
            placeholder="Search images..."
            value={imageSearch}
            onChange={e => onImageSearchChange(e.target.value)}
            sx={{ flexGrow: 1 }}
          />
          <Button onClick={onSearch}>Search</Button>
        </Box>

        {isLoadingImages ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : imageFiles.length === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Typography level="body-lg">No images found</Typography>
            <Typography level="body-sm" sx={{ mt: 1, color: 'text.secondary' }}>
              Upload images through the File Browser to use them as agent portraits
            </Typography>
          </Box>
        ) : (
          <Box
            sx={{
              overflow: 'auto',
              flexGrow: 1,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 2,
              p: 1,
            }}
          >
            {imageFiles.map(file => (
              <Card
                key={file.id}
                variant="outlined"
                sx={{
                  cursor: 'pointer',
                  p: 1,
                  transition: 'all 0.2s',
                  '&:hover': { borderColor: 'primary.main' },
                  ...(selectedImage?.id === file.id
                    ? {
                        borderColor: 'primary.main',
                        borderWidth: 2,
                      }
                    : {}),
                }}
                onClick={() => onSelectImage(file)}
                onDoubleClick={() => onApplyImage(file)}
              >
                <AspectRatio ratio="1" sx={{ mb: 1 }}>
                  {file.fileUrl ? (
                    <img src={file.fileUrl} alt={file.fileName} style={{ objectFit: 'cover' }} loading="lazy" />
                  ) : (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        bgcolor: 'background.level2',
                      }}
                    >
                      <ImageIcon />
                    </Box>
                  )}
                </AspectRatio>
                <Typography
                  level="body-xs"
                  sx={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textAlign: 'center',
                  }}
                >
                  {file.fileName}
                </Typography>
              </Card>
            ))}
          </Box>
        )}

        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 2 }}>
          <Button
            variant="solid"
            color="primary"
            disabled={!selectedImage}
            onClick={() => {
              if (selectedImage) onApplyImage(selectedImage);
            }}
          >
            Select Image
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default ImageBrowserModal;
