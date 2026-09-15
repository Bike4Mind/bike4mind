import { FC, useState } from 'react';
import { Stack, Box, CircularProgress, Dropdown, IconButton, Menu, MenuItem, MenuButton, Tooltip } from '@mui/joy';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { ISessionDocument } from '@bike4mind/common';
import { dayjs } from '@bike4mind/common';
import { useRemoveSessionsFromProject } from '@client/app/hooks/data/projects';
import { Link } from '@tanstack/react-router';
import { useConfirmation } from '@/app/hooks/useConfirmation';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';
import SessionRenameInput from '@client/app/components/Session/RenameInput';

interface ProjectSessionProps {
  session: ISessionDocument;
  projectId: string;
}

const ProjectSession: FC<ProjectSessionProps> = ({ session, projectId }) => {
  const title = formatSessionTitle(session.name);
  const updatedAt = dayjs(session.updatedAt).fromNow();
  const confirm = useConfirmation();
  const [isEditing, setIsEditing] = useState(false);

  const { mutateAsync: removeSession, isPending: isRemoving } = useRemoveSessionsFromProject();

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    confirm({
      type: 'danger',
      title: 'Remove Session',
      description: `Are you sure you want to remove "${title}" from this project?`,
      okLabel: 'Remove',
      onOk: async () => {
        try {
          await removeSession({
            projectId,
            sessionIds: [session.id],
          });
        } catch (error) {
          console.error('Failed to remove session:', error);
        }
      },
    });
  };

  return (
    <Box
      className="wrapped-component"
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
      <Stack flexGrow={1} sx={{ maxWidth: { xs: '70%', sm: '100%' }, gap: '12px' }}>
        {isEditing ? (
          <SessionRenameInput session={session} initialValue={title} onSuccess={() => setIsEditing(false)} size="sm" />
        ) : (
          <Box
            sx={{
              fontSize: '18px',
              lineHeight: '18px',
              color: 'text.primary',
            }}
          >
            {title}
          </Box>
        )}
        <Box
          fontSize="14px"
          lineHeight="14px"
          sx={{
            color: 'text.primary50',
          }}
        >
          Updated {updatedAt}
        </Box>
      </Stack>
      <Box display="flex" gap="16px">
        <Dropdown>
          <Tooltip title="More">
            <MenuButton
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
              <MoreVertIcon sx={{ fontSize: 20 }} />
            </MenuButton>
          </Tooltip>
          <Menu placement="bottom-end">
            <MenuItem
              onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                setIsEditing(true);
              }}
            >
              <EditOutlinedIcon fontSize="small" />
              Rename
            </MenuItem>
            <MenuItem color="danger" disabled={isRemoving} onClick={handleDelete}>
              {isRemoving ? (
                <CircularProgress size="sm" style={{ marginRight: 8 }} />
              ) : (
                <DeleteOutline fontSize="small" />
              )}
              {isRemoving ? 'Removing...' : 'Remove from project'}
            </MenuItem>
          </Menu>
        </Dropdown>
        <Tooltip title="View">
          <Link
            to="/notebooks/$id"
            params={{ id: session.id }}
            search={{ projectId }}
            style={{ textDecoration: 'none' }}
          >
            <IconButton
              variant="outlined"
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
            >
              <VisibilityOutlinedIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Link>
        </Tooltip>
      </Box>
    </Box>
  );
};

export default ProjectSession;
