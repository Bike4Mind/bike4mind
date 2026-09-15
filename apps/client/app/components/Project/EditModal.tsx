import { IProjectDocument } from '@bike4mind/common';
import { useUpdateProject } from '@client/app/hooks/data/projects';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Box,
  Button,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Textarea,
  FormHelperText,
} from '@mui/joy';
import { FC, ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

interface ProjectEditModalOptions {
  onClick: () => void;
}

interface ProjectEditModalProps {
  /**
   * If the modal is open, it will be controlled by this prop.
   * If it is not provided, the modal will be controlled by the internal state.
   */
  open?: boolean;
  setOpen?: (open: boolean) => void;
  project: IProjectDocument;
  children?: (options: ProjectEditModalOptions) => ReactNode;
  onSuccess?: (updatedProject: IProjectDocument) => void;
}

const ProjectEditModal: FC<ProjectEditModalProps> = ({ project, children, onSuccess, open, setOpen }) => {
  const [openModal, setOpenModal] = useState(false);
  const { mutate: updateProject, isPending } = useUpdateProject({
    onSuccess: (project: IProjectDocument) => {
      onSuccess?.(project);
      handleClose();
    },
  });
  const {
    handleSubmit,
    register,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm({
    defaultValues: project,
    resolver: zodResolver(
      z.object({
        name: z.string().min(1, 'Project name is required.'),
        description: z.string().min(1, 'Please write a description for the Project.'),
      }) as any
    ),
  });

  const handleClose = () => {
    reset(project);
    setOpen?.(false);
    setOpenModal(false);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.slice(0, 50);
    setValue('name', value);
  };

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value.slice(0, 500);
    setValue('description', value);
  };

  return (
    <>
      {open === undefined && children?.({ onClick: () => setOpenModal(true) })}
      <Modal open={open || openModal} onClose={handleClose} className="project-edit-modal">
        <ModalDialog className="project-edit-modal-dialog">
          <ModalClose className="project-edit-modal-close" />
          <Box
            display="flex"
            flexDirection="column"
            gap="30px"
            className="project-edit-modal-content"
            sx={{
              minWidth: { xs: '100%', sm: '400px' },
            }}
          >
            <Box fontSize="20px" lineHeight="20px" className="project-edit-modal-title">
              Edit Project
            </Box>
            <Box display="flex" flexDirection="column" gap="30px" data-testid="project-edit-modal-form">
              <FormControl className="project-edit-form-control">
                <FormLabel className="project-edit-form-label">Project Name</FormLabel>
                <Input
                  {...register('name')}
                  // eslint-disable-next-line react-hooks/incompatible-library
                  value={watch('name')}
                  onChange={handleNameChange}
                  data-testid="name-input"
                />
                <FormHelperText
                  className="project-edit-helper-text"
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span className="project-edit-error-message">{errors.name?.message as string}</span>
                  <span className="project-edit-character-count" style={{ fontSize: '12px' }}>
                    {watch('name').length}/50
                  </span>
                </FormHelperText>
              </FormControl>
              <FormControl className="project-edit-form-control">
                <FormLabel className="project-edit-form-label">Description</FormLabel>
                <Textarea
                  minRows={3}
                  {...register('description')}
                  value={watch('description')}
                  onChange={handleDescriptionChange}
                  data-testid="description-textarea"
                />
                <FormHelperText
                  className="project-edit-helper-text"
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span className="project-edit-error-message">{errors.description?.message as string}</span>
                  <span className="project-edit-character-count" style={{ fontSize: '12px' }}>
                    {watch('description').length}/500
                  </span>
                </FormHelperText>
              </FormControl>
            </Box>
            <Box display="flex" gap="20px" className="project-edit-modal-actions">
              <Button
                fullWidth
                variant="outlined"
                onClick={handleClose}
                color="neutral"
                className="project-edit-cancel-button"
              >
                Cancel
              </Button>
              <Button
                fullWidth
                disabled={isPending}
                loading={isPending}
                onClick={handleSubmit(data => updateProject({ ...project, ...data }))}
                className="project-edit-update-button"
                data-testid="update-project-btn"
              >
                Update Project
              </Button>
            </Box>
          </Box>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default ProjectEditModal;
