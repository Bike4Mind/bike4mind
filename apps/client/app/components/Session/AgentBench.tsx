import React, { useCallback } from 'react';
import { Box, Chip, Avatar, Tooltip, Badge, IconButton, Stack } from '@mui/joy';
import ChipDelete from '@mui/joy/ChipDelete';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { IAgent } from '@bike4mind/common';
import { agentAvatarFallbackSx } from '@client/app/components/Agent/AgentAvatar';
import { api } from '@client/app/contexts/ApiContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';

interface AgentBenchProps {
  agents: IAgent[];
  sessionId?: string;
  onAgentRemoved?: (agentId: string) => void;
}

export const CollapsedAgentBench: React.FC<{
  agentCount: number;
  agents: IAgent[];
  onClick: () => void;
}> = ({ agentCount, agents, onClick }) => {
  const { t } = useTranslation();

  // Show individual avatars for 1-2 agents, robot icon with count for 3+
  if (agentCount <= 2) {
    return (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', minWidth: 'fit-content' }}>
        {agents.slice(0, 2).map((agent, index) => (
          <Tooltip key={agent.id} title={t('agents.toggle_attached_agents')} placement="top">
            <IconButton
              variant="soft"
              color="neutral"
              onClick={onClick}
              sx={{
                borderRadius: '50%',
                width: 32,
                height: 32,
                minWidth: 32,
                flexShrink: 0,
                transition: 'transform 0.2s ease-in-out',
                '&:hover': {
                  transform: 'scale(1.05)',
                },
                animation: `fadeIn 0.3s ease-in-out ${index * 0.1}s`,
                '@keyframes fadeIn': {
                  '0%': {
                    opacity: 0,
                    transform: 'translateY(-10px)',
                  },
                  '100%': {
                    opacity: 1,
                    transform: 'translateY(0)',
                  },
                },
              }}
            >
              <Avatar
                size="sm"
                src={agent.visual?.portraitUrl || ''}
                sx={{
                  width: 24,
                  height: 24,
                  fontSize: '12px',
                  fontWeight: 600,
                  ...agentAvatarFallbackSx(agent.name),
                }}
              >
                {agent.name.charAt(0).toUpperCase()}
              </Avatar>
            </IconButton>
          </Tooltip>
        ))}
      </Box>
    );
  }

  // For 3+ agents, show robot icon with count badge
  return (
    <Tooltip title={t('agents.toggle_attached_agents')}>
      <IconButton
        variant="soft"
        color="warning"
        onClick={onClick}
        sx={{
          borderRadius: '50%',
          position: 'relative',
          transition: 'transform 0.2s ease-in-out',
          '&:hover': {
            transform: 'scale(1.05)',
          },
          animation: 'fadeIn 0.3s ease-in-out',
          '@keyframes fadeIn': {
            '0%': {
              opacity: 0,
              transform: 'translateY(-10px)',
            },
            '100%': {
              opacity: 1,
              transform: 'translateY(0)',
            },
          },
        }}
      >
        <SmartToyOutlinedIcon />
        <Badge
          badgeContent={agentCount}
          color="warning"
          size="sm"
          sx={{
            position: 'absolute',
            top: '25px',
            right: '10px',
            transform: 'translate(25%, -25%)',
            '& .MuiBadge-badge': {
              fontSize: '0.7rem',
              minWidth: '18px',
              height: '18px',
            },
          }}
        />
      </IconButton>
    </Tooltip>
  );
};

const AgentBench: React.FC<AgentBenchProps> = ({ agents, sessionId, onAgentRemoved }) => {
  const { t } = useTranslation();
  const { setCurrentSession, workBenchAgents, setWorkBenchAgents } = useSessions();
  const queryClient = useQueryClient();

  const handleRemoveAgent = useCallback(
    async (agentId: string) => {
      if (!sessionId) {
        // If no session, remove from workBench
        const updatedAgents = workBenchAgents.filter((agent: IAgent) => agent.id !== agentId);
        setWorkBenchAgents(updatedAgents);
        onAgentRemoved?.(agentId);
        return;
      }

      try {
        await api.delete(`/api/sessions/${sessionId}/agents`, { data: { agentId } });

        setCurrentSession(prev => {
          if (!prev) return null;
          const updatedAgentIds = (prev.agentIds || []).filter(id => id !== agentId);
          return { ...prev, agentIds: updatedAgentIds };
        });

        queryClient.invalidateQueries({ queryKey: ['session-agents', sessionId] });
        queryClient.invalidateQueries({ queryKey: ['session', sessionId] });

        onAgentRemoved?.(agentId);
      } catch (error) {
        console.error('Failed to remove agent:', error);
      }
    },
    [sessionId, setCurrentSession, queryClient, onAgentRemoved, workBenchAgents, setWorkBenchAgents]
  );

  if (agents.length === 0) {
    return null;
  }

  return (
    <Box
      sx={{
        width: '100%',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '8px',
        backgroundColor: 'background.surface',
        mb: 2,
        p: 2,
      }}
    >
      {/* Agent Chips */}
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
        {agents.map(agent => (
          <Tooltip key={agent.id} title={t('agents.agent_listening_tooltip', { name: agent.name })} placement="top">
            <Chip
              variant="soft"
              color="warning"
              size="md"
              startDecorator={
                <Avatar
                  size="sm"
                  src={agent.visual?.portraitUrl || ''}
                  sx={{
                    width: 24,
                    height: 24,
                    fontSize: '12px',
                    fontWeight: 600,
                    ...agentAvatarFallbackSx(agent.name),
                  }}
                >
                  {agent.name.charAt(0).toUpperCase()}
                </Avatar>
              }
              endDecorator={
                <ChipDelete
                  variant="plain"
                  sx={{ '--Icon-color': 'warning.700' }}
                  onClick={() => handleRemoveAgent(agent.id)}
                />
              }
              sx={{
                maxWidth: '200px',
                '& .MuiChip-label': {
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              }}
            >
              {agent.name}
            </Chip>
          </Tooltip>
        ))}
      </Stack>
    </Box>
  );
};

export default AgentBench;
