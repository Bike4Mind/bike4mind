import { FC, useState, useEffect } from 'react';
import { Modal, ModalDialog, Box, Button, IconButton } from '@mui/joy';
import ResearchAgentList from './List';
import ResearchAgentContent from './Content';
import ResearchAgentForm from './Form';
import { IResearchAgent } from '@bike4mind/common';
import { ArrowBack, Close } from '@mui/icons-material';
import {
  useCreateResearchAgent,
  useDeleteResearchAgent,
  useGetResearchAgents,
  useUpdateResearchAgent,
} from '@client/app/hooks/data/researchAgent';
import { useConfirmation } from '@client/app/hooks/useConfirmation';

interface ResearchAgentModalProps {
  open: boolean;
  onClose: () => void;
}

const ResearchAgentModal: FC<ResearchAgentModalProps> = ({ open, onClose }) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<IResearchAgent>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { data: researchAgents } = useGetResearchAgents();
  const { mutateAsync: createResearchAgent } = useCreateResearchAgent();
  const { mutate: updateResearchAgent } = useUpdateResearchAgent(editingAgent?.id ?? '');
  const { mutateAsync: deleteResearchAgent } = useDeleteResearchAgent();
  const confirm = useConfirmation();

  // Auto-select the first agent when available
  useEffect(() => {
    if (open && researchAgents && researchAgents.length > 0 && !selectedAgentId) {
      const sortedAgents = researchAgents.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setSelectedAgentId(sortedAgents[0].id);
    }
  }, [open, researchAgents, selectedAgentId]);

  // Reset selection when modal closes
  useEffect(() => {
    if (!open) {
      setSelectedAgentId(undefined);
    }
  }, [open]);

  const handleCreateAgent = () => {
    setEditingAgent(undefined);
    setIsFormOpen(true);
  };

  const handleEditAgent = () => {
    const agent = researchAgents?.find(a => a.id === selectedAgentId);
    if (agent) {
      setEditingAgent(agent);
      setIsFormOpen(true);
    }
  };

  const handleDeleteAgent = async () => {
    if (!selectedAgentId) return;
    confirm({
      type: 'danger',
      title: 'Delete Agent',
      description: 'Are you sure you want to delete this agent?',
      okLabel: 'Delete',
      onOk: async () => {
        await deleteResearchAgent(selectedAgentId);
        setSelectedAgentId(undefined);
      },
    });
  };

  const handleFormClose = () => {
    setIsFormOpen(false);
    setEditingAgent(undefined);
  };

  const handleFormSubmit = async (data: { name: string; description: string }) => {
    setIsSubmitting(true);
    try {
      if (editingAgent) {
        await updateResearchAgent({
          name: data.name,
          description: data.description,
        });
      } else {
        const newAgent = await createResearchAgent(data);
        setSelectedAgentId(newAgent.id);
        console.log(`🎯 Auto-selected newly created agent: ${newAgent.name} (${newAgent.id})`);
      }
      handleFormClose();
    } catch (error) {
      console.error('Error submitting agent:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
  };

  const handleCreateTask = () => {
    // TODO: Implement create task logic
    console.log('Create task clicked');
  };

  const selectedAgent = researchAgents?.find(agent => agent.id === selectedAgentId);
  const sortedAgents = researchAgents?.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1300,
        }}
      >
        <ModalDialog
          sx={{
            p: 0,
            gap: 0,
            width: '90vw',
            height: '90vh',
            overflow: 'hidden',
            bgcolor: 'background.surface',
            position: 'relative',
            transform: 'none',
            top: 'auto',
            left: 'auto',
            right: 'auto',
            bottom: 'auto',
          }}
        >
          {/* Close button */}
          <IconButton
            variant="plain"
            color="neutral"
            size="sm"
            onClick={onClose}
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 10,
            }}
          >
            <Close />
          </IconButton>

          <Box
            sx={{
              width: '100%',
              height: '100%',
              display: 'flex',
            }}
          >
            {/* Sidenav */}
            <Box
              sx={{
                width: '280px',
                height: '100%',
                borderRight: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.level1',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <ResearchAgentList
                agents={sortedAgents ?? []}
                selectedAgentId={selectedAgentId}
                onSelectAgent={handleSelectAgent}
                onCreateAgent={handleCreateAgent}
              />
              <Box p={2}>
                <Button
                  fullWidth
                  variant="outlined"
                  color="neutral"
                  sx={{ gap: 1, justifyContent: 'flex-start' }}
                  onClick={onClose}
                >
                  <ArrowBack />
                  Back
                </Button>
              </Box>
            </Box>

            {/* Main Content */}
            <Box
              sx={{
                flex: 1,
                height: '100%',
                overflow: 'auto',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {selectedAgent ? (
                <ResearchAgentContent
                  agent={selectedAgent}
                  onEditAgent={handleEditAgent}
                  onCreateTask={handleCreateTask}
                  onDeleteAgent={handleDeleteAgent}
                />
              ) : (
                <Box
                  sx={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Box sx={{ textAlign: 'center', color: 'text.secondary' }}>Select an agent to view details</Box>
                </Box>
              )}
            </Box>
          </Box>
        </ModalDialog>
      </Modal>

      <ResearchAgentForm
        open={isFormOpen}
        onClose={handleFormClose}
        onSubmit={handleFormSubmit}
        agent={editingAgent}
        isSubmitting={isSubmitting}
      />
    </>
  );
};

export default ResearchAgentModal;
