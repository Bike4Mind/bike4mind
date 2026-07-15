import { IProjectDocument, IFabFileDocument, KnowledgeType } from '@bike4mind/common';
import {
  Box,
  IconButton,
  Modal,
  ModalClose,
  ModalDialog,
  Menu,
  MenuItem,
  Dropdown,
  MenuButton,
  CircularProgress,
  Typography,
  Stack,
} from '@mui/joy';
import { truncate } from 'lodash';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import AddIcon from '@mui/icons-material/Add';
import { FC, ReactNode, useState, useRef } from 'react';
import KnowledgeDragDropInput from '../Knowledge/DragDropInput';
import {
  useAddSystemPromptsToProject,
  useToggleSystemPrompt,
  useRemoveSystemPrompt,
} from '@client/app/hooks/data/projects';
import { useGetFabFile } from '@client/app/hooks/data/fabFiles';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useKnowledgeModal } from '../Knowledge/KnowledgeModal';
import { useTranslation } from 'react-i18next';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import EmbeddedFileBrowser, { EmbeddedFileBrowserHandle } from '@client/app/components/Files/EmbeddedFileBrowser';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { toast } from 'react-hot-toast';
import { getErrorMessage } from '@client/app/utils/error';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';
import { grayAlpha } from '@client/app/utils/themes/colors';

interface ProjectSystemPromptsModalOptions {
  onClick: () => void;
}

interface ProjectSystemPromptsModalProps {
  project: IProjectDocument;
  children: (options: ProjectSystemPromptsModalOptions) => ReactNode;
}

