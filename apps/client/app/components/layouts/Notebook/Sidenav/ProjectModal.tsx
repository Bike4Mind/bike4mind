import { useMemo, useState } from 'react';
import {
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Autocomplete,
} from '@mui/joy';
import { debounce } from 'lodash';
import { toast } from 'sonner';
import { IProjectDocument } from '@bike4mind/common';
import { useSearchProjects, useAddSessionsToProject } from '@client/app/hooks/data/projects';
import type { CombinedSessionDocument } from './types';

interface ProjectModalProps {
  open: boolean;
  /** Close without clearing selection - mirrors the backdrop-dismiss behaviour. */
  onClose: () => void;
  selectedItems: Set<string>;
  combinedSessions: CombinedSessionDocument[];
  /** Called after a successful add so the parent can clear the selection. */
  onAdded: () => void;
}

/**
 * "Add to Project" bulk-action modal. Owns its own project-search state (search text,
 * debounce, selection) since none of it is consumed elsewhere in the sidebar. The parent
 * only supplies the current selection and an `onAdded` hook to clear it on success.
 */
const ProjectModal = ({ open, onClose, selectedItems, combinedSessions, onAdded }: ProjectModalProps) => {
  const [selectedProject, setSelectedProject] = useState<IProjectDocument | null>(null);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectInputValue, setProjectInputValue] = useState('');

  // Debounced search for project selection modal
  const debouncedProjectSearch = useMemo(
    () =>
      debounce((value: string) => {
        setProjectSearch(value);
      }, 300),
    []
  );

  // Search projects for the modal
  const { data: projectSearchResults, isLoading: isSearchingProjects } = useSearchProjects(
    projectSearch,
    {},
    { by: 'updatedAt', direction: 'desc' },
    { enabled: open }
  );

  const availableProjects = projectSearchResults?.pages.flatMap(page => page.data) ?? [];

  // Add sessions to project mutation
  const addSessionsToProject = useAddSessionsToProject({
    onSuccess: () => {
      toast.success('Added to project successfully');
      onClose();
      setSelectedProject(null);
      setProjectInputValue('');
      onAdded();
    },
    onError: () => {
      toast.error('Failed to add to project');
    },
  });

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog>
        <DialogTitle>Add to Project</DialogTitle>
        <DialogContent>
          <Typography level="body-md" sx={{ mb: 2 }}>
            Add {selectedItems.size} item{selectedItems.size > 1 ? 's' : ''} to a project
          </Typography>

          <Autocomplete
            placeholder="Search projects..."
            loading={isSearchingProjects}
            options={availableProjects}
            value={selectedProject}
            inputValue={projectInputValue}
            onChange={(_event, newValue) => setSelectedProject(newValue)}
            onInputChange={(_event, value) => {
              setProjectInputValue(value);
              debouncedProjectSearch(value);
            }}
            getOptionLabel={option => option.name}
            slotProps={{
              listbox: {
                sx: {
                  maxHeight: '200px',
                },
              },
            }}
            sx={{ mb: 2 }}
          />

          {selectedProject && (
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              Selected: <strong>{selectedProject.name}</strong>
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => {
              onClose();
              setSelectedProject(null);
              setProjectInputValue('');
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={async () => {
              if (!selectedProject) return;

              const itemsToAdd = Array.from(selectedItems);
              const sessionIds = combinedSessions
                .filter(s => itemsToAdd.includes(s.id) && !s.isProject && !s.isAgent)
                .map(s => s.id);

              if (sessionIds.length === 0) {
                toast.error('Only notebooks can be added to projects');
                return;
              }

              await addSessionsToProject.mutateAsync({
                projectId: selectedProject.id,
                sessionIds,
              });
            }}
            disabled={!selectedProject || addSessionsToProject.isPending}
            loading={addSessionsToProject.isPending}
          >
            Add to Project
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default ProjectModal;
