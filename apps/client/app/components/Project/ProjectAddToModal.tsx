import { IProjectDocument } from '@bike4mind/common';
import {
  useAddFilesToProject,
  useAddSessionsToProject,
  useCreateProject,
  useSearchProjects,
} from '@client/app/hooks/data/projects';
import {
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Typography,
} from '@mui/joy';
import { FC, ReactNode, useMemo, useState, createContext, useContext, useRef, useEffect } from 'react';
import { debounce } from 'lodash';

interface ProjectAddToModalContextType {
  openModal: (dataId: string, dataType: 'file' | 'session') => void;
}

const ProjectAddToModalContext = createContext<ProjectAddToModalContextType | null>(null);

export const ProjectAddToModalProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [modalData, setModalData] = useState<{ dataId: string; dataType: 'file' | 'session' } | null>(null);
  const isInitialized = useRef(false);

  useEffect(() => {
    isInitialized.current = true;
    return () => {
      isInitialized.current = false;
    };
  }, []);

  const openModal = (dataId: string, dataType: 'file' | 'session') => {
    if (!isInitialized.current) return;
    setModalData({ dataId, dataType });
    setIsOpen(true);
  };

  const contextValue = useMemo(() => ({ openModal }), []);

  return (
    <ProjectAddToModalContext.Provider value={contextValue}>
      {children}
      {modalData && (
        <div className="project-add-to-modal-provider-wrapper">
          <ProjectAddToModal
            dataId={modalData.dataId}
            dataType={modalData.dataType}
            open={isOpen}
            setOpen={setIsOpen}
          />
        </div>
      )}
    </ProjectAddToModalContext.Provider>
  );
};

export const useProjectAddToModal = () => {
  const context = useContext(ProjectAddToModalContext);
  if (!context) {
    // Instead of throwing, return a no-op function
    return {
      openModal: () => {
        console.warn('ProjectAddToModalProvider not initialized yet');
      },
    };
  }
  return context;
};

interface ProjectAddToModalOptions {
  onClick: () => void;
}

interface ProjectAddToModalProps {
  /**
   * If the modal is open, it will be controlled by this prop.
   * If it is not provided, the modal will be controlled by the internal state.
   */
  open?: boolean;
  setOpen?: (open: boolean) => void;
  dataId: string;
  dataType: 'file' | 'session';
  children?: (options: ProjectAddToModalOptions) => ReactNode;
}

