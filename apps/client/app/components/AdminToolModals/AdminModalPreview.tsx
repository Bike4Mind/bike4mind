import React, { useState } from 'react';
import {
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Typography,
  Box,
  Input,
  Textarea,
  FormControl,
  FormLabel,
  Chip,
  IconButton,
  Alert,
  Divider,
  Grid,
} from '@mui/joy';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import PreviewIcon from '@mui/icons-material/Preview';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { IModal } from '@bike4mind/common';
import GenericModal from '@client/app/components/modals/GenericModal';

interface AdminModalPreviewProps {
  isOpen: boolean;
  onClose: () => void;
  modalData: Partial<IModal>;
  onConfirm: (editedData: Partial<IModal>) => void;
  onEdit?: (field: string, value: any) => void;
  isEditing?: boolean;
}

export const AdminModalPreview: React.FC<AdminModalPreviewProps> = ({
  isOpen,
  onClose,
  modalData,
  onConfirm,
  onEdit,
  isEditing = true,
}) => {
  const [editedData, setEditedData] = useState<Partial<IModal>>(modalData);
  const [showLivePreview, setShowLivePreview] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);

  const handleFieldEdit = (field: keyof IModal, value: any) => {
    setEditedData(prev => ({ ...prev, [field]: value }));
    if (onEdit) {
      onEdit(field, value);
    }
  };

  const handleConfirm = () => {
    onConfirm(editedData);
    onClose();
  };

  return (
    <>
      <Modal open={isOpen} onClose={onClose}>
        <ModalDialog
          variant="outlined"
          size="lg"
          sx={{ width: '90%', maxWidth: 800, maxHeight: '90vh', overflow: 'auto' }}
        >
          <DialogTitle>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Stack direction="row" spacing={1} alignItems="center">
                <AutoAwesomeIcon color="primary" />
                <Typography level="h4">AI-Generated {editedData.isBanner ? 'Banner' : 'Modal'} Preview</Typography>
              </Stack>
              <IconButton size="sm" variant="plain" onClick={onClose}>
                <CancelIcon />
              </IconButton>
            </Stack>
          </DialogTitle>

          <Divider />

          <DialogContent>
            <Alert color="primary" variant="soft" startDecorator={<AutoAwesomeIcon />} sx={{ mb: 2 }}>
              This {editedData.isBanner ? 'banner' : 'modal'} was generated based on your request. Review and edit as
              needed before creating.
            </Alert>

            <Grid container spacing={2}>
              {/* Left Column - Content */}
              <Grid xs={12} md={6}>
                <Stack spacing={2}>
                  {!editedData.isBanner && (
                    <>
                      <FormControl>
                        <FormLabel>Title</FormLabel>
                        {isEditMode ? (
                          <Input
                            value={editedData.title || ''}
                            onChange={e => handleFieldEdit('title', e.target.value)}
                          />
                        ) : (
                          <Typography level="body-md">{editedData.title || 'No title'}</Typography>
                        )}
                      </FormControl>

                      <FormControl>
                        <FormLabel>Subtitle</FormLabel>
                        {isEditMode ? (
                          <Input
                            value={editedData.subtitle || ''}
                            onChange={e => handleFieldEdit('subtitle', e.target.value)}
                          />
                        ) : (
                          <Typography level="body-md">{editedData.subtitle || 'No subtitle'}</Typography>
                        )}
                      </FormControl>
                    </>
                  )}

                  {editedData.isBanner && (
                    <FormControl>
                      <FormLabel>Banner Message</FormLabel>
                      {isEditMode ? (
                        <Input
                          value={editedData.textMessage || ''}
                          onChange={e => handleFieldEdit('textMessage', e.target.value)}
                        />
                      ) : (
                        <Typography level="body-md">{editedData.textMessage || 'No message'}</Typography>
                      )}
                    </FormControl>
                  )}

                  <FormControl>
                    <FormLabel>Description</FormLabel>
                    {isEditMode ? (
                      <Textarea
                        minRows={3}
                        value={editedData.description || ''}
                        onChange={e => handleFieldEdit('description', e.target.value)}
                      />
                    ) : (
                      <Typography level="body-md">{editedData.description || 'No description'}</Typography>
                    )}
                  </FormControl>

                  {editedData.imageUrl && (
                    <FormControl>
                      <FormLabel>Image</FormLabel>
                      <Box
                        sx={{
                          width: '100%',
                          height: 150,
                          borderRadius: 'md',
                          overflow: 'hidden',
                          bgcolor: 'background.level1',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <img
                          src={editedData.imageUrl}
                          alt="Modal preview"
                          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                        />
                      </Box>
                    </FormControl>
                  )}
                </Stack>
              </Grid>

              {/* Right Column - Settings */}
              <Grid xs={12} md={6}>
                <Stack spacing={2}>
                  <FormControl>
                    <FormLabel>Type</FormLabel>
                    <Chip variant="solid" color={editedData.isBanner ? 'warning' : 'primary'}>
                      {editedData.isBanner ? 'Banner' : 'Modal'}
                    </Chip>
                  </FormControl>

                  <FormControl>
                    <FormLabel>Priority</FormLabel>
                    {isEditMode ? (
                      <Input
                        type="number"
                        value={editedData.priority || 5}
                        onChange={e => handleFieldEdit('priority', parseInt(e.target.value))}
                        slotProps={{
                          input: { min: 0, max: 10 },
                        }}
                      />
                    ) : (
                      <Typography level="body-md">{editedData.priority || 5}</Typography>
                    )}
                  </FormControl>

                  <FormControl>
                    <FormLabel>Target Tags</FormLabel>
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      {editedData.tags && editedData.tags.length > 0 ? (
                        editedData.tags.map(tag => (
                          <Chip key={tag} size="sm" variant="outlined">
                            {tag}
                          </Chip>
                        ))
                      ) : (
                        <Chip size="sm" variant="soft">
                          All users
                        </Chip>
                      )}
                    </Stack>
                  </FormControl>

                  <FormControl>
                    <FormLabel>Schedule</FormLabel>
                    <Typography level="body-sm">
                      {editedData.startDate} to {editedData.endDate}
                    </Typography>
                  </FormControl>

                  <FormControl>
                    <FormLabel>Status</FormLabel>
                    <Chip size="sm" variant="soft" color={editedData.enabled ? 'success' : 'neutral'}>
                      {editedData.enabled ? 'Enabled' : 'Disabled (Safe Default)'}
                    </Chip>
                  </FormControl>

                  <Box>
                    <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 1 }}>
                      Options:
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      {editedData.closeButton && (
                        <Chip size="sm" variant="soft">
                          Has Close Button
                        </Chip>
                      )}
                      {editedData.agreeButton && (
                        <Chip size="sm" variant="soft">
                          Has Agree Button
                        </Chip>
                      )}
                    </Stack>
                  </Box>
                </Stack>
              </Grid>
            </Grid>

            {/* Edit Mode Toggle */}
            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}>
              {!isEditMode ? (
                <Button variant="outlined" startDecorator={<EditIcon />} onClick={() => setIsEditMode(true)}>
                  Edit Content
                </Button>
              ) : (
                <Button
                  variant="soft"
                  color="success"
                  startDecorator={<CheckCircleIcon />}
                  onClick={() => setIsEditMode(false)}
                >
                  Done Editing
                </Button>
              )}
            </Box>
          </DialogContent>

          <Divider />

          <DialogActions>
            <Button variant="outlined" color="neutral" onClick={onClose}>
              Cancel
            </Button>

            <Button
              variant="outlined"
              color={showLivePreview ? 'danger' : 'primary'}
              startDecorator={<PreviewIcon />}
              onClick={() => setShowLivePreview(!showLivePreview)}
            >
              {showLivePreview ? 'Hide Live Preview' : 'Show Live Preview'}
            </Button>

            <Button variant="solid" color="success" startDecorator={<CheckCircleIcon />} onClick={handleConfirm}>
              Create {editedData.isBanner ? 'Banner' : 'Modal'}
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Live Preview Modal */}
      {showLivePreview && (
        <GenericModal
          {...(editedData as IModal)}
          isOpen={showLivePreview}
          onClose={() => setShowLivePreview(false)}
          onAgree={() => setShowLivePreview(false)}
          isPreview={true}
        />
      )}
    </>
  );
};
