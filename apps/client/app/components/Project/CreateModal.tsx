import { useCreateProject } from '@client/app/hooks/data/projects';
import {
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Textarea,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import { useState } from 'react';
import ProjectAddSessionsModal from './AddSessionsModal';
import ProjectAddFilesModal from './AddFilesModal';
import { useForm } from 'react-hook-form';
import { IProjectDocument } from '@bike4mind/common';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const ProjectCreateModal = ({ label, testId = 'new-project-btn' }: { label?: string; testId?: string }) => {
  const defaultValues: Pick<IProjectDocument, 'name' | 'description'> = { name: '', description: '' };
  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm({
    defaultValues: defaultValues,
    resolver: zodResolver(
      z.object({
        name: z.string().min(1, 'Project name is required.'),
        description: z.string().min(1, 'Please write a description for the Project.'),
      }) as any
    ),
  });

  const { mutate: createProject, isPending } = useCreateProject({
    onSuccess: () => {
      setSelectedSessions([]);
      setSelectedFiles([]);
      setOpen(false);
      reset(defaultValues);
    },
  });
  const [open, setOpen] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.slice(0, 50);
    // shouldValidate re-runs validation on change so a stale error clears as soon as the field becomes valid
    setValue('name', value, { shouldValidate: true });
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value.slice(0, 500);
    setValue('description', value, { shouldValidate: true });
  };

  const handleCloseModal = () => {
    setOpen(false);
    reset(defaultValues);
  };

  const handleCreate = (data: Pick<IProjectDocument, 'name' | 'description'>) => {
    createProject({
      name: data.name,
      description: data.description,
      sessionIds: selectedSessions,
      fileIds: selectedFiles,
    });
  };

  return (
    <>
      <Button
        className="create-project-button"
        data-testid={testId}
        onClick={() => setOpen(true)}
        sx={{ height: '36px', fontSize: '14px', fontWeight: '400', gap: '5px', borderRadius: '8px', minWidth: '140px' }}
      >
        <AddIcon /> {label ?? 'New Project'}
      </Button>

      <Modal className="create-project-modal" open={open} onClose={handleCloseModal}>
        <ModalDialog data-testid="create-project-modal-dialog">
          <form noValidate onSubmit={handleSubmit(handleCreate)}>
            <ModalClose className="create-project-modal-close" />
            <Box
              data-testid="create-project-form-container"
              display="flex"
              flexDirection="column"
              gap="30px"
              sx={{
                minWidth: { xs: '100%', sm: '400px' },
              }}
            >
              <Box className="create-project-title" fontSize="20px" lineHeight="20px">
                Create Project
              </Box>
              <Box className="create-project-form-fields" display="flex" flexDirection="column" gap="30px">
                <FormControl required className="create-project-name-control">
                  <FormLabel className="create-project-name-label">Project Name</FormLabel>
                  <Input
                    data-testid="name-input"
                    {...register('name')}
                    // eslint-disable-next-line react-hooks/incompatible-library
                    value={watch('name')}
                    onChange={handleNameChange}
                  />
                  <FormHelperText
                    className="create-project-name-helper"
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>{errors.name?.message as string}</span>
                    <span style={{ fontSize: '12px' }}>{watch('name').length}/50</span>
                  </FormHelperText>
                </FormControl>
                <FormControl required className="create-project-description-control">
                  <FormLabel className="create-project-description-label">Description</FormLabel>
                  <Textarea
                    data-testid="description-textarea"
                    minRows={3}
                    {...register('description')}
                    value={watch('description')}
                    onChange={handleDescriptionChange}
                  />
                  <FormHelperText
                    className="create-project-description-helper"
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>{errors.description?.message as string}</span>
                    <span style={{ fontSize: '12px' }}>{watch('description').length}/500</span>
                  </FormHelperText>
                </FormControl>

                <Stack className="create-project-add-section" gap={2}>
                  <Box className="create-project-add-container">
                    <FormLabel className="create-project-add-label" sx={{ mb: 1, display: 'block' }}>
                      Add Files and Sessions
                    </FormLabel>
                    <Stack className="create-project-add-buttons" direction="row" gap={2}>
                      <ProjectAddFilesModal
                        projectId=""
                        onAdd={fileIds => setSelectedFiles(fileIds)}
                        value={selectedFiles}
                      />
                      <ProjectAddSessionsModal
                        projectId=""
                        onAdd={sessionIds => setSelectedSessions(sessionIds)}
                        value={selectedSessions}
                      />
                    </Stack>
                  </Box>
                </Stack>
              </Box>
              <Box className="create-project-action-buttons" display="flex" gap="20px">
                <Button
                  className="create-project-cancel-button"
                  fullWidth
                  variant="outlined"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="create-project-submit-button"
                  data-testid="create-project-submit-btn"
                  fullWidth
                  disabled={isPending}
                  type="submit"
                >
                  Create Project
                </Button>
              </Box>
            </Box>
          </form>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default ProjectCreateModal;
