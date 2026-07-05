import React, { useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { IAgent } from '@bike4mind/common';
import { toast } from 'sonner';
import { createAgentToServer } from '@client/app/utils/agentsAPICalls';
import AgentForm from '@client/app/components/Agent/AgentForm';
import { useUser } from '@client/app/contexts/UserContext';
import { useQueryClient } from '@tanstack/react-query';

const NewAgentPage: React.FC = () => {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { currentUser, setCurrentUser } = useUser();
  const queryClient = useQueryClient();

  const handleSubmit = useCallback(
    async (agentData: Partial<IAgent>) => {
      setIsSubmitting(true);

      try {
        const newAgent = await createAgentToServer(agentData);

        // Update user credits if provided in response (API returns userCredits on credit transfer)
        const responseWithCredits = newAgent as IAgent & { userCredits?: number };
        if (responseWithCredits.userCredits !== undefined && currentUser && setCurrentUser) {
          setCurrentUser({
            ...currentUser,
            currentCredits: responseWithCredits.userCredits,
          });
        }

        toast.success('Agent created successfully!');
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        navigate({ to: `/agents/${newAgent.id}` });
      } catch (error) {
        console.error('Error creating agent:', error);
        toast.error('Failed to create agent. Please try again.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [navigate, currentUser, setCurrentUser]
  );

  return (
    <AgentForm
      mode="create"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      title="Create New Agent"
      subtitle="Build a new AI agent with personality and capabilities"
    />
  );
};

export default NewAgentPage;