const ProjectSystemPromptsModal: FC<ProjectSystemPromptsModalProps> = ({ project, children }) => {
  const [open, setOpen] = useState(false);
  const { mutate: addSystemPrompts, isPending } = useAddSystemPromptsToProject();
  const { mutateAsync: removeSystemPrompt } = useRemoveSystemPrompt();
  const fileBrowserRef = useRef<EmbeddedFileBrowserHandle>(null);

  const handleBulkAdd = (files: IFabFileDocument[]) => {
    const fileIds = files.map(file => file.id);
    addSystemPrompts({
      projectId: project.id,
      fileIds,
    });
  };

  const handleRemovePrompt = (fileId: string) => {
    removeSystemPrompt({ projectId: project.id, fileId });
  };

  return (
    <>
      {children({ onClick: () => setOpen(!open) })}

      <Modal open={open} onClose={() => setOpen(false)} className="project-system-prompt-modal">
        <ModalDialog className="project-system-prompt-modal-dialog">
          <ModalClose className="project-system-prompt-modal-close" />
          <Box
            display="flex"
            flexDirection="column"
            gap="30px"
            className="project-system-prompt-modal-content"
            sx={{
              minWidth: { xs: '100%', sm: '540px' },
            }}
          >
            <Box fontSize="20px" lineHeight="20px" className="project-system-prompt-modal-title">
              Project System Prompts
            </Box>
            <Stack gap="10px" className="project-system-prompt-list">
              {project.systemPrompts?.map(systemPrompt => (
                <div className="project-system-prompt-item-wrapper" key={systemPrompt.fileId}>
                  <SystemPromptItem projectId={project.id} systemPrompt={systemPrompt} />
                </div>
              ))}
              {isPending ? (
                <Box
                  className="project-system-prompt-loading"
                  sx={{
                    p: '20px',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <CircularProgress size="sm" className="project-system-prompt-loading-progress" /> Adding system
                  prompts...
                </Box>
              ) : (
                <KnowledgeDragDropInput
                  label={
                    <Box display="flex" gap="12px">
                      <AddIcon sx={{ fontSize: 16 }} /> Drag & Drop your system prompts files or
                    </Box>
                  }
                  onSuccess={file => {
                    addSystemPrompts({
                      projectId: project.id,
                      fileIds: [file.id],
                    });
                  }}
                />
              )}
            </Stack>
          </Box>
        </ModalDialog>
      </Modal>

      <EmbeddedFileBrowser
        ref={fileBrowserRef}
        onAdd={handleBulkAdd}
        onDelete={handleRemovePrompt}
        addButtonLabelKey="file_browser.add_files_to_project"
      />
    </>
  );
};

// Tab panel variant
export const SystemPrompts: FC<{ project: IProjectDocument }> = ({ project }) => {
  const { mutate: addSystemPrompts, isPending } = useAddSystemPromptsToProject();
  const { mutateAsync: removeSystemPrompt } = useRemoveSystemPrompt();
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileBrowserRef = useRef<EmbeddedFileBrowserHandle>(null);

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const data = {
          type: KnowledgeType.FILE,
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
        };
        const newFile = await createFabFileOnServerWithUpload(data, file);
        addSystemPrompts({
          projectId: project.id,
          fileIds: [newFile.id],
        });
        toast.success(`Uploaded: ${file.name}`);
      } catch (error) {
        console.error('Error uploading file %s:', file.name, error);
        toast.error(getErrorMessage(error));
      }
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handleBulkAdd = (files: IFabFileDocument[]) => {
    const fileIds = files.map(file => file.id);
    addSystemPrompts({
      projectId: project.id,
      fileIds,
    });
  };

  const handleRemovePrompt = (fileId: string) => {
    removeSystemPrompt({ projectId: project.id, fileId });
  };

  return (
    <Stack gap="20px" sx={{ height: '100%' }} className="project-system-prompt-tab-container">
      <Box
        display="flex"
        flexDirection="column"
        gap="20px"
        className="project-system-prompt-tab-content"
        sx={{
          mx: '20px',
          flexGrow: 1,
          overflow: 'auto',
        }}
      >
        <Box
          className="project-system-prompt-tab-actions"
          sx={{
            display: 'flex',
            gap: '12px',
            mb: '10px',
            width: '100%',
            justifyContent: 'flex-end',
          }}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
            multiple
            className="project-system-prompt-file-input"
          />

          <IconButton
            variant="outlined"
            color="primary"
            onClick={() => fileInputRef.current?.click()}
            className="project-system-prompt-upload-button"
            data-testid="project-system-prompt-upload-btn"
            sx={theme => ({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px 16px',
              borderRadius: '8px',
              gap: '8px',
              color: 'text.primary',
            })}
          >
            <UploadFileIcon
              sx={{ fontSize: '18px', color: 'text.primary' }}
              className="project-system-prompt-upload-icon"
            />
            <Typography level="body-sm" sx={{ color: 'text.primary' }} className="project-system-prompt-upload-text">
              {t('files.upload')}
            </Typography>
          </IconButton>

          <IconButton
            variant="outlined"
            color="primary"
            onClick={() => fileBrowserRef.current?.handleOpen()}
            className="project-system-prompt-browse-button"
            data-testid="project-file-browser-btn"
            sx={theme => ({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px 16px',
              borderRadius: '8px',
              gap: '8px',
              color: 'text.primary',
            })}
          >
            <FolderSharedIcon
              sx={{ fontSize: '18px', color: 'text.primary' }}
              className="project-system-prompt-browse-icon"
            />
            <Typography level="body-sm" sx={{ color: 'text.primary' }} className="project-system-prompt-browse-text">
              {t('files.long_title')}
            </Typography>
          </IconButton>
        </Box>
        <Stack gap="15px" className="project-system-prompt-tab-list">
          {project.systemPrompts?.map(systemPrompt => (
            <SystemPromptItem key={systemPrompt.fileId} projectId={project.id} systemPrompt={systemPrompt} />
          ))}
          {isPending ? (
            <Box
              className="project-system-prompt-tab-loading"
              sx={{
                p: '20px',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <CircularProgress size="sm" className="project-system-prompt-tab-loading-progress" /> Adding system
              prompts...
            </Box>
          ) : (
            <KnowledgeDragDropInput
              label={
                <Box display="flex" gap="12px">
                  Drag & Drop your system prompts files or
                </Box>
              }
              onSuccess={file => {
                addSystemPrompts({
                  projectId: project.id,
                  fileIds: [file.id],
                });
              }}
            />
          )}
        </Stack>
      </Box>
      <EmbeddedFileBrowser
        ref={fileBrowserRef}
        onAdd={handleBulkAdd}
        onDelete={handleRemovePrompt}
        addButtonLabelKey="file_browser.add_files_to_project"
      />
    </Stack>
  );
};

interface SystemPromptItemProps {
  projectId: string;
  systemPrompt: IProjectDocument['systemPrompts'][number];
}

const SystemPromptItem: FC<SystemPromptItemProps> = ({ projectId, systemPrompt }) => {
  const { mutate: toggleSystemPrompt } = useToggleSystemPrompt();
  const { mutateAsync: removeSystemPrompt } = useRemoveSystemPrompt();
  const { data: file, isLoading } = useGetFabFile(systemPrompt.fileId);
  const confirm = useConfirmation();
  const { setOpen, setSelectedFabFileId, setViewOnly } = useKnowledgeModal();

  const handleView = () => {
    setSelectedFabFileId(systemPrompt.fileId);
    setViewOnly(false);
    setOpen(true);
  };

  return (
    <Box
      className="project-system-prompt-item"
      sx={theme => ({
        borderRadius: '8px',
        display: 'flex',
        width: '100%',
        border: '1px solid',
        borderColor: theme.palette.project.border,
        backgroundColor: theme.palette.primary.softBg,
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '20px',
      })}
    >
      <Box
        display="flex"
        alignItems="center"
        gap={{ xs: '8px', sm: '20px' }}
        maxWidth={{ xs: '50%', sm: '100%' }}
        className="project-system-prompt-item-content"
      >
        <Box
          className="project-system-prompt-item-icon"
          sx={theme => {
            const isImage = file?.mimeType?.startsWith('image/');
            const color = isImage ? '' : theme.palette.project.fileIconColor;
            return {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 40,
              height: 40,
              minWidth: 40,
              minHeight: 40,
              maxWidth: 40,
              maxHeight: 40,
              '& .MuiSvgIcon-root': {
                color: theme.palette.fileBrowser?.fileIconColor || grayAlpha[210][50],
              },
              // Pass color to GetFileIcon below
              '--system-prompt-file-icon-color': color,
            };
          }}
        >
          {file ? (
            <GetFileIcon
              file={file}
              size={40}
              previewSize={40}
              color={
                file?.mimeType?.startsWith('image/') ? '' : undefined // Will use CSS var from parent
              }
            />
          ) : null}
        </Box>
        <Box
          className="project-system-prompt-item-text"
          sx={theme => ({
            fontSize: { xs: '14px', sm: '18px' },
            lineHeight: { xs: '14px', sm: '18px' },
            color: 'text.primary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          })}
        >
          {isLoading ? (
            <CircularProgress size="sm" className="project-system-prompt-item-loading" />
          ) : (
            truncate(file?.fileName || '', { length: 40 })
          )}
        </Box>
      </Box>
      <Box
        display="flex"
        alignItems="center"
        gap={{ xs: '8px', sm: '16px' }}
        className="project-system-prompt-item-actions"
      >
        <Dropdown>
          <MenuButton
            slots={{ root: IconButton }}
            slotProps={{
              root: {
                variant: 'outlined',
                className: 'project-system-prompt-item-menu-btn',
                'data-testid': 'project-system-prompt-item-menu-btn',
                sx: {
                  borderRadius: '8px',
                  width: 36,
                  height: 36,
                  minWidth: 36,
                  minHeight: 36,
                  maxWidth: 36,
                  maxHeight: 36,
                  p: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              },
            }}
          >
            <MoreVertIcon
              sx={{ fontSize: 20, width: 20, height: 20 }}
              className="project-system-prompt-item-menu-icon"
            />
          </MenuButton>
          <Menu
            placement="bottom-end"
            className="project-system-prompt-item-menu"
            sx={{
              minWidth: 120,
              zIndex: 1900,
              position: 'relative',
            }}
          >
            <MenuItem
              color="danger"
              className="project-system-prompt-item-menu-item"
              data-testid="project-system-prompt-item-menu-item"
              onClick={() => {
                confirm({
                  title: 'Delete System Prompt',
                  description: 'Are you sure you want to delete this system prompt?',
                  onOk: async () => {
                    await removeSystemPrompt({
                      projectId,
                      fileId: systemPrompt.fileId,
                    });
                  },
                });
              }}
            >
              <DeleteOutline fontSize="small" className="project-system-prompt-item-delete-icon" />
              Delete
            </MenuItem>
          </Menu>
        </Dropdown>
        <IconButton
          variant="outlined"
          className="project-system-prompt-item-view-btn"
          data-testid="project-system-prompt-item-view-btn"
          sx={{
            borderRadius: '8px',
            width: 36,
            height: 36,
            minWidth: 36,
            minHeight: 36,
            maxWidth: 36,
            maxHeight: 36,
            p: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={handleView}
        >
          <VisibilityOutlinedIcon
            sx={{ fontSize: 20, width: 20, height: 20 }}
            className="project-system-prompt-item-view-icon"
          />
        </IconButton>
        <Box
          className="project-system-prompt-item-divider"
          sx={theme => ({
            width: '1px',
            alignSelf: 'stretch',
            backgroundColor: theme.palette.project.systemPromptModal.backgroundColor,
            mx: '8px',
          })}
        />
        <SquareSlideToggle
          checked={systemPrompt.enabled}
          onChange={() => {
            toggleSystemPrompt({
              projectId,
              fileId: systemPrompt.fileId,
            });
          }}
        />
      </Box>
    </Box>
  );
};

export default ProjectSystemPromptsModal;
