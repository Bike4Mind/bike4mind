import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { IAgent } from '@bike4mind/common';
import { toast } from 'sonner';
import { getAgentByIdFromServer, updateAgentToServer } from '@client/app/utils/agentsAPICalls';
import AgentForm from '@client/app/components/Agent/AgentForm';
import { AGENT_FORM_ID } from '@client/app/constants/agentForm';
import { Button, Box } from '@mui/joy';
import SaveIcon from '@mui/icons-material/Save';
import { useQueryClient } from '@tanstack/react-query';

const EditAgentPage: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams({ strict: false });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [agentData, setAgentData] = useState<Partial<IAgent> | null>(null);
  const queryClient = useQueryClient();

  // Load agent data
  useEffect(() => {
    const fetchAgent = async () => {
      if (!id || Array.isArray(id)) return;

      setIsLoading(true);
      try {
        const agent = await getAgentByIdFromServer(id);
        setAgentData(agent);
      } catch (error) {
        console.error('Error fetching agent:', error);
        toast.error('Failed to load agent data');
      } finally {
        setIsLoading(false);
      }
    };

    fetchAgent();
  }, [id]);

  const handleSubmit = useCallback(
    async (updatedData: Partial<IAgent>) => {
      if (!agentData?.id) return;

      setIsSubmitting(true);
      try {
        const updatedAgent = await updateAgentToServer({
          ...updatedData,
          id: agentData.id,
        });

        toast.success('Agent updated successfully!');
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        navigate({ to: `/agents/${updatedAgent.id}` });
      } catch (error) {
        console.error('Error updating agent:', error);
        toast.error('Failed to update agent. Please try again.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [agentData, navigate]
  );

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div>Loading...</div>
      </div>
    );
  }

  if (!agentData) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div>Agent not found</div>
      </div>
    );
  }

  return (
    <AgentForm
      mode="edit"
      initialData={agentData}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      isLoading={isLoading}
      title={`${agentData.name || 'Untitled'}`}
      subtitle="Modify your agent's personality and capabilities"
      actions={{
        edit: api => (
          <Button
            data-testid="agent-form-submit"
            type="submit"
            form={AGENT_FORM_ID}
            color="primary"
            variant="solid"
            loading={api.isSubmitting}
            startDecorator={
              <Box
                sx={{
                  width: 24,
                  height: 24,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <SaveIcon sx={{ fontSize: '18px', m: 0 }} />
              </Box>
            }
            sx={{
              minWidth: { xs: '32px', sm: 'auto' },
              maxWidth: { xs: '32px', sm: '100%' },
              height: '32px',
              maxHeight: { xs: '32px', sm: 'auto' },
              minHeight: '32px',
              px: { xs: '0', sm: 2 },
              borderRadius: '6px',
              transition: 'all 0.3s ease',
              '& .MuiButton-startDecorator': {
                marginRight: { xs: '0px !important', sm: '8px !important' },
              },
            }}
          >
            <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>Save Changes</Box>
          </Button>
        ),
      }}
    />
  );
};

export default EditAgentPage;
