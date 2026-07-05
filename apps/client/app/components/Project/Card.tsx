import { FC, useCallback, useMemo, useState, useEffect } from 'react';
import { IProjectDocument, dayjs } from '@bike4mind/common';
import {
  Box,
  Dropdown,
  MenuButton,
  Menu,
  IconButton,
  MenuItem,
  CircularProgress,
  Stack,
  useTheme,
  Tooltip,
} from '@mui/joy';
import { brand } from '@client/app/utils/themes/colors';
import { Edit as EditMuiIcon, DeleteOutline } from '@mui/icons-material';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import { useDeleteProject } from '@client/app/hooks/data/projects';
import ProjectEditModal from './EditModal';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useGetUser } from '@client/app/hooks/data/user';
import { useUser } from '@client/app/contexts/UserContext';
import { useNavigate } from '@tanstack/react-router';

const CardStats: FC<{ count: number; label: string; icon: React.JSX.Element }> = ({ count, label, icon }) => (
  <Box
    role="img"
    aria-label={`${count} ${label}${count === 1 ? '' : 's'}`}
    sx={theme => ({
      alignItems: 'center',
      display: 'flex',
      gap: '8px',
      fontSize: { xs: '12px', sm: '14px' },
      border: `1px solid ${theme.palette.project.border}`,
      background: theme.palette.background.panel2,
      borderRadius: '6px',
      padding: '4px 10px',
      color: theme.palette.text.primary,
    })}
  >
    {icon} {count}
  </Box>
);

