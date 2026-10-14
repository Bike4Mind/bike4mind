import { useCreateProject } from '@client/app/hooks/data/projects';
import {
  Box,
  Button,
  DialogTitle,
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
import { useEffect, useRef, useState } from 'react';
import ProjectAddSessionsModal from './AddSessionsModal';
import ProjectAddFilesModal from './AddFilesModal';
import { useForm } from 'react-hook-form';
import { IProjectDocument } from '@bike4mind/common';
import { useNavigate } from '@tanstack/react-router';
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
        description: z.string(),
      }) as any
    ),
  });

  const navigate = useNavigate();
  const skipFocusReturnRef = useRef(false);
  const { mutate: createProject, isPending } = useCreateProject({
    onSuccess: project => {
      // The new project's page takes focus, so the opener must not steal it back.
      skipFocusReturnRef.current = true;
      setSelectedSessions([]);
      setSelectedFiles([]);
      setOpen(false);
      reset(defaultValues);
      navigate({ to: `/projects/${project.id}` });
    },
  });
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) wasOpenRef.current = true;
    else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (skipFocusReturnRef.current) skipFocusReturnRef.current = false;
      else openerRef.current?.focus();
    }
  }, [open]);

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
        ref={openerRef}
        className="create-project-button"
        data-testid={testId}
        onClick={() => setOpen(true)}
        sx={{ height: '36px', fontSize: '14px', fontWeight: '400', gap: '5px', borderRadius: '8px', minWidth: '140px' }}
      >
        <AddIcon /> {label ?? 'New Project'}
      </Button>

      <Modal
        className="create-project-modal"
        open={open}
        onClose={handleCloseModal}
        // Modal would restore focus to whatever held it at open time, which is <body> when the
        // opener was clicked in a browser that does not focus buttons on click; the effect above
        // returns focus to the opener on every close path instead.
        disableRestoreFocus
      >
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
              <DialogTitle
                component="h2"
                className="create-project-title"
                sx={{ fontSize: '20px', lineHeight: '20px' }}
              >
                Create Project
              </DialogTitle>
              <Box className="create-project-form-fields" display="flex" flexDirection="column" gap="30px">
                <FormControl required className="create-project-name-control">
                  <FormLabel className="create-project-name-label">Project Name</FormLabel>
                  <Input
                    data-testid="name-input"
                    autoFocus
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
                <FormControl className="create-project-description-control">
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
