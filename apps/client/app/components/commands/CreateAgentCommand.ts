import { IChatHistoryItemDocument, ISessionDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { QueryClient } from '@tanstack/react-query';
import { createOptimisticQuest } from '@client/app/utils/llm';
import { GearsStatusResponse } from '@client/app/hooks/useGearsStatus';

interface CreateAgentCommandArgs {
  params: string; // Agent name from command
  currentSession: ISessionDocument;
  queryClient: QueryClient;
}

export const handleCreateAgentCommand = async (args: CreateAgentCommandArgs): Promise<void> => {
  const { params, currentSession, queryClient } = args;

  const agentName = params.trim();

  if (!agentName) {
    toast.error('Please provide a name for the agent: /create_agent <name>');
    return;
  }

  // Validate agent name (basic validation)
  if (agentName.length < 2 || agentName.length > 50) {
    toast.error('Agent name must be between 2 and 50 characters');
    return;
  }

  // Create optimistic quest to track the operation
  const questPrompt = `Creating agent "${agentName}" from session context...`;

  await createOptimisticQuest(queryClient, currentSession.id, questPrompt, async () => {
    try {
      const toastId = toast.loading(`🤖 Creating agent "${agentName}" from session context...`);

      // Files are derived server-side from session knowledgeIds and message
      // fabFileIds for authorization safety.
      const contextData = {
        agentName,
        sessionId: currentSession.id,
      };

      const response = await api.post('/api/agents/create-from-context', contextData);

      if (response.data.success) {
        toast.success(`✨ Agent "${agentName}" created successfully!`, {
          id: toastId,
          duration: 5000,
        });

        // Invalidate agent queries to refresh the list
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        // A first agent unlocks the 'agents' gear - refresh the earned-nav
        // state (see routes/agents/new.tsx for the same first-create pattern).
        const gearsStatus = queryClient.getQueryData<GearsStatusResponse>(['gears', 'status']);
        const agentsGear = gearsStatus?.gears.find(g => g.key === 'agents');
        if (!agentsGear || !agentsGear.unlocked) {
          void queryClient.invalidateQueries({ queryKey: ['gears', 'status'] });
        }

        const quest = {
          id: response.data.agent.id,
          sessionId: currentSession.id,
          type: 'message' as const,
          prompt: questPrompt,
          replies: [
            `✅ **Agent "${agentName}" has been created!**\n\nThe agent has been generated with:\n- Personality traits based on the conversation context\n- Knowledge from attached files\n- A custom system prompt\n- Unique quirks and characteristics\n\nYou can now @${agentName} to interact with your new agent!`,
          ],
          images: [],
          status: 'completed' as const,
          timestamp: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          agentIds: [response.data.agent.id],
        } as unknown as IChatHistoryItemDocument;

        return { quest, session: currentSession };
      } else {
        throw new Error(response.data.message || 'Failed to create agent');
      }
    } catch (error: any) {
      console.error('Error creating agent from context:', error);

      toast.error(error.response?.data?.message || 'Failed to create agent. Please try again.');

      const quest = {
        id: `error-${Date.now()}`,
        sessionId: currentSession.id,
        type: 'message' as const,
        prompt: questPrompt,
        replies: [`❌ Failed to create agent "${agentName}": ${error.response?.data?.message || error.message}`],
        images: [],
        status: 'stopped' as const,
        timestamp: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as IChatHistoryItemDocument;

      return { quest, session: currentSession };
    }
  });
};
