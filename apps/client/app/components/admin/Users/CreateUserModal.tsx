import React, { useState, useMemo } from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  FormControl,
  FormLabel,
  Input,
  Button,
  Stack,
  Select,
  Option,
  Checkbox,
  Alert,
  CircularProgress,
  Box,
  Chip,
  ChipDelete,
} from '@mui/joy';
import { create } from 'zustand';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { PREDEFINED_USER_TAGS } from '@bike4mind/common';
import { useGetUserTags } from '@client/app/hooks/data/user';

interface CreateUserModalStore {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useCreateUserModal = create<CreateUserModalStore>(set => ({
  open: false,
  setOpen: (open: boolean) => set({ open }),
}));

interface CreateUserFormData {
  username: string;
  email: string;
  name: string;
  isAdmin: boolean;
  level: string;
  initialCredits: number;
  storageLimit: number;
  tags: string[];
}

const DEFAULT_FORM_DATA: CreateUserFormData = {
  username: '',
  email: '',
  name: '',
  isAdmin: false,
  level: 'DemoUser',
  initialCredits: 10000,
  storageLimit: 1000,
  tags: [],
};

const USER_LEVELS = ['DemoUser', 'PaidUser', 'VIPUser', 'ManagerUser', 'AdminUser'];

const CreateUserModal: React.FC = () => {
  const { open, setOpen } = useCreateUserModal();
  const [formData, setFormData] = useState<CreateUserFormData>(DEFAULT_FORM_DATA);
  const queryClient = useQueryClient();
  const userTagsQuery = useGetUserTags();

  const availableTags = useMemo(() => {
    const apiTags = userTagsQuery.data || [];
    return Array.from(new Set(['Admin', ...PREDEFINED_USER_TAGS, ...apiTags]));
  }, [userTagsQuery.data]);

  const createUserMutation = useMutation({
    mutationFn: async (userData: CreateUserFormData) => {
      console.log('Sending user data:', userData);
      const response = await api.post('/api/admin/create-user', userData);
      console.log('Success response:', response.data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      handleClose();
    },
    onError: (error: any) => {
      console.error('Error creating user:', error);
      console.error('Error response:', error.response?.data);
    },
  });

  const handleClose = () => {
    setFormData(DEFAULT_FORM_DATA);
    createUserMutation.reset();
    setOpen(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createUserMutation.mutate(formData);
  };

  const toggleTag = (tag: string) => {
    const currentTags = formData.tags;
    if (currentTags.includes(tag)) {
      const newTags = currentTags.filter(t => t !== tag);
      setFormData({
        ...formData,
        tags: newTags,
        // Uncheck Admin Privileges if Admin tag is unchecked
        isAdmin: tag === 'Admin' ? false : formData.isAdmin,
      });
    } else {
      const newTags = [...currentTags, tag];
      setFormData({
        ...formData,
        tags: newTags,
        // Check Admin Privileges if Admin tag is checked
        isAdmin: tag === 'Admin' ? true : formData.isAdmin,
      });
    }
  };

  const isFormValid = () => {
    return (
      formData.username.trim() !== '' &&
      formData.email.trim() !== '' &&
      formData.name.trim() !== '' &&
      formData.email.includes('@') &&
      formData.tags.length > 0
    );
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog
        sx={{
          minWidth: { xs: '90%', sm: 600 },
          maxWidth: 700,
          maxHeight: '90vh',
          overflow: 'auto',
          // On mobile, the default center layout (top:50% + translateY(-50%)) causes the modal
          // to jump when the virtual keyboard opens and shifts the visual viewport height.
          // Anchoring to a fixed top position with only horizontal centering prevents this.
          '@media (pointer: coarse)': {
            top: '5%',
            transform: 'translateX(-50%)',
          },
        }}
      >
        <ModalClose />
        <Typography level="h4" sx={{ mb: 2 }}>
          Create New User
        </Typography>

        {createUserMutation.isError && (
          <Alert
            color="danger"
            variant="soft"
            startDecorator={<ErrorOutlineIcon />}
            sx={{ mb: 2 }}
            endDecorator={
              <Button size="sm" variant="plain" onClick={() => createUserMutation.reset()}>
                Dismiss
              </Button>
            }
          >
            <Stack spacing={0.5}>
              <Typography level="body-sm" fontWeight="bold">
                Error creating user:
              </Typography>
              <Typography level="body-sm">
                {(createUserMutation.error as any)?.response?.data?.error ||
                  (createUserMutation.error as any)?.response?.data?.message ||
                  (createUserMutation.error as any)?.message ||
                  'Failed to create user'}
              </Typography>
            </Stack>
          </Alert>
        )}

        {createUserMutation.isSuccess && (
          <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineIcon />} sx={{ mb: 2 }}>
            User created successfully!
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <Stack spacing={2}>
            {/* Basic Information */}
            <Typography level="title-md" sx={{ mt: 1 }}>
              Basic Information
            </Typography>

            <FormControl required>
              <FormLabel>Username</FormLabel>
              <Input
                data-testid="create-user-username-input"
                placeholder="Enter username"
                value={formData.username}
                onChange={e => setFormData({ ...formData, username: e.target.value })}
                disabled={createUserMutation.isPending}
                autoComplete="off"
              />
            </FormControl>

            <FormControl required>
              <FormLabel>Email</FormLabel>
              <Input
                data-testid="create-user-email-input"
                type="email"
                placeholder="user@example.com"
                value={formData.email}
                onChange={e => setFormData({ ...formData, email: e.target.value })}
                disabled={createUserMutation.isPending}
                autoComplete="off"
              />
            </FormControl>

            <FormControl required>
              <FormLabel>Full Name</FormLabel>
              <Input
                data-testid="create-user-name-input"
                placeholder="Enter full name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                disabled={createUserMutation.isPending}
                autoComplete="off"
              />
            </FormControl>

            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              This app is passwordless — the user signs in with a one-time code emailed to the address above.
            </Typography>

            {/* User Settings */}
            <Typography level="title-md" sx={{ mt: 2 }}>
              User Settings
            </Typography>

            <FormControl required>
              <FormLabel>User Level</FormLabel>
              <Select
                data-testid="create-user-level-select"
                value={formData.level}
                onChange={(_, value) => setFormData({ ...formData, level: value || 'DemoUser' })}
                disabled={createUserMutation.isPending}
              >
                {USER_LEVELS.map(level => (
                  <Option key={level} value={level} data-testid={`create-user-level-option-${level.toLowerCase()}`}>
                    {level}
                  </Option>
                ))}
              </Select>
            </FormControl>

            <FormControl>
              <Checkbox
                data-testid="create-user-admin-checkbox"
                label="Admin Privileges"
                checked={formData.isAdmin}
                onChange={e => {
                  const isChecked = e.target.checked;
                  setFormData({ ...formData, isAdmin: isChecked });
                  // Automatically toggle Admin tag
                  if (isChecked && !formData.tags.includes('Admin')) {
                    setFormData(prev => ({ ...prev, tags: [...prev.tags, 'Admin'], isAdmin: isChecked }));
                  } else if (!isChecked && formData.tags.includes('Admin')) {
                    setFormData(prev => ({
                      ...prev,
                      tags: prev.tags.filter(tag => tag !== 'Admin'),
                      isAdmin: isChecked,
                    }));
                  }
                }}
                disabled={createUserMutation.isPending}
              />
            </FormControl>

            {/* Tags */}
            <FormControl>
              <FormLabel>User Tags</FormLabel>
              <Box
                sx={{
                  p: 2,
                  border: '1px solid',
                  borderColor: formData.tags.length === 0 ? 'danger.outlinedBorder' : 'neutral.outlinedBorder',
                  borderRadius: 'sm',
                  maxHeight: 200,
                  overflowY: 'auto',
                }}
              >
                <Stack spacing={1}>
                  {availableTags.map(tag => (
                    <Box key={tag}>
                      <Checkbox
                        data-testid={`create-user-tag-${tag.toLowerCase().replace(/\s+/g, '-')}`}
                        label={tag}
                        checked={formData.tags.includes(tag)}
                        onChange={() => toggleTag(tag)}
                        disabled={createUserMutation.isPending}
                      />
                    </Box>
                  ))}
                </Stack>
              </Box>
              <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.secondary' }}>
                Tags determine which models are available to the user. For external users, recommend the{' '}
                <Typography fontWeight="bold">&quot;Customer&quot;</Typography> tag.
              </Typography>
              {formData.tags.length === 0 && (
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'danger.500' }}>
                  Please select at least one tag
                </Typography>
              )}
            </FormControl>

            {formData.tags.length > 0 && (
              <Box>
                <Typography level="body-sm" sx={{ mb: 1, fontWeight: 500 }}>
                  Selected Tags ({formData.tags.length}):
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
                  {formData.tags.map(tag => (
                    <Chip
                      key={tag}
                      size="sm"
                      variant="soft"
                      color="primary"
                      endDecorator={<ChipDelete onDelete={() => toggleTag(tag)} />}
                    >
                      {tag}
                    </Chip>
                  ))}
                </Stack>
              </Box>
            )}

            {/* Resources */}
            <Typography level="title-md" sx={{ mt: 2 }}>
              Resources
            </Typography>

            <FormControl>
              <FormLabel>Initial Credits</FormLabel>
              <Input
                data-testid="create-user-credits-input"
                type="number"
                value={formData.initialCredits}
                onChange={e => setFormData({ ...formData, initialCredits: parseInt(e.target.value) || 0 })}
                disabled={createUserMutation.isPending}
                slotProps={{
                  input: {
                    min: 0,
                  },
                }}
              />
            </FormControl>

            <FormControl>
              <FormLabel>Storage Limit (MB)</FormLabel>
              <Input
                data-testid="create-user-storage-input"
                type="number"
                value={formData.storageLimit}
                onChange={e => setFormData({ ...formData, storageLimit: parseInt(e.target.value) || 1000 })}
                disabled={createUserMutation.isPending}
                slotProps={{
                  input: {
                    min: 0,
                  },
                }}
              />
            </FormControl>

            <Alert color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />} sx={{ mt: 2 }}>
              <Typography level="body-sm">
                This will create a new user account with the specified settings. The user signs in with a one-time code
                emailed to their address.
              </Typography>
            </Alert>

            {/* Actions */}
            <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
              <Button
                data-testid="create-user-cancel-btn"
                variant="outlined"
                color="neutral"
                onClick={handleClose}
                disabled={createUserMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                data-testid="create-user-submit-btn"
                type="submit"
                disabled={!isFormValid() || createUserMutation.isPending}
                startDecorator={createUserMutation.isPending ? <CircularProgress size="sm" /> : null}
              >
                {createUserMutation.isPending ? 'Creating...' : 'Create User'}
              </Button>
            </Stack>
          </Stack>
        </form>
      </ModalDialog>
    </Modal>
  );
};

export default CreateUserModal;
