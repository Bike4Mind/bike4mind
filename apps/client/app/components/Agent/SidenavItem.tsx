import { Box, Typography, Avatar, Tooltip } from '@mui/joy';
import { FC, memo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { agentAvatarFallbackSx } from './AgentAvatar';

interface AgentSidenavItemProps {
  agent: {
    id: string;
    name: string;
    triggerWords?: string[];
    visual?: { portraitUrl?: string };
  };
  onClick?: () => void;
  /** Highlights the row (blue bar + focused bg) when its dedicated agent screen is open. */
  isSelected?: boolean;
}

const AgentSidenavItem: FC<AgentSidenavItemProps> = ({ agent, onClick, isSelected }) => {
  const navigate = useNavigate();

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      navigate({ to: `/agents/${agent.id}` });
    }
  };

  return (
    <Box
      className="agent-sidenav-item"
      onClick={handleClick}
      sx={theme => ({
        position: 'relative',
        borderRadius: '8px',
        gap: '12px',
        padding: '6px 12px',
        minHeight: '36px',
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        backgroundColor: isSelected ? theme.palette.notebooklist.focusedBackground : 'transparent',
        // Blue left active-indicator bar, matching the notebook row's selected state.
        '&::before': isSelected
          ? {
              content: '""',
              position: 'absolute',
              left: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              width: '2px',
              height: '80%',
              backgroundColor: theme.palette.primary[500],
              borderRadius: '1px',
            }
          : {},
        '&:hover': {
          backgroundColor: isSelected ? undefined : theme.palette.notebooklist.hoverBg,
        },
        transition: 'background 0.2s',
      })}
    >
      <Tooltip title="Agent" placement="top">
        <Avatar
          size="sm"
          src={agent.visual?.portraitUrl || ''}
          sx={{
            width: 20,
            height: 20,
            fontSize: '11px',
            fontWeight: 600,
            flexShrink: 0,
            ...agentAvatarFallbackSx(agent.name),
          }}
        >
          {agent.name.charAt(0).toUpperCase()}
        </Avatar>
      </Tooltip>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          level="body-xs"
          sx={theme => ({
            color: theme.palette.neutral.softColor,
            fontWeight: 400,
            textAlign: 'left',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          })}
          noWrap
        >
          {agent.name}
        </Typography>
        {agent.triggerWords && agent.triggerWords.length > 0 && (
          <Typography
            level="body-xs"
            sx={{
              color: 'text.tertiary',
              fontSize: '0.7rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {agent.triggerWords.join(', ')}
          </Typography>
        )}
      </Box>
    </Box>
  );
};

export default memo(AgentSidenavItem);
