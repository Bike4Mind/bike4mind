import React, { useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { IAgent } from '@bike4mind/common';
import { toast } from 'sonner';
import { createAgentToServer } from '@client/app/utils/agentsAPICalls';
import AgentForm from '@client/app/components/Agent/AgentForm';
import { useUser } from '@client/app/contexts/UserContext';
import { useQueryClient } from '@tanstack/react-query';
import { GearsStatusResponse } from '@client/app/hooks/useGearsStatus';

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
        // A first agent unlocks the 'agents' gear server-side, but the Gears
        // status query has a 5-minute staleTime - without an explicit
        // invalidation the sidenav keeps hiding the earned Agents row until a
        // reload. Only invalidate while the gear is still locked so routine
        // creations don't refetch the status (same pattern as SessionFilePond's
        // first-upload invalidation for the files gear).
        const gearsStatus = queryClient.getQueryData<GearsStatusResponse>(['gears', 'status']);
        const agentsGear = gearsStatus?.gears.find(g => g.key === 'agents');
        if (!agentsGear || !agentsGear.unlocked) {
          void queryClient.invalidateQueries({ queryKey: ['gears', 'status'] });
        }
        navigate({ to: `/agents/${newAgent.id}` });
      } catch (error) {
        console.error('Error creating agent:', error);
        toast.error('Failed to create agent. Please try again.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [navigate, currentUser, setCurrentUser, queryClient]
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
