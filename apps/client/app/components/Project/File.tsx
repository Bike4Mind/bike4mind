import { Box, Stack, Dropdown, IconButton, Menu, MenuButton, MenuItem, Tooltip } from '@mui/joy';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { FC } from 'react';
import { IFabFileDocument } from '@bike4mind/common';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';
import { dayjs } from '@bike4mind/common';
import { useConfirmation } from '@/app/hooks/useConfirmation';
import { useKnowledgeModal } from '@client/app/components/Knowledge/KnowledgeModal';
import { useTheme } from '@mui/joy/styles';
import { grayAlpha } from '@client/app/utils/themes/colors';

interface ProjectFileProps {
  file: IFabFileDocument;
  onRemove: () => void;
}

const ProjectFile: FC<ProjectFileProps> = ({ file, onRemove }) => {
  const confirm = useConfirmation();
  const { setOpen, setSelectedFabFileId, setViewOnly } = useKnowledgeModal();
  const theme = useTheme();

  const handleView = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedFabFileId(file.id);
    setViewOnly(false);
    setOpen(true);
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    confirm({
      type: 'danger',
      title: 'Remove File',
      description: `Are you sure you want to remove "${file.fileName}" from this project?`,
      okLabel: 'Remove',
      onOk: async () => {
        onRemove();
      },
    });
  };

  return (
    <Box
      className="project-file-container"
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
        gap="20px"
        className="project-file-content"
        sx={{ maxWidth: { xs: '70%', sm: '100%' } }}
      >
        <Box
          className="project-file-icon-container"
          sx={theme => ({
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
              color: theme.palette.fileBrowser.fileIconColor || grayAlpha[200][50],
            },
          })}
        >
          <div className="project-file-icon">
            {(() => {
              // Only apply icon color to non-image files
              const isImage = file.mimeType?.startsWith('image/');
              const color = isImage ? undefined : theme.palette.project.fileIconColor;
              return <GetFileIcon file={file} size={40} previewSize={40} color={color} />;
            })()}
          </div>
        </Box>

        <Stack gap="12px" className="project-file-info">
          <Box
            component="label"
            className="project-file-name"
            sx={{
              fontSize: '18px',
              lineHeight: '18px',
              color: 'text.primary',
            }}
          >
            {file.fileName}
          </Box>
          <Box
            className="project-file-updated"
            sx={{
              fontSize: '14px',
              lineHeight: '14px',
              color: 'text.primary50',
            }}
          >
            Updated {dayjs(file.updatedAt).fromNow()}
          </Box>
        </Stack>
      </Box>

      <Box display="flex" gap="16px" className="project-file-actions">
        <Dropdown>
          <Tooltip title="More" className="project-file-more-tooltip">
            <MenuButton
              className="project-file-more-button"
              slots={{ root: IconButton }}
              slotProps={{
                root: {
                  variant: 'outlined',
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
              <MoreVertIcon sx={{ fontSize: 20 }} className="project-file-more-icon" />
            </MenuButton>
          </Tooltip>
          <Menu placement="bottom-end" className="project-file-menu">
            <MenuItem color="danger" onClick={handleRemove} className="project-file-remove-menu-item">
              <DeleteOutline fontSize="small" />
              Remove from project
            </MenuItem>
          </Menu>
        </Dropdown>
        <Tooltip title="View" className="project-file-view-tooltip">
          <IconButton
            variant="outlined"
            className="project-file-view-button"
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
            <VisibilityOutlinedIcon sx={{ fontSize: 20 }} className="project-file-view-icon" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};

export default ProjectFile;
