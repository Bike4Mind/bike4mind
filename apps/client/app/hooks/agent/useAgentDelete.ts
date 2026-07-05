import { useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { deleteAgentFromServer } from '@client/app/utils/agentsAPICalls';

interface UseAgentDeleteOptions {
  agentId: string;
  onDeleteSuccess?: (agentId: string) => void;
  redirectAfterDelete?: boolean;
  redirectTo?: string;
}

export const useAgentDelete = ({
  agentId,
  onDeleteSuccess,
  redirectAfterDelete = false,
  redirectTo = '/agents',
}: UseAgentDeleteOptions) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const openDeleteModal = useCallback(() => {
    setShowDeleteModal(true);
  }, []);

  const closeDeleteModal = useCallback(() => {
    setShowDeleteModal(false);
  }, []);

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await deleteAgentFromServer(agentId);
      queryClient.invalidateQueries({ queryKey: ['agents'] });

      if (onDeleteSuccess) {
        onDeleteSuccess(agentId);
      }

      setShowDeleteModal(false);

      if (redirectAfterDelete) {
        navigate({ to: redirectTo });
      }
    } catch (err) {
      console.error('Failed to delete agent', err);
      throw err; // Re-throw to let ConfirmationModal handle the error
    } finally {
      setIsDeleting(false);
    }
  }, [agentId, onDeleteSuccess, redirectAfterDelete, redirectTo, navigate]);

  return {
    showDeleteModal,
    isDeleting,
    openDeleteModal,
    closeDeleteModal,
    handleDelete,
  };
};
