import { Box, Chip, Tooltip, Typography } from '@mui/joy';
import PersonIcon from '@mui/icons-material/Person';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUser } from '@client/app/hooks/data/user';
import { ISessionDocument } from '@bike4mind/common';
import { useMemo } from 'react';

interface SessionOwnerBadgeProps {
  session: ISessionDocument;
  variant?: 'compact' | 'full';
}

/**
 * Displays the owner of a shared note/session
 * Only shows when the current user is NOT the owner
 */
const SessionOwnerBadge: React.FC<SessionOwnerBadgeProps> = ({ session, variant = 'full' }) => {
  const { currentUser } = useUser();

  // Only fetch owner data if this is NOT the current user's session
  const isOwnSession = currentUser?.id === session.userId;
  const { data: ownerUser } = useGetUser(isOwnSession ? null : session.userId);

  // Determine display text
  const ownerDisplayName = useMemo(() => {
    if (!ownerUser) return null;
    // Prefer name over username, fallback to username if name not available
    return ownerUser.name || ownerUser.username || 'Unknown User';
  }, [ownerUser]);

  // Don't show badge if this is the user's own session
  if (isOwnSession || !ownerDisplayName) {
    return null;
  }

  if (variant === 'compact') {
    return (
      <Tooltip title={`Shared by ${ownerDisplayName}`} placement="bottom">
        <Chip
          size="sm"
          variant="soft"
          color="primary"
          startDecorator={<PersonIcon sx={{ fontSize: '14px' }} />}
          sx={{
            fontSize: '12px',
            height: '24px',
            maxWidth: '150px',
            '& .MuiChip-label': {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }}
        >
          {ownerDisplayName}
        </Chip>
      </Tooltip>
    );
  }

  return (
    <Tooltip title={`This note is shared with you by ${ownerDisplayName}`} placement="bottom">
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1.5,
          py: 0.5,
          borderRadius: '6px',
          backgroundColor: 'primary.softBg',
          border: '1px solid',
          borderColor: 'primary.softActiveBg',
          cursor: 'default',
        }}
      >
        <PersonIcon
          sx={{
            fontSize: '16px',
            color: 'primary.solidBg',
          }}
        />
        <Typography
          level="body-xs"
          sx={{
            color: 'primary.solidBg',
            fontWeight: 500,
            maxWidth: '200px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {ownerDisplayName}
        </Typography>
      </Box>
    </Tooltip>
  );
};

export default SessionOwnerBadge;
