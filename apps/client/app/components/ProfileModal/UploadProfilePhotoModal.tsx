import React, { useCallback, useState } from 'react';
import { Box, Button, Modal, ModalDialog, Typography } from '@mui/joy';
import { FilePond, registerPlugin } from 'react-filepond';
import 'filepond/dist/filepond.min.css';

// Type assertion for FilePond component
const FilePondComponent = FilePond as any;
import FilePondPluginImageExifOrientation from 'filepond-plugin-image-exif-orientation';
import FilePondPluginImagePreview from 'filepond-plugin-image-preview';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import FilePondPluginFileValidateSize from 'filepond-plugin-file-validate-size';
import { useUser } from '@client/app/contexts/UserContext';
import { useUploadProfilePhoto } from '@client/app/utils/userAPICalls';
import { toast } from 'sonner';

registerPlugin(FilePondPluginImageExifOrientation, FilePondPluginImagePreview, FilePondPluginFileValidateSize);

interface UploadProfilePhotoModalProps {
  open: boolean;
  onClose: () => void;
  onUploadComplete: (photoUrl: string) => void;
}

const UploadProfilePhotoModal: React.FC<UploadProfilePhotoModalProps> = ({ open, onClose, onUploadComplete }) => {
  const [files, setFiles] = useState<any[]>([]);
  const { currentUser } = useUser();
  const uploadPhoto = useUploadProfilePhoto();

  const handleProcessFile = useCallback(
    async (
      fieldName: string,
      file: File,
      metadata: any,
      load: (fileId: string | number) => void,
      error: (message: string) => void,
      progress: (computable: boolean, loaded: number, total: number) => void
    ) => {
      if (!currentUser?.id) {
        error('User not found');
        toast.error('User not found');
        return;
      }

      try {
        const result = await uploadPhoto.mutateAsync({
          userId: currentUser.id,
          fileInfo: {
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type,
          },
          file,
        });

        load((result as any)?.id || file.name);
        onUploadComplete((result as any)?.photoUrl || URL.createObjectURL(file));
        setFiles([]);
        toast.success('Profile photo updated successfully');
      } catch (err) {
        error('Upload failed');
        toast.error('Failed to upload profile photo');
        console.error('Upload error:', err);
      }
    },
    [onUploadComplete, currentUser, uploadPhoto]
  );

  return (
    <Modal className="profile-photo-upload-modal" open={open} onClose={onClose}>
      <ModalDialog
        className="profile-photo-upload-dialog"
        sx={{
          maxWidth: 300,
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
        }}
      >
        <Typography className="profile-photo-upload-title" level="h4" component="h2" sx={{ mb: 2 }}>
          Upload Profile Photo
        </Typography>
        <Box className="profile-photo-upload-filepond-container" sx={{ width: '100%' }}>
          <FilePondComponent
            files={files}
            onupdatefiles={setFiles}
            allowMultiple={false}
            maxFiles={1}
            server={{
              process: handleProcessFile,
            }}
            acceptedFileTypes={['image/png', 'image/jpeg', 'image/jpg']}
            labelIdle='Drag & Drop your photo or <span class="filepond--label-action">Browse</span>'
            maxFileSize="5MB"
            imagePreviewHeight={170}
            stylePanelLayout="compact"
          />
        </Box>
        <Box
          className="profile-photo-upload-actions"
          sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 2 }}
        >
          <Button className="profile-photo-upload-cancel-btn" variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default UploadProfilePhotoModal;
