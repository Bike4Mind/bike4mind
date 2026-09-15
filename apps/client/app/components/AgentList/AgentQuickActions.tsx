import { FC, useState } from 'react';
import { Box, IconButton } from '@mui/joy';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { useNavigate } from '@tanstack/react-router';
import ConfirmationModal from '@client/app/components/common/ConfirmationModal/index';
import { useAgentDelete } from '@client/app/hooks/agent/useAgentDelete';
import VoiceCustomizeModal from './VoiceCustomizeModal';

interface AgentQuickActionsProps {
  agentId: string;
  onDelete?: (agentId: string) => void;
  /** Voice agents are system-owned: edit opens the per-user customize modal and delete is hidden. */
  isVoiceAgent?: boolean;
  agentName?: string;
}

const AgentQuickActions: FC<AgentQuickActionsProps> = ({ agentId, onDelete, isVoiceAgent, agentName }) => {
  const navigate = useNavigate();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const { showDeleteModal, isDeleting, openDeleteModal, closeDeleteModal, handleDelete } = useAgentDelete({
    agentId,
    onDeleteSuccess: onDelete,
  });

  return (
    <>
      <Box
        className="card-actions"
        sx={{ position: 'absolute', top: 12, right: 12, zIndex: 2, display: 'flex', gap: { xs: '4px', sm: 0 } }}
        onClick={e => e.stopPropagation()}
      >
        <IconButton
          data-testid="agent-quick-action-edit"
          variant="plain"
          color="neutral"
          size="sm"
          sx={{
            borderRadius: '8px',
            minWidth: { xs: '28px', sm: '32px' },
            maxWidth: { xs: '28px', sm: '32px' },
            transition: 'background-color 160ms ease, color 160ms ease, transform 160ms ease',
          }}
          onClick={e => {
            e.stopPropagation();
            if (isVoiceAgent) {
              setCustomizeOpen(true);
            } else {
              navigate({ to: `/agents/${agentId}/edit` });
            }
          }}
        >
          <EditOutlinedIcon fontSize="small" sx={{ width: '18px', height: '18px', color: 'text.tertiary' }} />
        </IconButton>
        {!isVoiceAgent && (
          <IconButton
            data-testid="agent-quick-action-delete"
            variant="plain"
            color="danger"
            size="sm"
            sx={{
              borderRadius: '8px',
              minWidth: { xs: '28px', sm: '32px' },
              maxWidth: { xs: '28px', sm: '32px' },
              transition: 'background-color 160ms ease, color 160ms ease, transform 160ms ease',
            }}
            onClick={e => {
              e.stopPropagation();
              openDeleteModal();
            }}
          >
            <DeleteOutlineOutlinedIcon fontSize="small" sx={{ width: '18px', height: '18px' }} />
          </IconButton>
        )}
      </Box>

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

      {isVoiceAgent && (
        <VoiceCustomizeModal
          open={customizeOpen}
          onClose={() => setCustomizeOpen(false)}
          agentName={agentName ?? 'voice agent'}
        />
      )}
    </>
  );
};

export default AgentQuickActions;