const ProjectCard: FC<{ project: IProjectDocument }> = ({ project: initialProject }) => {
  const theme = useTheme();
  const navigate = useNavigate();
  const { currentUser } = useUser();
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [project, setProject] = useState(initialProject);
  const { mutateAsync: deleteProject, isPending: isDeleting } = useDeleteProject();
  const { data } = useGetUser(project.userId);
  const confirm = useConfirmation();
  const isOwner = currentUser?.id === project.userId;

  useEffect(() => setProject(initialProject), [initialProject]);

  const handleDelete = useCallback(async () => {
    confirm({
      type: 'danger',
      title: 'Delete Project',
      description: `Are you sure you want to delete "${project.name}"? This action cannot be undone.`,
      okLabel: 'Delete',
      cancelLabel: 'Cancel',
      onOk: async () => {
        await deleteProject(project.id);
      },
    });
  }, [confirm, deleteProject, project.id, project.name]);

  const handleCardClick = (e: React.MouseEvent) => {
    // Prevent navigation if clicking on menu, modal, or their children
    if (
      (e.target as HTMLElement).closest('.project-menu') ||
      (e.target as HTMLElement).closest('[role="dialog"]') ||
      (e.target as HTMLElement).closest('[role="presentation"]')
    ) {
      return;
    }
    navigate({ to: `/projects/${project.id}` });
  };

  const handleProjectUpdate = (updatedProject: IProjectDocument) => {
    setProject(updatedProject);
    setEditModalOpen(false);
  };

  const availableActions = useMemo(() => {
    const actions = [];

    if (isOwner) {
      actions.push(
        ...[
          <MenuItem
            key={0}
            data-testid="project-card-menu-edit-item"
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
              setEditModalOpen(true);
            }}
          >
            <EditMuiIcon fontSize="small" style={{ marginRight: 8 }} />
            Edit
          </MenuItem>,
          <MenuItem
            key={1}
            data-testid="project-card-menu-delete-item"
            color="danger"
            disabled={isDeleting}
            onClick={async e => {
              e.preventDefault();
              e.stopPropagation();
              await handleDelete();
            }}
          >
            {isDeleting ? (
              <CircularProgress size="sm" style={{ marginRight: 8 }} />
            ) : (
              <DeleteOutline fontSize="small" style={{ marginRight: 8 }} />
            )}
            {isDeleting ? 'Deleting...' : 'Delete'}
          </MenuItem>,
        ]
      );
    }

    return actions;
  }, [isOwner, isDeleting, handleDelete]);

  return (
    <Box
      onClick={handleCardClick}
      data-testid="project-card"
      sx={{
        border: '1px solid',
        borderColor: theme.palette.project.border,
        position: 'relative',
        p: { xs: '12px', sm: '16px', md: '20px' },
        borderRadius: '8px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: { xs: '12px', sm: '16px', md: '20px' },
        bgcolor: theme.palette.primary.softBg,
        transition: 'transform 0.3s ease-in-out, box-shadow 0.3s ease-in-out',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: theme => `0 0 15px 1px ${theme.palette.project.projectCard.shadowColor}`,
        },
        minHeight: { xs: '200px', sm: '220px' },
        height: '100%',
        width: '100%',
        // Reveal the three-dots menu button on hover/focus within
        '&:hover .project-card-menu-btn, &:focus-within .project-card-menu-btn': {
          opacity: 1,
          visibility: 'visible',
        },
      }}
    >
      <ProjectEditModal
        project={project}
        open={editModalOpen}
        setOpen={setEditModalOpen}
        onSuccess={handleProjectUpdate}
      />

      <Box
        data-testid="project-card-header"
        sx={{
          fontSize: { xs: '16px', sm: '18px' },
          lineHeight: '1.2',
          fontWeight: '500',
          zIndex: 2,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <Tooltip title={project.name}>
          <Box
            data-testid="project-card-name"
            sx={theme => ({
              color: theme.palette.text.primary,
              textDecoration: 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 'calc(100% - 40px)',
            })}
          >
            {project.name}
          </Box>
        </Tooltip>
        <Box
          data-testid="project-card-menu"
          sx={{
            flexShrink: 0,
            marginRight: { xs: 0, sm: '-8px' },
            marginTop: { xs: 0, sm: '-8px' },
          }}
        >
          {availableActions.length > 0 && (
            <Dropdown>
              <MenuButton
                data-testid="project-card-menu-btn"
                className="project-card-menu-btn"
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    variant: 'plain',
                    size: 'sm',
                    sx: {
                      opacity: 0,
                      visibility: 'hidden',
                      transition: 'opacity 0.15s ease',
                      '& svg': {
                        opacity: 0.5,
                        transition: 'opacity 0.3s ease',
                      },
                      '&:hover, &:focus, &:active': {
                        backgroundColor: 'transparent',
                        '& svg': {
                          opacity: 1,
                        },
                      },
                      // Ensure it becomes visible when focused via keyboard
                      '&:focus-visible': {
                        opacity: 1,
                        visibility: 'visible',
                      },
                    },
                  },
                }}
                onClick={e => e.stopPropagation()}
              >
                <MoreVertIcon sx={{ fontSize: 18 }} />
              </MenuButton>
              <Menu data-testid="project-card-menu-dropdown" placement="bottom-end">
                {availableActions}
              </Menu>
            </Dropdown>
          )}
        </Box>
      </Box>

      <Box
        component="p"
        data-testid="project-card-description"
        sx={{
          display: '-webkit-box',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          zIndex: 2,
          fontSize: { xs: '12px', sm: '14px' },
          lineHeight: '1.4',
          m: 0,
          mb: '12px',
          color: theme.palette.project.projectCard.descriptionColor,
        }}
      >
        {project.description}
      </Box>

      <Box
        data-testid="project-card-footer"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: { xs: '12px', sm: '16px', md: '20px' },
          mt: 'auto',
          zIndex: 2,
        }}
      >
        <Stack
          data-testid="project-card-stack"
          sx={{
            zIndex: 2,
            color: theme => theme.palette.text.primary,
            mb: '12px',
            mt: '-4px',
          }}
          spacing={0.5}
        >
          <Box data-testid="project-card-owner" sx={{ color: brand[800] }}>
            {data && data.name}
          </Box>
          <Box data-testid="project-card-updated" sx={{ fontSize: '12px', opacity: 0.5 }}>
            Updated {dayjs(project.updatedAt).fromNow()}
          </Box>
        </Stack>
        <Box
          data-testid="project-card-stats-container"
          sx={{
            display: 'flex',
            gap: { xs: '4px', sm: '10px' },
            flexWrap: 'wrap',
          }}
        >
          <Tooltip title="Notebooks">
            <span data-testid="project-card-notebooks-tooltip">
              <CardStats
                count={project.sessionIds.length}
                label="Notebook"
                icon={<EditMuiIcon sx={{ fontSize: 16, opacity: 0.5 }} />}
              />
            </span>
          </Tooltip>
          <Tooltip title="Knowledge Files">
            <span data-testid="project-card-files-tooltip">
              <CardStats
                count={project.fileIds.length}
                label="Knowledge File"
                icon={<InsertDriveFileOutlinedIcon sx={{ fontSize: 16, opacity: 0.5 }} />}
              />
            </span>
          </Tooltip>
          <Tooltip title="Members">
            <span data-testid="project-card-members-tooltip">
              <CardStats
                count={project.users.length}
                label="Member"
                icon={<PersonOutlineIcon sx={{ fontSize: 16, opacity: 0.5 }} />}
              />
            </span>
          </Tooltip>
        </Box>
      </Box>
    </Box>
  );
};

export default ProjectCard;
