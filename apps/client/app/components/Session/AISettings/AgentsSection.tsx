import { IAgent } from '@bike4mind/common';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';
import { api } from '@client/app/contexts/ApiContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useGetAgents, useGetSessionAgents } from '@client/app/hooks/data/agents';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { SmartToy as SmartToyIcon, Close as CloseIcon, Settings as SettingsIcon } from '@mui/icons-material';
import { Avatar, Box, Tooltip, Typography, IconButton } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import React, { PropsWithChildren, useCallback, useMemo, useState, useEffect } from 'react';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { agentAvatarFallbackSx } from '@client/app/components/Agent/AgentAvatar';
import AgentProactiveMessagingModal from './AgentProactiveMessagingModal';
import { useGetSessionAgentConfigs } from '@client/app/hooks/data/agentProactiveMessaging';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

const ToolContainer = ({ children }: PropsWithChildren) => {
  return (
    <Box
      className="tool-container"
      sx={theme => ({
        backgroundColor: theme => theme.palette.background.surface2,
        width: '100%',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        p: '12px',
        border: 'none',
        color: 'text.primary',
      })}
    >
      {children}
    </Box>
  );
};

interface AgentsSectionProps {
  onClose?: () => void;
  showMobileHeader?: boolean;
  onModalOpenChange?: (isOpen: boolean) => void;
}