export const ProjectAddToModal: FC<ProjectAddToModalProps> = ({ dataId, dataType, children, open, setOpen }) => {
  const [openModal, setOpenModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedProject, setSelectedProject] = useState<IProjectDocument | null>(null);
  const [search, setSearch] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [newProjectName, setNewProjectName] = useState('');

  const debouncedSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
      }, 300),
    []
  );

  // Clear the search term whenever the modal opens. The Autocomplete feeds the
  // typed/selected text back into the server `search` param, which narrows the
  // project list to that one match. If it isn't reset, reopening the modal
  // shows only the previously selected project instead of all of them.
  const isOpen = open || openModal;
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setInputValue('');
      setSelectedProject(null);
      setNewProjectName('');
    }
  }, [isOpen]);

  // isOpen, not `open`: the render-prop caller (file browser) leaves `open` undefined and drives
  // the internal state instead, so keying on `open` left its list permanently empty.
  const { data: projectResults, isLoading: isSearching } = useSearchProjects(
    search,
    {},
    { by: 'updatedAt', direction: 'desc' },
    { enabled: isOpen }
  );

  const projects = projectResults?.pages.flatMap(page => page.data) ?? [];
  // Only an unfiltered empty result means "no projects"; an empty search just found no match.
  const hasNoProjects = !!projectResults && !isSearching && !search && projects.length === 0;

  const addFileMutation = useAddFilesToProject({
    onSuccess: () => {
      setIsLoading(false);
      setOpen?.(false);
    },
    onError: () => {
      setIsLoading(false);
    },
  });

  const addSessionMutation = useAddSessionsToProject({
    onSuccess: () => {
      setIsLoading(false);
      setOpen?.(false);
    },
    onError: () => {
      setIsLoading(false);
    },
  });

  const createProject = useCreateProject({
    onSuccess: () => {
      setOpen?.(false);
      setOpenModal(false);
    },
  });

  const handleCreate = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    if (dataType === 'file') {
      createProject.mutate({ name, description: '', fileIds: [dataId] });
      return;
    }
    const project = await createProject.mutateAsync({ name, description: '' }).catch(() => undefined);
    if (project) {
      setIsLoading(true);
      addSessionMutation.mutate({ projectId: project.id, sessionIds: [dataId] });
    }
  };

  const handleAdd = async () => {
    if (!selectedProject) return;

    setIsLoading(true);
    if (dataType === 'file') {
      addFileMutation.mutate({ projectId: selectedProject.id, fileIds: [dataId] });
    } else {
      addSessionMutation.mutate({ projectId: selectedProject.id, sessionIds: [dataId] });
    }
  };

  const handleClose = () => {
    setOpen?.(false);
    setOpenModal(false);
    setSearch('');
    setInputValue('');
    setSelectedProject(null);
  };

  return (
    <>
      {open === undefined && children?.({ onClick: () => setOpenModal(true) })}
      {
        <Modal open={open || openModal} onClose={handleClose} className="project-add-to-modal">
          <ModalDialog className="project-add-to-modal-dialog">
            <ModalClose className="project-add-to-modal-close" />
            <Box
              display="flex"
              flexDirection="column"
              gap="30px"
              minWidth="400px"
              className="project-add-to-modal-content"
            >
              <Box fontSize="20px" lineHeight="20px" className="project-add-to-modal-title">
                Add to Project
              </Box>
              {hasNoProjects ? (
                <Box
                  display="flex"
                  flexDirection="column"
                  gap="16px"
                  className="project-add-to-modal-empty"
                  data-testid="project-add-to-modal-empty"
                  component="form"
                  onSubmit={(event: React.FormEvent) => {
                    event.preventDefault();
                    handleCreate();
                  }}
                >
                  <Typography level="body-md">
                    No projects yet. Create one and this {dataType === 'file' ? 'file' : 'notebook'} goes straight into
                    it.
                  </Typography>
                  <Input
                    autoFocus
                    placeholder="Project name"
                    value={newProjectName}
                    onChange={event => setNewProjectName(event.target.value)}
                    slotProps={{
                      input: { 'aria-label': 'Project name', 'data-testid': 'project-add-to-modal-name-input' },
                    }}
                  />
                  <Box display="flex" justifyContent="flex-end" gap="8px">
                    <Button variant="outlined" color="neutral" onClick={handleClose} disabled={createProject.isPending}>
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      loading={createProject.isPending}
                      disabled={!newProjectName.trim()}
                      data-testid="project-add-to-modal-create-btn"
                    >
                      Create project
                    </Button>
                  </Box>
                </Box>
              ) : (
                <Box display="flex" flexDirection="column" gap="16px" className="project-add-to-modal-form">
                  <Autocomplete
                    placeholder="Search projects..."
                    loading={isSearching}
                    options={projects}
                    value={selectedProject}
                    inputValue={inputValue}
                    onChange={(_event, newValue) => setSelectedProject(newValue)}
                    onInputChange={(_event, value) => {
                      setInputValue(value);
                      debouncedSearch(value);
                    }}
                    getOptionLabel={option => option.name}
                    slotProps={{
                      loading: {
                        children: <CircularProgress size="sm" className="project-add-to-modal-search-progress" />,
                      },
                    }}
                    className="project-add-to-modal-autocomplete"
                  />
                  <Box display="flex" justifyContent="flex-end" gap="8px" className="project-add-to-modal-actions">
                    <Button
                      variant="outlined"
                      onClick={handleClose}
                      disabled={isLoading}
                      color="neutral"
                      className="project-add-to-modal-cancel-button"
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleAdd}
                      disabled={isLoading || !selectedProject}
                      loading={isLoading}
                      className="project-add-to-modal-add-button"
                    >
                      Add
                    </Button>
                  </Box>
                </Box>
              )}
            </Box>
          </ModalDialog>
        </Modal>
      }
    </>
  );
};
