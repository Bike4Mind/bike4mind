import { useCallback } from 'react';
import { IAgent, detectAgentMentions } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useQueryClient } from '@tanstack/react-query';
import perfLogger from '@client/app/utils/performanceLogger';

// Re-exported from `@bike4mind/common` so both the client chat parser and the
// server-side `AgentDetectionFeature` share one definition. Prefer
// `LexicalChatInputRef.getMentions()` over this; the editor tree is the
// source of truth; this is the fallback for callers that only have raw text.
export { detectAgentMentions };

/**
 * Find agents whose name or trigger words match the given mentions.
 */
export function findAgentsByMentions(mentions: string[], availableAgents: IAgent[]): IAgent[] {
  if (mentions.length === 0) return [];

  perfLogger.log(`🔍 findAgentsByMentions: searching for mentions:`, mentions);
  perfLogger.log(
    `🔍 Available agents:`,
    availableAgents.map(a => ({ name: a.name, triggers: a.triggerWords }))
  );

  const matchedAgents = availableAgents.filter(agent => {
    const nameMatch = mentions.some(mention => agent.name.toLowerCase() === mention.toLowerCase());
    const triggerMatch = mentions.some(mention =>
      agent.triggerWords.some(trigger => trigger.toLowerCase().replace('@', '') === mention.toLowerCase())
    );

    const isMatch = nameMatch || triggerMatch;
    if (isMatch) {
      perfLogger.log(`🔍 Agent "${agent.name}" matched! nameMatch: ${nameMatch}, triggerMatch: ${triggerMatch}`);
    }

    return isMatch;
  });

  perfLogger.log(
    `🔍 findAgentsByMentions: found ${matchedAgents.length} matching agents:`,
    matchedAgents.map(a => a.name)
  );
  return matchedAgents;
}

/**
 * Hook that provides an `attachAgentsToSession` callback.
 */
export function useAttachAgentsToSession({
  currentSessionId,
  sessionAgents,
  onAgentsAttached,
}: {
  currentSessionId: string | null;
  sessionAgents: IAgent[];
  onAgentsAttached?: () => void;
}) {
  const queryClient = useQueryClient();

  return useCallback(
    async (agents: IAgent[]): Promise<void> => {
      if (!currentSessionId || agents.length === 0) return;

      try {
        const agentsToAttach = agents.filter(
          agent => !sessionAgents.some(sessionAgent => sessionAgent.id === agent.id)
        );

        if (agentsToAttach.length === 0) return;

        await Promise.all(
          agentsToAttach.map(agent => api.post(`/api/sessions/${currentSessionId}/agents`, { agentId: agent.id }))
        );

        perfLogger.log(
          `🤖 Auto-attached ${agentsToAttach.length} agents: ${agentsToAttach.map(a => a.name).join(', ')}`
        );

        queryClient.invalidateQueries({ queryKey: ['session-agents', currentSessionId] });
        queryClient.invalidateQueries({ queryKey: ['session', currentSessionId] });

        if (agentsToAttach.length > 0) {
          onAgentsAttached?.();
        }
      } catch (error) {
        console.error('Failed to auto-attach agents:', error);
      }
    },
    [currentSessionId, sessionAgents, queryClient, onAgentsAttached]
  );
}
