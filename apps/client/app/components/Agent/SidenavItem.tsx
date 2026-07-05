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
}

const AgentSidenavItem: FC<AgentSidenavItemProps> = ({ agent, onClick }) => {
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
        borderRadius: '8px',
        gap: '12px',
        padding: '6px 12px',
        minHeight: '36px',
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        backgroundColor: 'transparent',
        '&:hover': {
          backgroundColor: theme.palette.notebooklist.hoverBg,
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