const AgentsSection: React.FC<AgentsSectionProps> = ({ onClose, showMobileHeader = false, onModalOpenChange }) => {
  const { data: allAgents = [] } = useGetAgents();
  const { currentSessionId, workBenchAgents, setWorkBenchAgents } = useSessions();
  const { data: sessionAgents = [] } = useGetSessionAgents(currentSessionId);
  const { isFeatureEnabled } = useFeatureEnabled();
  const queryClient = useQueryClient();
  // Check if agent proactive messaging is enabled in admin settings
  const isProactiveMessagingEnabled = useGetSettingsValue('enableAgentProactiveMessages');

  // Get proactive messaging configs for the session
  const { data: proactiveConfigs = [] } = useGetSessionAgentConfigs(currentSessionId);

  // Modal state
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<IAgent | null>(null);

  const isAgentsEnabled = isFeatureEnabled('enableAgents');

  const activeSessionId = currentSessionId;

  // Backend already filters to owned + shared agents
  const availableAgents = useMemo(() => {
    return allAgents;
  }, [allAgents]);

  // Check if an agent is attached to the current session
  const isAgentAttached = useCallback(
    (agentId: string) => {
      if (!activeSessionId) {
        // WorkBench mode - check workBenchAgents
        return workBenchAgents.some(agent => agent.id === agentId);
      }
      // Session mode - check sessionAgents
      return sessionAgents.some(agent => agent.id === agentId);
    },
    [activeSessionId, workBenchAgents, sessionAgents]
  );

  // Handle agent toggle
  const handleAgentToggle = useCallback(
    async (agent: IAgent) => {
      if (!activeSessionId) {
        // WorkBench mode - local toggle
        const isAttached = workBenchAgents.some(a => a.id === agent.id);

        if (isAttached) {
          const updatedAgents = workBenchAgents.filter(a => a.id !== agent.id);
          setWorkBenchAgents(updatedAgents);
        } else {
          const updatedAgents = [...workBenchAgents, agent];
          setWorkBenchAgents(updatedAgents);
        }
        return;
      }

      try {
        const isAttached = isAgentAttached(agent.id);

        if (isAttached) {
          await api.delete(`/api/sessions/${activeSessionId}/agents`, {
            data: { agentId: agent.id },
          });
        } else {
          await api.post(`/api/sessions/${activeSessionId}/agents`, {
            agentId: agent.id,
          });
        }

        queryClient.invalidateQueries({ queryKey: ['session-agents', activeSessionId] });
        queryClient.invalidateQueries({ queryKey: ['session', activeSessionId] });
      } catch (error) {
        console.error('Failed to toggle agent attachment:', error);
      }
    },
    [activeSessionId, isAgentAttached, workBenchAgents, setWorkBenchAgents, queryClient]
  );

  // Handle settings button click
  const handleOpenSettings = useCallback((agent: IAgent, e: React.MouseEvent) => {
    setSelectedAgent(agent);
    setSettingsModalOpen(true);
  }, []);

  // Check if agent has proactive messaging enabled
  const hasProactiveMessagingEnabled = useCallback(
    (agentId: string) => {
      return proactiveConfigs.some(config => config.agentId === agentId && config.proactiveMessaging.enabled);
    },
    [proactiveConfigs]
  );

  // Notify parent when modal opens/closes
  useEffect(() => {
    onModalOpenChange?.(settingsModalOpen);
  }, [settingsModalOpen, onModalOpenChange]);

  if (!isAgentsEnabled) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          Agents feature is not enabled. Enable it in your profile settings.
        </Typography>
        <Box sx={{ mt: 1 }}>
          <ContextHelpButton helpId="features/agents" tooltipText="Learn about Agents" size="sm" />
        </Box>
      </Box>
    );
  }

  if (availableAgents.length === 0) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <SmartToyIcon sx={{ fontSize: '3rem', color: 'text.secondary', mb: 1 }} />
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          No agents available. Create your first agent to get started.
        </Typography>
        <Box sx={{ mt: 1 }}>
          <ContextHelpButton helpId="features/agents" tooltipText="Learn about Agents" size="sm" />
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          p: '8px 12px',
          borderBottom: '1px solid',
          borderColor: 'border.soft',
          top: 0,
          maxHeight: '56px',
          backgroundColor: theme => theme.palette.background.body,
          zIndex: 1,
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: { xs: 'flex-start', sm: 'space-between' },
            flex: 1,
            width: '100%',
            gap: 1,
          }}
        >
          <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>Agents</Typography>

          <ContextHelpButton helpId="features/agents" tooltipText="Learn about Agents" size="sm" />
        </Box>

        {onClose && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <IconButton
              variant="plain"
              size="sm"
              onClick={onClose}
              sx={{
                '&:hover': {
                  backgroundColor: 'background.level1',
                },
              }}
            >
              <CloseIcon sx={{ fontSize: '16px', color: 'text.primary50', cursor: 'pointer' }} />
            </IconButton>
          </Box>
        )}
      </Box>

      <Box
        className="agents-list"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          p: '8px',
          gap: 1,
          maxHeight: { xs: 'none', sm: '400px' },
          overflow: { xs: 'auto', sm: 'auto' },
          ...scrollbarStyles,
        }}
      >
        {availableAgents.map(agent => {
          const isAttached = isAgentAttached(agent.id);

          return (
            <Box className="agent-item" key={agent.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <ToolContainer>
                <Box sx={{ width: '100%', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Avatar
                    src={agent.visual?.portraitUrl}
                    size="sm"
                    sx={{
                      width: '40px',
                      height: '40px',
                      fontWeight: 600,
                      borderRadius: '4px',
                      flexShrink: 0,
                      ...agentAvatarFallbackSx(agent.name),
                    }}
                  >
                    {agent.name.charAt(0).toUpperCase()}
                  </Avatar>
                  <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                      <Typography
                        level="body-sm"
                        sx={{ wordBreak: 'break-word', color: theme => theme.palette.text.primary }}
                      >
                        {agent.name}
                      </Typography>
                      {isAttached &&
                        activeSessionId &&
                        isProactiveMessagingEnabled &&
                        hasProactiveMessagingEnabled(agent.id) && (
                          <Tooltip title="Proactive messaging enabled">
                            <Box
                              sx={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                backgroundColor: 'primary.500',
                                flexShrink: 0,
                              }}
                              data-testid={`proactive-messaging-indicator-${agent.id}`}
                            />
                          </Tooltip>
                        )}
                    </Box>
                    <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5, flexWrap: 'wrap' }}>
                      {agent.triggerWords.map((triggerWord, index) => (
                        <Typography key={index} level="body-xs" sx={{ color: 'text.primary50', lineHeight: 1 }}>
                          {triggerWord}
                        </Typography>
                      ))}
                    </Box>
                  </Box>
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
                  {isAttached && activeSessionId && isProactiveMessagingEnabled && (
                    <IconButton
                      size="sm"
                      variant="plain"
                      color={hasProactiveMessagingEnabled(agent.id) ? 'primary' : 'neutral'}
                      onMouseDown={e => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleOpenSettings(agent, e);
                      }}
                      sx={{
                        '&:hover': {
                          backgroundColor: 'background.level1',
                        },
                      }}
                      data-testid={`agent-settings-button-${agent.id}`}
                    >
                      <SettingsIcon sx={{ fontSize: '16px' }} />
                    </IconButton>
                  )}
                  <SquareSlideToggle
                    width={40}
                    height={24}
                    onChange={() => handleAgentToggle(agent)}
                    checked={isAttached}
                  />
                </Box>
              </ToolContainer>
            </Box>
          );
        })}
      </Box>

      {/* Proactive Messaging Settings Modal */}
      {selectedAgent && (
        <AgentProactiveMessagingModal
          open={settingsModalOpen}
          onClose={() => {
            setSettingsModalOpen(false);
            setSelectedAgent(null);
          }}
          agent={selectedAgent}
          sessionId={activeSessionId ?? ''}
        />
      )}
    </Box>
  );
};

export default AgentsSection;
