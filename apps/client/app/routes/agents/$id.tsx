import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { IAgent } from '@bike4mind/common';
import { toast } from 'sonner';
import { getAgentByIdFromServer } from '@client/app/utils/agentsAPICalls';
import AgentView from '@client/app/components/Agent/AgentView';
import { Button, Dropdown, IconButton as JoyIconButton, MenuButton, Menu, MenuItem, Box } from '@mui/joy';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ConfirmationModal from '@client/app/components/common/ConfirmationModal/index';
import { useAgentDelete } from '@client/app/hooks/agent/useAgentDelete';

const ViewAgentPage: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams({ strict: false });
  const [isLoading, setIsLoading] = useState(true);
  const [agentData, setAgentData] = useState<IAgent | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const { showDeleteModal, isDeleting, openDeleteModal, closeDeleteModal, handleDelete } = useAgentDelete({
    agentId: id || '',
    redirectAfterDelete: true,
    redirectTo: '/agents',
  });

  // Load agent data
  useEffect(() => {
    const fetchAgent = async () => {
      if (!id || Array.isArray(id)) return;

      setIsLoading(true);
      try {
        const agent = await getAgentByIdFromServer(id);
        console.log('agent', agent);
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

  const handleEdit = useCallback(() => {
    if (agentData?.id) {
      navigate({ to: `/agents/${agentData.id}/edit` });
    }
  }, [agentData, navigate]);

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
    <>
      <AgentView
        agent={agentData}
        title={agentData.name || 'Untitled Agent'}
        subtitle="View agent details and configuration"
        backTo="/agents"
        headerActions={
          <>
            <Button
              data-testid="agent-edit-btn"
              variant="outlined"
              color="neutral"
              startDecorator={<EditIcon sx={{ fontSize: '18px', color: 'text.primary', margin: 0 }} />}
              onClick={handleEdit}
              sx={{
                minWidth: { xs: '32px', sm: 'auto' },
                maxWidth: { xs: '32px', sm: '100%' },
                height: '32px',
                maxHeight: { xs: '32px', sm: 'auto' },
                minHeight: '32px',
                fontWeight: 500,
                transition: 'all 0.3s ease',
                px: { xs: '0px', sm: 2 },
                color: 'text.primary',
                border: theme => `1px solid ${theme.palette.border.input}`,
                '& .MuiButton-startDecorator': {
                  marginRight: { xs: '0px !important', sm: '8px !important' },
                },
              }}
            >
              <Box sx={{ display: { xs: 'none', sm: 'inline' } }}>Edit Agent</Box>
            </Button>
            <Dropdown open={menuOpen} onOpenChange={(event, isOpen) => setMenuOpen(isOpen)}>
              <MenuButton
                data-testid="agent-view-menu-btn"
                slots={{ root: JoyIconButton }}
                color="neutral"
                slotProps={{
                  root: {
                    variant: 'outlined',
                    sx: {
                      width: '32px',
                      height: '32px',
                      minWidth: '32px',
                      minHeight: '32px',
                      maxWidth: '32px',
                      maxHeight: '32px',
                      border: theme => `1px solid ${theme.palette.border.input}`,
                      transition: 'all 0.3s ease',
                      padding: 0,
                    },
                  },
                }}
              >
                <MoreVertIcon sx={{ fontSize: '18px', color: 'text.primary' }} />
              </MenuButton>
              <Menu
                placement="bottom-end"
                sx={theme => ({
                  minWidth: 140,
                  backgroundColor: theme.palette.background.body,
                  border: `1px solid ${theme.palette.border.soft}`,
                  borderRadius: '8px',
                  boxShadow: 'none',
                  padding: '8px',
                  '& .MuiMenuItem-root': {
                    borderRadius: '6px',
                    gap: '8px',
                    transition: 'all 0.3s ease',
                  },
                  '& .MuiMenuItem-root:hover': {
                    // backgroundColor: theme.palette.background.level2,
                  },
                })}
              >
                <MenuItem data-testid="agent-delete-menu-item" onClick={openDeleteModal} color="danger">
                  <DeleteIcon sx={{ mr: 0.5, fontSize: '18px' }} />
                  Delete
                </MenuItem>
              </Menu>
            </Dropdown>
          </>
        }
      />
      <ConfirmationModal
        open={showDeleteModal}
        onClose={closeDeleteModal}
        onConfirm={handleDelete}
        loading={isDeleting}
        title="Delete Agent"
        description="Are you sure you want to delete this agent? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        confirmColor="danger"
        showToast={true}
        successMessage="Agent deleted successfully"
        errorMessage="Failed to delete agent. Please try again."
      />
    </>
  );
};

export default ViewAgentPage;
